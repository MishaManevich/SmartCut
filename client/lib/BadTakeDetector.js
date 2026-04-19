/**
 * SmartCut — Bad Take Detector (v9)
 *
 * Consumes a whisper transcript (segments + word-level timestamps) and
 * returns cut regions for:
 *
 *   1. RESTART PHRASES — "sorry, let me try that again", "take two",
 *      "one more time", "ugh", etc. Cuts from the phrase's start BACK to
 *      a natural sentence boundary, and keeps the retake that follows.
 *
 *   2. DUPLICATE SENTENCES — near-identical sentences spoken within 30s
 *      of each other. Keeps the LATER take (the retake) and removes the
 *      earlier ones.
 *
 *   3. FILLER RUNS — ≥3 consecutive filler tokens ("um", "uh", "like",
 *      "you know") with no speech between.
 *
 * All regions are emitted in the SAME shape as silence regions:
 *   { startSeconds, endSeconds, duration, type: "bad_take"|"duplicate"|"fillers",
 *     confidence, reason }
 *
 * Public API:
 *   BadTakeDetector.detect(transcript, opts) → Array<Region>
 */

(function (global) {
  "use strict";

  var BadTakeDetector = {};

  // ── Config ────────────────────────────────────────────────────────────────

  var RESTART_PATTERNS = [
    /\b(sorry|scratch that|ignore that|forget that|wait)\b.*\b(let me|let's|i(['' ]ll)? (try|start|say|do)|try that|do that|start over|again)\b/i,
    /\b(take\s+(?:two|three|four|2|3|4|five|5)|one more time|once more)\b/i,
    /\b(let me (try|start|do|say) that again|try that again|do that again|say that again|start again|start over)\b/i,
    /\b(actually(?:,)? (?:let me|let's|i ?(?:should|need|want))|hold on|hmm(?:m)*,?\s+actually)\b/i,
    /\b(cut that|don['''`]t use that|edit this out|cut this out)\b/i,
    /\b(ugh|argh)[,.!]?\s+(let me|take|sorry|okay)\b/i
  ];

  var FILLERS = {
    "um": 1, "uh": 1, "uhh": 1, "ummm": 1, "uhm": 1, "erm": 1, "er": 1,
    "ah": 1, "hmm": 1, "like": 0.5, "you know": 0.5, "i mean": 0.5, "so": 0.3
  };

  // ── Public: detect ────────────────────────────────────────────────────────

  /**
   * Detect bad takes. Returns a Promise<Array<Region>>.
   *
   * Detection stages, in order:
   *   1. Retake chains (heuristic; opener match + incomplete-sentence signals)
   *   2. Semantic retakes (embedding similarity; catches paraphrased retakes)
   *   3. Restart phrases (verbal "sorry, take two" cues)
   *   4. Duplicate sentences (character-bigram dice)
   *   5. Filler runs
   *
   * Stage 2 (semantic) is SKIPPED if Embedder is unavailable or opts.useSemantic
   * is explicitly false. Result is always the same shape.
   */
  BadTakeDetector.detect = function (transcript, opts) {
    opts = opts || {};
    if (!transcript || !transcript.segments) return Promise.resolve([]);

    var regions = [];

    // Stage 1 — heuristic chains (synchronous)
    var chainResult = detectRetakeChains(transcript, opts);
    regions = regions.concat(chainResult.regions);
    var usedIdx = chainResult.usedIdx;

    // Stage 2 — semantic retakes (async, optional)
    var semanticPromise;
    var embedderAvailable =
      opts.useSemantic !== false &&
      typeof global.Embedder !== "undefined" &&
      global.Embedder.isAvailable &&
      global.Embedder.isAvailable();
    if (embedderAvailable) {
      semanticPromise = detectSemanticRetakes(transcript, opts, usedIdx);
    } else {
      semanticPromise = Promise.resolve({ regions: [], usedIdx: usedIdx });
    }

    return semanticPromise.then(function (sem) {
      regions = regions.concat(sem.regions);
      usedIdx = sem.usedIdx;

      // Stages 3–5 — synchronous fill-ins
      regions = regions.concat(detectRestarts(transcript, opts, usedIdx));
      regions = regions.concat(detectDuplicates(transcript, opts, usedIdx));
      regions = regions.concat(detectFillerRuns(transcript, opts));

      // Dedupe + merge overlapping regions
      regions.sort(function (a, b) { return a.startSeconds - b.startSeconds; });
      var merged = [];
      for (var i = 0; i < regions.length; i++) {
        var r = regions[i];
        if (merged.length && r.startSeconds < merged[merged.length - 1].endSeconds + 0.1) {
          var prev = merged[merged.length - 1];
          if (r.endSeconds > prev.endSeconds) prev.endSeconds = r.endSeconds;
          prev.duration = prev.endSeconds - prev.startSeconds;
          prev.reason += " + " + r.reason;
          prev.confidence = Math.max(prev.confidence, r.confidence);
        } else {
          merged.push(r);
        }
      }
      return merged;
    });
  };

  // ── 0. Retake chains (the big one) ────────────────────────────────────────
  //
  // The most common real-world retake: speaker stops mid-sentence (or finishes
  // it but is unhappy with it), pauses briefly, then re-attempts with the same
  // opening words. There's no verbal cue — just a shared opener.
  //
  // We look for pairs A→B within a short window where:
  //   - First 4+ tokens match exactly, OR
  //   - First 3 tokens match AND (A is incomplete OR gap < 2s)
  //
  // If B is ALSO followed by a similar C, we chain them. We always KEEP THE
  // LAST take and cut everything before it (this matches the pro-editor
  // default: retakes exist because the earlier attempt was unsatisfactory).

  function detectRetakeChains(transcript, opts) {
    opts = opts || {};
    var segs = transcript.segments || [];
    var out = [];
    var usedIdx = {};
    var DEBUG = !!opts.debug;

    // Tunables — tightened in v9.3 after "every bad take is a 37s chain" bug.
    // Old values overfit to speech patterns that share stopword-only openers
    // ("and this is X", "this is the Y") and produced massive false chains.
    var MAX_LOOKAHEAD        = 3;        // was 4
    var MAX_GAP_MS           = 3500;     // was 5000
    var OPENER_STRONG        = 4;        // unchanged
    var OPENER_MIN           = 3;        // unchanged
    var SHORT_GAP_MS         = 2000;     // unchanged
    var MIN_CONTENT_MATCHES  = 1;        // NEW — matched opener must include ≥ 1 content word

    if (DEBUG) console.log("[BadTakeDetector] heuristic chain scan — " + segs.length + " segments");

    for (var i = 0; i < segs.length - 1; i++) {
      if (usedIdx[i]) continue;
      var first = segs[i];
      var firstTokens = tokenize(first.text);
      if (firstTokens.length < 2) continue;

      // Walk the chain forward, always comparing the NEXT candidate against
      // the CURRENT "head" of the chain (which is the latest retake we've
      // accepted — that's the fairest comparison).
      var head       = first;
      var headTokens = firstTokens;
      var lastKeeper = i;

      for (var j = i + 1; j < Math.min(i + 1 + MAX_LOOKAHEAD, segs.length); j++) {
        if (usedIdx[j]) break;
        var cand  = segs[j];
        var prev  = segs[j - 1];
        var gap   = cand.from - prev.to;
        if (gap > MAX_GAP_MS) break;

        var candTokens = tokenize(cand.text);
        if (candTokens.length < 2) continue;

        var score = retakeScore(head, cand, headTokens, candTokens, gap, {
          OPENER_STRONG:       OPENER_STRONG,
          OPENER_MIN:          OPENER_MIN,
          SHORT_GAP_MS:        SHORT_GAP_MS,
          MIN_CONTENT_MATCHES: MIN_CONTENT_MATCHES
        });
        if (DEBUG) {
          console.log("  [chain?] #" + i + "→#" + j +
            " opener=" + score.openerLen +
            " content=" + score.contentMatches +
            " gap=" + gap + "ms" +
            " A=\"" + head.text.slice(0, 40) + "\"" +
            " B=\"" + cand.text.slice(0, 40) + "\"" +
            " → " + (score.isRetake ? "RETAKE" : "reject"));
        }
        if (score.isRetake) {
          lastKeeper = j;
          head       = cand;
          headTokens = candTokens;
        } else {
          // Don't keep walking forward looking for a retake of a DIFFERENT
          // sentence we just skipped — that's what led to 37-second chains.
          break;
        }
      }

      if (lastKeeper > i) {
        // Cut from first segment's start to just before the keeper's start.
        // This removes all aborted attempts AND the pauses between them,
        // leaving only the final clean take.
        var startMs = first.from;
        var endMs   = segs[lastKeeper].from - 30; // 30ms nudge
        if (endMs <= startMs) endMs = startMs + 10;

        var chainLen = lastKeeper - i + 1;   // includes the keeper
        var cutCount = lastKeeper - i;       // segments being cut
        var preview  = first.text.trim().slice(0, 55);
        var reason   = 'retake (opener match)';
        if (cutCount > 1) reason = 'retake chain, ' + cutCount + ' false starts';
        if (!/[.!?]$/.test(first.text)) reason = 'mid-sentence stop + retake';

        out.push({
          startSeconds: startMs / 1000,
          endSeconds:   endMs   / 1000,
          duration:     (endMs - startMs) / 1000,
          type:         "bad_take",
          confidence:   0.85,
          reason:       reason + ': "' + preview + (preview.length < first.text.length ? '…' : '') + '"'
        });

        for (var k = i; k < lastKeeper; k++) usedIdx[k] = true;
        i = lastKeeper - 1; // continue after the keeper (the outer loop will i++)
      }
    }

    return { regions: out, usedIdx: usedIdx };
  }

  function retakeScore(segA, segB, tokensA, tokensB, gap, cfg) {
    // Count exact-match opener tokens
    var openerLen = 0;
    var cap = Math.min(tokensA.length, tokensB.length, 8);
    for (var i = 0; i < cap; i++) {
      if (tokensA[i] === tokensB[i]) openerLen++;
      else break;
    }

    // CRITICAL guardrail: count how many of the matched opener tokens are
    // CONTENT words (not stopwords/fillers). A 4-token "and this is the" opener
    // is meaningless — people start sentences that way constantly. A 4-token
    // "the reason i love" is a real retake signature.
    var contentMatches = 0;
    for (var c = 0; c < openerLen; c++) {
      if (!STOPWORDS[tokensA[c]]) contentMatches++;
    }

    var aIncomplete = !/[.!?]$/.test((segA.text || "").trim());
    var aIsShort    = tokensA.length <= 7;
    var shortGap    = gap < cfg.SHORT_GAP_MS && gap > 60;

    // Primary gate: must have enough CONTENT-word overlap in the opener.
    // This alone kills the "and this is X" / "this is the Y" false-positive class.
    if (contentMatches < (cfg.MIN_CONTENT_MATCHES || 1)) {
      return { isRetake: false, openerLen: openerLen, contentMatches: contentMatches };
    }

    // Secondary gate: combinatorial strength.
    var isRetake =
      (openerLen >= cfg.OPENER_STRONG) ||
      (openerLen >= cfg.OPENER_MIN && (aIncomplete || shortGap)) ||
      (aIncomplete && aIsShort && openerLen >= 2 && shortGap);

    return { isRetake: isRetake, openerLen: openerLen, contentMatches: contentMatches };
  }

  // Stopwords + fillers: shared-opener tokens that carry no meaning. Having
  // all these in common tells us NOTHING about whether two sentences are retakes
  // of each other. The list is intentionally generous for spoken English.
  var STOPWORDS = {
    "the":1,"a":1,"an":1,"and":1,"but":1,"or":1,"so":1,"of":1,"to":1,
    "in":1,"on":1,"at":1,"for":1,"with":1,"from":1,"by":1,"as":1,
    "is":1,"are":1,"was":1,"were":1,"be":1,"been":1,"being":1,"am":1,
    "it":1,"this":1,"that":1,"these":1,"those":1,"there":1,"here":1,
    "i":1,"you":1,"we":1,"they":1,"he":1,"she":1,"me":1,"him":1,"her":1,
    "us":1,"them":1,"my":1,"your":1,"our":1,"their":1,"his":1,"its":1,
    "have":1,"has":1,"had":1,"do":1,"does":1,"did":1,
    "will":1,"would":1,"can":1,"could":1,"should":1,"may":1,"might":1,
    "just":1,"now":1,"also":1,"then":1,"if":1,"when":1,"while":1,"not":1,
    "like":1,"um":1,"uh":1,"uhh":1,"hmm":1,"well":1,"ok":1,"okay":1,
    "yeah":1,"yep":1,"yes":1,"no":1,"gonna":1,"wanna":1,"gotta":1
  };

  // ── Semantic retake detection (embeddings) ────────────────────────────────
  //
  // Uses MiniLM-L6-v2 sentence embeddings to find retakes that DON'T share
  // openers — i.e. paraphrased restatements of the same idea:
  //
  //   "The best part about this is the battery"   (aborted)
  //   "What I love most is how long it lasts"     (the retake)
  //
  // Algorithm:
  //   1. Gather candidate segment indices not already claimed by heuristics.
  //   2. Filter to segments with ≥ 4 words (shorter ones are too noisy).
  //   3. Batch-embed all candidates in one call (~1-2s for ~50 segments).
  //   4. For each candidate pair within TEMPORAL_WINDOW_MS:
  //        - if cosineSim >= SIM_THRESHOLD → B is a retake of A
  //        - keep the LATER take (B), cut A
  //   5. Chain-merge: A→B and B→C → cut A and B, keep C.
  //
  // Conservative thresholds to avoid false positives on genuinely similar but
  // intentional sentences (e.g. product-feature lists where each item is
  // phrased similarly).

  function detectSemanticRetakes(transcript, opts, usedIdx) {
    var segs = transcript.segments || [];
    var DEBUG = !!opts.debug;
    if (segs.length < 2) return Promise.resolve({ regions: [], usedIdx: usedIdx });

    var SIM_THRESHOLD        = opts.semanticSimThreshold || 0.78;
    var TEMPORAL_WINDOW_MS   = (opts.semanticWindowSec   || 45) * 1000;
    var MIN_WORDS            = 4;

    // Collect candidate indices
    var candIdx = [];
    var skippedUsed = 0;
    var skippedShort = 0;
    for (var i = 0; i < segs.length; i++) {
      if (usedIdx[i])  { skippedUsed++;  continue; }
      var toks = tokenize(segs[i].text);
      if (toks.length < MIN_WORDS) { skippedShort++; continue; }
      candIdx.push(i);
    }
    if (DEBUG) {
      console.log("[BadTakeDetector] semantic stage: " + candIdx.length +
        " candidates (skipped " + skippedUsed + " already-flagged, " +
        skippedShort + " too-short)");
    }
    if (candIdx.length < 2) return Promise.resolve({ regions: [], usedIdx: usedIdx });

    var texts = candIdx.map(function (i) { return segs[i].text; });

    return global.Embedder.embed(texts).then(function (vectors) {
      var cs = global.Embedder.cosineSimilarity;
      var out = [];
      var localUsed = {};

      // Debug: dump the top pairs so we know whether the threshold is
      // sensible for this particular video. If the top similarity is ~0.5
      // across the board, we probably have no real retakes. If it's ~0.75
      // and we're cutting at 0.78, we might be missing stuff.
      if (DEBUG) {
        var pairs = [];
        for (var xi = 0; xi < candIdx.length; xi++) {
          for (var xj = xi + 1; xj < candIdx.length; xj++) {
            var dt2 = segs[candIdx[xj]].from - segs[candIdx[xi]].to;
            if (dt2 > TEMPORAL_WINDOW_MS || dt2 < -500) continue;
            pairs.push({
              i: xi, j: xj,
              sim: cs(vectors[xi], vectors[xj]),
              textA: segs[candIdx[xi]].text.slice(0, 50),
              textB: segs[candIdx[xj]].text.slice(0, 50),
              dt: dt2
            });
          }
        }
        pairs.sort(function (a, b) { return b.sim - a.sim; });
        console.log("[BadTakeDetector] semantic top pairs (threshold " + SIM_THRESHOLD + "):");
        pairs.slice(0, 8).forEach(function (p) {
          console.log("  " + (p.sim * 100).toFixed(0) + "%" +
            " (gap " + Math.round(p.dt) + "ms)" +
            "  A=\"" + p.textA + "\"" +
            "  B=\"" + p.textB + "\"");
        });
      }

      for (var a = 0; a < candIdx.length; a++) {
        if (localUsed[a]) continue;
        var segA     = segs[candIdx[a]];
        var vecA     = vectors[a];
        var keeperA  = a;        // latest accepted retake in this chain
        var chainEnd = a;

        for (var b = a + 1; b < candIdx.length; b++) {
          if (localUsed[b]) continue;
          var segB = segs[candIdx[b]];
          // Use the LATEST keeper in the chain as comparison anchor —
          // a later take may be closer to the final than the original abort.
          var dt = segB.from - segs[candIdx[keeperA]].to;
          if (dt > TEMPORAL_WINDOW_MS) break;
          if (dt < -500) continue;
          var sim = cs(vectors[keeperA], vectors[b]);
          if (sim >= SIM_THRESHOLD) {
            chainEnd = b;
            keeperA  = b;
          }
        }

        if (chainEnd > a) {
          var firstSegIdx = candIdx[a];
          var keepSegIdx  = candIdx[chainEnd];
          var firstSeg    = segs[firstSegIdx];
          var keepSeg     = segs[keepSegIdx];

          var startMs = firstSeg.from;
          var endMs   = keepSeg.from - 30;
          if (endMs <= startMs) endMs = startMs + 10;

          var preview = firstSeg.text.trim().slice(0, 55);
          var cutCount = chainEnd - a;
          var simDisplay = Math.round(cs(vectors[a], vectors[chainEnd]) * 100);
          var reason = (cutCount > 1)
            ? 'semantic retake chain, ' + cutCount + ' earlier attempts (' + simDisplay + '% meaning match)'
            : 'paraphrased retake (' + simDisplay + '% meaning match)';

          out.push({
            startSeconds: startMs / 1000,
            endSeconds:   endMs   / 1000,
            duration:     (endMs - startMs) / 1000,
            type:         "bad_take",
            confidence:   Math.min(0.95, 0.6 + (simDisplay - 78) / 50),
            reason:       reason + ': "' + preview + (preview.length < firstSeg.text.length ? '…' : '') + '"'
          });

          for (var k = a; k < chainEnd; k++) {
            localUsed[k] = true;
            usedIdx[candIdx[k]] = true;
          }
          a = chainEnd - 1; // outer loop will ++
        }
      }

      return { regions: out, usedIdx: usedIdx };
    }).catch(function (err) {
      // If the embedder fails, degrade gracefully — heuristic results still apply.
      console.warn("[BadTakeDetector] semantic stage failed:", err);
      return { regions: [], usedIdx: usedIdx };
    });
  }

  // Tokenize for opener matching: lowercase + strip punctuation. We keep
  // stopwords because "the thing about" is meaningful as a retake signature.
  function tokenize(s) {
    return (s || "")
      .toLowerCase()
      .replace(/[^\w\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(function (t) { return t.length > 0; });
  }

  // ── 1. Restart phrases ────────────────────────────────────────────────────
  //
  // If a sentence matches a restart pattern, we want to cut:
  //   from [start of preceding SENTENCE that was the flubbed take]
  //   to   [end of restart phrase itself]
  // This removes the flubbed take AND the apology, keeping the clean retake.

  function detectRestarts(transcript, opts, usedIdx) {
    usedIdx = usedIdx || {};
    var out = [];
    var segs = transcript.segments;
    for (var i = 0; i < segs.length; i++) {
      if (usedIdx[i]) continue;
      var s = segs[i];
      var hit = matchRestart(s.text);
      if (!hit) continue;

      // The flubbed take is the ONE sentence immediately before the restart.
      // We only widen further if that sentence is tightly coupled (< 300ms gap)
      // to an even earlier one AND looks like part of the same attempt.
      // Heuristic: stop at the first real pause (>= 400ms) OR after 2 sentences
      // OR when we cross a sentence-terminator (.!?) with a gap.
      var startMs = s.from;
      var stepped = 0;
      for (var j = i - 1; j >= 0; j--) {
        var prev = segs[j];
        var nextSeg = segs[j + 1];
        var gap = (nextSeg ? nextSeg.from - prev.to : 0);
        // Stop if there's a real pause — that's a safe take boundary
        if (gap > 400) break;
        startMs = prev.from;
        stepped++;
        // Don't eat more than 2 prior sentences by default
        if (stepped >= 2) break;
        // If the prior sentence ended with .!? and there's any meaningful gap,
        // trust that as a sentence boundary.
        if (/[.!?]$/.test(prev.text) && gap > 150) break;
      }

      out.push({
        startSeconds: startMs / 1000,
        endSeconds:   s.to    / 1000,
        duration:     (s.to - startMs) / 1000,
        type:         "bad_take",
        confidence:   0.85,
        reason:       "restart: \"" + s.text.slice(0, 60) + (s.text.length > 60 ? "…" : "") + "\""
      });
    }
    return out;
  }

  function matchRestart(text) {
    for (var i = 0; i < RESTART_PATTERNS.length; i++) {
      if (RESTART_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  // ── 2. Duplicate sentences ────────────────────────────────────────────────
  //
  // If sentence A's normalized text is >=80% similar to a later sentence B
  // within 30 seconds, A is likely the flubbed take; remove A.

  function detectDuplicates(transcript, opts, usedIdx) {
    usedIdx = usedIdx || {};
    var out = [];
    var segs = transcript.segments;
    var simThreshold = opts.similarityThreshold || 0.80;
    var windowSec    = opts.duplicateWindowSec || 30;

    var normed = segs.map(function (s) { return normalize(s.text); });

    for (var i = 0; i < segs.length - 1; i++) {
      if (usedIdx[i]) continue;
      if (normed[i].length < 12) continue;    // ignore very short segments
      for (var j = i + 1; j < segs.length; j++) {
        var dt = (segs[j].from - segs[i].to) / 1000;
        if (dt > windowSec) break;
        var sim = similarity(normed[i], normed[j]);
        if (sim >= simThreshold) {
          out.push({
            startSeconds: segs[i].from / 1000,
            endSeconds:   segs[i].to   / 1000,
            duration:     (segs[i].to - segs[i].from) / 1000,
            type:         "duplicate",
            confidence:   Math.min(0.95, sim),
            reason:       "dup of later take (" + Math.round(sim * 100) + "% match)"
          });
          break;
        }
      }
    }
    return out;
  }

  function normalize(t) {
    return (t || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Bigram Dice coefficient — fast, fuzzy, good for "is this sentence the same thing?"
  function similarity(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    var aBigrams = bigrams(a), bBigrams = bigrams(b);
    var aTotal = 0, bTotal = 0;
    for (var k in aBigrams) aTotal += aBigrams[k];
    for (var k2 in bBigrams) bTotal += bBigrams[k2];
    var intersect = 0;
    for (var k3 in aBigrams) {
      if (bBigrams[k3]) intersect += Math.min(aBigrams[k3], bBigrams[k3]);
    }
    return (2 * intersect) / (aTotal + bTotal);
  }

  function bigrams(s) {
    var out = {};
    for (var i = 0; i < s.length - 1; i++) {
      var pair = s.substr(i, 2);
      out[pair] = (out[pair] || 0) + 1;
    }
    return out;
  }

  // ── 3. Filler runs ────────────────────────────────────────────────────────
  //
  // Three or more consecutive filler words with no real-word in between =
  // cut the whole run.

  function detectFillerRuns(transcript, opts) {
    var out = [];
    var words = transcript.words || [];
    var runStart = -1;
    var runScore = 0;

    function flush(endIdx) {
      if (runStart >= 0 && (endIdx - runStart) >= 3 && runScore >= 3) {
        var first = words[runStart], last = words[endIdx - 1];
        out.push({
          startSeconds: first.t0 / 1000,
          endSeconds:   last.t1  / 1000,
          duration:     (last.t1 - first.t0) / 1000,
          type:         "fillers",
          confidence:   0.75,
          reason:       "filler run (" + (endIdx - runStart) + " tokens)"
        });
      }
      runStart = -1;
      runScore = 0;
    }

    for (var i = 0; i < words.length; i++) {
      var w = words[i].text.toLowerCase().replace(/[^\w]/g, "");
      if (FILLERS[w]) {
        if (runStart < 0) runStart = i;
        runScore += FILLERS[w];
      } else {
        flush(i);
      }
    }
    flush(words.length);
    return out;
  }

  global.BadTakeDetector = BadTakeDetector;
})(window);
