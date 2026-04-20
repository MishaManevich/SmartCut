/**
 * SmartCut — License module (Paddle-backed, via our own backend)
 *
 * ─── Architecture ───────────────────────────────────────────────────────────
 *    Premiere panel  →  Cloudflare Worker  →  Paddle API / KV
 *
 *    - Paddle.js overlay collects payment on trysmartcut.com (MoR)
 *    - Paddle webhooks → our Worker → KV (license records)
 *    - Worker emails the newly minted license key to the buyer (Resend)
 *    - Panel calls POST /verify        to activate & revalidate
 *    - Panel calls POST /download-url  to get a short-lived signed URL to
 *                                      the latest .zxp in R2
 *    - Panel calls POST /portal-url    to open the Paddle Customer Portal
 *                                      (cancel, change card, switch plan)
 *
 * See `tools/license-worker/` for the Worker and PADDLE-SETUP.md for the
 * one-time Paddle Dashboard configuration.
 *
 * ─── Pricing ───────────────────────────────────────────────────────────────
 *   Monthly  — $29.99/mo
 *   Annual   — $199/year     (~45% vs monthly)
 *   Lifetime — $49 one-time  (launch special)
 *
 * ─── Protocol (backend ↔ client) ───────────────────────────────────────────
 *   POST /verify
 *     Body:    { licenseKey, machineId, machineMeta, activation, app }
 *     Returns: { ok, kind, email, plan, activationsUsed, activationsMax,
 *                expiresAt } | { ok:false, reason, message }
 *
 *   POST /download-url
 *     Body:    { licenseKey, machineId, platform }
 *     Returns: { ok, url, version, expiresAt } | { ok:false, reason, message }
 *
 *   POST /portal-url
 *     Body:    { licenseKey, machineId }
 *     Returns: { ok, url } | { ok:false, reason, message }
 */
(function (global) {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIG — edit these URLs before shipping (see PADDLE-SETUP.md)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // BACKEND_BASE: your deployed Cloudflare Worker.
  //
  // PRICING_URL:  public pricing page on trysmartcut.com. "Upgrade" buttons
  //               in the extension open this in the system browser — the
  //               landing page then fires the Paddle.js overlay when the
  //               user picks a plan. We can't trigger the overlay from
  //               inside Premiere's CEP panel, so all in-extension purchase
  //               buttons route through here.
  //
  // MANAGE_URL:   fallback used for lifetime buyers (no sub portal) and for
  //               errors. For subscribers we mint a one-click Paddle
  //               Customer Portal session via the backend (requestPortalUrl).
  // ═══════════════════════════════════════════════════════════════════════════

  // Using the workers.dev URL directly for now — the custom domain
  // (license.trysmartcut.com) is cosmetic only and can be wired up later
  // without any code change other than flipping this string back.
  var BACKEND_BASE    = "https://smartcut-license.patient-dust-4377.workers.dev";
  var PRICING_URL     = "https://trysmartcut.com/#pricing";       // anchor → scrolls to pricing cards
  var MANAGE_URL      = "mailto:support@trysmartcut.com";         // fallback only

  // Human-readable plan catalog for UI (kept in sync with Paddle prices).
  var PLANS = {
    monthly:  { label: "Monthly",  price: "$29.99/mo",      tagline: "Cancel anytime" },
    annual:   { label: "Annual",   price: "$199/year",      tagline: "Save ~45% vs monthly" },
    lifetime: { label: "Lifetime", price: "$49 (launch)",   tagline: "One-time payment, forever" }
  };

  // Dev-only: keys that activate without the backend. MUST stay empty in
  // builds you ship to customers (any string here is effectively a master license).
  // For local testing, add a throwaway entry and remove before packaging.
  var DEV_MASTER_KEYS = [];

  var STORAGE_KEY        = "SMARTCUT_LICENSE_V2";
  var LEGACY_KEY         = "smartcut_license";
  var LEGACY_EDITS_KEY   = "smartcut_trial_edits";

  var TRIAL_DAYS         = 7;
  var TRIAL_MAX_EDITS    = 10;
  var OFFLINE_GRACE_DAYS = 14;   // hard wall: after this many offline days the
                                 // extension blocks until it can phone home.
                                 // 14d matches the industry default (Adobe CC
                                 // itself is 30d) and gives editors plenty of
                                 // room for location shoots / travel without
                                 // ever seeing a "please connect" nag.
                                 // Silent background refresh below resets the
                                 // counter whenever the user is online, so
                                 // honest users never notice this wall at all.
  var SILENT_REFRESH_DAYS = 1;   // soft target: try to silently re-verify this
                                 // often when the user is online. Failures are
                                 // ignored — only the hard wall blocks usage.
  var _bgRevalidateInFlight = false;  // guards against duplicate in-flight calls

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
    // Main pricing page — all three plans live there. Used by every
    // "Upgrade" / "Buy" button inside Premiere. We can't trigger the
    // Paddle.js overlay from inside the CEP panel (the overlay has to
    // run on trysmartcut.com where Paddle.js is initialized with our
    // client token), so we always route the user to the website and
    // let them pick the plan there.
    BUY_URL:         PRICING_URL,
    PRICING_URL:     PRICING_URL,
    PLANS:           PLANS,
    MANAGE_URL:      MANAGE_URL,      // lifetime fallback
    BACKEND_BASE:    BACKEND_BASE,
    TRIAL_DAYS:      TRIAL_DAYS,
    TRIAL_MAX_EDITS: TRIAL_MAX_EDITS,

    // Opens the pricing page with a hint of which plan the user came for.
    // The landing page reads ?plan=<slug> and can auto-scroll/highlight the
    // matching card. Unknown plans just land on #pricing.
    checkoutUrlFor: function (plan) {
      if (plan === "monthly" || plan === "annual" || plan === "lifetime") {
        return "https://trysmartcut.com/?plan=" + plan + "#pricing";
      }
      return PRICING_URL;
    },

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
          activationsMax:  resp.activationsMax  || 2,
          expiresAt:       resp.expiresAt || null
        };
        saveEnvelope(env);
        return { ok: true, kind: "full", email: env.purchaseEmail };
      }).catch(function (err) {
        return { ok: false, message: "Could not reach license server (" + (err.message || err) + "). Check your internet and try again." };
      });
    },

    // Fire-and-forget: if the user is online and we haven't revalidated in a
    // while, silently refresh `lastCheckAt` so they never actually hit the
    // OFFLINE_GRACE_DAYS wall during normal use. Network failures are ignored
    // (they just stay on their current envelope). Call this after the panel
    // opens and on a cadence while the panel is visible.
    maybeBackgroundRevalidate: function () {
      var env = loadEnvelope();
      if (!env || env.kind !== "full" || env.isDev) return;
      if (_bgRevalidateInFlight) return;
      var sinceCheck = (Date.now() - new Date(env.lastCheckAt).getTime()) / 864e5;
      if (sinceCheck < SILENT_REFRESH_DAYS) return;  // too soon, skip
      _bgRevalidateInFlight = true;
      License.revalidate().then(function () {})
        .catch(function () {})
        .then(function () { _bgRevalidateInFlight = false; });
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

    // Legacy in-panel trial (local only). The activation UI now sends buyers to
    // ?plan=annual on the site for Stripe/Paddle trials. Kept so old trial
    // envelopes and recordTrialEdit() still behave until those users convert.
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
    },

    // Ask the backend for a one-time Paddle Customer Portal URL bound to
    // this license's customer_id. The panel opens it in the system
    // browser so the user can cancel, change card, switch plan, etc.
    // Lifetime licenses don't have a portal — the server returns
    // { ok: false, reason: "no_subscription" } and the UI should fall
    // back to MANAGE_URL (a mailto).
    requestPortalUrl: function () {
      var env = loadEnvelope();
      if (!env || env.kind !== "full" || !env.key) {
        return Promise.resolve({ ok: false, reason: "no_license",
          message: "No active license to manage." });
      }
      if (env.isDev) {
        return Promise.resolve({ ok: false, reason: "dev_license",
          message: "Dev licenses don't have a billing portal." });
      }
      return postJSON("/portal-url", {
        licenseKey: env.key,
        machineId:  getMachineId()
      }).catch(function (err) {
        return { ok: false, reason: "network",
          message: "Could not reach license server: " + (err.message || err) };
      });
    }
  };

  global.License = License;
})(typeof window !== "undefined" ? window : this);
