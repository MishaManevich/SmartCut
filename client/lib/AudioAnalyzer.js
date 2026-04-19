/**
 * SmartCut — Audio Analyzer (v8)
 *
 * v8 REWRITE — fixes Bug #1/#2/#3:
 *  - Primary decode path uses the Web Audio API's decodeAudioData(), which
 *    natively handles WAV, MP3, AAC, M4A, FLAC, and most MOV/MP4 containers
 *    that use AAC audio — everything pro users actually record with.
 *  - The WHOLE audio buffer is analyzed (not just the first ~10 seconds) by
 *    concatenating every channel's Float32Array end-to-end (after downmix).
 *  - Custom WAV parser kept as last-resort fallback for truly raw PCM WAV.
 *  - Auto-threshold detection works as long as we have samples — no longer
 *    blocked by decode failures.
 *
 * Public API (all return/accept Promises or callbacks):
 *   new AudioAnalyzer(settings)
 *   analyzer.analyzeFile(filePath)       → Promise<AnalysisResult>
 *   analyzer.analyzeThresholdFile(path)  → Promise<ThresholdResult>
 *   analyzer.analyzeBuffer(arrayBuffer)  → Promise<AnalysisResult>
 *
 * Settings (all optional):
 *   sensitivity          1..5  (default 3)      — higher = more aggressive
 *   silenceThresholdDb   dB    (default -35)
 *   minSilenceDuration   sec   (default 0.3)
 *   paddingMs            ms    (default 50)     — contract silence edges
 *   detectSilence        bool  (default true)
 *   autoThreshold        bool  (default false)  — histogram noise-floor pick
 *   trimStart/trimEnd    sec   (optional)       — only analyze a sub-range
 */

(function (global) {
  "use strict";

  var DEFAULT_SETTINGS = {
    sensitivity:        3,
    silenceThresholdDb: -35,
    minSilenceDuration: 0.3,
    paddingMs:          50,
    detectSilence:      true,
    autoThreshold:      false,
    trimStart:          null,   // seconds into source
    trimEnd:            null
  };

  function AudioAnalyzer(settings) {
    this.settings = {};
    for (var k in DEFAULT_SETTINGS) this.settings[k] = DEFAULT_SETTINGS[k];
    if (settings) {
      for (var k2 in settings) {
        if (settings[k2] !== undefined && settings[k2] !== null) {
          this.settings[k2] = settings[k2];
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // File loading (CEP Node.js fs) → ArrayBuffer
  // ─────────────────────────────────────────────────────────────────────────

  AudioAnalyzer.readFileAsArrayBuffer = function (filePath) {
    return new Promise(function (resolve, reject) {
      try {
        var fs = require("fs");
        var buf = fs.readFileSync(filePath);
        var ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        resolve(ab);
      } catch (e) {
        reject(new Error("Cannot read file: " + filePath + ". " + (e.message || e)));
      }
    });
  };

  // ─────────────────────────────────────────────────────────────────────────
  // FFmpeg helpers
  //
  // Reading a full 4K/ProRes video into memory through Node's fs is a
  // non-starter: Buffer caps out at 2GB on the Node that CEP ships, and
  // Chromium's decodeAudioData can't decode ProRes/DNxHD/H.265-10bit anyway.
  //
  // When ffmpeg is on the machine (Homebrew, MacPorts, system), we pipe the
  // source through it to get a tiny 16kHz mono PCM WAV. That WAV is a few
  // MB/minute, decodes instantly via Web Audio, and works for *any* source
  // codec Premiere itself could play. This is the same trick AutoCut and
  // friends use to sidestep Chromium's codec list.
  //
  // If ffmpeg isn't available, we fall back to the direct fs.readFileSync
  // path and surface a clearer install-ffmpeg message on failure.
  // ─────────────────────────────────────────────────────────────────────────

  var _cachedFfmpegPath = undefined; // undefined = not probed, null = probed & missing, string = found

  AudioAnalyzer.findFFmpeg = function () {
    if (_cachedFfmpegPath !== undefined) return _cachedFfmpegPath;
    _cachedFfmpegPath = null;
    try {
      var fs = require("fs");
      var candidates = [
        "/opt/homebrew/bin/ffmpeg",   // Apple Silicon Homebrew
        "/usr/local/bin/ffmpeg",      // Intel Homebrew / manual install
        "/usr/bin/ffmpeg",            // system
        "/opt/local/bin/ffmpeg",      // MacPorts
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe"
      ];
      for (var i = 0; i < candidates.length; i++) {
        try { if (fs.existsSync(candidates[i])) { _cachedFfmpegPath = candidates[i]; return _cachedFfmpegPath; } }
        catch (eExist) {}
      }
      try {
        var child_process = require("child_process");
        var isWin = (process && process.platform === "win32");
        var probe = isWin ? "where ffmpeg" : "command -v ffmpeg 2>/dev/null";
        var out = child_process.execSync(probe, { encoding: "utf8" });
        if (out) {
          var firstLine = out.split(/\r?\n/)[0].trim();
          if (firstLine && fs.existsSync(firstLine)) { _cachedFfmpegPath = firstLine; return _cachedFfmpegPath; }
        }
      } catch (eProbe) {}
    } catch (e) {}
    return _cachedFfmpegPath;
  };

  // Extract a mono 16kHz PCM WAV from any source file via ffmpeg.
  // Resolves to the temp WAV path. Caller must delete it when done.
  AudioAnalyzer.extractAudioViaFFmpeg = function (filePath, ffmpegBin) {
    return new Promise(function (resolve, reject) {
      try {
        var os   = require("os");
        var path = require("path");
        var fs   = require("fs");
        var cp   = require("child_process");
        var tmp  = path.join(os.tmpdir(),
          "smartcut-audio-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + ".wav");
        // -vn           : drop video
        // -ac 1         : mono
        // -ar 16000     : 16kHz (plenty for silence / speech detection)
        // -acodec pcm_s16le : raw WAV, trivial to parse
        // -f wav        : force container (helps when extension is weird)
        var args = ["-y", "-nostdin", "-loglevel", "error",
                    "-i", filePath,
                    "-vn", "-ac", "1", "-ar", "16000",
                    "-acodec", "pcm_s16le", "-f", "wav", tmp];
        var proc;
        try { proc = cp.spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] }); }
        catch (eSpawn) { reject(new Error("ffmpeg spawn failed: " + (eSpawn.message || eSpawn))); return; }
        var stderrTail = "";
        try {
          proc.stderr.on("data", function (d) {
            stderrTail += d.toString();
            if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
          });
        } catch (eErr) {}
        proc.on("error", function (err) {
          reject(new Error("ffmpeg error: " + (err && err.message || err)));
        });
        proc.on("close", function (code) {
          if (code === 0 && fs.existsSync(tmp)) {
            resolve(tmp);
          } else {
            var tail = stderrTail ? stderrTail.split("\n").slice(-6).join("\n") : "";
            reject(new Error("ffmpeg exited " + code + (tail ? "\n" + tail : "")));
          }
        });
      } catch (e) { reject(e); }
    });
  };

  // Runs an analysis over the ffmpeg-extracted WAV, then cleans the temp file
  // up regardless of success. Returns the result of `transform(arrayBuffer)`.
  function _withFfmpegExtract(filePath, transform) {
    var ffmpeg = AudioAnalyzer.findFFmpeg();
    if (!ffmpeg) {
      // Best-effort direct path. The caller's catch layer will provide a
      // friendlier "install ffmpeg" message if this blows up.
      return AudioAnalyzer.readFileAsArrayBuffer(filePath).then(transform);
    }
    return AudioAnalyzer.extractAudioViaFFmpeg(filePath, ffmpeg).then(function (wavPath) {
      return AudioAnalyzer.readFileAsArrayBuffer(wavPath).then(function (ab) {
        var done = function () { try { require("fs").unlinkSync(wavPath); } catch (eDel) {} };
        return Promise.resolve(transform(ab)).then(
          function (res) { done(); return res; },
          function (err) { done(); throw err; }
        );
      });
    });
  }

  // Smart loader for the main.js pipeline (which reads the ArrayBuffer up
  // front and pipes it into analyzer.decode() itself). Uses ffmpeg when
  // available so source video files, ProRes, and files >2GB all work
  // uniformly. Falls back to a direct fs.readFileSync when ffmpeg is
  // missing. Resolves with { arrayBuffer, source: "ffmpeg"|"direct",
  // cleanup: fn } so the caller can free the temp WAV after decode.
  AudioAnalyzer.loadSourceForAnalysis = function (filePath) {
    var ffmpeg = AudioAnalyzer.findFFmpeg();
    if (!ffmpeg) {
      return AudioAnalyzer.readFileAsArrayBuffer(filePath).then(function (ab) {
        return { arrayBuffer: ab, source: "direct", cleanup: function () {} };
      }).catch(function (err) {
        throw _enrichAnalysisError(err, filePath);
      });
    }
    return AudioAnalyzer.extractAudioViaFFmpeg(filePath, ffmpeg).then(function (wavPath) {
      return AudioAnalyzer.readFileAsArrayBuffer(wavPath).then(function (ab) {
        return {
          arrayBuffer: ab,
          source:      "ffmpeg",
          cleanup:     function () { try { require("fs").unlinkSync(wavPath); } catch (e) {} }
        };
      });
    }).catch(function (err) {
      throw _enrichAnalysisError(err, filePath);
    });
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Write mono 16-bit PCM WAV (whisper-cli input format)
  //   samples:     Float32Array (-1..1)
  //   sampleRate:  source rate
  //   outPath:     absolute fs path
  //   targetRate:  resample target (default 16000 — what Whisper wants)
  // ─────────────────────────────────────────────────────────────────────────

  AudioAnalyzer.writeWav16kMono = function (samples, sampleRate, outPath, targetRate) {
    targetRate = targetRate || 16000;
    var resampled = (sampleRate === targetRate)
      ? samples
      : resampleLinear(samples, sampleRate, targetRate);

    var numSamples = resampled.length;
    var byteRate   = targetRate * 2;
    var dataSize   = numSamples * 2;
    var fileSize   = 44 + dataSize;

    var fs = require("fs");
    var buf = Buffer.alloc(fileSize);
    var off = 0;
    buf.write("RIFF", off); off += 4;
    buf.writeUInt32LE(fileSize - 8, off); off += 4;
    buf.write("WAVE", off); off += 4;
    buf.write("fmt ", off); off += 4;
    buf.writeUInt32LE(16, off); off += 4;               // fmt chunk size
    buf.writeUInt16LE(1, off); off += 2;                // PCM
    buf.writeUInt16LE(1, off); off += 2;                // channels
    buf.writeUInt32LE(targetRate, off); off += 4;
    buf.writeUInt32LE(byteRate, off); off += 4;
    buf.writeUInt16LE(2, off); off += 2;                // block align
    buf.writeUInt16LE(16, off); off += 2;               // bits/sample
    buf.write("data", off); off += 4;
    buf.writeUInt32LE(dataSize, off); off += 4;

    for (var i = 0; i < numSamples; i++) {
      var v = resampled[i];
      if (v > 1)  v = 1;
      if (v < -1) v = -1;
      buf.writeInt16LE((v < 0 ? v * 0x8000 : v * 0x7FFF) | 0, off);
      off += 2;
    }
    fs.writeFileSync(outPath, buf);
    return { path: outPath, sampleRate: targetRate, durationSec: numSamples / targetRate };
  };

  function resampleLinear(src, srcRate, dstRate) {
    if (srcRate === dstRate) return src;
    var ratio = srcRate / dstRate;
    var n = Math.floor(src.length / ratio);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var pos = i * ratio;
      var i0  = pos | 0;
      var frac = pos - i0;
      var a = src[i0] || 0;
      var b = src[i0 + 1] !== undefined ? src[i0 + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Decode: prefer Web Audio decodeAudioData (handles MOV/MP4/AAC/WAV/MP3),
  // fallback to our hand-rolled WAV parser for pure PCM WAV.
  // Returns { samples:Float32Array, sampleRate, channels, duration }
  // where `samples` is a MONO mix (average of all channels).
  // ─────────────────────────────────────────────────────────────────────────

  AudioAnalyzer.prototype.decode = function (arrayBuffer) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var AudioContextCtor = global.AudioContext || global.webkitAudioContext || global.OfflineAudioContext;
      if (!AudioContextCtor) {
        // No Web Audio available — fall back to WAV decoder
        var w = self._decodeWav(arrayBuffer);
        if (w) resolve(w);
        else reject(new Error("No Web Audio API available and file is not WAV"));
        return;
      }

      var ctx;
      try { ctx = new AudioContextCtor(); }
      catch (ctxErr) {
        var w2 = self._decodeWav(arrayBuffer);
        if (w2) { resolve(w2); return; }
        reject(new Error("AudioContext creation failed: " + ctxErr));
        return;
      }

      // decodeAudioData may be Promise-returning (modern) or callback-style.
      var decoded = null;
      try {
        decoded = ctx.decodeAudioData(
          arrayBuffer.slice(0),
          function (buf) { finish(buf); },
          function (err) { handleError(err); }
        );
      } catch (syncErr) {
        handleError(syncErr);
        return;
      }
      if (decoded && typeof decoded.then === "function") {
        decoded.then(finish, handleError);
      }

      function finish(audioBuffer) {
        try {
          var mono = mixToMono(audioBuffer);
          try { ctx.close(); } catch (e) {}
          resolve({
            samples:    mono,
            sampleRate: audioBuffer.sampleRate,
            channels:   audioBuffer.numberOfChannels,
            duration:   audioBuffer.duration,
            decoder:    "WebAudio"
          });
        } catch (e) { reject(e); }
      }

      function handleError(err) {
        try { ctx.close(); } catch (e) {}
        // Last-resort WAV fallback
        var w3 = self._decodeWav(arrayBuffer);
        if (w3) { resolve(w3); return; }
        reject(new Error("Audio decode failed: " +
          (err && err.message ? err.message : String(err)) +
          " (codec/container not supported by Chromium in this file)"));
      }
    });
  };

  function mixToMono(audioBuffer) {
    var ch = audioBuffer.numberOfChannels;
    var len = audioBuffer.length;
    var out = new Float32Array(len);
    if (ch === 1) {
      out.set(audioBuffer.getChannelData(0));
      return out;
    }
    for (var c = 0; c < ch; c++) {
      var data = audioBuffer.getChannelData(c);
      for (var i = 0; i < len; i++) out[i] += data[i];
    }
    var inv = 1 / ch;
    for (var j = 0; j < len; j++) out[j] *= inv;
    return out;
  }

  /** Minimal PCM-WAV decoder — last-ditch fallback for raw WAV only. */
  AudioAnalyzer.prototype._decodeWav = function (arrayBuffer) {
    try {
      var view = new DataView(arrayBuffer);
      if (view.byteLength < 44) return null;
      var riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
      var wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
      if (riff !== "RIFF" || wave !== "WAVE") return null;

      var offset = 12;
      var channels = 1, sampleRate = 44100, bitsPerSample = 16;

      while (offset < view.byteLength - 8) {
        var chunkId = String.fromCharCode(
          view.getUint8(offset), view.getUint8(offset + 1),
          view.getUint8(offset + 2), view.getUint8(offset + 3)
        );
        var chunkSize = view.getUint32(offset + 4, true);

        if (chunkId === "fmt ") {
          channels      = view.getUint16(offset + 10, true);
          sampleRate    = view.getUint32(offset + 12, true);
          bitsPerSample = view.getUint16(offset + 22, true);
        }

        if (chunkId === "data") {
          var dataOffset = offset + 8;
          var bytesPerSample = bitsPerSample / 8;
          var numSamples = Math.floor(chunkSize / (bytesPerSample * channels));
          var samples = new Float32Array(numSamples);
          var maxVal  = Math.pow(2, bitsPerSample - 1);

          for (var i = 0; i < numSamples; i++) {
            var sum = 0;
            for (var c = 0; c < channels; c++) {
              var pos = dataOffset + (i * channels + c) * bytesPerSample;
              if (pos + bytesPerSample > view.byteLength) break;
              var v;
              if (bitsPerSample === 16)      v = view.getInt16(pos, true);
              else if (bitsPerSample === 24) v = (view.getUint8(pos) | (view.getUint8(pos + 1) << 8) | (view.getInt8(pos + 2) << 16));
              else if (bitsPerSample === 32) v = view.getFloat32(pos, true) * maxVal;
              else                            v = view.getUint8(pos) - 128;
              sum += v / maxVal;
            }
            samples[i] = sum / channels;
          }

          return {
            samples:    samples,
            sampleRate: sampleRate,
            channels:   channels,
            duration:   numSamples / sampleRate,
            decoder:    "rawWav"
          };
        }
        offset += 8 + chunkSize + (chunkSize % 2);
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Top-level entry points
  // ─────────────────────────────────────────────────────────────────────────

  AudioAnalyzer.prototype.analyzeFile = function (filePath) {
    var self = this;
    return _withFfmpegExtract(filePath, function (ab) {
      return self.analyzeBuffer(ab);
    }).catch(function (err) {
      throw _enrichAnalysisError(err, filePath);
    });
  };

  AudioAnalyzer.prototype.analyzeThresholdFile = function (filePath) {
    var self = this;
    return _withFfmpegExtract(filePath, function (ab) {
      return self.decode(ab).then(function (audio) {
        return self._detectNoiseFloor(audio.samples, audio.sampleRate);
      });
    }).catch(function (err) {
      throw _enrichAnalysisError(err, filePath);
    });
  };

  // Wrap raw "can't read / can't decode" errors with something users can act
  // on. If ffmpeg is missing we tell them to install it; if the file is >2GB
  // we flag the Buffer limit specifically; otherwise we surface the raw
  // message with the file path so it's obvious which clip failed.
  function _enrichAnalysisError(err, filePath) {
    var msg = (err && err.message) ? err.message : String(err);
    var sizeStr = "";
    try {
      var fs = require("fs");
      var st = fs.statSync(filePath);
      sizeStr = " (file " + Math.round(st.size / (1024 * 1024)) + " MB)";
    } catch (eStat) {}

    var has2GBHint = /greater than 2 GB|RangeError \[ERR_FS_FILE_TOO_LARGE\]|File size.*bytes.*is greater/i.test(msg);
    var ffmpegMissing = !AudioAnalyzer.findFFmpeg();

    if (has2GBHint && ffmpegMissing) {
      return new Error(
        "Source clip is larger than 2 GB, which Node can't read directly." + sizeStr + "\n\n" +
        "Fix: install ffmpeg so SmartCut can extract just the audio first.\n" +
        "  macOS:   brew install ffmpeg\n" +
        "  Windows: winget install Gyan.FFmpeg  (or see ffmpeg.org/download)\n\n" +
        "Then re-open the panel and Analyze again."
      );
    }
    if (has2GBHint) {
      return new Error("Couldn't extract audio from a clip > 2 GB" + sizeStr +
        ". This usually means ffmpeg couldn't open the file (moved, offline, or an unusual codec). Relink the clip in Premiere and retry.\n\nRaw: " + msg);
    }
    if (/ffmpeg/i.test(msg) && ffmpegMissing) {
      return new Error(
        "ffmpeg is required to read this source file" + sizeStr + " but was not found on this machine.\n" +
        "Install it with `brew install ffmpeg` (macOS) and reopen the panel.\n\nRaw: " + msg
      );
    }
    return new Error(msg + (sizeStr ? "\n" + filePath + sizeStr : ""));
  }

  AudioAnalyzer.prototype.analyzeBuffer = function (arrayBuffer) {
    var self = this;
    return self.decode(arrayBuffer).then(function (audio) {
      return self._analyzeSamples(audio);
    });
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Core pipeline: runs over EVERY sample in the buffer (no truncation)
  // ─────────────────────────────────────────────────────────────────────────

  AudioAnalyzer.prototype._analyzeSamples = function (audio) {
    var samples    = audio.samples;
    var sampleRate = audio.sampleRate;
    var duration   = audio.duration;

    // Optional sub-range trimming (inPoint / outPoint of clip)
    var s = this.settings;
    if (s.trimStart !== null || s.trimEnd !== null) {
      var startIdx = Math.max(0, Math.floor((s.trimStart || 0) * sampleRate));
      var endIdx   = (s.trimEnd !== null)
        ? Math.min(samples.length, Math.ceil(s.trimEnd * sampleRate))
        : samples.length;
      if (endIdx > startIdx) {
        samples  = samples.subarray(startIdx, endIdx);
        duration = (endIdx - startIdx) / sampleRate;
      }
    }

    // Step 0: Auto-threshold (optional)
    var autoThresholdResult = null;
    if (s.autoThreshold) {
      autoThresholdResult = this._detectNoiseFloor(samples, sampleRate);
      if (autoThresholdResult && typeof autoThresholdResult.threshold === "number") {
        s.silenceThresholdDb = autoThresholdResult.threshold;
      }
    }

    // Step 1: windowed RMS energy profile
    var windowMs = 20;
    var profile  = this._energyProfile(samples, sampleRate, windowMs);

    // Step 2: silence regions
    var silenceRegions = s.detectSilence
      ? this._detectSilence(profile)
      : [];

    // v8.1: edge refinement disabled by default — it was pushing silence
    // boundaries OUTWARD (into surrounding speech) by up to 300ms, which
    // caused sentence ends to be clipped. We now rely on raw silence
    // detection plus the paddingMs safety margin in the cutter.
    var naturalCutPoints = [];
    var refined = silenceRegions.slice(0);

    // Offset refined regions back to source-absolute time if we trimmed
    if (s.trimStart) {
      for (var r = 0; r < refined.length; r++) {
        refined[r].startSeconds += s.trimStart;
        refined[r].endSeconds   += s.trimStart;
      }
    }

    var totalSaved = 0;
    for (var ri = 0; ri < refined.length; ri++) {
      totalSaved += (refined[ri].endSeconds - refined[ri].startSeconds);
    }

    var result = {
      silenceRegions: refined,
      badTakes:       [],   // reserved for P2 whisper-based detection
      summary: {
        totalSilences:              refined.length,
        totalBadTakes:              0,
        estimatedTimeSavedSeconds:  Math.round(totalSaved * 10) / 10,
        audioDuration:              duration,
        sampleRate:                 sampleRate,
        decoder:                    audio.decoder || "unknown"
      }
    };
    if (autoThresholdResult) result.autoThreshold = autoThresholdResult;
    return result;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RMS energy profile (windowMs window, half-overlap hop)
  // ─────────────────────────────────────────────────────────────────────────

  AudioAnalyzer.prototype._energyProfile = function (samples, sampleRate, windowMs) {
    var windowSize = Math.max(1, Math.floor(sampleRate * windowMs / 1000));
    var hopSize    = Math.max(1, Math.floor(windowSize / 2));
    var total      = samples.length;
    if (total < windowSize) {
      return { rmsDb: new Float32Array(0), timeStamps: new Float32Array(0), windowMs: windowMs };
    }
    var numFrames  = Math.floor((total - windowSize) / hopSize) + 1;

    var rmsDb      = new Float32Array(numFrames);
    var timeStamps = new Float32Array(numFrames);

    for (var i = 0; i < numFrames; i++) {
      var start = i * hopSize;
      var sumSq = 0;
      for (var j = 0; j < windowSize; j++) {
        var v = samples[start + j];
        sumSq += v * v;
      }
      var rms = Math.sqrt(sumSq / windowSize);
      rmsDb[i]      = rms > 0 ? 20 * Math.log10(rms) : -100;
      timeStamps[i] = start / sampleRate;
    }

    return { rmsDb: rmsDb, timeStamps: timeStamps, windowMs: windowMs };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Silence detection (run to end of buffer)
  // ─────────────────────────────────────────────────────────────────────────

  AudioAnalyzer.prototype._detectSilence = function (profile) {
    var s = this.settings;
    // v10: sensitivity removed from UI — it was mathematically identical to
    // dragging the threshold slider. We keep the `sensitivity` field in
    // settings for back-compat but always treat 3 as neutral (= no offset).
    var sensOffset = (typeof s.sensitivity === "number") ? (s.sensitivity - 3) * 5 : 0;
    var thresh = s.silenceThresholdDb + sensOffset;
    var minDur = s.minSilenceDuration;

    var regions = [];
    var inSil = false, silStart = 0;
    var rmsDb = profile.rmsDb;
    var ts    = profile.timeStamps;

    for (var i = 0; i < rmsDb.length; i++) {
      var time = ts[i];
      var e    = rmsDb[i];

      if (e < thresh) {
        if (!inSil) { silStart = time; inSil = true; }
      } else if (inSil) {
        var dur = time - silStart;
        if (dur >= minDur) {
          regions.push(makeRegion(silStart, time, dur));
        }
        inSil = false;
      }
    }
    // Trailing silence
    if (inSil && ts.length > 0) {
      var endTime = ts[ts.length - 1] + (profile.windowMs / 1000);
      var dur2    = endTime - silStart;
      if (dur2 >= minDur) regions.push(makeRegion(silStart, endTime, dur2));
    }
    return regions;
  };

  function makeRegion(start, end, dur) {
    var type = "silence";
    if (dur > 2.0) type = "dead_air";
    else if (dur > 1.0) type = "long_pause";
    var conf = Math.min(0.99, 0.6 + Math.min(0.35, dur / 5));
    return {
      startSeconds: round3(start),
      endSeconds:   round3(end),
      duration:     round3(dur),
      type:         type,
      confidence:   Math.round(conf * 100) / 100
    };
  }
  function round3(n) { return Math.round(n * 1000) / 1000; }

  // ─────────────────────────────────────────────────────────────────────────
  // Natural cut points — local minima with a meaningful energy drop
  // ─────────────────────────────────────────────────────────────────────────

  AudioAnalyzer.prototype._naturalCutPoints = function (profile) {
    var rmsDb = profile.rmsDb;
    if (rmsDb.length < 7) return [];
    var smooth = smoothArray(rmsDb, 5);
    var ts = profile.timeStamps;
    var pts = [];
    var minGap = 0.3;

    for (var i = 3; i < smooth.length - 3; i++) {
      var e = smooth[i];
      var isMin = e < smooth[i - 1] && e < smooth[i + 1] &&
                  e < smooth[i - 2] && e < smooth[i + 2];
      if (!isMin) continue;

      var leftE  = Math.max(smooth[i - 2], smooth[i - 3]);
      var rightE = Math.max(smooth[i + 2], smooth[i + 3]);
      var drop   = ((leftE - e) + (rightE - e)) / 2;
      if (drop < 3) continue;

      var t = ts[i];
      if (pts.length && (t - pts[pts.length - 1].timeSeconds) < minGap) continue;
      pts.push({ timeSeconds: round3(t), energyDb: Math.round(e * 10) / 10 });
    }
    return pts;
  };

  function smoothArray(arr, win) {
    var out  = new Float32Array(arr.length);
    var half = Math.floor(win / 2);
    for (var i = 0; i < arr.length; i++) {
      var sum = 0, count = 0;
      var lo = Math.max(0, i - half);
      var hi = Math.min(arr.length - 1, i + half);
      for (var j = lo; j <= hi; j++) { sum += arr[j]; count++; }
      out[i] = sum / count;
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Refine silence edges toward the nearest natural cut point
  // ─────────────────────────────────────────────────────────────────────────

  AudioAnalyzer.prototype._refineEdges = function (regions, cuts) {
    var out = [];
    for (var i = 0; i < regions.length; i++) {
      var r = regions[i];
      var bestStart = r.startSeconds, bestEnd = r.endSeconds;

      var minS = Infinity;
      for (var a = 0; a < cuts.length; a++) {
        var cp = cuts[a].timeSeconds;
        if (cp > r.startSeconds + 0.2) continue;
        var d = Math.abs(cp - r.startSeconds);
        if (d < minS && d < 0.3) { minS = d; bestStart = cp; }
      }

      var minE = Infinity;
      for (var b = 0; b < cuts.length; b++) {
        var cp2 = cuts[b].timeSeconds;
        if (cp2 < r.endSeconds - 0.2) continue;
        var d2 = Math.abs(cp2 - r.endSeconds);
        if (d2 < minE && d2 < 0.3) { minE = d2; bestEnd = cp2; }
      }

      if (bestEnd > bestStart + 0.1) {
        out.push({
          startSeconds: round3(bestStart),
          endSeconds:   round3(bestEnd),
          duration:     round3(bestEnd - bestStart),
          type:         r.type,
          confidence:   r.confidence,
          refined:      bestStart !== r.startSeconds || bestEnd !== r.endSeconds
        });
      }
    }
    return out;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Auto-threshold: histogram-based noise-floor detection
  // (runs over every sample, returns { noiseFloorDb, speechPeakDb, threshold })
  // ─────────────────────────────────────────────────────────────────────────

  AudioAnalyzer.prototype._detectNoiseFloor = function (samples, sampleRate) {
    var chunkMs = 50;
    var chunkSize = Math.max(1, Math.floor(sampleRate * chunkMs / 1000));
    var numChunks = Math.floor(samples.length / chunkSize);
    if (numChunks === 0) {
      return { noiseFloorDb: -60, speechPeakDb: -20, threshold: -40, totalChunks: 0 };
    }

    // Build histogram: 100 bins spanning -100dB .. 0dB
    var bins = new Array(100);
    for (var b = 0; b < 100; b++) bins[b] = 0;

    for (var i = 0; i < numChunks; i++) {
      var off = i * chunkSize;
      var sumSq = 0;
      for (var j = 0; j < chunkSize; j++) {
        var v = samples[off + j];
        sumSq += v * v;
      }
      var rms = Math.sqrt(sumSq / chunkSize);
      var db  = rms > 0 ? 20 * Math.log10(rms) : -100;
      var idx = Math.max(0, Math.min(99, Math.round(db + 100)));
      bins[idx]++;
    }

    // Smooth twice with 3-tap moving average
    var smoothed = bins.slice();
    for (var pass = 0; pass < 2; pass++) {
      var tmp = smoothed.slice();
      for (var k = 1; k < 99; k++) {
        tmp[k] = (smoothed[k - 1] + smoothed[k] + smoothed[k + 1]) / 3;
      }
      smoothed = tmp;
    }

    // Noise-floor peak: strongest bin in [-100, -30) range
    var nfBin = 0, nfMax = 0;
    for (var x = 0; x < 70; x++) {
      if (smoothed[x] > nfMax) { nfMax = smoothed[x]; nfBin = x; }
    }
    var noiseFloorDb = nfBin - 100;

    // Speech peak: strongest bin above noise floor (+5 bin gap)
    var spBin = Math.min(99, nfBin + 10), spMax = 0;
    for (var y = nfBin + 5; y < 100; y++) {
      if (smoothed[y] > spMax) { spMax = smoothed[y]; spBin = y; }
    }
    var speechPeakDb = spBin - 100;

    // Threshold: halfway between noise floor & speech peak (at least +6 dB above floor)
    var mid      = (noiseFloorDb + speechPeakDb) / 2;
    var thresh   = Math.round(Math.max(noiseFloorDb + 6, mid));

    return {
      noiseFloorDb: noiseFloorDb,
      speechPeakDb: speechPeakDb,
      threshold:    thresh,
      totalChunks:  numChunks
    };
  };

  // Exports (CEP panel is browser-like; also expose on CommonJS if loaded that way)
  global.AudioAnalyzer = AudioAnalyzer;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = AudioAnalyzer;
  }
})(typeof window !== "undefined" ? window : this);
