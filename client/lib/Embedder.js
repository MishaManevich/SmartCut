/**
 * SmartCut — Sentence Embedder (v9.2)
 *
 * Thin wrapper around @huggingface/transformers running all-MiniLM-L6-v2 int8
 * via WASM. 100% local, no network, no API keys.
 *
 * Public API:
 *   Embedder.isAvailable()                  → boolean (model + runtime on disk?)
 *   Embedder.load(onProgress)               → Promise<void>   (lazy; idempotent)
 *   Embedder.embed(texts)                   → Promise<Array<Float32Array>>
 *   Embedder.cosineSimilarity(a, b)         → number ∈ [-1, 1]
 *
 * Embeddings are L2-normalized, so cosine similarity is just the dot product.
 */
(function (global) {
  "use strict";

  var Embedder = {};
  var extractor     = null;
  var loadingPromise = null;
  var loadedOnce    = false;

  // Same trick as Transcriber.js — CEP's getSystemPath can return a file:/ URL
  // with URL-encoded spaces, which Node's fs can't consume.
  function normalizeCEPPath(p) {
    if (!p) return p;
    try { p = decodeURIComponent(p); } catch (e) {}
    p = p.replace(/^file:\/*/i, "");
    var isWin = (typeof process !== "undefined" && process.platform === "win32");
    if (!isWin && p.charAt(0) !== "/") p = "/" + p;
    return p;
  }

  function getExtensionRoot() {
    if (typeof CSInterface !== "undefined") {
      try {
        var cs = new CSInterface();
        var r  = cs.getSystemPath(cs.EXTENSION_PATH || "extension");
        if (r) return normalizeCEPPath(r);
      } catch (e) {}
    }
    return ".";
  }

  Embedder.isAvailable = function () {
    try {
      if (typeof window.transformers === "undefined") return false;
      var fs   = require("fs");
      var path = require("path");
      var root = getExtensionRoot();
      var model = path.join(root, "models", "Xenova", "all-MiniLM-L6-v2", "onnx", "model_quantized.onnx");
      var wasm  = path.join(root, "bin", "ort-wasm", "ort-wasm-simd-threaded.jsep.wasm");
      return fs.existsSync(model) && fs.existsSync(wasm);
    } catch (e) { return false; }
  };

  Embedder.load = function (onProgress) {
    if (extractor) return Promise.resolve(extractor);
    if (loadingPromise) return loadingPromise;

    var tf = window.transformers;
    if (!tf) return Promise.reject(new Error("transformers.js bundle not loaded"));

    var root       = getExtensionRoot();
    var modelDir   = (root + "/models/").replace(/\/+/g, "/");
    var wasmDir    = (root + "/bin/ort-wasm/").replace(/\/+/g, "/");

    // Tell transformers.js where to find local models and ORT WASM.
    // allowRemoteModels=false → refuse to silently hit HuggingFace if a file
    // is missing; we want hard failures so we know something's wrong.
    tf.env.allowLocalModels  = true;
    tf.env.allowRemoteModels = false;
    tf.env.localModelPath    = modelDir;
    tf.env.useBrowserCache   = false;
    tf.env.useFSCache        = false;
    // WASM backend paths — must be a trailing-slash URL/path.
    if (tf.env.backends && tf.env.backends.onnx && tf.env.backends.onnx.wasm) {
      tf.env.backends.onnx.wasm.wasmPaths = wasmDir;
      // Single-threaded is safer in CEP (SharedArrayBuffer / COOP/COEP aren't
      // guaranteed). Setting numThreads=1 trades ~2x speed for compatibility.
      tf.env.backends.onnx.wasm.numThreads = 1;
    }

    loadingPromise = tf.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "q8",                          // int8-quantized ONNX
      progress_callback: function (p) {
        if (typeof onProgress === "function" && p) {
          var pct = p.progress != null ? Math.round(p.progress) : null;
          onProgress(pct, p.status || "loading", p.file || "");
        }
      }
    }).then(function (pipe) {
      extractor  = pipe;
      loadedOnce = true;
      return pipe;
    }).catch(function (err) {
      loadingPromise = null;
      throw err;
    });

    return loadingPromise;
  };

  /**
   * Embed an array of text strings. Returns an array of Float32Array, one per
   * input, each L2-normalized (so cosine similarity == dot product).
   */
  Embedder.embed = function (texts) {
    if (!Array.isArray(texts)) texts = [texts];
    if (texts.length === 0) return Promise.resolve([]);

    return Embedder.load().then(function (pipe) {
      return pipe(texts, { pooling: "mean", normalize: true });
    }).then(function (tensor) {
      // tensor.dims = [N, 384]; tensor.data is a flat Float32Array
      var dim  = tensor.dims[tensor.dims.length - 1];
      var n    = tensor.dims[0];
      var data = tensor.data;
      var out  = new Array(n);
      for (var i = 0; i < n; i++) {
        // slice() on a typed array returns a copy — we want a stable view
        out[i] = data.slice(i * dim, (i + 1) * dim);
      }
      return out;
    });
  };

  Embedder.cosineSimilarity = function (a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    var sum = 0;
    for (var i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
  };

  Embedder.isLoaded = function () { return loadedOnce; };

  global.Embedder = Embedder;
})(window);
