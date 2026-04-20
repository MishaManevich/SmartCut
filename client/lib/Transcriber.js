/**
 * SmartCut — Whisper Transcriber (v9)
 *
 * Runs the bundled whisper.cpp binary via the CEP process API (non-blocking).
 * 100% local. No network. No API keys.
 *
 * Public API:
 *   Transcriber.transcribe(wavPath, opts) → Promise<TranscriptResult>
 *
 * opts.onProgress(percent, statusString)    — streamed progress
 * opts.onLog(line)                          — raw stderr lines
 *
 * Returns:
 *   { segments: [ {from,to,text}, ... ],     // milliseconds
 *     words:    [ {t0,t1,text}, ... ],       // milliseconds (if word-level)
 *     fullText: "...",
 *     stderr:   "..." }
 *
 * Bundled binaries live in:
 *   <extensionRoot>/bin/whisper/macos-arm64/whisper-cli
 *   <extensionRoot>/bin/whisper/macos-x64/whisper-cli     (future)
 *   <extensionRoot>/bin/whisper/win-x64/whisper-cli.exe   (future)
 *
 * Bundled model:
 *   <extensionRoot>/models/ggml-base.en.bin (142 MB)
 */

(function (global) {
  "use strict";

  var Transcriber = {};

  // ── Platform detection ────────────────────────────────────────────────────

  // Pick a reasonable whisper thread count for this host.
  //
  // whisper.cpp's upstream default is min(4, hardware_concurrency), which
  // leaves most of the CPU idle on any modern laptop. Empirically on
  // Apple Silicon we see near-linear speedup up to ~6–8 threads and then
  // memory-bandwidth saturation flattens the curve (and extra threads
  // start causing cache contention + thermal throttling on battery).
  //
  // We also leave at least 2 cores free so the Premiere host app stays
  // responsive — users have Premiere in the foreground while we run.
  function computeDefaultThreads() {
    try {
      var os = require("os");
      var cores = (os.cpus && os.cpus().length) || 4;
      var t = Math.max(1, cores - 2);
      if (t > 8) t = 8;
      return t;
    } catch (e) {
      return 4;
    }
  }

  function detectPlatform() {
    var os = require("os");
    var platform = os.platform();      // darwin, win32, linux
    var arch     = os.arch();          // arm64, x64
    if (platform === "darwin" && arch === "arm64") return "macos-arm64";
    if (platform === "darwin" && arch === "x64")   return "macos-x64";
    if (platform === "win32"  && arch === "x64")   return "win-x64";
    return null;
  }

  // ── Paths ─────────────────────────────────────────────────────────────────

  // CEP's getSystemPath returns a file: URL on some hosts (Premiere on macOS
  // returns "file:/Users/.../Application%20Support/..." with a single slash
  // and URL-encoded spaces). Node's fs can't consume that — normalize to a
  // plain filesystem path.
  function normalizeCEPPath(p) {
    if (!p) return p;
    try { p = decodeURIComponent(p); } catch (e) {}
    // Strip file:// prefix (0–3 slashes; Adobe emits 1)
    p = p.replace(/^file:\/*/i, "");
    var isWin = (require("os").platform() === "win32");
    if (!isWin && p.charAt(0) !== "/") p = "/" + p;
    return p;
  }

  function getExtensionRoot() {
    // In CEP's CEF environment `__dirname` resolves to the extension root
    // (NOT the JS file's directory like in plain Node), so it can't be
    // relied on. CSInterface's SystemPath.EXTENSION is the correct API.
    if (typeof CSInterface !== "undefined") {
      try {
        var cs = new CSInterface();
        var root = cs.getSystemPath(cs.EXTENSION_PATH || "extension");
        if (root) return normalizeCEPPath(root);
      } catch (e) {}
    }
    // Fallback — still useful for node/test environments
    var path = require("path");
    return path.resolve(__dirname || ".", "..", "..");
  }

  Transcriber.getBinaryPath = function () {
    var path = require("path");
    var fs   = require("fs");
    var plat = detectPlatform();
    if (!plat) throw new Error("Unsupported platform for whisper.cpp");

    var root = getExtensionRoot();
    var bin  = (plat === "win-x64")
      ? path.join(root, "bin", "whisper", plat, "whisper-cli.exe")
      : path.join(root, "bin", "whisper", plat, "whisper-cli");
    if (!fs.existsSync(bin)) throw new Error("whisper-cli not found at " + bin);
    return bin;
  };

  Transcriber.getModelPath = function (modelName) {
    var path = require("path");
    var fs   = require("fs");
    modelName = modelName || "ggml-base.en.bin";
    var p = path.join(getExtensionRoot(), "models", modelName);
    if (!fs.existsSync(p)) throw new Error("Whisper model not found at " + p);
    return p;
  };

  Transcriber.getBackendDir = function () {
    var path = require("path");
    var plat = detectPlatform();
    return path.join(getExtensionRoot(), "bin", "whisper", plat);
  };

  // ── Transcribe ────────────────────────────────────────────────────────────

  Transcriber.transcribe = function (wavPath, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var fs   = require("fs");
      var path = require("path");
      var bin, model, backendDir;
      try {
        bin        = Transcriber.getBinaryPath();
        model      = Transcriber.getModelPath(opts.model);
        backendDir = Transcriber.getBackendDir();
      } catch (e) { reject(e); return; }

      var outPrefix = wavPath.replace(/\.wav$/i, "");     // whisper writes `<prefix>.json`
      var jsonPath  = outPrefix + ".json";

      // Ensure binary is executable (ZXP install may strip perms)
      try { fs.chmodSync(bin, 0o755); } catch (e) {}

      // Remove stale output
      try { fs.unlinkSync(jsonPath); } catch (e) {}

      var args = [
        "-m", model,
        "-f", wavPath,
        "-of", outPrefix,         // output prefix
        "-oj",                    // write JSON
        "-l", "en",
        "-ml", "1",               // word-level timestamps (one token per segment)
        "--no-prints",            // keep stderr clean
        "-pp"                     // print progress to stderr
      ];

      // Thread count. whisper.cpp's built-in default is min(4, cpuCount)
      // which leaves most of an 8-10 core Apple Silicon chip idle. If the
      // caller didn't specify a count, pick a sensible one based on the
      // host's actual CPU count. We cap at 8 because above that whisper
      // sees diminishing returns (memory bandwidth bound).
      var threads = (typeof opts.threads === "number")
        ? opts.threads
        : computeDefaultThreads();
      args.push("-t", String(threads));

      if (opts.beam === false) {
        args.push("-bs", "1");    // greedy, faster
      }

      // Pass env so our bundled backends win over any system install
      var env = Object.assign({}, global.process && global.process.env || {});
      env.GGML_BACKEND_PATH = backendDir;
      // Make sure co-located dylibs resolve via rpath
      env.DYLD_FALLBACK_LIBRARY_PATH =
        backendDir + (env.DYLD_FALLBACK_LIBRARY_PATH ? ":" + env.DYLD_FALLBACK_LIBRARY_PATH : "");

      var child_process = require("child_process");
      var proc = child_process.spawn(bin, args, { env: env });

      var stderr = "";
      var lastPct = 0;
      var tStart  = Date.now();
      var hbTimer = null;

      // If whisper.cpp doesn't emit `-pp` lines (older binary, different
      // build flags), the bar would freeze for tens of minutes on long
      // clips even though work is proceeding. Heartbeat keeps the UI honest.
      if (opts.onProgress) {
        hbTimer = global.setInterval(function () {
          var elapsed = Math.round((Date.now() - tStart) / 1000);
          opts.onProgress(lastPct, "Transcribing " + lastPct + "% (running " + elapsed + "s\u2026)");
        }, 20000);
      }

      // Drain stdout. `--no-prints` is passed so whisper shouldn't emit
      // anything on stdout, but some builds still do (e.g. backend-init
      // banners). If we never read the pipe, a ~64 KB OS buffer fills up
      // and the child process blocks on `write()` — presenting as a hang
      // stuck at an arbitrary progress percentage. We consume and
      // discard to be safe.
      if (proc.stdout) {
        proc.stdout.on("data", function () { /* discard */ });
      }

      proc.stderr.on("data", function (chunk) {
        var txt = chunk.toString("utf8");
        stderr += txt;
        if (opts.onLog) {
          txt.split(/\r?\n/).forEach(function (line) {
            if (line) opts.onLog(line);
          });
        }
        // whisper emits `whisper_print_progress_callback: progress = NN%`
        // — often multiple lines arrive in a single chunk when the OS
        // buffers stderr, so iterate over every match rather than just
        // the first one (otherwise the UI skips progress ticks).
        if (opts.onProgress) {
          var patterns = [
            /progress\s*=\s*(\d+)\s*%/g,
            /progress:\s*(\d+)\s*%/gi,
            /(\d+)\s*%\s*\|\s*[^|]+\|/g
          ];
          for (var pi = 0; pi < patterns.length; pi++) {
            var re = patterns[pi];
            var m;
            re.lastIndex = 0;
            while ((m = re.exec(txt)) !== null) {
              var pct = parseInt(m[1], 10);
              if (pct >= 0 && pct <= 100 && pct > lastPct) {
                lastPct = pct;
                opts.onProgress(pct, "Transcribing " + pct + "%");
              }
            }
          }
        }
      });

      proc.on("error", function (err) {
        if (hbTimer) { try { global.clearInterval(hbTimer); } catch (eHb) {} }
        reject(new Error("whisper-cli spawn failed: " + (err && err.message || err)));
      });

      proc.on("close", function (code) {
        if (hbTimer) { try { global.clearInterval(hbTimer); } catch (eHb2) {} }
        if (code !== 0) {
          reject(new Error("whisper-cli exited " + code + "\n" + stderr.slice(-1000)));
          return;
        }
        try {
          var raw = fs.readFileSync(jsonPath, "utf8");
          var obj = JSON.parse(raw);
          resolve(parseWhisperJson(obj, stderr));
        } catch (e) {
          reject(new Error("Failed to read whisper output: " + e.message + "\n" + stderr.slice(-500)));
        }
      });
    });
  };

  // ── Parser ────────────────────────────────────────────────────────────────
  //
  // whisper.cpp's `-oj` format:
  //   { transcription: [
  //       { offsets: {from:0, to:320}, text: "Hello", ... }
  //     ] }
  //
  // With `-ml 1` each segment is ~1 token = effectively one word. We merge
  // adjacent single-token entries into full-sentence segments and keep the
  // per-token array as `words` for fine-grained cut logic.

  function parseWhisperJson(obj, stderr) {
    var segs = obj.transcription || obj.segments || [];
    var words = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var off = s.offsets || {};
      var t0  = (typeof off.from === "number") ? off.from : 0;
      var t1  = (typeof off.to   === "number") ? off.to   : t0;
      var txt = (s.text || "").trim();
      if (!txt) continue;
      words.push({ t0: t0, t1: t1, text: txt });
    }

    // Group words into sentences (split on punctuation or gap > 700ms)
    var segments = [];
    var cur = null;
    for (var j = 0; j < words.length; j++) {
      var w = words[j];
      var endsSentence = /[.!?]$/.test(w.text);
      var bigGap = cur && (w.t0 - cur.to > 700);
      if (!cur || bigGap) {
        cur = { from: w.t0, to: w.t1, text: w.text };
        segments.push(cur);
      } else {
        cur.text += " " + w.text;
        cur.to = w.t1;
      }
      if (endsSentence && cur) cur = null;
    }

    return {
      segments: segments,
      words:    words,
      fullText: words.map(function (w) { return w.text; }).join(" "),
      stderr:   stderr
    };
  }

  global.Transcriber = Transcriber;
})(window);
