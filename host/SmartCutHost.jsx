/**
 * SmartCut — ExtendScript Host (v9)
 *
 * v9 SCOPE AWARE — new:
 *   resolveAnalysisPlan(payloadJSON)   — returns {scope, audioSource, clips}
 *     scope      : which time range to analyze + cut
 *     audioSource: which track to READ for silence/speech detection
 *     clips      : concrete clip list (media paths, seq-time offsets)
 *   applyCuts(payload)                  — now scope-bounded; razors + removes
 *                                         only within scope.startSec/endSec,
 *                                         across all video+audio tracks.
 *
 * v8 REWRITE — fixes Bug #4 (cutting engine):
 *  - Primary razor strategy: CleanCut-style setPlayerPosition(ticks) + qeSeq.CTI.timecode
 *    This avoids the Time.getFormatted() format-mismatch that caused v7 razors
 *    to silently fail on Premiere v26.
 *  - Removal strategy: JumpCut-style match-by-bounds (with ~1 frame tolerance),
 *    falling back to alternating-index if no bound match is found.
 *  - Relink phase: pairs video+audio clips by time overlap then linkSelection().
 *  - All razor/remove operations processed END → START to keep indices valid.
 *  - Each phase logs clip counts so the panel can diagnose failures cleanly.
 *  - Returns structured JSON for the panel's applyCutsToTimeline handler.
 *
 * Functions exposed to main.js:
 *   getActiveSequenceInfo()   — sequence metadata
 *   getScopeInfo()            — sequence + current video-clip selection + I/O marks
 *   renameActiveSequence(p)   — rename the active sequence (legacy Scope card)
 *   renameScopeTarget(p)      — rename the current Scope target (clip OR sequence)
 *   getTrackInfo()            — video tracks + clip counts
 *   getSourceMediaPaths(trackIndex?) — clips on selected video track (for audio read)
 *   getAudioClipInfo()        — audio-track clips (fallback for estimation)
 *   applyCuts(payloadJSON)    — the new cut engine (v8)
 *   applyCutsV7(payloadJSON)  — alias, kept so older panel builds still work
 *   testCut()                 — single-cut smoke test (CTI razor at 1s in)
 *   runDiagnostics()          — environment probe
 *   setPlayheadPosition(sec)  — seek
 *   undoLastAction()          — qe.project.undoStackPopBack + Cmd+Z hint
 *   createSnapshot()          — clones active seq into project bin (pre-cut safety net)
 *   restoreSnapshot(payload)  — re-activates the snapshot sequence after a cut
 */

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

var TICKS_PER_SECOND = 254016000000;
var EPSILON_SEC      = 0.04;   // ~1 frame @ 24fps — clip-bound match tolerance

// ═══════════════════════════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════════════════════════

var _log = [];
var _logPath = "";

function logInit() { _log = []; _logPath = ""; }
function log(msg)  { _log.push(String(msg)); }

function writeLogFile() {
  var paths = [];
  try { paths.push(Folder.userData.fsName + "/SmartCutPro/debug.log"); } catch (e) {}
  try { paths.push(Folder.myDocuments.fsName + "/SmartCutPro_debug.log"); } catch (e) {}
  try { paths.push(Folder.desktop.fsName + "/SmartCutPro_debug.log"); } catch (e) {}
  try { paths.push(Folder.temp.fsName   + "/SmartCutPro_debug.log"); } catch (e) {}
  for (var p = 0; p < paths.length; p++) {
    try {
      var f = new File(paths[p]);
      var parent = f.parent;
      if (parent && !parent.exists) { try { parent.create(); } catch (e2) {} }
      if (f.open("w")) {
        f.encoding = "UTF-8";
        var ok = f.write(_log.join("\n"));
        f.close();
        if (ok) { _logPath = paths[p]; return; }
      }
    } catch (e) {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON helpers (ExtendScript is ES3 — no native JSON)
// ═══════════════════════════════════════════════════════════════════════════

function jsonStringify(obj) {
  if (obj === null || obj === undefined) return "null";
  var t = typeof obj;
  if (t === "number" || t === "boolean") return String(obj);
  if (t === "string") {
    return '"' + obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                    .replace(/\n/g, "\\n").replace(/\r/g, "\\r")
                    .replace(/\t/g, "\\t") + '"';
  }
  if (obj instanceof Array) {
    var arr = [];
    for (var i = 0; i < obj.length; i++) arr.push(jsonStringify(obj[i]));
    return "[" + arr.join(",") + "]";
  }
  if (t === "object") {
    var pairs = [];
    for (var k in obj) {
      if (obj.hasOwnProperty(k)) pairs.push('"' + k + '":' + jsonStringify(obj[k]));
    }
    return "{" + pairs.join(",") + "}";
  }
  return '"' + String(obj) + '"';
}

// ═══════════════════════════════════════════════════════════════════════════
// Time helpers
// ═══════════════════════════════════════════════════════════════════════════

function safeSeconds(timeObj) {
  if (timeObj === null || timeObj === undefined) return 0;
  if (typeof timeObj === "number") return timeObj;
  try { if (typeof timeObj.seconds === "number") return timeObj.seconds; } catch (e) {}
  try {
    var t = parseFloat(timeObj.ticks) / TICKS_PER_SECOND;
    if (!isNaN(t)) return t;
  } catch (e) {}
  try { return parseFloat(timeObj) || 0; } catch (e) { return 0; }
}

function getSequenceFPS(seq) {
  try {
    var s = seq.getSettings();
    if (s && s.videoFrameRate) {
      var ticks = parseFloat(s.videoFrameRate.ticks);
      if (ticks > 0) return TICKS_PER_SECOND / ticks;
    }
  } catch (e) {}
  return 24;
}

/**
 * Move the playhead to `seconds` and return the QE sequence's CTI timecode.
 * This is CleanCut's approach — it avoids the Time.getFormatted() format
 * mismatch that causes QE razor() to silently fail on Premiere v24+.
 */
function seekAndGetCTITimecode(seq, qeSeq, seconds) {
  var ticks = Math.round(seconds * TICKS_PER_SECOND);
  seq.setPlayerPosition(ticks.toString());
  return qeSeq.CTI.timecode;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sequence / Track inspection
// ═══════════════════════════════════════════════════════════════════════════

function getActiveSequenceInfo() {
  try {
    if (!app.project || !app.project.activeSequence) {
      return jsonStringify({ error: "No active sequence. Open one in the Timeline." });
    }
    var seq = app.project.activeSequence;
    return jsonStringify({
      name: String(seq.name || ""),
      duration: safeSeconds(seq.end),
      framerate: getSequenceFPS(seq),
      videoTrackCount: seq.videoTracks ? seq.videoTracks.numTracks : 0,
      audioTrackCount: seq.audioTracks ? seq.audioTracks.numTracks : 0
    });
  } catch (e) {
    return jsonStringify({ error: "getActiveSequenceInfo: " + String(e.message || e) });
  }
}

// Rename the currently-active sequence. Called from the Scope card's
// editable name input. Returns the new name Premiere actually accepted
// (it can silently coerce duplicates), so the panel can sync back.
function renameActiveSequence(payloadJSON) {
  try {
    if (!payloadJSON) return jsonStringify({ error: "No payload" });
    var p;
    try { p = eval("(" + payloadJSON + ")"); }
    catch (e) { return jsonStringify({ error: "Bad payload: " + e }); }

    var newName = String((p && p.name) || "").replace(/^\s+|\s+$/g, "");
    if (!newName) return jsonStringify({ error: "Empty name" });

    if (!app.project || !app.project.activeSequence) {
      return jsonStringify({ error: "No active sequence" });
    }
    var seq = app.project.activeSequence;
    try { seq.name = newName; }
    catch (eSet) { return jsonStringify({ error: "seq.name= failed: " + eSet }); }

    return jsonStringify({ success: true, name: String(seq.name || newName) });
  } catch (e) {
    return jsonStringify({ error: "renameActiveSequence: " + String(e.message || e) });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SCOPE INFO — selection + sequence snapshot for the Scope card.
//
// Returns enough info for the panel to describe what's about to be cut:
//   * sequence:  { name, duration, videoTrackCount, audioTrackCount }
//   * selection: { clips: [{ trackIndex, clipIndex, name, start, end, duration }] }
//   * inOut:     { start, end, hasMarks } | null
//
// The panel combines this with the current Scope-mode dropdown to render a
// single meaningful line (e.g. "copy_AAD3F14E… · Clip · 0:12"). Only video
// track selections are reported — audio-only selections are uncommon and the
// analysis resolver handles them via its own code path.
// ═══════════════════════════════════════════════════════════════════════════
function getScopeInfo() {
  try {
    if (!app.project || !app.project.activeSequence) {
      return jsonStringify({ error: "No active sequence. Open one in the Timeline." });
    }
    var seq = app.project.activeSequence;
    var vCount = seq.videoTracks ? seq.videoTracks.numTracks : 0;
    var aCount = seq.audioTracks ? seq.audioTracks.numTracks : 0;
    var seqEnd = safeSeconds(seq.end);

    // Gather selected VIDEO track items.
    //
    // v9.10: we now use `clip.isSelected()` exclusively as the source of
    // truth. The previous two-strategy union had a nasty bug on stacked
    // duplicates: `seq.getSelection()` returns TrackItems without a track
    // index, so the code fell back to matching by (start + end + name).
    // With three identical copies of a clip on V1/V2/V3, that fallback
    // would resolve V2's selected item to V1's first-matching clip, then
    // `isSelected()` would also record V2, producing a spurious "2 clips
    // selected" count. Dropping the bounds-match eliminates the
    // ambiguity: every track/clip is asked directly whether it's
    // selected, so stacked duplicates report exactly one selection.
    var selMap = {};
    var selClips = [];
    var debugStrategy = "isSelected";

    function recordSelection(trackIndex, clipIndex, clip) {
      var key = trackIndex + ":" + clipIndex;
      if (selMap[key]) return;
      selMap[key] = true;
      var startS = safeSeconds(clip.start);
      var endS   = safeSeconds(clip.end);
      selClips.push({
        trackIndex: trackIndex,
        clipIndex:  clipIndex,
        name:       String(clip.name || ""),
        start:      startS,
        end:        endS,
        duration:   Math.max(0, endS - startS)
      });
    }

    for (var t = 0; t < vCount; t++) {
      var track = seq.videoTracks[t];
      if (!track || !track.clips) continue;
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        try {
          if (clip.isSelected && clip.isSelected()) {
            recordSelection(t, c, clip);
          }
        } catch (eSel) {}
      }
    }

    // I/O marks — Premiere reports 0 / endS when unset, which we treat as
    // "no marks". Gate everything in a try block because older builds don't
    // expose getInPoint/getOutPoint.
    var inOut = null;
    try {
      if (seq.getInPoint && seq.getOutPoint) {
        var inS  = safeSeconds(seq.getInPoint());
        var outS = safeSeconds(seq.getOutPoint());
        var hasMarks = !(inS <= 0.0005 && Math.abs(outS - seqEnd) <= 0.0005);
        inOut = { start: inS, end: outS, hasMarks: hasMarks };
      }
    } catch (eIO) {}

    return jsonStringify({
      sequence: {
        name: String(seq.name || ""),
        duration: seqEnd,
        videoTrackCount: vCount,
        audioTrackCount: aCount
      },
      selection: { clips: selClips, strategy: debugStrategy },
      inOut: inOut
    });
  } catch (e) {
    return jsonStringify({ error: "getScopeInfo: " + String(e.message || e) });
  }
}

// Rename the current Scope target (single clip OR sequence).
// Payload shapes:
//   { target: "clip", trackIndex: n, clipIndex: n, name: "new" }
//   { target: "sequence", name: "new" }
// Returns the name Premiere actually accepted so the panel can sync its input.
function renameScopeTarget(payloadJSON) {
  try {
    if (!payloadJSON) return jsonStringify({ error: "No payload" });
    var p;
    try { p = eval("(" + payloadJSON + ")"); }
    catch (e) { return jsonStringify({ error: "Bad payload: " + e }); }

    var newName = String((p && p.name) || "").replace(/^\s+|\s+$/g, "");
    if (!newName) return jsonStringify({ error: "Empty name" });

    if (!app.project || !app.project.activeSequence) {
      return jsonStringify({ error: "No active sequence" });
    }
    var seq = app.project.activeSequence;

    if (p.target === "clip") {
      var ti = parseInt(p.trackIndex, 10);
      var ci = parseInt(p.clipIndex,  10);
      if (isNaN(ti) || isNaN(ci)) return jsonStringify({ error: "Bad track/clip index" });
      var track = seq.videoTracks[ti];
      if (!track || !track.clips) return jsonStringify({ error: "Track not found" });
      var clip = track.clips[ci];
      if (!clip) return jsonStringify({ error: "Clip not found" });

      // Prefer renaming the track-item instance (this clip only). Fall back
      // to projectItem.name only if Premiere refuses — projectItem renaming
      // rewrites the bin entry and affects every instance, which is louder
      // than what users expect from an inline timeline rename.
      var applied = null;
      try { clip.name = newName; applied = "trackItem"; } catch (eTrack) {}
      if (!applied) {
        try {
          if (clip.projectItem) { clip.projectItem.name = newName; applied = "projectItem"; }
        } catch (ePI) {}
      }
      if (!applied) return jsonStringify({ error: "Premiere refused the rename on this version" });
      return jsonStringify({ success: true, target: "clip", method: applied, name: String(clip.name || newName) });
    }

    // Default target = sequence.
    try { seq.name = newName; }
    catch (eSet) { return jsonStringify({ error: "seq.name= failed: " + eSet }); }
    return jsonStringify({ success: true, target: "sequence", name: String(seq.name || newName) });
  } catch (e) {
    return jsonStringify({ error: "renameScopeTarget: " + String(e.message || e) });
  }
}

function getTrackInfo() {
  try {
    if (!app.project || !app.project.activeSequence) {
      return jsonStringify({ error: "No active sequence" });
    }
    var seq = app.project.activeSequence;
    var tracks = [];
    for (var i = 0; i < seq.videoTracks.numTracks; i++) {
      var vt = seq.videoTracks[i];
      tracks.push({
        index: i,
        name: "V" + (i + 1),
        clipCount: (vt && vt.clips) ? vt.clips.numItems : 0
      });
    }
    return jsonStringify({ tracks: tracks });
  } catch (e) {
    return jsonStringify({ error: "getTrackInfo: " + String(e.message || e) });
  }
}

/**
 * Return media-file paths for clips on the specified video track.
 * If no track specified, returns paths for all tracks.
 * Panel uses these paths to read + analyze the audio directly.
 */
function getSourceMediaPaths(trackIndexArg) {
  try {
    if (!app.project || !app.project.activeSequence) {
      return jsonStringify({ error: "No active sequence" });
    }
    var seq   = app.project.activeSequence;
    var paths = [];
    var seen  = {};
    var wantedTrack = (trackIndexArg === undefined || trackIndexArg === null || trackIndexArg === "")
      ? -1 : parseInt(trackIndexArg);

    // Video tracks first (video files usually have the embedded audio)
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      if (wantedTrack !== -1 && v !== wantedTrack) continue;
      var vt = seq.videoTracks[v];
      if (!vt || !vt.clips) continue;
      for (var c = 0; c < vt.clips.numItems; c++) {
        var clip = vt.clips[c];
        try {
          if (clip.projectItem) {
            var mp = String(clip.projectItem.getMediaPath() || "");
            if (mp && !seen[mp]) {
              seen[mp] = true;
              paths.push({
                path: mp,
                clipName: String(clip.name || ""),
                trackIndex: v,
                trackType: "video",
                start: safeSeconds(clip.start),
                end:   safeSeconds(clip.end),
                duration: safeSeconds(clip.end) - safeSeconds(clip.start),
                inPoint:  safeSeconds(clip.inPoint),
                outPoint: safeSeconds(clip.outPoint)
              });
            }
          }
        } catch (e) {}
      }
    }

    // If nothing found on video, fall back to audio tracks
    if (paths.length === 0) {
      for (var a = 0; a < seq.audioTracks.numTracks; a++) {
        var at = seq.audioTracks[a];
        if (!at || !at.clips) continue;
        for (var ac = 0; ac < at.clips.numItems; ac++) {
          var aclip = at.clips[ac];
          try {
            if (aclip.projectItem) {
              var amp = String(aclip.projectItem.getMediaPath() || "");
              if (amp && !seen[amp]) {
                seen[amp] = true;
                paths.push({
                  path: amp,
                  clipName: String(aclip.name || ""),
                  trackIndex: a,
                  trackType: "audio",
                  start: safeSeconds(aclip.start),
                  end:   safeSeconds(aclip.end),
                  duration: safeSeconds(aclip.end) - safeSeconds(aclip.start),
                  inPoint:  safeSeconds(aclip.inPoint),
                  outPoint: safeSeconds(aclip.outPoint)
                });
              }
            }
          } catch (e) {}
        }
      }
    }

    return jsonStringify({ paths: paths });
  } catch (e) {
    return jsonStringify({ error: "getSourceMediaPaths: " + String(e.message || e) });
  }
}

function getAudioClipInfo() {
  try {
    if (!app.project || !app.project.activeSequence) {
      return jsonStringify({ error: "No active sequence" });
    }
    var seq = app.project.activeSequence;
    var clips = [];
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var track = seq.audioTracks[t];
      if (!track || !track.clips) continue;
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        var mp = "";
        try { if (clip.projectItem) mp = String(clip.projectItem.getMediaPath() || ""); } catch (e) {}
        clips.push({
          trackIndex: t, clipIndex: c,
          name: String(clip.name || ""),
          start: safeSeconds(clip.start),
          end:   safeSeconds(clip.end),
          duration: safeSeconds(clip.duration),
          mediaPath: mp
        });
      }
    }
    return jsonStringify({ clips: clips });
  } catch (e) {
    return jsonStringify({ error: "getAudioClipInfo: " + String(e.message || e) });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALYSIS PLAN RESOLVER (v9)
//
// Given a scope mode + audio-source preference, figures out:
//   1. Time bounds in sequence time (startSec, endSec)
//   2. Which audio to read (track index + "video" or "audio" family)
//   3. Which source-media clips overlap the bounds (with per-clip seq offsets
//      so the panel can map region seconds back and forth)
//
// Input JSON:
//   { scope: "smart"|"entire"|"selected"|"inout", audioSource: "auto"|"v0"|"a0"|"a1"... }
//
// Output JSON:
//   { ok:true,
//     scope:    { mode, resolvedMode, startSec, endSec, description },
//     audio:    { mode, resolvedKind, resolvedTrackIndex, trackLabel, reason },
//     clips:    [{ mediaPath, clipName, seqStartSec, seqEndSec,
//                  inPointSec, outPointSec, trackKind, trackIndex }] }
// ═══════════════════════════════════════════════════════════════════════════

// Returns the currently-selected clips across all tracks; empty array if none.
function collectSelectedClips(seq) {
  var out = [];
  function consider(clip, kind, idx) {
    try {
      if (clip && clip.isSelected && clip.isSelected()) {
        out.push({ clip: clip, kind: kind, trackIndex: idx });
      }
    } catch (e) {}
  }
  try {
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      var vt = seq.videoTracks[v];
      if (!vt || !vt.clips) continue;
      for (var c = 0; c < vt.clips.numItems; c++) consider(vt.clips[c], "video", v);
    }
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
      var at = seq.audioTracks[a];
      if (!at || !at.clips) continue;
      for (var ac = 0; ac < at.clips.numItems; ac++) consider(at.clips[ac], "audio", a);
    }
  } catch (e) {}
  return out;
}

// Given a sequence and a TrackItem, return {kind, index} of the track that
// hosts that clip, or null if not found. Uses identity comparison.
function findClipTrack(seq, targetClip) {
  try {
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
      var vt = seq.videoTracks[v];
      if (!vt || !vt.clips) continue;
      for (var c = 0; c < vt.clips.numItems; c++) {
        if (vt.clips[c] === targetClip) return { kind: "video", index: v };
      }
    }
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
      var at = seq.audioTracks[a];
      if (!at || !at.clips) continue;
      for (var ac = 0; ac < at.clips.numItems; ac++) {
        if (at.clips[ac] === targetClip) return { kind: "audio", index: a };
      }
    }
  } catch (e) {}
  return null;
}

// Resolve which video + audio tracks SmartCut should actually touch given
// the current selection.
//
// v9.14 policy (strict linked-only):
//   - The video target is the selected video clip's track.
//   - The audio targets are ONLY the tracks whose LINKED audio clips
//     (via clip.getLinkedItems()) cover >=50% of the selected video
//     clip's duration. The coverage filter rejects stale / fragment-sized
//     "links" that Premiere sometimes reports across unrelated tracks.
//   - If nothing qualifies (e.g., the user unlinked their video from
//     audio), we return an empty audio target set. The client surfaces
//     this as a warning so the user can re-link before applying cuts.
//
// This lets non-standard pairings work (V1 linked to A2 is fine, as long
// as they're actually linked in Premiere), while refusing to silently
// touch the "wrong" audio track.
//
// Multiple selected video clips: we pick the longest as the primary.
// Single-clip mode in the UI should prevent this anyway.
function resolveTargetTracksFromSelection(seq) {
  var sel = collectSelectedClips(seq);
  if (!sel || sel.length === 0) return null;

  // Find the primary selected video clip (longest = most content).
  var primaryV = null;
  var longestDur = -1;
  for (var i = 0; i < sel.length; i++) {
    if (sel[i].kind !== "video") continue;
    var cStart = safeSeconds(sel[i].clip.start);
    var cEnd   = safeSeconds(sel[i].clip.end);
    var dur    = cEnd - cStart;
    if (dur > longestDur) {
      primaryV = sel[i];
      longestDur = dur;
    }
  }

  var videoSet = {}, audioSet = {};

  // If no video clip is selected, operate on just the audio tracks that
  // were actually clicked. Rare audio-only path.
  if (!primaryV) {
    for (var j = 0; j < sel.length; j++) {
      if (sel[j].kind === "audio") audioSet[sel[j].trackIndex] = true;
    }
  } else {
    videoSet[primaryV.trackIndex] = true;

    var vStart = safeSeconds(primaryV.clip.start);
    var vEnd   = safeSeconds(primaryV.clip.end);
    var vDur   = Math.max(0.01, vEnd - vStart);

    var coverage = {};
    try {
      if (primaryV.clip && typeof primaryV.clip.getLinkedItems === "function") {
        var linked = primaryV.clip.getLinkedItems();
        if (linked && linked.numItems) {
          for (var li = 0; li < linked.numItems; li++) {
            var lc = linked[li];
            var loc = findClipTrack(seq, lc);
            if (!loc || loc.kind !== "audio") continue;
            var ls = safeSeconds(lc.start);
            var le = safeSeconds(lc.end);
            var oS = Math.max(ls, vStart);
            var oE = Math.min(le, vEnd);
            var overlap = Math.max(0, oE - oS);
            if (overlap > 0) {
              coverage[loc.index] = (coverage[loc.index] || 0) + overlap;
            }
          }
        }
      }
    } catch (eLink) {}

    // Only qualify tracks whose linked audio covers a big chunk of the
    // video clip. Stale / fragment-sized links are rejected.
    for (var ti in coverage) {
      if (!coverage.hasOwnProperty(ti)) continue;
      if (coverage[ti] / vDur >= 0.5) {
        audioSet[parseInt(ti, 10)] = true;
      }
    }
    // No same-index fallback by design: if the user unlinked V/A, they
    // need to re-link (Clip > Link) so SmartCut knows which audio to cut.
  }

  var videoArr = [], audioArr = [];
  for (var kv in videoSet) if (videoSet.hasOwnProperty(kv)) videoArr.push(parseInt(kv, 10));
  for (var ka in audioSet) if (audioSet.hasOwnProperty(ka)) audioArr.push(parseInt(ka, 10));
  videoArr.sort(function (a, b) { return a - b; });
  audioArr.sort(function (a, b) { return a - b; });
  return { video: videoArr, audio: audioArr };
}

// Returns [startSec, endSec] of Premiere's In/Out marks, or null if not set.
function readInOutRange(seq) {
  try {
    var inS  = safeSeconds(seq.getInPoint  ? seq.getInPoint()  : seq.zeroPoint);
    var outS = safeSeconds(seq.getOutPoint ? seq.getOutPoint() : seq.end);
    var endS = safeSeconds(seq.end);
    if (outS > inS && !(inS <= 0.001 && Math.abs(outS - endS) < 0.01)) {
      return [inS, outS];
    }
  } catch (e) {}
  return null;
}

// Sum of clip durations on a given track within [s,e]. Used for auto-picking
// the "primary" audio track — the one with the most coverage is usually the
// mic recording.
function trackCoverageWithin(track, s, e) {
  if (!track || !track.clips) return 0;
  var total = 0;
  for (var c = 0; c < track.clips.numItems; c++) {
    try {
      var clip = track.clips[c];
      var cs = safeSeconds(clip.start);
      var ce = safeSeconds(clip.end);
      var overlap = Math.min(ce, e) - Math.max(cs, s);
      if (overlap > 0) total += overlap;
    } catch (eX) {}
  }
  return total;
}

// Iterate all clips on a given track and return those overlapping [s,e].
function collectClipsOnTrack(track, kind, trackIndex, s, e) {
  var out = [];
  if (!track || !track.clips) return out;
  for (var c = 0; c < track.clips.numItems; c++) {
    try {
      var clip = track.clips[c];
      var cs = safeSeconds(clip.start);
      var ce = safeSeconds(clip.end);
      if (ce <= s + 0.001 || cs >= e - 0.001) continue;
      if (!clip.projectItem) continue;
      var mp = String(clip.projectItem.getMediaPath() || "");
      if (!mp) continue;
      out.push({
        mediaPath:   mp,
        clipName:    String(clip.name || ""),
        seqStartSec: cs,
        seqEndSec:   ce,
        inPointSec:  safeSeconds(clip.inPoint),
        outPointSec: safeSeconds(clip.outPoint),
        trackKind:   kind,
        trackIndex:  trackIndex
      });
    } catch (eX) {}
  }
  return out;
}

function resolveAnalysisPlan(payloadJSON) {
  try {
    if (!app.project || !app.project.activeSequence) {
      return jsonStringify({ ok: false, error: "No active sequence" });
    }
    var seq   = app.project.activeSequence;
    var seqEnd = safeSeconds(seq.end);

    var payload = {};
    if (payloadJSON && payloadJSON !== "undefined" && payloadJSON !== "null") {
      try { payload = eval("(" + payloadJSON + ")"); } catch (e) { payload = {}; }
    }
    var scopeMode  = String(payload.scope       || "smart").toLowerCase();
    var audioMode  = String(payload.audioSource || "auto" ).toLowerCase();

    // ── 1. Time bounds ────────────────────────────────────────────────────
    var startSec = 0, endSec = seqEnd;
    var resolvedScope = scopeMode;
    var scopeDesc = "";

    // v9.5: selection-only scope model. The panel always sends "smart".
    // Legacy values ("selected", "inout", "entire") are accepted for
    // backwards compatibility but collapse into the same rule: if clips
    // are selected, use those clips' bounds; otherwise, use the entire
    // sequence. (In/Out ranges are no longer a scope source.)
    var sel = collectSelectedClips(seq);
    if (sel.length > 0) {
      var minS = Infinity, maxS = -Infinity;
      for (var i = 0; i < sel.length; i++) {
        var cs = safeSeconds(sel[i].clip.start);
        var ce = safeSeconds(sel[i].clip.end);
        if (cs < minS) minS = cs;
        if (ce > maxS) maxS = ce;
      }
      startSec = minS; endSec = maxS;
      resolvedScope = "selected";
      scopeDesc = sel.length + " selected clip" + (sel.length !== 1 ? "s" : "");
    } else {
      startSec = 0; endSec = seqEnd;
      resolvedScope = "entire";
      scopeDesc = "entire sequence";
    }

    if (endSec - startSec < 0.1) {
      return jsonStringify({ ok: false, error: "Scope is too short (< 100ms)." });
    }

    // ── 2. Audio source ──────────────────────────────────────────────────
    // Strategy: within the chosen bounds, pick the track with the highest
    // clip coverage. Prefer dedicated audio tracks over embedded video audio
    // (better signal-to-noise for pro recordings). Fall back to V1 embedded.
    var audioKind       = "video";   // "video" (embedded on video track) or "audio"
    var audioTrackIndex = 0;
    var audioReason     = "";

    function pickAudioAuto() {
      var bestA = -1, bestACoverage = 0;
      for (var a = 0; a < seq.audioTracks.numTracks; a++) {
        var cov = trackCoverageWithin(seq.audioTracks[a], startSec, endSec);
        if (cov > bestACoverage) { bestACoverage = cov; bestA = a; }
      }
      var bestV = -1, bestVCoverage = 0;
      for (var v = 0; v < seq.videoTracks.numTracks; v++) {
        var covV = trackCoverageWithin(seq.videoTracks[v], startSec, endSec);
        if (covV > bestVCoverage) { bestVCoverage = covV; bestV = v; }
      }
      // Prefer audio track if it has any signal, otherwise fall back to video.
      if (bestA >= 0 && bestACoverage > 0.5) {
        return { kind: "audio", index: bestA,
          reason: "A" + (bestA + 1) + " has most audio coverage (" + bestACoverage.toFixed(1) + "s)" };
      }
      if (bestV >= 0) {
        return { kind: "video", index: bestV,
          reason: "V" + (bestV + 1) + " embedded audio (no dedicated audio track with content)" };
      }
      return { kind: "video", index: 0, reason: "fallback: V1 embedded" };
    }

    if (audioMode === "auto" || audioMode === "") {
      var picked = pickAudioAuto();
      audioKind = picked.kind; audioTrackIndex = picked.index; audioReason = picked.reason;
    } else if (audioMode.charAt(0) === "v") {
      audioKind = "video";
      audioTrackIndex = parseInt(audioMode.substring(1), 10) || 0;
      audioReason = "user-selected V" + (audioTrackIndex + 1);
    } else if (audioMode.charAt(0) === "a") {
      audioKind = "audio";
      audioTrackIndex = parseInt(audioMode.substring(1), 10) || 0;
      audioReason = "user-selected A" + (audioTrackIndex + 1);
    } else {
      var picked2 = pickAudioAuto();
      audioKind = picked2.kind; audioTrackIndex = picked2.index;
      audioReason = "unrecognized audioSource '" + audioMode + "' → " + picked2.reason;
    }

    // Safety check: requested track must exist
    var trackFamily = audioKind === "audio" ? seq.audioTracks : seq.videoTracks;
    if (!trackFamily || audioTrackIndex >= trackFamily.numTracks) {
      return jsonStringify({
        ok: false,
        error: "Audio source track does not exist: " +
               (audioKind === "audio" ? "A" : "V") + (audioTrackIndex + 1)
      });
    }

    // ── 3. Collect concrete clips on the chosen audio source within bounds ─
    var track = trackFamily[audioTrackIndex];
    var clips = collectClipsOnTrack(track, audioKind, audioTrackIndex, startSec, endSec);

    if (clips.length === 0) {
      return jsonStringify({
        ok: false,
        error: "No clips with media on " +
          (audioKind === "audio" ? "A" : "V") + (audioTrackIndex + 1) +
          " within " + scopeDesc + "."
      });
    }

    // Sort by sequence time so the panel processes left-to-right.
    clips.sort(function (a, b) { return a.seqStartSec - b.seqStartSec; });

    var trackLabel = (audioKind === "audio" ? "A" : "V") + (audioTrackIndex + 1);

    // v9.9: figure out which tracks the cut phase should actually touch.
    // Derived from the current selection + each selected clip's linked
    // items. Null means "no selection → no restriction". The client passes
    // this straight back into applyCuts() so PHASE 1/2 can skip untouched
    // tracks.
    var targetTracks = resolveTargetTracksFromSelection(seq);

    return jsonStringify({
      ok: true,
      scope: {
        mode:         scopeMode,
        resolvedMode: resolvedScope,
        startSec:     startSec,
        endSec:       endSec,
        description:  scopeDesc
      },
      audio: {
        mode:                audioMode,
        resolvedKind:        audioKind,
        resolvedTrackIndex:  audioTrackIndex,
        trackLabel:          trackLabel,
        reason:              audioReason
      },
      clips:        clips,
      targetTracks: targetTracks
    });

  } catch (eTop) {
    return jsonStringify({ ok: false, error: "resolveAnalysisPlan: " + String(eTop.message || eTop) });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE CUTTING ENGINE (v8)
//
// Input payload:
//   {
//     regions: [ { startSeconds, endSeconds, ... }, ... ],   // silence regions
//     paddingMs: 0,                                          // contract region
//     videoTrackIndex: 0,                                    // 0-based
//     relink: true                                           // optional
//   }
//
// Algorithm:
//   1. Enable QE. Fail loudly if qe.project.getActiveSequence() is null
//      (timeline panel does not have focus).
//   2. Build the list of cut-times from regions (startSeconds + paddingSec,
//      endSeconds - paddingSec). Dedupe + sort DESCENDING.
//   3. For each cut-time (from latest → earliest), seek the playhead, grab the
//      CTI timecode, then razor ALL video + audio tracks at that timecode.
//   4. After razoring, scan the target video track and remove every clip whose
//      [start,end] falls inside one of the silence regions (with EPSILON
//      tolerance). Ripple-delete on video propagates audio removal when the
//      clips are linked.
//   5. Also scan audio tracks and remove matching clips (covers detached
//      audio + additional A-tracks).
//   6. Optional: rebuild linking between remaining video/audio clips.
//
// Returns structured JSON for the panel to render.
// ═══════════════════════════════════════════════════════════════════════════

function applyCuts(payloadJSON) {
  logInit();
  log("applyCuts() v9.14 - linked-only audio targets, no same-index fallback");
  log("Premiere version: " + (app.version || "unknown"));

  try {
    // ── Parse ──────────────────────────────────────────────────────────────
    if (!payloadJSON || payloadJSON === "undefined" || payloadJSON === "null") {
      return jsonStringify({ error: "No cut data received", log: _log });
    }
    var payload;
    try { payload = eval("(" + payloadJSON + ")"); }
    catch (e) { return jsonStringify({ error: "Invalid JSON: " + String(e), log: _log }); }

    if (!payload || !payload.regions || payload.regions.length === 0) {
      return jsonStringify({ error: "No regions supplied", log: _log });
    }

    var videoTrackIndex = (typeof payload.videoTrackIndex === "number")
      ? payload.videoTrackIndex : 0;
    var paddingSec = ((payload.paddingMs || 0)) / 1000;
    var crossfadeMs = (typeof payload.crossfadeMs === "number")
      ? Math.max(0, Math.min(100, payload.crossfadeMs)) : 0;
    var doRelink   = (payload.relink !== false);

    // v9 scope bounds: any regions/razors/removes outside this window are
    // ignored. This lets "Selected clips" and "In/Out range" scopes work
    // correctly on multi-clip timelines without touching the rest.
    var scopeStart = (typeof payload.scopeStartSec === "number")
      ? payload.scopeStartSec : -Infinity;
    var scopeEnd   = (typeof payload.scopeEndSec === "number")
      ? payload.scopeEndSec :  Infinity;

    // v9.9: target-track restriction. When the user selects one clip, these
    // arrays contain only that clip's video track + its linked audio track.
    // Any track not in these sets is skipped entirely during razor + remove,
    // so unrelated clips on V1/V3/A1/A3 stay untouched. Null means no
    // restriction (whole-sequence mode; not reachable from current UI).
    var targetVideoTracks = (payload.targetVideoTracks && payload.targetVideoTracks.length)
      ? payload.targetVideoTracks : null;
    var targetAudioTracks = (payload.targetAudioTracks && payload.targetAudioTracks.length)
      ? payload.targetAudioTracks : null;
    var vTargetSet = null, aTargetSet = null;
    if (targetVideoTracks) {
      vTargetSet = {};
      for (var tvi = 0; tvi < targetVideoTracks.length; tvi++) vTargetSet[targetVideoTracks[tvi]] = true;
    }
    if (targetAudioTracks) {
      aTargetSet = {};
      for (var tai = 0; tai < targetAudioTracks.length; tai++) aTargetSet[targetAudioTracks[tai]] = true;
    }
    function _shouldTouchV(idx) { return vTargetSet === null || vTargetSet[idx] === true; }
    function _shouldTouchA(idx) { return aTargetSet === null || aTargetSet[idx] === true; }
    // v9.6: asymmetric padding — word TAILS (fricatives like "s","f","th")
    // fade out slowly and go below the RMS threshold before the word actually
    // ends. Word ONSETS are sharp, so we need less protection on that edge.
    // Previous multipliers (1.5 / 0.6) summed to 2.1× the padding knob,
    // which left ~252ms of dead air on the shortform preset (120ms × 2.1).
    // Softer (1.2 / 0.4) keeps enough safety for fricatives while producing
    // much tighter cut transitions.
    var leadPadSec  = paddingSec * 1.2;
    var tailPadSec  = paddingSec * 0.4;

    log("Primary video track: V" + (videoTrackIndex + 1));
    log("Regions: " + payload.regions.length);
    log("Padding: " + (payload.paddingMs || 0) + "ms  (lead=" +
        Math.round(leadPadSec * 1000) + "ms, tail=" +
        Math.round(tailPadSec * 1000) + "ms)");
    log("Scope: " + (isFinite(scopeStart) ? scopeStart.toFixed(3) : "-inf") + "s " +
        "to " + (isFinite(scopeEnd) ? scopeEnd.toFixed(3) : "+inf") + "s");
    log("Target video tracks: " + (targetVideoTracks ? targetVideoTracks.join(",") : "all"));
    log("Target audio tracks: " + (targetAudioTracks ? targetAudioTracks.join(",") : "all"));

    // ── Validate sequence ──────────────────────────────────────────────────
    if (!app.project || !app.project.activeSequence) {
      return jsonStringify({ error: "No active sequence", log: _log });
    }
    var seq = app.project.activeSequence;
    var fps = getSequenceFPS(seq);
    log("Sequence: '" + seq.name + "' fps=" + fps +
        " dur=" + safeSeconds(seq.end).toFixed(3) + "s");

    if (videoTrackIndex < 0 || videoTrackIndex >= seq.videoTracks.numTracks) {
      return jsonStringify({
        error: "Video track V" + (videoTrackIndex + 1) + " does not exist",
        log: _log
      });
    }
    var vTrack = seq.videoTracks[videoTrackIndex];
    var clipCountBefore = vTrack.clips.numItems;
    log("V" + (videoTrackIndex + 1) + " (primary/audio source) clips before: " + clipCountBefore);

    for (var ci = 0; ci < vTrack.clips.numItems; ci++) {
      try {
        var dc = vTrack.clips[ci];
        log("  [" + ci + "] '" + dc.name + "' " +
            safeSeconds(dc.start).toFixed(3) + "-" + safeSeconds(dc.end).toFixed(3));
      } catch (e) {}
    }

    // v9.10: snapshot clip counts across every TARGET video track so the
    // post-razor sanity check below sees the tracks that actually got cut.
    // Previously we only tracked `vTrack` (= the "primary" videoTrackIndex,
    // typically V1, which is the track we pulled audio from for analysis).
    // When the user selects a clip on V2 or V3, razor skips V1 entirely -
    // so V1's clip count stays the same and the check falsely concludes
    // "razor had no effect" and aborts before PHASE 2 (remove silences).
    // Result: cuts were visible on V2/V3 but the dead space was never
    // removed, because the ripple-delete phase never ran.
    var vTargetCountsBefore = {};
    var vCountAll = seq.videoTracks.numTracks;
    for (var vtbi = 0; vtbi < vCountAll; vtbi++) {
      if (!_shouldTouchV(vtbi)) continue;
      try { vTargetCountsBefore[vtbi] = seq.videoTracks[vtbi].clips.numItems; }
      catch (eCnt) { vTargetCountsBefore[vtbi] = -1; }
    }

    // v9.12: dump every clip on every target video track (not just the
    // "primary" track). Prior logs showed only V1's state, which is
    // useless when the user is cutting V3 - we couldn't see whether V3
    // was in the expected state going into Phase 1. With this we can
    // diagnose "regions didn't match anything" bugs quickly: if V3 has
    // 61 clips from a previous run, it's obvious why the new regions
    // (expecting one big clip spanning the scope) don't line up.
    for (var tli = 0; tli < vCountAll; tli++) {
      if (!_shouldTouchV(tli)) continue;
      if (tli === videoTrackIndex) continue; // already dumped above
      var tgtTrack = null;
      try { tgtTrack = seq.videoTracks[tli]; } catch (eT) {}
      if (!tgtTrack) continue;
      var tgtCount = tgtTrack.clips ? tgtTrack.clips.numItems : 0;
      log("V" + (tli + 1) + " (target) clips before: " + tgtCount);
      var dumpMax = tgtCount > 12 ? 12 : tgtCount;
      for (var tci = 0; tci < dumpMax; tci++) {
        try {
          var tgc = tgtTrack.clips[tci];
          log("  [" + tci + "] '" + tgc.name + "' " +
              safeSeconds(tgc.start).toFixed(3) + "-" +
              safeSeconds(tgc.end).toFixed(3));
        } catch (eTC) {}
      }
      if (tgtCount > dumpMax) log("  ... (" + (tgtCount - dumpMax) + " more clips)");
    }

    // ── Prepare regions: apply padding, clamp to scope, filter empty ──────
    var regions = [];
    var skippedOutOfScope = 0;
    for (var ri = 0; ri < payload.regions.length; ri++) {
      var r = payload.regions[ri];
      var s = r.startSeconds + leadPadSec;
      var e = r.endSeconds   - tailPadSec;

      // Clamp to scope window. A region entirely outside scope is discarded.
      if (e <= scopeStart || s >= scopeEnd) {
        skippedOutOfScope++;
        continue;
      }
      if (s < scopeStart) s = scopeStart;
      if (e > scopeEnd)   e = scopeEnd;

      if (e - s >= 0.05) {
        regions.push({ start: s, end: e, origIndex: ri });
      } else {
        log("Region " + ri + " skipped (too short after padding/clamp): " +
            r.startSeconds.toFixed(3) + "–" + r.endSeconds.toFixed(3));
      }
    }
    if (skippedOutOfScope > 0) log("Regions skipped (out of scope): " + skippedOutOfScope);
    regions.sort(function (a, b) { return b.start - a.start; });
    if (regions.length === 0) {
      return jsonStringify({ error: "All regions too short after padding", log: _log });
    }
    log("Regions queued: " + regions.length);

    // ── Build deduped cut-time list (END→START) ────────────────────────────
    var cutTimes = [];
    var seen = {};
    for (var rg = 0; rg < regions.length; rg++) {
      var cs = regions[rg].start, ce = regions[rg].end;
      // push end first so order is naturally descending
      if (!seen[ce.toFixed(4)]) { cutTimes.push(ce); seen[ce.toFixed(4)] = true; }
      if (!seen[cs.toFixed(4)]) { cutTimes.push(cs); seen[cs.toFixed(4)] = true; }
    }
    cutTimes.sort(function (a, b) { return b - a; });
    log("Unique cut times: " + cutTimes.length);

    // ── Enable QE DOM ──────────────────────────────────────────────────────
    log("");
    log("═══ PHASE 1: RAZOR ═══");
    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) {
      return jsonStringify({
        error: "QE sequence is null — click on the Timeline panel first, then retry.",
        log: _log
      });
    }
    log("QE sequence OK");

    var razorCount = 0;
    var razorErrors = [];

    for (var t = 0; t < cutTimes.length; t++) {
      var seconds = cutTimes[t];
      var tc;
      try {
        tc = seekAndGetCTITimecode(seq, qeSeq, seconds);
      } catch (seekErr) {
        log("  seek failed at " + seconds.toFixed(3) + "s: " + seekErr);
        razorErrors.push("seek@" + seconds.toFixed(3) + ": " + String(seekErr));
        continue;
      }

      log("Razor @ " + seconds.toFixed(3) + "s  tc=" + tc);

      // Video tracks — razor only on tracks in the target set.
      for (var vi = 0; vi < qeSeq.numVideoTracks; vi++) {
        if (!_shouldTouchV(vi)) continue;
        try {
          var qv = qeSeq.getVideoTrackAt(vi);
          if (qv) { qv.razor(tc); razorCount++; }
        } catch (ev) {
          razorErrors.push("V" + (vi + 1) + "@" + tc + ": " + String(ev));
        }
      }
      // Audio tracks — razor only on tracks in the target set.
      for (var ai = 0; ai < qeSeq.numAudioTracks; ai++) {
        if (!_shouldTouchA(ai)) continue;
        try {
          var qa = qeSeq.getAudioTrackAt(ai);
          if (qa) { qa.razor(tc); razorCount++; }
        } catch (ea) {
          razorErrors.push("A" + (ai + 1) + "@" + tc + ": " + String(ea));
        }
      }
    }

    var clipCountAfterRazor = vTrack.clips.numItems;
    log("Razor calls: " + razorCount +
        "  |  V" + (videoTrackIndex + 1) + " clips: " + clipCountBefore +
        " → " + clipCountAfterRazor +
        "  |  errors: " + razorErrors.length);

    // v9.10: evaluate razor effectiveness across every TARGET track, not
    // just the primary videoTrackIndex. The primary track (V1) is where
    // audio analysis pulled its waveform from; the TARGET tracks are
    // where cuts are actually applied (often V2/V3 when the user selects
    // a clip on a stacked layer). If we only checked the primary, razor
    // could succeed on V2 while V1 stayed untouched and we'd incorrectly
    // abort.
    var razorDidCut = false;
    var razorTargetDetails = [];
    for (var vtci in vTargetCountsBefore) {
      if (!vTargetCountsBefore.hasOwnProperty(vtci)) continue;
      var idx = parseInt(vtci, 10);
      var before = vTargetCountsBefore[vtci];
      var after  = -1;
      try { after = seq.videoTracks[idx].clips.numItems; } catch (eCntA) {}
      razorTargetDetails.push("V" + (idx + 1) + ": " + before + "→" + after);
      if (before >= 0 && after > before) razorDidCut = true;
    }
    log("Target-track razor effect: " + razorTargetDetails.join(", "));

    if (!razorDidCut) {
      writeLogFile();
      return jsonStringify({
        success: false,
        cutsApplied: 0,
        totalRegions: payload.regions.length,
        clipCountBefore: clipCountBefore,
        clipCountAfterRazor: clipCountAfterRazor,
        razorCount: razorCount,
        razorErrors: razorErrors,
        razorTargetDetails: razorTargetDetails,
        method: "CTI razor",
        error: "Razor had no effect on the selected clip's track. " +
               "Click on the Timeline panel first, then retry.",
        logPath: _logPath,
        log: _log
      });
    }

    // ── PHASE 2: ripple-delete silence clips, per-track ────────────────────
    //
    // v9.5 — back to the v7-proven approach: walk EVERY video and audio
    // track independently and ripple-delete the clip matching each silence
    // region. This is robust to Premiere's sync-lock state:
    //   - Sync lock ON:  first ripple shifts linked tracks, subsequent
    //                    per-track passes find nothing to do (safe no-op).
    //   - Sync lock OFF: each track independently closes its own gap.
    //
    // Regions are processed LATEST-to-EARLIEST so earlier regions' timeline
    // coordinates are not invalidated by ripple shifts at later ones.
    //
    // Safety net: after every region, if NO track ripple-deleted (e.g. the
    // clip was locked), we fall back to a manual gap-close across all
    // tracks so the timeline still tightens.
    log("");
    log("═══ PHASE 2: REMOVE CLIPS (per-track ripple) ═══");

    var removedVideo    = 0;
    var removedAudio    = 0;
    var removeErrors    = [];
    var rippleSucceeded = 0;
    var rippleFellBack  = 0;

    // Find and remove the clip on `track` whose bounds match [reg.start,
    // reg.end]. Prefers exact match, falls back to "clip fully contained in
    // region". Walks from last to first so indices stay valid. Attempts
    // ripple delete first; if Premiere refuses, falls back to non-ripple.
    function removeMatchingClipOnTrack(track, reg, label) {
      if (!track || !track.clips) return { removed: false, rippled: false };
      // Pass 1: exact match
      for (var k = track.clips.numItems - 1; k >= 0; k--) {
        try {
          var clip = track.clips[k];
          var cs = safeSeconds(clip.start);
          var ce = safeSeconds(clip.end);
          if (ce <= scopeStart || cs >= scopeEnd) continue;
          if (Math.abs(cs - reg.start) < EPSILON_SEC &&
              Math.abs(ce - reg.end)   < EPSILON_SEC) {
            return _doRemove(clip, cs, ce, k, label, reg, "exact");
          }
        } catch (e) {}
      }
      // Pass 2: contained match (clip fully inside region)
      for (var k2 = track.clips.numItems - 1; k2 >= 0; k2--) {
        try {
          var clip2 = track.clips[k2];
          var cs2 = safeSeconds(clip2.start);
          var ce2 = safeSeconds(clip2.end);
          if (ce2 <= scopeStart || cs2 >= scopeEnd) continue;
          if (cs2 >= reg.start - EPSILON_SEC &&
              ce2 <= reg.end   + EPSILON_SEC) {
            return _doRemove(clip2, cs2, ce2, k2, label, reg, "contained");
          }
        } catch (e) {}
      }
      return { removed: false, rippled: false };
    }

    function _doRemove(clip, cs, ce, idx, label, reg, matchKind) {
      // v9.8: pass inAlignToVideo=false to BOTH remove() calls. The second
      // param controls whether Premiere auto-shifts the linked A/V partner
      // when we remove this clip. With it on (the v9.5/9.6 default), we
      // ripple V1, Premiere also shifts the linked A1 segment, then our
      // own per-track loop walks A1 and ripples it *again* — double-shift,
      // which shows up as out-of-sync badges like "+1;24;38" on audio
      // clips. Setting it false makes each track self-contained: our code
      // handles every track independently, no hidden linked-clip magic.
      try {
        clip.remove(true, false);
        log("  region[" + reg.origIndex + "] " +
            reg.start.toFixed(3) + "-" + reg.end.toFixed(3) +
            "  " + label + " clip[" + idx + "] " +
            cs.toFixed(3) + "-" + ce.toFixed(3) +
            " [ripple" + (matchKind === "exact" ? "" : ", " + matchKind) + "]");
        return { removed: true, rippled: true };
      } catch (e1) {
        try {
          clip.remove(false, false);
          log("  region[" + reg.origIndex + "] " +
              reg.start.toFixed(3) + "-" + reg.end.toFixed(3) +
              "  " + label + " clip[" + idx + "] " +
              cs.toFixed(3) + "-" + ce.toFixed(3) +
              " [non-ripple fallback]");
          return { removed: true, rippled: false };
        } catch (e2) {
          removeErrors.push(label + " region[" + reg.origIndex + "]: " + String(e2));
          return { removed: false, rippled: false };
        }
      }
    }

    // Manual gap close used only when every track refused ripple. Shifts
    // every clip whose start >= gapEnd on target tracks left by the gap
    // size. v9.13: collect refs first, then move latest-to-earliest so
    // clip reordering mid-loop can't skip or double-process items.
    function closeGapManually(gapStart, gapEnd) {
      var shift = gapEnd - gapStart;
      if (shift <= 0) return 0;
      var moved = 0;
      var doShift = function (tr) {
        if (!tr || !tr.clips) return;
        var toMove = [];
        for (var j = 0; j < tr.clips.numItems; j++) {
          try {
            var c = tr.clips[j];
            var cstart = safeSeconds(c.start);
            if (cstart >= gapEnd - EPSILON_SEC) {
              toMove.push({ clip: c, start: cstart });
            }
          } catch (eClip) {}
        }
        // Process earliest-first. This way any clip we've already moved
        // is behind (leftward of) the next unmoved clip, so Premiere never
        // sees a transient overlap that would reject the move.
        toMove.sort(function (a, b) { return a.start - b.start; });
        for (var m = 0; m < toMove.length; m++) {
          try { toMove[m].clip.move(-shift); moved++; }
          catch (eMove) {
            try {
              var t = new Time();
              t.seconds = toMove[m].start - shift;
              toMove[m].clip.start = t;
              moved++;
            } catch (eSet) {}
          }
        }
      };
      for (var v = 0; v < seq.videoTracks.numTracks; v++) {
        if (!_shouldTouchV(v)) continue;
        doShift(seq.videoTracks[v]);
      }
      for (var a = 0; a < seq.audioTracks.numTracks; a++) {
        if (!_shouldTouchA(a)) continue;
        doShift(seq.audioTracks[a]);
      }
      return moved;
    }

    // Process regions LATEST-to-EARLIEST.
    //
    // The `regions` array was sorted descending by .start above, so index 0
    // is the LATEST region and index (length-1) is the earliest. Iterating
    // 0 → length-1 therefore processes latest first, which is correct:
    // each ripple shifts later clips left, so we want the later regions
    // handled while their timeline coordinates are still valid, before any
    // earlier ripple invalidates them.
    for (var rg2 = 0; rg2 < regions.length; rg2++) {
      var reg = regions[rg2];
      var anyRipple      = false;
      var removedThisReg = 0;

      for (var vt2 = 0; vt2 < seq.videoTracks.numTracks; vt2++) {
        if (!_shouldTouchV(vt2)) continue;
        var res = removeMatchingClipOnTrack(
          seq.videoTracks[vt2], reg, "V" + (vt2 + 1));
        if (res.removed) { removedVideo++; removedThisReg++; }
        if (res.rippled) anyRipple = true;
      }
      for (var at2 = 0; at2 < seq.audioTracks.numTracks; at2++) {
        if (!_shouldTouchA(at2)) continue;
        var resA = removeMatchingClipOnTrack(
          seq.audioTracks[at2], reg, "A" + (at2 + 1));
        if (resA.removed) { removedAudio++; removedThisReg++; }
        if (resA.rippled) anyRipple = true;
      }

      // Only fire the manual gap-close when we actually removed something
      // non-ripple — there's nothing to close if zero clips were touched.
      // Without this guard, a region that failed to match *anything* would
      // wrongly shift hundreds of clips and create new gaps elsewhere.
      if (anyRipple) {
        rippleSucceeded++;
      } else if (removedThisReg > 0) {
        var movedCount = closeGapManually(reg.start, reg.end);
        if (movedCount > 0) {
          rippleFellBack++;
          log("  region[" + reg.origIndex + "] manual gap-close: shifted " +
              movedCount + " clip(s) left by " +
              (reg.end - reg.start).toFixed(3) + "s");
        }
      } else {
        log("  region[" + reg.origIndex + "] " +
            reg.start.toFixed(3) + "-" + reg.end.toFixed(3) +
            "  no matching clip on any track (skipped)");
      }
    }

    var clipCountFinal = vTrack.clips.numItems;
    log("Removed: video=" + removedVideo + ", audio=" + removedAudio);
    log("Ripple: succeeded=" + rippleSucceeded +
        ", manual-close fallback=" + rippleFellBack);
    log("V" + (videoTrackIndex + 1) + " clips: " +
        clipCountBefore + " -> " + clipCountAfterRazor + " -> " + clipCountFinal);

    // ── PHASE 2B: guaranteed gap-closer (post-ripple safety net) ────────────
    //
    // Premiere 26's `clip.remove(true, false)` call doesn't consistently
    // ripple — sometimes the ExtendScript call returns without throwing
    // (our "rippleSucceeded" counter goes up) but the gap is left in
    // place anyway. The symptom: Phase 2 log shows `Ripple: succeeded=49`,
    // yet the user sees a bunch of dead space on the target track.
    //
    // This phase ignores the ripple-success bookkeeping and instead
    // walks the earliest target video track, finds every gap between
    // consecutive clips inside the scope window, and shifts everything
    // on the target video + audio tracks left to close it. Runs iteratively
    // until there are no more gaps to close.
    log("");
    log("═══ PHASE 2B: GAP-CLOSE SAFETY NET ═══");
    var gapsClosed = 0;
    var anchorV = -1;
    for (var av = 0; av < seq.videoTracks.numTracks; av++) {
      if (_shouldTouchV(av)) { anchorV = av; break; }
    }
    if (anchorV < 0) {
      log("No target video track — skipping gap-close sweep.");
    } else {
      var MAX_GAP_PASSES = 300;
      for (var gp = 0; gp < MAX_GAP_PASSES; gp++) {
        var anchorTrack = seq.videoTracks[anchorV];
        if (!anchorTrack || !anchorTrack.clips || anchorTrack.clips.numItems < 2) break;
        // Collect (start,end) pairs sorted by start time.
        var clipSpans = [];
        for (var cs0 = 0; cs0 < anchorTrack.clips.numItems; cs0++) {
          try {
            var sc = anchorTrack.clips[cs0];
            clipSpans.push({
              start: safeSeconds(sc.start),
              end:   safeSeconds(sc.end)
            });
          } catch (eSp) {}
        }
        clipSpans.sort(function (a, b) { return a.start - b.start; });
        // Find earliest in-scope gap.
        var gapStart = -1, gapEnd = -1;
        for (var gi = 0; gi < clipSpans.length - 1; gi++) {
          var gs = clipSpans[gi].end;
          var ge = clipSpans[gi + 1].start;
          if (ge - gs <= EPSILON_SEC) continue;
          // Only close gaps that lie entirely within the analysis scope.
          // Keeps us from pulling unrelated downstream content leftward.
          if (gs < scopeStart - EPSILON_SEC) continue;
          if (ge > scopeEnd   + EPSILON_SEC) continue;
          gapStart = gs; gapEnd = ge;
          break;
        }
        if (gapStart < 0) break; // no more gaps
        var closedMoved = closeGapManually(gapStart, gapEnd);
        if (closedMoved <= 0) {
          log("  gap " + gapStart.toFixed(3) + "-" + gapEnd.toFixed(3) +
              " : could not shift any clip (stopping sweep)");
          break;
        }
        gapsClosed++;
        log("  closed gap " + gapStart.toFixed(3) + "-" + gapEnd.toFixed(3) +
            " (" + (gapEnd - gapStart).toFixed(3) + "s), shifted " +
            closedMoved + " clip(s)");
      }
      log("Gap-close passes completed. Gaps closed: " + gapsClosed);
    }
    var clipCountAfterGapClose = vTrack.clips.numItems;
    if (gapsClosed > 0) {
      log("V" + (videoTrackIndex + 1) + " clips after gap-close: " + clipCountAfterGapClose);
    }

    // ── PHASE 3: optionally re-link surviving V/A clips by time overlap ────
    var relinkCount = 0;
    if (doRelink && removedVideo > 0) {
      log("");
      log("═══ PHASE 3: RELINK ═══");
      try {
        relinkCount = relinkByOverlap(seq, videoTrackIndex);
        log("Relink pairs: " + relinkCount);
      } catch (eLink) {
        log("Relink error: " + eLink);
      }
    }

    // ── PHASE 4: audio crossfades at cut boundaries (best-effort) ──────────
    // Adds a short "Constant Power" audio transition at each surviving audio
    // clip boundary within the scope window. This prevents the audible click
    // that a hard cut can produce on voice when we slice in the middle of a
    // non-zero-crossing sample. We use QE DOM which is fragile across
    // Premiere versions, so every call is wrapped — a failure here never
    // breaks the cut itself.
    var crossfadeCount = 0;
    if (crossfadeMs > 0 && removedVideo > 0) {
      log("");
      log("═══ PHASE 4: AUDIO CROSSFADES (" + crossfadeMs + "ms) ═══");
      try {
        crossfadeCount = addAudioCrossfades(qeSeq, seq, cutTimes, crossfadeMs, scopeStart, scopeEnd, fps, aTargetSet);
        log("Crossfades added: " + crossfadeCount);
      } catch (eXf) {
        log("Crossfade error (skipped): " + eXf);
      }
    }

    writeLogFile();

    return jsonStringify({
      success: removedVideo > 0,
      cutsApplied: removedVideo,
      audioClipsRemoved: removedAudio,
      totalRegions: payload.regions.length,
      regionsProcessed: regions.length,
      clipCountBefore: clipCountBefore,
      clipCountAfterRazor: clipCountAfterRazor,
      clipCountFinal: clipCountFinal,
      razorCount: razorCount,
      razorErrors: razorErrors,
      removeErrors: removeErrors,
      rippleSucceeded: rippleSucceeded,
      rippleFellBack: rippleFellBack,
      relinkCount: relinkCount,
      crossfadeCount: crossfadeCount,
      method: "CTI razor + per-track ripple delete (v9.9, target-track restriction)",
      logPath: _logPath,
      log: _log
    });

  } catch (fatal) {
    log("FATAL: " + String(fatal.message || fatal));
    writeLogFile();
    return jsonStringify({
      error: "applyCuts fatal: " + String(fatal.message || fatal),
      logPath: _logPath,
      log: _log
    });
  }
}

/**
 * Walk every video clip on videoTrackIndex, find audio clips that overlap
 * its time range across all audio tracks, and linkSelection() them.
 */
function relinkByOverlap(seq, videoTrackIndex) {
  var vTrack = seq.videoTracks[videoTrackIndex];
  if (!vTrack || !vTrack.clips) return 0;

  var linked = 0;
  for (var ci = 0; ci < vTrack.clips.numItems; ci++) {
    try {
      var v = vTrack.clips[ci];
      var vs = safeSeconds(v.start);
      var ve = safeSeconds(v.end);

      var selection = [v];
      for (var ati = 0; ati < seq.audioTracks.numTracks; ati++) {
        var aT = seq.audioTracks[ati];
        if (!aT || !aT.clips) continue;
        for (var ak = 0; ak < aT.clips.numItems; ak++) {
          try {
            var a = aT.clips[ak];
            var as_ = safeSeconds(a.start);
            var ae_ = safeSeconds(a.end);
            if (as_ < ve - EPSILON_SEC && ae_ > vs + EPSILON_SEC) {
              selection.push(a);
            }
          } catch (e) {}
        }
      }

      if (selection.length >= 2) {
        try {
          seq.setSelection(selection);
          seq.linkSelection();
          linked++;
        } catch (eL) {}
      }
    } catch (e) {}
  }
  return linked;
}

// ═══════════════════════════════════════════════════════════════════════════
// Audio crossfades at cut boundaries (best-effort, QE-DOM based)
// ═══════════════════════════════════════════════════════════════════════════
//
// Premiere exposes "Constant Power" (and "Constant Gain" / "Exponential Fade")
// as named audio transitions. The QE track exposes `addAudioTransition(
// transition, alignment, location_tc, duration_tc)`. `alignment` accepts:
//   0 = end at cut   (fade-out on outgoing clip)
//   1 = centered     (symmetric across cut)
//   2 = start at cut (fade-in on incoming clip)
// We use centered (1) so both sides get an equal fade curve.
//
// This call is extremely version-sensitive. Every single transition add is
// wrapped in try/catch so any failure is isolated — we log and move on.
function addAudioCrossfades(qeSeq, seq, cutTimes, durationMs, scopeStart, scopeEnd, fps, aTargetSet) {
  if (!qeSeq || !cutTimes || cutTimes.length === 0) return 0;
  if (!durationMs || durationMs < 1) return 0;

  var transition = null;
  try {
    if (qe && qe.project && qe.project.getAudioTransitionByName) {
      transition = qe.project.getAudioTransitionByName("Constant Power");
    }
  } catch (e) { log("  getAudioTransitionByName err: " + e); }

  if (!transition) {
    log("  Constant Power transition not available — skipping crossfades");
    return 0;
  }

  // ExtendScript-safe frame-timecode builder for a millisecond duration.
  // We send SMPTE-style "HH:MM:SS:FF" at the sequence fps.
  function tcFromSeconds(sec) {
    if (sec < 0) sec = 0;
    var totalFrames = Math.round(sec * fps);
    var frames  = totalFrames % Math.round(fps);
    var totSec  = Math.floor(totalFrames / fps);
    var h       = Math.floor(totSec / 3600);
    var m       = Math.floor((totSec % 3600) / 60);
    var s       = totSec % 60;
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return pad(h) + ":" + pad(m) + ":" + pad(s) + ":" + pad(frames);
  }

  var durSec = durationMs / 1000;
  var durTc  = tcFromSeconds(durSec);
  var added  = 0;

  for (var ti = 0; ti < cutTimes.length; ti++) {
    var t = cutTimes[ti];
    if (t <= scopeStart || t >= scopeEnd) continue;
    var locTc = tcFromSeconds(t);

    for (var a = 0; a < qeSeq.numAudioTracks; a++) {
      if (aTargetSet && !aTargetSet[a]) continue;
      try {
        var qaTrack = qeSeq.getAudioTrackAt(a);
        if (!qaTrack) continue;
        // alignment = 1  (centered on cut)
        qaTrack.addAudioTransition(transition, 1, locTc, durTc);
        added++;
      } catch (e) {
        // Silent per-call failure is normal — Premiere rejects transitions
        // on track boundaries that don't abut two clips.
      }
    }
  }

  return added;
}

// Back-compat — older panel builds call applyCutsV7/applyCutsV4
function applyCutsV7(payloadJSON) { return applyCuts(payloadJSON); }
function applyCutsV4(payloadJSON) { return applyCuts(payloadJSON); }

// ═══════════════════════════════════════════════════════════════════════════
// testCut() — single-cut smoke test
// ═══════════════════════════════════════════════════════════════════════════

function testCut() {
  logInit();
  log("testCut() — CTI razor smoke test");

  var result = {
    premiereVersion: String(app.version || "unknown"),
    hasSequence: false,
    hasClip: false,
    clipName: "",
    originalClipCount: 0,
    clipCountAfterRazor: 0,
    razorTimecode: "",
    success: false,
    method: "CTI razor",
    error: ""
  };

  try {
    if (!app.project || !app.project.activeSequence) {
      result.error = "No active sequence";
      result.log = _log; return jsonStringify(result);
    }
    var seq = app.project.activeSequence;
    result.hasSequence = true;

    var v1 = seq.videoTracks[0];
    if (!v1 || !v1.clips || v1.clips.numItems === 0) {
      result.error = "No clips on V1";
      result.log = _log; return jsonStringify(result);
    }
    result.hasClip = true;
    result.clipName = String(v1.clips[0].name || "");
    result.originalClipCount = v1.clips.numItems;

    var cs = safeSeconds(v1.clips[0].start);
    var ce = safeSeconds(v1.clips[0].end);
    var razorT = cs + Math.min(1.0, (ce - cs) / 2);

    app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) {
      result.error = "QE sequence is null — click on Timeline panel then retry";
      result.log = _log; return jsonStringify(result);
    }

    var tc = seekAndGetCTITimecode(seq, qeSeq, razorT);
    result.razorTimecode = tc;
    log("Razor @ " + razorT.toFixed(3) + "s  tc=" + tc);

    try { qeSeq.getVideoTrackAt(0).razor(tc); } catch (e) { log("V razor: " + e); }
    try { qeSeq.getAudioTrackAt(0).razor(tc); } catch (e) { log("A razor: " + e); }

    result.clipCountAfterRazor = v1.clips.numItems;
    if (result.clipCountAfterRazor > result.originalClipCount) {
      result.success = true;
      try { qe.project.undoStackPopBack(); } catch (e) {}
      log("SUCCESS — clip count " + result.originalClipCount +
          " → " + result.clipCountAfterRazor + " (undid test cut)");
    } else {
      result.error = "Razor had no effect on clip count";
      log("FAIL — clip count unchanged");
    }
  } catch (e) {
    result.error = "testCut fatal: " + String(e.message || e);
  }

  writeLogFile();
  result.log = _log;
  result.logPath = _logPath;
  return jsonStringify(result);
}

// ═══════════════════════════════════════════════════════════════════════════
// runDiagnostics()
// ═══════════════════════════════════════════════════════════════════════════

function runDiagnostics() {
  logInit();
  log("runDiagnostics() v8");

  var d = {
    premiereVersion: String(app.version || "unknown"),
    buildNumber: "",
    hasActiveSequence: false,
    sequenceName: "",
    fps: 0,
    videoTracks: 0,
    audioTracks: 0,
    v1ClipCount: 0,
    firstClipName: "",
    firstClipStart: 0,
    firstClipEnd: 0,
    canReadClipEnd: false,
    canReadClipInPoint: false,
    canReadClipOutPoint: false,
    clipEndType: "",
    timeObjectWorks: false,
    qeAvailable: false,
    qeSequenceAvailable: false,
    qePerTrackRazorAvailable: false,
    ctiTimecodeAvailable: false,
    sampleTimecode: "",
    desktopPath: "",
    tempPath: "",
    errors: []
  };

  try { d.buildNumber = String(app.build || ""); } catch (e) {}
  try { d.desktopPath = Folder.desktop.fsName; } catch (e) {}
  try { d.tempPath    = Folder.temp.fsName;    } catch (e) {}

  try {
    if (app.project && app.project.activeSequence) {
      var seq = app.project.activeSequence;
      d.hasActiveSequence = true;
      d.sequenceName     = String(seq.name || "");
      d.fps              = getSequenceFPS(seq);
      d.videoTracks      = seq.videoTracks ? seq.videoTracks.numTracks : 0;
      d.audioTracks      = seq.audioTracks ? seq.audioTracks.numTracks : 0;

      if (d.videoTracks > 0) {
        var v1 = seq.videoTracks[0];
        d.v1ClipCount = v1.clips ? v1.clips.numItems : 0;
        if (d.v1ClipCount > 0) {
          var c0 = v1.clips[0];
          d.firstClipName = String(c0.name || "");
          try {
            d.firstClipStart = safeSeconds(c0.start);
            d.firstClipEnd   = safeSeconds(c0.end);
            d.canReadClipEnd = true;
            d.clipEndType    = typeof c0.end;
          } catch (e) { d.errors.push("clip.end read: " + String(e)); }
          try { safeSeconds(c0.inPoint);  d.canReadClipInPoint  = true; } catch (e) {}
          try { safeSeconds(c0.outPoint); d.canReadClipOutPoint = true; } catch (e) {}

          try {
            var t = new Time(); t.seconds = 1.0;
            d.timeObjectWorks = Math.abs(t.seconds - 1.0) < 0.001;
          } catch (e) { d.errors.push("Time: " + String(e)); }
        }
      }

      try {
        app.enableQE();
        d.qeAvailable = true;
        var qeSeq = qe.project.getActiveSequence();
        if (qeSeq) {
          d.qeSequenceAvailable = true;
          try {
            var tt = qeSeq.getVideoTrackAt(0);
            if (tt && typeof tt.razor === "function") {
              d.qePerTrackRazorAvailable = true;
            }
          } catch (e) {}
          try {
            seq.setPlayerPosition(Math.round(5 * TICKS_PER_SECOND).toString());
            d.sampleTimecode = qeSeq.CTI.timecode;
            d.ctiTimecodeAvailable = true;
          } catch (e) { d.errors.push("CTI.timecode: " + String(e)); }
        }
      } catch (e) { d.errors.push("QE: " + String(e)); }
    } else {
      d.errors.push("No active sequence");
    }
  } catch (e) { d.errors.push("Diagnostics: " + String(e)); }

  writeLogFile();
  d.logPath = _logPath;
  d.log     = _log;
  return jsonStringify(d);
}

// ═══════════════════════════════════════════════════════════════════════════
// Misc
// ═══════════════════════════════════════════════════════════════════════════

function setPlayheadPosition(seconds) {
  try {
    if (!app.project || !app.project.activeSequence) {
      return jsonStringify({ error: "No active sequence" });
    }
    var ticks = Math.round((parseFloat(seconds) || 0) * TICKS_PER_SECOND);
    app.project.activeSequence.setPlayerPosition(ticks.toString());
    return jsonStringify({ success: true, position: parseFloat(seconds) || 0 });
  } catch (e) {
    return jsonStringify({ error: "setPlayheadPosition: " + String(e.message || e) });
  }
}

function undoLastAction() {
  try {
    try {
      app.enableQE();
      if (typeof qe !== "undefined" && qe.project) {
        qe.project.undoStackPopBack();
        return jsonStringify({ success: true, method: "qe" });
      }
    } catch (e) {}
    return jsonStringify({
      success: false,
      message: "Use Cmd+Z in Premiere Pro to undo"
    });
  } catch (e) {
    return jsonStringify({ error: "undoLastAction: " + String(e.message || e) });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot / Restore
//
// applyCuts() fires hundreds of razor + ripple-delete operations, each of
// which lands in Premiere's own undo stack. Cmd+Z after a multi-minute cut
// means mashing the key hundreds of times and watching the timeline
// reassemble in half-states. To give users a single-click "get me back to
// where I was" we clone the active sequence BEFORE razoring and keep the
// clone in the project bin. On restore, we simply re-activate that clone.
// Nothing is ever deleted — if the user decides they liked the cut after
// all, the post-cut sequence is still right next to its backup in the bin.
// ═══════════════════════════════════════════════════════════════════════════

function _pad2(n) { return (n < 10 ? "0" : "") + n; }

function _findSequenceByID(seqID) {
  if (!app.project || !app.project.sequences) return null;
  var want = String(seqID);
  for (var i = 0; i < app.project.sequences.numSequences; i++) {
    var s = app.project.sequences[i];
    try { if (String(s.sequenceID) === want) return s; } catch (e) {}
  }
  return null;
}

function createSnapshot() {
  try {
    if (!app.project || !app.project.activeSequence) {
      return jsonStringify({ error: "No active sequence" });
    }
    var seq = app.project.activeSequence;
    var originalName = seq.name;
    var originalID   = String(seq.sequenceID);

    // Snapshot the list of existing sequence IDs so we can identify the
    // newly-added clone after seq.clone() runs. clone() returns void in
    // all released Premiere versions I've tested.
    var priorIDs = {};
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      try { priorIDs[String(app.project.sequences[i].sequenceID)] = true; } catch (e) {}
    }

    try { seq.clone(); }
    catch (eClone) {
      return jsonStringify({ error: "Sequence.clone() failed: " + eClone });
    }

    var newSeq = null;
    for (var j = 0; j < app.project.sequences.numSequences; j++) {
      var cand = app.project.sequences[j];
      try {
        var id = String(cand.sequenceID);
        if (!priorIDs[id]) { newSeq = cand; break; }
      } catch (e2) {}
    }
    if (!newSeq) {
      // Fallback: look for a sequence named "{original} Copy"
      for (var k = 0; k < app.project.sequences.numSequences; k++) {
        var c2 = app.project.sequences[k];
        try {
          if (c2.name.indexOf(originalName) === 0 &&
              String(c2.sequenceID) !== originalID) {
            newSeq = c2;
          }
        } catch (e3) {}
      }
    }
    if (!newSeq) {
      return jsonStringify({ error: "Could not locate cloned sequence" });
    }

    var now = new Date();
    var stamp = _pad2(now.getHours()) + ":" + _pad2(now.getMinutes());
    var newName = originalName + " (before SmartCut " + stamp + ")";
    try { newSeq.name = newName; } catch (eName) {}

    // clone() sometimes switches the active sequence to the new copy —
    // put focus back on the original so applyCuts() cuts the right one.
    try { app.project.activeSequence = seq; } catch (eAct) {}

    return jsonStringify({
      success: true,
      backupSequenceID:   String(newSeq.sequenceID),
      backupName:         newName,
      originalSequenceID: originalID
    });
  } catch (e) {
    return jsonStringify({ error: "createSnapshot: " + String(e.message || e) });
  }
}

function restoreSnapshot(payloadJSON) {
  try {
    if (!payloadJSON) return jsonStringify({ error: "No payload" });
    var p;
    try { p = eval("(" + payloadJSON + ")"); }
    catch (e) { return jsonStringify({ error: "Bad payload: " + e }); }

    var backupID = String(p && p.backupSequenceID || "");
    if (!backupID) return jsonStringify({ error: "No backupSequenceID" });

    var target = _findSequenceByID(backupID);
    if (!target) {
      return jsonStringify({
        error: "Backup sequence not found — it may have been deleted from the project"
      });
    }
    try { app.project.activeSequence = target; }
    catch (eAct) { return jsonStringify({ error: "Could not activate backup: " + eAct }); }

    return jsonStringify({
      success: true,
      name: target.name,
      sequenceID: String(target.sequenceID)
    });
  } catch (e) {
    return jsonStringify({ error: "restoreSnapshot: " + String(e.message || e) });
  }
}
