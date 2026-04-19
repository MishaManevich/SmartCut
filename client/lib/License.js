/**
 * SmartCut — License module (Paddle-backed, via our own backend)
 *
 * ─── Why a backend? ──────────────────────────────────────────────────────────
 * We used to point the panel at a payment provider's public verify endpoint
 * (Gumroad). That was simple but tightly coupled the client to one provider
 * and — more importantly — left release-download URLs publicly reachable. If
 * you switch payment providers (Paddle → Stripe, etc) the client has to be
 * re-released.
 *
 * The right shape for a paid CEP/Electron app is:
 *
 *    Premiere panel  →  your backend  →  Paddle API / database
 *
 *    - Paddle webhooks ingest purchases and refunds into the backend
 *    - Backend stores { licenseKey, email, transactionId, machineIds[],
 *      status, expiresAt }
 *    - Panel calls POST <BACKEND>/verify to activate & revalidate
 *    - Panel calls POST <BACKEND>/download-url to get a signed, short-lived
 *      URL to the latest .zxp — so unpaid users can never grab the binary
 *
 * See `tools/license-worker/` for a reference Cloudflare Worker that
 * implements the whole contract.
 *
 * ─── Protocol (backend ↔ client) ─────────────────────────────────────────────
 * Both endpoints accept JSON and return JSON.
 *
 *   POST <BACKEND>/verify
 *   Body:    { licenseKey, machineId, machineMeta: { hostname, cpu }, app: { version, os } }
 *   Returns: { ok: true,  kind: "full",  email, activationsUsed, activationsMax, expiresAt }
 *            { ok: false, reason, message }
 *
 *   POST <BACKEND>/download-url
 *   Body:    { licenseKey, machineId }
 *   Returns: { ok: true, url, expiresAt, version }
 *            { ok: false, reason, message }
 *
 * The backend verifies the key exists, isn't refunded/chargebacked, and that
 * the machine is already activated (or under the activation cap). The
 * license key is the one Paddle returns to the customer after checkout.
 */
(function (global) {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIG — edit these two values before shipping
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // BACKEND_BASE: your deployed license server (Cloudflare Worker / Vercel /
  // Fly / Render — anything that speaks HTTPS). See tools/license-worker/.
  //
  // CHECKOUT_URL: your Paddle product checkout link. Paddle delivers the
  // license key to the customer's email after purchase.
  // ═══════════════════════════════════════════════════════════════════════════

  var BACKEND_BASE = "https://license.smartcutpro.app"; // ← CHANGE ME
  var CHECKOUT_URL = "https://pay.smartcutpro.app/checkout"; // ← CHANGE ME (Paddle checkout URL)
  // Paddle customer portal URL — where paying customers go to cancel,
  // update card, change plan, download invoices. Paddle gives you a
  // per-product portal link in the dashboard. Falls back to CHECKOUT_URL
  // if not configured.
  var MANAGE_URL   = "https://pay.smartcutpro.app/account"; // ← CHANGE ME (Paddle customer portal URL)

  // Dev master keys — activate locally without touching the backend. Remove
  // or leave intact before shipping; they're only useful while BACKEND_BASE
  // isn't reachable. Any key matching one of these activates as a full
  // license bound to the current machine with no expiry.
  var DEV_MASTER_KEYS = [
    "SCP-DEV-4F9A-BEEF-CAFE-2026"
  ];

  var STORAGE_KEY        = "SMARTCUT_LICENSE_V2";
  var LEGACY_KEY         = "smartcut_license";
  var LEGACY_EDITS_KEY   = "smartcut_trial_edits";

  var TRIAL_DAYS         = 7;
  var TRIAL_MAX_EDITS    = 10;
  var OFFLINE_GRACE_DAYS = 14;   // how long a valid license works without re-check

  // ─── Machine fingerprint ──────────────────────────────────────────────────
  function getMachineId() {
    try {
      var os   = require("os");
      var host = os.hostname() || "unknown";
      var home = os.homedir() || "unknown";
      var cpu  = (os.cpus()[0] && os.cpus()[0].model) || "unknown";
      return simpleHash(host + "|" + home + "|" + cpu);
    } catch (e) {
      return "cep-fallback-" + simpleHash(navigator.userAgent || "ua");
    }
  }

  function getMachineMeta() {
    try {
      var os = require("os");
      return {
        hostname: os.hostname(),
        cpu:      (os.cpus()[0] && os.cpus()[0].model) || "",
        platform: os.platform(),
        release:  os.release()
      };
    } catch (e) { return { platform: "cep" }; }
  }

  function simpleHash(str) {
    var h = 5381, i;
    for (i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
    return (h >>> 0).toString(36);
  }

  // Returns "mac" | "win" | "unknown" — used to request the correct .zxp.
  function detectPlatform() {
    try {
      var os = require("os");
      var p  = (os.platform() || "").toLowerCase();
      if (p === "darwin")         return "mac";
      if (p.indexOf("win") === 0) return "win";
    } catch (e) {}
    // Fallback for contexts where node os isn't available.
    var ua = (navigator && navigator.userAgent || "").toLowerCase();
    if (ua.indexOf("mac") !== -1)     return "mac";
    if (ua.indexOf("windows") !== -1) return "win";
    return "unknown";
  }

  function getCurrentVersion() {
    try {
      if (global.Updater && global.Updater.currentVersion) return global.Updater.currentVersion();
    } catch (e) {}
    return "0.0.0";
  }

  // ─── Envelope I/O ─────────────────────────────────────────────────────────
  function loadEnvelope() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveEnvelope(env) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
  }
  function clearEnvelope() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // ─── Backend I/O ──────────────────────────────────────────────────────────
  function postJSON(path, body) {
    return fetch(BACKEND_BASE + path, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, reason: "bad_response",
          message: "Server returned HTTP " + r.status };
      });
    });
  }

  function verifyRemote(licenseKey, isActivation) {
    return postJSON("/verify", {
      licenseKey:  licenseKey,
      machineId:   getMachineId(),
      machineMeta: getMachineMeta(),
      activation:  !!isActivation,
      app: {
        version: getCurrentVersion(),
        os:      getMachineMeta().platform || ""
      }
    });
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  var License = {
    BUY_URL:         CHECKOUT_URL,
    MANAGE_URL:      MANAGE_URL,
    BACKEND_BASE:    BACKEND_BASE,
    TRIAL_DAYS:      TRIAL_DAYS,
    TRIAL_MAX_EDITS: TRIAL_MAX_EDITS,

    check: function () {
      var env = loadEnvelope();

      // Migrate legacy v1 trial if present.
      if (!env) {
        var legacy = null;
        try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null"); }
        catch (e) {}
        if (legacy && legacy.type === "trial") {
          env = {
            kind:        "trial",
            trialStart:  legacy.start,
            trialEdits:  parseInt(localStorage.getItem(LEGACY_EDITS_KEY) || "0"),
            machineId:   getMachineId()
          };
          saveEnvelope(env);
          localStorage.removeItem(LEGACY_KEY);
          localStorage.removeItem(LEGACY_EDITS_KEY);
        }
      }

      if (!env) {
        return { ok: false, reason: "not_activated",
          message: "No license found.", canRetryOnline: false };
      }

      if (env.machineId && env.machineId !== getMachineId()) {
        return { ok: false, reason: "wrong_machine",
          message: "This license is activated on another machine. Deactivate there first or contact support.",
          canRetryOnline: false };
      }

      if (env.kind === "trial") {
        var days = (Date.now() - new Date(env.trialStart).getTime()) / 864e5;
        var editsLeft = Math.max(0, TRIAL_MAX_EDITS - (env.trialEdits || 0));
        if (days > TRIAL_DAYS) {
          return { ok: false, reason: "trial_expired",
            message: "Your 7-day free trial has ended.", canRetryOnline: false };
        }
        if (editsLeft <= 0) {
          return { ok: false, reason: "trial_used_up",
            message: "Trial limit of " + TRIAL_MAX_EDITS + " edits reached.",
            canRetryOnline: false };
        }
        return {
          ok: true, kind: "trial",
          daysLeft: Math.ceil(TRIAL_DAYS - days), editsLeft: editsLeft
        };
      }

      if (env.kind === "full") {
        // Backend-signalled expiry (subscription).
        if (env.expiresAt && new Date(env.expiresAt).getTime() < Date.now()) {
          return { ok: false, reason: "subscription_expired",
            message: "Your subscription has ended. Renew to continue.",
            canRetryOnline: true };
        }
        var sinceCheck = (Date.now() - new Date(env.lastCheckAt).getTime()) / 864e5;
        if (sinceCheck > OFFLINE_GRACE_DAYS) {
          return { ok: false, reason: "needs_online",
            message: "Please connect to the internet to revalidate your license (once every " +
                     OFFLINE_GRACE_DAYS + " days).",
            canRetryOnline: true,
            envelope: env };
        }
        return { ok: true, kind: "full", key: env.key };
      }

      return { ok: false, reason: "invalid", message: "Corrupt license envelope." };
    },

    activate: function (rawKey) {
      var key = String(rawKey || "").trim();
      if (!key) {
        return Promise.resolve({ ok: false, message: "Enter a license key." });
      }
      // ─── Dev master-key short-circuit ─────────────────────────────────────
      if (DEV_MASTER_KEYS.indexOf(key.toUpperCase()) !== -1) {
        var devEnv = {
          kind:            "full",
          key:             key,
          machineId:       getMachineId(),
          activatedAt:     new Date().toISOString(),
          lastCheckAt:     new Date().toISOString(),
          purchaseEmail:   "dev@smartcutpro.local",
          activationsUsed: 1,
          activationsMax:  999,
          expiresAt:       null,
          isDev:           true
        };
        saveEnvelope(devEnv);
        return Promise.resolve({ ok: true, kind: "full", email: devEnv.purchaseEmail, dev: true });
      }
      return verifyRemote(key, true).then(function (resp) {
        if (!resp || !resp.ok) {
          return { ok: false, message: (resp && resp.message) || "License key not recognized." };
        }
        var env = {
          kind:            "full",
          key:             key,
          machineId:       getMachineId(),
          activatedAt:     new Date().toISOString(),
          lastCheckAt:     new Date().toISOString(),
          purchaseEmail:   resp.email || null,
          activationsUsed: resp.activationsUsed || 1,
          activationsMax:  resp.activationsMax  || 3,
          expiresAt:       resp.expiresAt || null
        };
        saveEnvelope(env);
        return { ok: true, kind: "full", email: env.purchaseEmail };
      }).catch(function (err) {
        return { ok: false, message: "Could not reach license server (" + (err.message || err) + "). Check your internet and try again." };
      });
    },

    revalidate: function () {
      var env = loadEnvelope();
      if (!env || env.kind !== "full") {
        return Promise.resolve({ ok: false, message: "No full license to revalidate." });
      }
      // Dev keys never hit the server.
      if (env.isDev) {
        env.lastCheckAt = new Date().toISOString();
        saveEnvelope(env);
        return Promise.resolve({ ok: true, dev: true });
      }
      return verifyRemote(env.key, false).then(function (resp) {
        if (!resp || !resp.ok) {
          if (resp && (resp.reason === "refunded" || resp.reason === "revoked")) {
            clearEnvelope();
          }
          return { ok: false, message: (resp && resp.message) || "License no longer valid." };
        }
        env.lastCheckAt = new Date().toISOString();
        env.expiresAt   = resp.expiresAt || env.expiresAt;
        saveEnvelope(env);
        return { ok: true };
      }).catch(function (err) {
        return { ok: false, message: "Network error: " + (err.message || err) };
      });
    },

    startTrial: function () {
      var env = loadEnvelope();
      if (env && env.trialStart) {
        return { ok: false, message: "A trial has already been used on this machine." };
      }
      if (localStorage.getItem(LEGACY_KEY)) {
        return { ok: false, message: "A trial has already been used on this machine." };
      }
      env = {
        kind:       "trial",
        trialStart: new Date().toISOString(),
        trialEdits: 0,
        machineId:  getMachineId()
      };
      saveEnvelope(env);
      return { ok: true, kind: "trial" };
    },

    recordTrialEdit: function () {
      var env = loadEnvelope();
      if (!env || env.kind !== "trial") return;
      env.trialEdits = (env.trialEdits || 0) + 1;
      saveEnvelope(env);
    },

    info: function () {
      var env = loadEnvelope() || {};
      return {
        kind:          env.kind || "none",
        key:           env.key || null,
        email:         env.purchaseEmail || null,
        activatedAt:   env.activatedAt || null,
        trialStart:    env.trialStart || null,
        trialEdits:    env.trialEdits || 0,
        machineId:     getMachineId(),
        expiresAt:     env.expiresAt || null
      };
    },

    deactivate: function () {
      var env = loadEnvelope();
      if (env && env.kind === "full" && env.key) {
        // Best-effort: tell backend to decrement the activation count.
        postJSON("/deactivate", {
          licenseKey: env.key,
          machineId:  getMachineId()
        }).catch(function () {});
      }
      clearEnvelope();
      return { ok: true };
    },

    // Used by Updater.js to request an authenticated download URL.
    // Returns a Promise resolving to { ok, url, version, expiresAt } or
    // { ok: false, reason, message }.
    //
    // We include the detected platform so the backend can hand back the
    // right .zxp — Mac and Windows ship as separate installers because of
    // the bundled whisper-cli binary. The backend falls back to the
    // platform-less filename if it hasn't been uploaded per-platform yet.
    requestDownloadUrl: function () {
      var env = loadEnvelope();
      if (!env || env.kind !== "full" || !env.key) {
        return Promise.resolve({ ok: false, reason: "no_license",
          message: "A valid license is required to download updates." });
      }
      return postJSON("/download-url", {
        licenseKey: env.key,
        machineId:  getMachineId(),
        platform:   detectPlatform()
      }).catch(function (err) {
        return { ok: false, reason: "network",
          message: "Could not reach update server: " + (err.message || err) };
      });
    }
  };

  global.License = License;
})(typeof window !== "undefined" ? window : this);
