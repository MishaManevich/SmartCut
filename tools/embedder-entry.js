/**
 * Entry for the transformers.js IIFE bundle. esbuild wraps this with a
 * globalName shim; we then expose a clean `window.transformers` object.
 */

import * as transformers from "@huggingface/transformers";

// Expose under a stable global name for the CEP panel
if (typeof window !== "undefined") {
  window.transformers = transformers;
}
