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

      if (typeof opts.threads === "number") {
        args.push("-t", String(opts.threads));
      }
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

      proc.stderr.on("data", function (chunk) {
        var txt = chunk.toString("utf8");
        stderr += txt;
        if (opts.onLog) {
          txt.split(/\r?\n/).forEach(function (line) {
            if (line) opts.onLog(line);
          });
        }
        // whisper emits `whisper_print_progress_callback: progress = NN%`
        var m = txt.match(/progress\s*=\s*(\d+)%/);
        if (m && opts.onProgress) {
          var pct = parseInt(m[1], 10);
          if (pct > lastPct) {
            lastPct = pct;
            opts.onProgress(pct, "Transcribing " + pct + "%");
          }
        }
      });

      proc.on("error", function (err) {
        reject(new Error("whisper-cli spawn failed: " + (err && err.message || err)));
      });

      proc.on("close", function (code) {
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
