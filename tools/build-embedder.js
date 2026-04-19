#!/usr/bin/env node
/**
 * Build the transformers.js bundle for the CEP panel.
 *
 * @huggingface/transformers ships an ES module that imports onnxruntime-web.
 * We bundle the whole thing into a single IIFE so the panel can load it
 * with a plain <script> tag and get `window.transformers` populated.
 *
 * Also copies the ORT WASM binary next to the bundle so transformers.js can
 * load it at runtime without hitting a CDN.
 */

const esbuild = require("esbuild");
const fs      = require("fs");
const path    = require("path");

const ROOT        = path.resolve(__dirname, "..");
const ENTRY       = path.resolve(ROOT, "tools/embedder-entry.js");
const OUT_JS      = path.resolve(ROOT, "client/lib/transformers.bundle.js");
const OUT_WASM_DIR = path.resolve(ROOT, "bin/ort-wasm");

// Ensure output dirs exist
fs.mkdirSync(path.dirname(OUT_JS), { recursive: true });
fs.mkdirSync(OUT_WASM_DIR, { recursive: true });

// Copy the ONE WASM variant that @huggingface/transformers v3 actually uses.
// The onnxruntime-web dist folder has ~50 variants (webgpu/webgl/jspi/asyncify
// etc.) that would bloat the extension to 50MB+ — transformers only loads the
// "simd-threaded.jsep" build at runtime, so that's all we ship.
const ORT_SRC = path.resolve(ROOT, "node_modules/@huggingface/transformers/dist");
const NEEDED  = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
NEEDED.forEach(function (f) {
  const src = path.join(ORT_SRC, f);
  const dst = path.join(OUT_WASM_DIR, f);
  if (!fs.existsSync(src)) { console.error("  [missing] " + f); process.exit(1); }
  fs.copyFileSync(src, dst);
  const sz = (fs.statSync(dst).size / (1024 * 1024)).toFixed(1);
  console.log("  copied " + f + " (" + sz + " MB)");
});

// Build the IIFE bundle
esbuild.build({
  entryPoints: [ENTRY],
  bundle:      true,
  format:      "iife",
  globalName:  "__smartcut_transformers",   // temporary global; entry re-exports
  outfile:     OUT_JS,
  platform:    "browser",
  target:      ["chrome90"],   // CEP Chromium is Chrome 88+; 90 is safe
  minify:      true,
  sourcemap:   false,
  legalComments: "none",
  logLevel:    "info"
}).then(function () {
  const sz = (fs.statSync(OUT_JS).size / (1024 * 1024)).toFixed(2);
  console.log("[ok] transformers.bundle.js built — " + sz + " MB");
}).catch(function (err) {
  console.error("[fail] esbuild:", err);
  process.exit(1);
});
