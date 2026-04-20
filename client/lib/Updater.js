/**
 * SmartCut — Update checker (license-gated)
 *
 * ─── Security model ──────────────────────────────────────────────────────────
 * Unpaid users must NOT be able to download new .zxp installers. Two things
 * make that work:
 *
 *   1. The "what's the latest version?" check is public — it returns only a
 *      version string and release notes. No harm if anyone can read it.
 *
 *   2. The actual .zxp download URL is never public. When the user clicks
 *      "Download update", the panel asks the license server for a
 *      short-lived (≤10 min), machine-bound, signed URL. The server verifies
 *      the caller's license before generating it. This means:
 *         - unpaid users never see a working download link
 *         - expired/refunded licenses can't download either (server rejects)
 *         - leaked URLs stop working after a few minutes
 *         - moving the binary behind the server is hosting-agnostic (R2, S3,
 *           Cloudflare Stream, GitHub private repo + raw download, …)
 *
 * See tools/license-worker/ for the matching server-side implementation.
 *
 * ─── Public endpoints ────────────────────────────────────────────────────────
 *   GET  <BACKEND>/latest-version
 *     → { version: "1.2.3", notes: "…", releasedAt: "ISO" }
 *
 *   POST <BACKEND>/download-url    (license-gated — called via License.js)
 *     → { ok: true, url: "https://…signed-url…", expiresAt, version }
 *
 * Customise BACKEND_BASE if you host the API on a separate domain from the
 * license endpoints. By default we reuse License.BACKEND_BASE so there's a
 * single source of truth.
 */
(function (global) {
  "use strict";

  var CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-check every 6h
  var LAST_CHECK_KEY    = "SMARTCUT_LAST_UPDATE_CHECK";
  var LAST_KNOWN_KEY    = "SMARTCUT_LAST_KNOWN_VERSION";

  function getBackendBase() {
    if (global.License && global.License.BACKEND_BASE) {
      return global.License.BACKEND_BASE;
    }
    return "https://license.trysmartcut.com"; // ← fallback, edit to taste
  }

  function getCurrentVersion() {
    try {
      var CSInterface = global.CSInterface;
      var csi = new CSInterface();
      var root = csi.getSystemPath("extension")
        .replace(/^file:/, "")
        .replace(/%20/g, " ");
      if (root.charAt(0) !== "/") root = "/" + root;
      var fs   = require("fs");
      var path = require("path");
      var xml  = fs.readFileSync(path.join(root, "CSXS", "manifest.xml"), "utf8");
      var m = xml.match(/ExtensionBundleVersion="([^"]+)"/);
      return m ? m[1] : "0.0.0";
    } catch (e) { return "0.0.0"; }
  }

  function cmpSemver(a, b) {
    var pa = String(a).split(".").map(function (x) { return parseInt(x, 10) || 0; });
    var pb = String(b).split(".").map(function (x) { return parseInt(x, 10) || 0; });
    for (var i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return  1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

  var Updater = {
    check: function (force) {
      var current = getCurrentVersion();
      var last = parseInt(localStorage.getItem(LAST_CHECK_KEY) || "0", 10);

      if (!force && last && (Date.now() - last) < CHECK_INTERVAL_MS) {
        var known = localStorage.getItem(LAST_KNOWN_KEY);
        if (known && cmpSemver(known, current) > 0) {
          return Promise.resolve({
            updateAvailable: true, current: current, latest: known, cached: true
          });
        }
        return Promise.resolve({ updateAvailable: false, current: current, cached: true });
      }

      return fetch(getBackendBase() + "/latest-version", {
        method: "GET",
        headers: { "Accept": "application/json" }
      }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (rel) {
        var latest = String(rel.version || "").replace(/^v/, "");
        localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        if (latest) localStorage.setItem(LAST_KNOWN_KEY, latest);

        if (latest && cmpSemver(latest, current) > 0) {
          return {
            updateAvailable: true,
            current:         current,
            latest:          latest,
            notes:           rel.notes || "",
            releasedAt:      rel.releasedAt || null
          };
        }
        return { updateAvailable: false, current: current, latest: latest };
      }).catch(function (err) {
        return { updateAvailable: false, current: current, error: err.message || String(err) };
      });
    },

    // Asks the license server for a signed download URL, then opens it in
    // the user's default browser. Returns a Promise so the caller can show
    // a spinner and error messages.
    downloadLatest: function () {
      if (!global.License || !global.License.requestDownloadUrl) {
        return Promise.resolve({
          ok: false,
          message: "License module unavailable."
        });
      }
      return global.License.requestDownloadUrl().then(function (resp) {
        if (!resp.ok || !resp.url) {
          return {
            ok: false,
            message: resp.message ||
              "Could not get a download link. Trial users need to purchase SmartCut to receive updates."
          };
        }
        Updater.openURL(resp.url);
        return { ok: true, version: resp.version, url: resp.url };
      });
    },

    openURL: function (url) {
      try {
        if (global.CSInterface) {
          new global.CSInterface().openURLInDefaultBrowser(url);
          return;
        }
      } catch (e) {}
      try { global.open(url, "_blank"); } catch (e2) {}
    },

    currentVersion: getCurrentVersion
  };

  global.Updater = Updater;
})(typeof window !== "undefined" ? window : this);
