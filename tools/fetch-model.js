#!/usr/bin/env node
/**
 * Download the all-MiniLM-L6-v2 model + tokenizer from HuggingFace into
 * models/Xenova/all-MiniLM-L6-v2/ in the exact directory layout that
 * transformers.js expects when env.localModelPath is set.
 *
 * Only downloaded files: the int8-quantized ONNX model (~23 MB) and the
 * tokenizer/config JSON files (<1 MB total). We do NOT download the full
 * fp32 model (~90 MB) — int8 is indistinguishable for sentence similarity.
 */

const fs   = require("fs");
const path = require("path");
const https = require("https");

const REPO   = "Xenova/all-MiniLM-L6-v2";
const BASE   = "https://huggingface.co/" + REPO + "/resolve/main/";
const OUTDIR = path.resolve(__dirname, "../models/" + REPO);

const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx"
];

function download(relPath) {
  return new Promise(function (resolve, reject) {
    const url = BASE + relPath;
    const out = path.join(OUTDIR, relPath);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    // Skip if already present and non-empty
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      const sz = (fs.statSync(out).size / 1024).toFixed(1);
      console.log("  [skip] " + relPath + " (" + sz + " KB — already present)");
      return resolve();
    }

    console.log("  [get] " + relPath);
    const file = fs.createWriteStream(out);
    const req  = https.get(url, function handle(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        file.close();
        fs.unlinkSync(out);
        const redirUrl = new URL(res.headers.location, url).toString();
        const redirFile = fs.createWriteStream(out);
        https.get(redirUrl, function (r2) {
          r2.pipe(redirFile);
          redirFile.on("finish", function () {
            redirFile.close();
            const sz = (fs.statSync(out).size / 1024).toFixed(1);
            console.log("    → " + sz + " KB");
            resolve();
          });
        }).on("error", reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(out);
        return reject(new Error("HTTP " + res.statusCode + " for " + url));
      }
      res.pipe(file);
      file.on("finish", function () {
        file.close();
        const sz = (fs.statSync(out).size / 1024).toFixed(1);
        console.log("    → " + sz + " KB");
        resolve();
      });
    });
    req.on("error", reject);
  });
}

(async function () {
  fs.mkdirSync(OUTDIR, { recursive: true });
  console.log("Downloading " + REPO + " → " + OUTDIR);
  for (const f of FILES) {
    try { await download(f); }
    catch (e) { console.error("  [fail] " + f + ": " + e.message); process.exit(1); }
  }
  console.log("[ok] model + tokenizer in place");
})();
