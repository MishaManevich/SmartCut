/**
 * CSInterface.js — Adobe CEP Interface Library
 * SmartCut — Fixed version.
 *
 * CRITICAL FIX:
 *   The real Adobe __adobe_cep__.evalScript() is ASYNCHRONOUS. It does NOT
 *   return the ExtendScript result directly. Instead, it accepts a callback
 *   as the second argument. The previous version called callback(result) where
 *   result was the synchronous return value of evalScript — which is always
 *   undefined in the real CEP runtime — causing "Unexpected token u in JSON
 *   at position 0" on every single call.
 *
 *   Correct usage:
 *     __adobe_cep__.evalScript(script, function(result) { ... });
 *
 * For the official full-featured CSInterface, see:
 *   https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_11.x/CSInterface.js
 */

var CSInterface = function () {
  this._listeners = {};
};

// ─── evalScript (THE critical fix) ─────────────────────────────────────────

/**
 * Evaluates an ExtendScript expression in the host application.
 *
 * @param {string}   script   - The ExtendScript to evaluate
 * @param {function} callback - Called with (result: string) when done.
 *                              result is always a string (or "undefined" on error).
 */
CSInterface.prototype.evalScript = function (script, callback) {
  if (typeof __adobe_cep__ !== "undefined") {
    // FIXED: Pass callback as second argument — this is the correct async API.
    // __adobe_cep__.evalScript does NOT return the result synchronously.
    if (callback) {
      __adobe_cep__.evalScript(script, function (result) {
        // Guard: if ExtendScript returned nothing, give back a safe empty object
        // string so callers never receive undefined.
        if (result === undefined || result === null || result === "undefined") {
          result = '{"error":"ExtendScript returned no value"}';
        }
        callback(result);
      });
    } else {
      __adobe_cep__.evalScript(script);
    }
  } else {
    // ── Development / outside-Premiere fallback ──────────────────────────
    // Simulate async behavior with setTimeout so callers can't accidentally
    // depend on synchronous execution.
    console.warn("[CSInterface] Running outside Adobe host — returning mock data.");
    if (!callback) return;

    var mockResult;
    if (script.indexOf("getActiveSequenceInfo") >= 0) {
      mockResult = JSON.stringify({
        name: "Demo Sequence",
        id: "demo-seq-001",
        framerate: 29.97,
        duration: 120,
        videoTrackCount: 3,
        audioTrackCount: 2
      });
    } else if (script.indexOf("getScopeInfo") >= 0) {
      mockResult = JSON.stringify({
        sequence: {
          name: "Demo Sequence",
          duration: 120,
          videoTrackCount: 3,
          audioTrackCount: 2
        },
        selection: { clips: [] },
        inOut: { start: 0, end: 120, hasMarks: false }
      });
    } else if (script.indexOf("renameScopeTarget") >= 0) {
      mockResult = JSON.stringify({ success: true, target: "sequence", name: "Demo Sequence" });
    } else if (script.indexOf("getSourceMediaPaths") >= 0) {
      mockResult = JSON.stringify({
        paths: [{
          trackIndex: 0,
          clipIndex: 0,
          name: "Interview.mp4",
          path: "/mock/path/interview.mp4",
          start: 0,
          end: 120,
          inPoint: 0,
          outPoint: 120
        }]
      });
    } else if (script.indexOf("getAudioClipInfo") >= 0) {
      mockResult = JSON.stringify({
        clips: [{
          trackIndex: 0, clipIndex: 0,
          name: "Interview.mp4",
          start: 0, end: 120, duration: 120,
          mediaPath: "/mock/path/interview.mp4"
        }]
      });
    } else if (script.indexOf("applyCuts") >= 0) {
      mockResult = JSON.stringify({ success: true, cutsApplied: 3, totalRegions: 3, errors: [] });
    } else if (script.indexOf("setPlayheadPosition") >= 0) {
      mockResult = JSON.stringify({ success: true, position: 0 });
    } else if (script.indexOf("undoLastAction") >= 0) {
      mockResult = JSON.stringify({ success: true });
    } else {
      mockResult = "{}";
    }

    setTimeout(function () { callback(mockResult); }, 0);
  }
};

// ─── System Paths ───────────────────────────────────────────────────────────

CSInterface.prototype.EXTENSION_PATH = "extension";
CSInterface.prototype.USER_DATA_PATH = "userData";

CSInterface.prototype.getSystemPath = function (pathType) {
  if (typeof __adobe_cep__ !== "undefined") {
    return __adobe_cep__.getSystemPath(pathType);
  }
  if (pathType === "extension") return "/mock/extension/path";
  return "/mock/path";
};

// ─── Host Environment ────────────────────────────────────────────────────────

CSInterface.prototype.getHostEnvironment = function () {
  if (typeof __adobe_cep__ !== "undefined") {
    try { return JSON.parse(__adobe_cep__.getHostEnvironment()); } catch (e) { return {}; }
  }
  return {
    appName: "PPRO",
    appVersion: "24.0",
    appLocale: "en_US",
    appUILocale: "en_US",
    appId: "PPRO",
    isAppOnline: true
  };
};

// ─── Event Listeners ────────────────────────────────────────────────────────

CSInterface.prototype.addEventListener = function (type, listener, obj) {
  if (typeof __adobe_cep__ !== "undefined") {
    __adobe_cep__.addEventListener(type, listener, obj);
  }
};

CSInterface.prototype.removeEventListener = function (type, listener, obj) {
  if (typeof __adobe_cep__ !== "undefined") {
    __adobe_cep__.removeEventListener(type, listener, obj);
  }
};

// ─── Extension Control ──────────────────────────────────────────────────────

CSInterface.prototype.closeExtension = function () {
  if (typeof __adobe_cep__ !== "undefined") {
    __adobe_cep__.closeExtension();
  }
};

// ─── Open URL in system browser (required for checkout / pricing links) ─────

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  if (!url) return;
  try {
    if (typeof cep !== "undefined" && cep.util && typeof cep.util.openURLInDefaultBrowser === "function") {
      cep.util.openURLInDefaultBrowser(url);
      return;
    }
  } catch (e) {}
  try {
    if (typeof __adobe_cep__ !== "undefined" && typeof __adobe_cep__.openURLInDefaultBrowser === "function") {
      __adobe_cep__.openURLInDefaultBrowser(url);
      return;
    }
  } catch (e2) {}
  try {
    window.open(url, "_blank");
  } catch (e3) {}
};
