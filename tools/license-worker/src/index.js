// ═══════════════════════════════════════════════════════════════════════════
// SmartCut — License Worker (Cloudflare)
// ═══════════════════════════════════════════════════════════════════════════
//
// Dual-provider — Stripe is the primary payment path, Paddle is kept live
// as a fallback. Either webhook can mint / mutate the same license record
// and the panel code stays identical (it just talks to /verify).
//
// Responsibilities:
//   1. Stripe webhooks       → store license keys in KV, reflect status
//   2. Paddle webhooks       → same, for the fallback flow
//   3. POST /verify          → verify / activate a license (panel calls)
//   4. POST /deactivate      → drop a machine from the activation list
//   5. POST /download-url    → hand back a short-lived signed URL to the
//                              latest macOS .dmg (or .zxp) in R2. License-gated.
//   6. GET  /latest-version  → public: { version, notes, releasedAt }
//   7. POST /portal-url      → mint a Paddle Customer Portal session for the
//                              caller's license (one-click "Manage sub")
//   8. POST /admin/release   → (admin-only) bump LATEST_VERSION after
//                              uploading SmartCutPro-<ver>-mac.dmg (preferred) or .zxp to R2
//   9. POST /admin/grant     → (admin-only) manually create a license
//                              (for comp copies, support overrides, etc)
//  10. GET  /lifetime-stats  → public: how many lifetime slots are left
//                              (powers the landing-page counter)
//
// ─── KV schema ──────────────────────────────────────────────────────────────
//   key:    license:<licenseKey>
//   value:  {
//     licenseKey,
//     email,
//     status: "active" | "paused" | "refunded" | "canceled" | "chargebacked",
//     plan:   "monthly" | "annual" | "lifetime",
//     provider: "paddle" | "stripe",
//     // Paddle ids (null when license came from Stripe)
//     paddleCustomerId,
//     paddleSubscriptionId | null,
//     paddleTransactionId,
//     paddlePriceId,
//     // Stripe ids (null when license came from Paddle)
//     stripeCustomerId,
//     stripeSubscriptionId | null,
//     stripeCheckoutSessionId,
//     stripePriceId,
//     createdAt,
//     expiresAt | null,                // current_period_end for subs, null for lifetime
//     machineIds: [{ id, meta, activatedAt }],
//     activationsMax
//   }
//
//   Secondary indexes (so webhooks can look up a license by provider ids):
//     Paddle:
//       paddle:ctm:<customer_id>     → licenseKey
//       paddle:sub:<subscription_id> → licenseKey
//       paddle:txn:<transaction_id>  → licenseKey    (idempotency)
//     Stripe:
//       stripe:cus:<customer_id>     → licenseKey
//       stripe:sub:<subscription_id> → licenseKey
//       stripe:ses:<session_id>      → licenseKey    (idempotency)
//       stripe:evt:<event_id>        → "1"           (event-level dedupe, 7d TTL)
//
// ═══════════════════════════════════════════════════════════════════════════

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: JSON_HEADERS });
    }

    try {
      if (url.pathname.startsWith("/download/")) {
        return handleSignedDownload(req, env);
      }
      if (url.pathname.startsWith("/get-install/")) {
        return handleGetInstall(req, env);
      }
      switch (url.pathname) {
        case "/":                         return json({ ok: true, service: "smartcut-license" });
        case "/latest-version":           return handleLatestVersion(env);
        case "/webhook/paddle":           return handlePaddleWebhook(req, env);
        case "/webhook/stripe":           return handleStripeWebhook(req, env);
        case "/verify":                   return handleVerify(req, env);
        case "/deactivate":               return handleDeactivate(req, env);
        case "/download-url":             return handleDownloadUrl(req, env);
        case "/portal-url":               return handlePortalUrl(req, env);
        case "/fulfillment":              return handleFulfillment(req, env);
        case "/lifetime-stats":           return handleLifetimeStats(env);
        case "/admin/release":            return handleAdminRelease(req, env);
        case "/admin/grant":              return handleAdminGrant(req, env);
        case "/admin/recovery-sweep":     return handleAdminRecoverySweep(req, env);
      }
      return json({ ok: false, reason: "not_found" }, 404);
    } catch (e) {
      console.error("Worker error:", e);
      return json({ ok: false, reason: "server_error",
        message: e.message || String(e) }, 500);
    }
  },

  // Cloudflare Cron Trigger — invokes this once per scheduled interval.
  // wrangler.toml declares the cron expression in [triggers.crons].
  // Each cron pattern executes this whole handler; we dispatch by event.cron.
  async scheduled(event, env, ctx) {
    // Hourly sweep for abandoned-cart recoveries.
    ctx.waitUntil((async () => {
      try {
        const result = await sweepAbandonedCarts(env);
        console.log("cart-recovery sweep:", JSON.stringify(result));
      } catch (e) {
        console.error("cart-recovery sweep failed:", e);
      }
    })());
  }
};

// ─── /latest-version (public) ───────────────────────────────────────────────
async function handleLatestVersion(env) {
  const kv = await env.LICENSES.get("__release__", "json");
  if (kv && kv.version) return json(kv);
  return json({
    version:    env.LATEST_VERSION,
    notes:      env.LATEST_NOTES || "",
    releasedAt: env.LATEST_RELEASED_AT || null
  });
}

// ─── /verify ────────────────────────────────────────────────────────────────
// Body: { licenseKey, machineId, machineMeta, activation, app }
async function handleVerify(req, env) {
  const body = await req.json().catch(() => ({}));
  const { licenseKey, machineId, machineMeta, activation } = body;
  if (!licenseKey || !machineId) {
    return json({ ok: false, reason: "bad_request",
      message: "licenseKey and machineId required" }, 400);
  }

  const rec = await getLicense(env, licenseKey);
  if (!rec) {
    return json({ ok: false, reason: "not_found",
      message: "License key not recognized." });
  }
  if (rec.status === "refunded" || rec.status === "chargebacked") {
    return json({ ok: false, reason: "refunded",
      message: "License has been refunded." });
  }
  if (rec.status === "canceled" && rec.plan !== "lifetime") {
    return json({ ok: false, reason: "canceled",
      message: "Subscription was canceled." });
  }
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) {
    return json({ ok: false, reason: "expired",
      message: "Subscription expired." });
  }

  rec.machineIds = rec.machineIds || [];
  const already = rec.machineIds.find(m => m.id === machineId);

  if (!already) {
    if (rec.machineIds.length >= (rec.activationsMax || 2)) {
      return json({ ok: false, reason: "too_many_activations",
        message: `License already activated on ${rec.activationsMax} machines. Contact support to reset.` });
    }
    if (activation) {
      rec.machineIds.push({
        id: machineId,
        meta: machineMeta || {},
        activatedAt: new Date().toISOString()
      });
      await putLicense(env, rec);
    } else {
      return json({ ok: false, reason: "unknown_machine",
        message: "This license isn't activated on this machine. Re-enter your key to activate." });
    }
  }

  return json({
    ok: true, kind: "full",
    email: rec.email || null,
    plan:  rec.plan  || null,
    activationsUsed: rec.machineIds.length,
    activationsMax:  rec.activationsMax || 2,
    expiresAt:       rec.expiresAt || null
  });
}

// ─── /deactivate ────────────────────────────────────────────────────────────
async function handleDeactivate(req, env) {
  const body = await req.json().catch(() => ({}));
  const { licenseKey, machineId } = body;
  if (!licenseKey || !machineId) return json({ ok: false }, 400);

  const rec = await getLicense(env, licenseKey);
  if (!rec) return json({ ok: true });

  rec.machineIds = (rec.machineIds || []).filter(m => m.id !== machineId);
  await putLicense(env, rec);
  return json({ ok: true });
}

// ─── /portal-url ────────────────────────────────────────────────────────────
// One-click billing: Stripe Billing Portal for Stripe subscribers, Paddle
// Customer Portal for Paddle subscribers. Lifetime (no recurring sub)
// returns no_subscription — panel falls back to mailto.
//
// Body: { licenseKey, machineId }
async function handlePortalUrl(req, env) {
  const body = await req.json().catch(() => ({}));
  const { licenseKey, machineId } = body;
  if (!licenseKey || !machineId) {
    return json({ ok: false, reason: "bad_request" }, 400);
  }
  const rec = await getLicense(env, licenseKey);
  if (!rec) {
    return json({ ok: false, reason: "not_found",
      message: "License not recognized." });
  }
  const hasMachine = (rec.machineIds || []).some(m => m.id === machineId);
  if (!hasMachine) {
    return json({ ok: false, reason: "unknown_machine",
      message: "This machine isn't activated for this license." });
  }
  // One-time lifetime — nothing to manage in a subscription portal.
  if (rec.plan === "lifetime") {
    return json({ ok: false, reason: "no_subscription",
      message: "Lifetime licenses don't have a subscription portal. " +
               "Email support@trysmartcut.com if you need help." });
  }

  // Stripe subscriptions — mint a Billing Portal session (requires portal
  // enabled in Stripe Dashboard; same settings as Customer portal login link).
  if (rec.stripeCustomerId) {
    if (!env.STRIPE_API_KEY) {
      return json({ ok: false, reason: "stripe_error",
        message: "Billing portal is not configured on the server." });
    }
    const returnUrl = env.PORTAL_RETURN_URL || "https://trysmartcut.com/thanks";
    const params = new URLSearchParams();
    params.set("customer", rec.stripeCustomerId);
    params.set("return_url", returnUrl);
    try {
      const res = await stripeFetch(env, "/v1/billing_portal/sessions", {
        method: "POST",
        body: params.toString()
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error("stripe billing portal session failed", data);
        return json({ ok: false, reason: "stripe_error",
          message: (data && data.error && data.error.message) ||
            "Could not open the billing portal right now." });
      }
      if (data.url) return json({ ok: true, url: data.url });
    } catch (e) {
      console.error("stripe billing portal exception", e);
      return json({ ok: false, reason: "stripe_error",
        message: "Could not open the billing portal right now." });
    }
    return json({ ok: false, reason: "stripe_error",
      message: "Stripe returned no portal URL." });
  }

  if (!rec.paddleCustomerId) {
    return json({ ok: false, reason: "no_subscription",
      message: "No billing portal is linked to this license. " +
               "Email support@trysmartcut.com if you need help." });
  }

  // Paddle's portal API is a POST to the customer's portal-sessions
  // endpoint. Optionally pass subscription_ids[] to deep-link into the
  // "Manage this subscription" panel rather than the customer home.
  const reqBody = rec.paddleSubscriptionId
    ? { subscription_ids: [rec.paddleSubscriptionId] }
    : {};

  const res = await paddleFetch(env, `/customers/${rec.paddleCustomerId}/portal-sessions`, {
    method: "POST",
    body:   JSON.stringify(reqBody)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("portal session failed", data);
    return json({ ok: false, reason: "paddle_error",
      message: "Could not open the billing portal right now." });
  }

  // Paddle returns urls.general.overview for the generic portal and
  // urls.subscriptions[0].cancel_subscription etc for deep links.
  // We just send back the overview URL — portal handles all actions from there.
  const portalUrl =
    (data.data && data.data.urls && data.data.urls.general && data.data.urls.general.overview) ||
    null;
  if (!portalUrl) {
    return json({ ok: false, reason: "paddle_error",
      message: "Paddle returned no portal URL." });
  }
  return json({ ok: true, url: portalUrl });
}

// ─── /download-url ──────────────────────────────────────────────────────────
async function handleDownloadUrl(req, env) {
  const body = await req.json().catch(() => ({}));
  const { licenseKey, machineId } = body;
  const platform = normalizePlatform(body.platform);
  if (!licenseKey || !machineId) return json({ ok: false, reason: "bad_request" }, 400);

  const rec = await getLicense(env, licenseKey);
  if (!rec || rec.status !== "active") {
    return json({ ok: false, reason: "no_active_license",
      message: "Active license required to download." });
  }
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) {
    return json({ ok: false, reason: "expired",
      message: "Subscription expired." });
  }
  const hasMachine = (rec.machineIds || []).some(m => m.id === machineId);
  if (!hasMachine) {
    return json({ ok: false, reason: "unknown_machine",
      message: "This machine isn't activated for this license." });
  }

  if (shippingMacosOnly(env) && platform === "win") {
    return json({ ok: false, reason: "platform_not_available",
      message: "SmartCut is macOS-only for now. Windows is coming; your license will work there once we ship it." });
  }

  const kvRel = await env.LICENSES.get("__release__", "json");
  const version = (kvRel && kvRel.version) || env.LATEST_VERSION;
  // Prefer .zip here: in-panel updater wants the raw bundle swap, not a DMG mount.
  const fileName = await pickReleaseFile(env, version, platform, { preferInstaller: false });
  if (!fileName) {
    return json({ ok: false, reason: "no_build",
      message: `No ${platform} build of ${version} is available yet. We'll email you as soon as it's ready.` });
  }
  const ttlSec = parseInt(env.DOWNLOAD_URL_TTL_SEC || "600", 10);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;

  const toSign = `${fileName}|${expiresAt}|${machineId}`;
  const sig = await hmacSha256Hex(env.DOWNLOAD_SIGNING_KEY || "dev-insecure-key", toSign);
  const origin = new URL(req.url).origin;
  const url = `${origin}/download/${encodeURIComponent(fileName)}?exp=${expiresAt}&mid=${encodeURIComponent(machineId)}&sig=${sig}`;

  return json({
    ok: true, url, version, platform, fileName,
    expiresAt: new Date(expiresAt * 1000).toISOString()
  });
}

function normalizePlatform(raw) {
  const p = String(raw || "").toLowerCase();
  if (p === "mac" || p === "darwin" || p === "osx") return "mac";
  if (p === "win" || p === "windows" || p.startsWith("win")) return "win";
  return "unknown";
}

/**
 * @param {{ preferInstaller?: boolean }} opts
 *   preferInstaller true  → email / thanks /get-install: DMG first (consumer installer UX).
 *   preferInstaller false → POST /download-url (panel updater): zip first (fast in-place swap).
 */
async function pickReleaseFile(env, version, platform, opts = {}) {
  const preferInstaller = opts.preferInstaller === true;
  const candidates = [];
  if (platform === "mac") {
    if (preferInstaller) {
      // Human-facing first install: DMG contains Install SmartCut.app + updater.
      candidates.push(`SmartCutPro-${version}-mac.dmg`);
      candidates.push(`SmartCut-${version}-mac.dmg`);
      candidates.push(`SmartCutPro-${version}-mac.zip`);
      candidates.push(`SmartCut-${version}-mac.zip`);
    } else {
      // In-panel updater: zip is smallest; avoids exposing raw folders to buyers.
      candidates.push(`SmartCutPro-${version}-mac.zip`);
      candidates.push(`SmartCut-${version}-mac.zip`);
      candidates.push(`SmartCutPro-${version}-mac.dmg`);
      candidates.push(`SmartCut-${version}-mac.dmg`);
    }
    // ZXP legacy fallbacks appended below for both modes.
  }
  if (platform === "mac" || platform === "win") {
    candidates.push(`SmartCut-${version}-${platform}.zxp`);
    candidates.push(`SmartCutPro-${version}-${platform}.zxp`);
  }
  candidates.push(`SmartCut-${version}.zxp`);
  candidates.push(`SmartCutPro-${version}.zxp`);
  for (const name of candidates) {
    const head = await env.RELEASES.head(name);
    if (head) return name;
  }
  return null;
}

async function handleSignedDownload(req, env) {
  const url = new URL(req.url);
  const fileName = decodeURIComponent(url.pathname.replace(/^\/download\//, ""));
  const exp = parseInt(url.searchParams.get("exp") || "0", 10);
  const mid = url.searchParams.get("mid") || "";
  const sig = url.searchParams.get("sig") || "";

  if (!fileName || !exp || !sig) return new Response("Bad request", { status: 400 });
  if (exp < Math.floor(Date.now() / 1000)) return new Response("Link expired", { status: 410 });

  const expected = await hmacSha256Hex(env.DOWNLOAD_SIGNING_KEY || "dev-insecure-key",
    `${fileName}|${exp}|${mid}`);
  if (expected !== sig) return new Response("Bad signature", { status: 403 });

  const obj = await env.RELEASES.get(fileName);
  if (!obj) return new Response("Release not found", { status: 404 });

  const lower = fileName.toLowerCase();
  let contentType = "application/octet-stream";
  if (lower.endsWith(".dmg")) contentType = "application/x-apple-diskimage";
  else if (lower.endsWith(".zip")) contentType = "application/zip";
  else if (lower.endsWith(".zxp")) contentType = "application/zip";

  return new Response(obj.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, max-age=60"
    }
  });
}

// ─── /get-install/:platform?key=SC-XXX ──────────────────────────────────────
// Public (key-gated) installer download. The email's download buttons
// point here — the buyer hasn't activated any machine yet, so we can't
// reuse /download-url (which requires machineId). Instead we validate
// the license key, then 302-redirect to a freshly-signed R2 URL.
//
// Security model: license keys are 20-char random strings (~100 bits),
// effectively unguessable. The ZXP itself is useless without a key
// (the extension calls /verify on startup), so even a leaked link
// isn't a piracy vector — it just hands someone a binary they can't run.
function shippingMacosOnly(env) {
  const v = env.SHIPPING_MACOS_ONLY;
  // Default mac-only until Windows is explicitly enabled (avoids Windows CTAs
  // if the binding is missing in a deployed worker).
  if (v === "0" || v === "false" || v === false) return false;
  return true;
}

async function handleGetInstall(req, env) {
  const url = new URL(req.url);
  const platform = normalizePlatform(url.pathname.replace(/^\/get-install\//, ""));
  const licenseKey = url.searchParams.get("key") || "";

  if (!licenseKey) {
    return installErrorPage("Missing license key.",
      "The download link in your email should include a key. Check your inbox for the full URL.");
  }

  const rec = await getLicense(env, licenseKey);
  if (!rec) {
    return installErrorPage("License not found.",
      "We couldn't find this license. Double-check the key or contact support@trysmartcut.com.");
  }
  if (rec.status !== "active") {
    return installErrorPage("License inactive.",
      "This license isn't currently active. If you think that's a mistake, email support@trysmartcut.com.");
  }
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) {
    return installErrorPage("Subscription expired.",
      "Your subscription has lapsed. Renew and we'll reissue the download link.");
  }

  if (shippingMacosOnly(env) && platform === "win") {
    return installErrorPage("Windows isn\u2019t available yet.",
      "SmartCut currently supports <b>macOS only</b>. Your license is valid for Windows too once we ship it &mdash; we\u2019ll email existing customers. Questions? <a href=\"mailto:support@trysmartcut.com\">support@trysmartcut.com</a>");
  }

  const kvRel = await env.LICENSES.get("__release__", "json");
  const version = (kvRel && kvRel.version) || env.LATEST_VERSION;
  // First-time buyers expect the DMG (Install SmartCut.app), not the raw .zip bundle.
  const fileName = await pickReleaseFile(env, version, platform, { preferInstaller: true });
  if (!fileName) {
    return installErrorPage(`No ${platform === "mac" ? "macOS" : platform === "win" ? "Windows" : "installer"} build yet.`,
      `The ${platform === "mac" ? "macOS" : platform === "win" ? "Windows" : ""} build of ${version} isn't uploaded yet. We'll email you the moment it's ready — usually within 24h of launch.`);
  }

  const ttlSec = parseInt(env.DOWNLOAD_URL_TTL_SEC || "600", 10);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  const mid = `key:${licenseKey}`;   // bind signature to license, not machine
  const toSign = `${fileName}|${expiresAt}|${mid}`;
  const sig = await hmacSha256Hex(env.DOWNLOAD_SIGNING_KEY || "dev-insecure-key", toSign);
  const target = `${url.origin}/download/${encodeURIComponent(fileName)}?exp=${expiresAt}&mid=${encodeURIComponent(mid)}&sig=${sig}`;

  return new Response(null, { status: 302, headers: { Location: target } });
}

// Small HTML error page for /get-install — nicer than bare JSON when the
// user clicks through from their email client.
function installErrorPage(heading, body) {
  const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${heading} — SmartCut</title>
<style>
  html,body{margin:0;background:#f4f4f5;color:#3f3f46;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  .wrap{max-width:520px;margin:80px auto;padding:32px;border:1px solid #e4e4e7;border-radius:14px;background:#ffffff;}
  h1{margin:0 0 12px;font-size:22px;color:#18181b;letter-spacing:-0.01em;}
  p{margin:0 0 14px;color:#52525b;line-height:1.6;font-size:14.5px;}
  a{color:#c2410c;}
  @media (prefers-color-scheme: dark) {
    html,body{background:#0a0a0b;color:#d4d4d8;}
    .wrap{border-color:#3f3f46;background:#18181b;}
    h1{color:#fafafa;}
    p{color:#a1a1aa;}
    a{color:#fb923c;}
  }
</style></head><body><div class="wrap">
  <h1>${heading}</h1><p>${body}</p>
  <p><a href="https://trysmartcut.com">← Back to trysmartcut.com</a></p>
</div></body></html>`;
  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

// ─── /fulfillment?session_id=... ────────────────────────────────────────────
// Public polling endpoint used by the post-checkout /thanks page. The
// browser lands on /thanks with a Stripe session_id (or Paddle _ptxn) in
// the URL, but the webhook that actually mints the license may not have
// fired yet (Stripe usually takes 1-5s, worst case ~60s). This endpoint
// lets the page poll until the license materializes, then hands back the
// key + download URLs so we can show them inline — no need to wait for
// the email to arrive.
async function handleFulfillment(req, env) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session_id") || "";
  const paddleTxn = url.searchParams.get("_ptxn") || url.searchParams.get("txn") || "";

  let licenseKey = null;
  if (sessionId) {
    licenseKey = await env.LICENSES.get(`stripe:ses:${sessionId}`);
  } else if (paddleTxn) {
    licenseKey = await env.LICENSES.get(`paddle:txn:${paddleTxn}`);
  } else {
    return json({ ok: false, reason: "bad_request",
      message: "Provide session_id or _ptxn." }, 400);
  }

  if (!licenseKey) {
    // Webhook hasn't fired yet — tell the caller to keep polling.
    return json({ ok: false, reason: "pending",
      message: "Payment processing. Your license key will appear in a moment." });
  }

  const rec = await getLicense(env, licenseKey);
  if (!rec) {
    return json({ ok: false, reason: "pending" });
  }

  const origin = new URL(req.url).origin;
  const dl = (p) =>
    `${origin}/get-install/${p}?key=${encodeURIComponent(licenseKey)}`;

  const macOnly = shippingMacosOnly(env);
  const downloads = { mac: dl("mac") };
  if (!macOnly) downloads.win = dl("win");

  return json({
    ok:           true,
    licenseKey,
    plan:         rec.plan,
    email:        rec.email || null,
    expiresAt:    rec.expiresAt || null,
    macOSOnly:    macOnly,
    downloads
  });
}

// ─── /webhook/paddle ────────────────────────────────────────────────────────
//
// Paddle sends signed webhooks. The signature header is:
//
//   Paddle-Signature: ts=<unix_seconds>;h1=<hex>
//
// Expected HMAC = sha256(`${ts}:${rawBody}`, PADDLE_WEBHOOK_SECRET). We
// reject anything older than 5 minutes to block replay attacks.
//
// Event flow:
//
//   transaction.completed
//     → First touchpoint after a successful purchase (one-time OR first
//       payment of a subscription). We mint a brand-new licenseKey,
//       store a license record with the Paddle customer_id +
//       subscription_id, and email the key to the buyer. Idempotent on
//       transaction_id so retries don't mint duplicate licenses.
//
//   subscription.activated
//     → Subscription became active (after trial, after past_due recovery).
//       Reflect status=active.
//
//   subscription.updated
//     → Plan switches (monthly ↔ annual), pauses, renewals. We mirror
//       plan, next_billed_at → expiresAt, status.
//
//   subscription.canceled
//     → Sub canceled. Mark status=canceled; license fails /verify after
//       the current billing period ends.
//
//   subscription.paused / subscription.resumed
//     → Reflect status=paused / active.
//
//   adjustment.created  (action = "refund" or "chargeback")
//     → Mark status=refunded / chargebacked.
async function handlePaddleWebhook(req, env) {
  const rawBody   = await req.text();
  const sigHeader = req.headers.get("Paddle-Signature") || "";
  if (!await verifyPaddleSignature(rawBody, sigHeader, env.PADDLE_WEBHOOK_SECRET)) {
    return new Response("Bad signature", { status: 401 });
  }

  const evt = JSON.parse(rawBody);
  const type = evt.event_type;
  const data = evt.data || {};

  switch (type) {
    case "transaction.completed":      await onTransactionCompleted(data, env); break;
    case "transaction.created":        await onTransactionCreatedOrUpdated(data, env); break;
    case "transaction.updated":        await onTransactionCreatedOrUpdated(data, env); break;
    case "transaction.canceled":       await onTransactionCanceled(data, env); break;
    case "subscription.activated":     await onSubscriptionActivated(data, env); break;
    case "subscription.updated":       await onSubscriptionUpdated(data, env); break;
    case "subscription.canceled":      await onSubscriptionCanceled(data, env); break;
    case "subscription.paused":        await onSubscriptionPaused(data, env); break;
    case "subscription.resumed":       await onSubscriptionActivated(data, env); break;
    case "adjustment.created":         await onAdjustmentCreated(data, env); break;
    default:
      // Ignore unhandled events; Paddle sends many we don't care about.
      break;
  }
  return json({ ok: true });
}

async function onTransactionCompleted(txn, env) {
  const transactionId  = txn.id;
  const customerId     = txn.customer_id || null;
  const subscriptionId = txn.subscription_id || null;

  // Idempotency: if we've already processed this exact transaction, bail.
  // Paddle retries webhooks on 5xx for up to 72h so retries are expected.
  if (transactionId) {
    const existingLicense = await env.LICENSES.get(`paddle:txn:${transactionId}`);
    if (existingLicense) return;
  }

  // Pull the price id. Paddle's transaction payload includes items[] with
  // full price objects inline (unlike Stripe which makes you expand).
  const firstItem = txn.items && txn.items[0];
  const priceId   = (firstItem && firstItem.price && firstItem.price.id) || null;
  const plan      = planFromPriceId(priceId, env);

  // Work out expiry. For subscriptions it's in txn.billing_period.ends_at
  // or we fetch the subscription. For lifetime, null = never expires.
  let expiresAt = null;
  if (subscriptionId) {
    if (txn.billing_period && txn.billing_period.ends_at) {
      expiresAt = txn.billing_period.ends_at;
    } else {
      // Fallback: fetch the subscription for next_billed_at
      const subRes = await paddleFetch(env, `/subscriptions/${subscriptionId}`);
      const subData = await subRes.json().catch(() => ({}));
      if (subData.data && subData.data.next_billed_at) {
        expiresAt = subData.data.next_billed_at;
      }
    }
  }

  // Paddle doesn't always include the full customer inline. Fetch to get
  // the email reliably.
  let email = null;
  if (customerId) {
    const cRes = await paddleFetch(env, `/customers/${customerId}`);
    const cData = await cRes.json().catch(() => ({}));
    email = (cData.data && cData.data.email) || null;
  }

  // Reuse an existing license if the customer came back to buy again;
  // otherwise mint a fresh key.
  let licenseKey = null;
  if (customerId) {
    licenseKey = await env.LICENSES.get(`paddle:ctm:${customerId}`);
  }
  if (!licenseKey) {
    licenseKey = generateLicenseKey();
  }

  const existing = await getLicense(env, licenseKey);
  const isFirstPurchase = !existing;   // controls whether we email the key
  const rec = existing || emptyLicense(licenseKey, env);
  rec.email                = email || rec.email;
  rec.status               = "active";
  rec.plan                 = plan || rec.plan || "monthly";
  rec.paddleCustomerId     = customerId || rec.paddleCustomerId;
  rec.paddleSubscriptionId = subscriptionId || rec.paddleSubscriptionId || null;
  // paddleTransactionId tracks the ORIGINAL purchase txn, don't overwrite
  // it on renewals — that's what refund lookups key off of.
  rec.paddleTransactionId  = rec.paddleTransactionId || transactionId || null;
  rec.paddlePriceId        = priceId || rec.paddlePriceId || null;
  rec.createdAt            = rec.createdAt || new Date().toISOString();
  rec.expiresAt            = expiresAt;
  await putLicense(env, rec);

  // Secondary indexes so webhook lookups by Paddle id are O(1).
  if (customerId) {
    await env.LICENSES.put(`paddle:ctm:${customerId}`, licenseKey);
  }
  if (subscriptionId) {
    await env.LICENSES.put(`paddle:sub:${subscriptionId}`, licenseKey);
  }
  if (transactionId) {
    // Idempotency marker so a retry of transaction.completed can't mint
    // a second license for the same txn.
    await env.LICENSES.put(`paddle:txn:${transactionId}`, licenseKey);
  }

  // Track lifetime slot consumption for the public counter on the
  // landing page. Guarded with a per-transaction marker so webhook
  // retries don't double-count the same purchase.
  if (rec.plan === "lifetime" && transactionId) {
    await incrementLifetimeSold(env, transactionId);
  }

  // Email the license key to the buyer — but ONLY on the first purchase.
  // Paddle fires transaction.completed on every renewal too, and we don't
  // want to spam the user their key every month.
  //
  // Best-effort: we don't fail the webhook if email delivery hiccups;
  // Paddle would otherwise retry the whole event and we'd double-process
  // (though the txn-id idempotency marker above catches that too).
  if (isFirstPurchase && email && env.RESEND_API_KEY) {
    try {
      await sendLicenseEmail(env, email, licenseKey, rec.plan, {
        expiresAt: rec.expiresAt
      });
    } catch (e) { console.error("license email failed:", e); }
  }

  // Mark the abandoned-cart tracker as converted so the cron doesn't send
  // a recovery email after a successful purchase.
  await clearPendingCart(env, { transactionId, email });
}

// ─── Lifetime slot counter ──────────────────────────────────────────────────
// Idempotent: marks the transaction id as seen before incrementing so retries
// are safe. KV reads are eventually consistent but at 1 purchase/minute
// scale the racing is not a concern.
async function incrementLifetimeSold(env, transactionId) {
  const seenKey = `lifetime:seen:${transactionId}`;
  const seen    = await env.LICENSES.get(seenKey);
  if (seen) return;
  await env.LICENSES.put(seenKey, "1");

  const curr = parseInt((await env.LICENSES.get("lifetime:sold")) || "0", 10) || 0;
  await env.LICENSES.put("lifetime:sold", String(curr + 1));
}

// ─── /lifetime-stats (public) ───────────────────────────────────────────────
// Powers the "X of 1000 lifetime slots left" counter on the landing page.
async function handleLifetimeStats(env) {
  const cap  = parseInt(env.LIFETIME_CAP || "1000", 10) || 1000;
  const sold = parseInt((await env.LICENSES.get("lifetime:sold")) || "0", 10) || 0;
  return json({
    ok:        true,
    sold,
    cap,
    remaining: Math.max(0, cap - sold),
    soldOut:   sold >= cap,
    launchEndsAt: env.LIFETIME_LAUNCH_END || null
  });
}

async function onSubscriptionActivated(sub, env) {
  const licenseKey = await env.LICENSES.get(`paddle:sub:${sub.id}`);
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;
  rec.status = "active";
  if (sub.next_billed_at) {
    rec.expiresAt = sub.next_billed_at;
  }
  await putLicense(env, rec);
}

async function onSubscriptionPaused(sub, env) {
  const licenseKey = await env.LICENSES.get(`paddle:sub:${sub.id}`);
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;
  rec.status = "paused";
  await putLicense(env, rec);
}

async function onSubscriptionUpdated(sub, env) {
  const licenseKey = await env.LICENSES.get(`paddle:sub:${sub.id}`);
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;

  // Plan swap detection — inspect the first item on the subscription.
  if (sub.items && sub.items[0] && sub.items[0].price) {
    const newPriceId = sub.items[0].price.id;
    rec.paddlePriceId = newPriceId;
    rec.plan = planFromPriceId(newPriceId, env) || rec.plan;
  }
  if (sub.next_billed_at) {
    rec.expiresAt = sub.next_billed_at;
  }

  // Paddle statuses: active | trialing | past_due | paused | canceled
  if (sub.status === "active" || sub.status === "trialing") {
    rec.status = "active";
  } else if (sub.status === "past_due") {
    rec.status = "paused";
  } else if (sub.status === "paused") {
    rec.status = "paused";
  } else if (sub.status === "canceled") {
    rec.status = "canceled";
  }
  await putLicense(env, rec);
}

async function onSubscriptionCanceled(sub, env) {
  const licenseKey = await env.LICENSES.get(`paddle:sub:${sub.id}`);
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;

  // Paddle fires subscription.canceled in two scenarios: user cancels
  // themselves (period end is in the future — grace until then) or their
  // card fails for multiple retries and Paddle dunning-cancels (period
  // usually ends soon). Either way, user keeps access until expiresAt.
  const wasAlreadyCanceled = rec.status === "canceled";
  rec.status = "canceled";
  // Keep expiresAt as-is — user keeps access until the period ends.
  // /verify handles expiry-based lockout.
  await putLicense(env, rec);

  // Send the "sorry to see you go" email exactly once per cancellation.
  // Best-effort: don't fail the webhook on email hiccups.
  if (!wasAlreadyCanceled && rec.email && env.RESEND_API_KEY) {
    try {
      await sendCancellationEmail(env, rec.email, {
        licenseKey: rec.licenseKey,
        plan:       rec.plan,
        expiresAt:  rec.expiresAt
      });
    } catch (e) { console.error("cancellation email failed:", e); }
  }
}

// Paddle models refunds and chargebacks as "adjustments". We only care
// about negative adjustments that actually move money back to the customer.
async function onAdjustmentCreated(adj, env) {
  const action = adj.action;                         // "refund" | "chargeback" | "credit"
  const txnId  = adj.transaction_id || null;

  if (action !== "refund" && action !== "chargeback") return;

  // Map adjustment → transaction → license. We indexed paddle:txn:<id>
  // when we first minted the license, so this is O(1).
  let licenseKey = null;
  if (txnId) {
    licenseKey = await env.LICENSES.get(`paddle:txn:${txnId}`);
  }
  // Fallback: look up by customer_id if we didn't index the txn (shouldn't
  // happen, but let's not fail silently on first refund in prod).
  if (!licenseKey && adj.customer_id) {
    licenseKey = await env.LICENSES.get(`paddle:ctm:${adj.customer_id}`);
  }
  if (!licenseKey) return;

  const rec = await getLicense(env, licenseKey);
  if (!rec) return;
  rec.status = action === "chargeback" ? "chargebacked" : "refunded";
  await putLicense(env, rec);
}

// ═══════════════════════════════════════════════════════════════════════════
// STRIPE webhooks
// ═══════════════════════════════════════════════════════════════════════════
//
// We keep Stripe as the *primary* payment path now (it's live / approved) and
// leave the Paddle handlers above fully intact as a fallback — flip
// CHECKOUT_PROVIDER on the landing page and the other one takes over.
//
// Stripe-Signature header format:
//   t=1611001430,v1=<hex>,v1=<hex>,v0=<hex>
//
// Expected signature = HMAC-SHA256(secret, `${t}.${rawBody}`). We reject
// anything older than 5 minutes to block replay attacks. Multiple v1
// entries can coexist during key rotation — accept if any match.
//
// Events we handle (subscribe to these in the Stripe Dashboard when you
// create the webhook endpoint — see STRIPE-SETUP.md):
//
//   checkout.session.completed
//     → Successful purchase (one-time OR first payment of a subscription).
//       We mint a licenseKey, store the record with customer/subscription
//       ids, and email the key. Idempotent on session.id so Stripe's
//       retries don't create duplicate licenses.
//
//   customer.subscription.updated
//     → Plan changes (monthly ↔ annual), status changes, renewals.
//       Mirror plan + current_period_end → expiresAt + status.
//
//   customer.subscription.deleted
//     → Subscription ended (either at period-end after a user cancel, or
//       immediately via dunning). Mark status=canceled; /verify rejects
//       after expiresAt. Send the "sorry to see you go" email.
//
//   invoice.paid
//     → Subscription renewal succeeded. Bump expiresAt to the new
//       current_period_end so /verify doesn't lock the user out.
//
//   charge.refunded
//     → Full or partial refund. Mark status=refunded (we lock out on any
//       refund — partial refunds are rare in SaaS and usually mean the
//       customer wants out).
//
//   charge.dispute.created
//     → Chargeback opened. Mark status=chargebacked.
async function handleStripeWebhook(req, env) {
  const rawBody   = await req.text();
  const sigHeader = req.headers.get("Stripe-Signature") || "";
  if (!await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET)) {
    return new Response("Bad signature", { status: 401 });
  }

  const evt  = JSON.parse(rawBody);
  const type = evt.type;
  const obj  = (evt.data && evt.data.object) || {};

  // Event-level idempotency. Stripe retries for up to ~3 days on 5xx, so
  // we must make sure the same event.id can be processed twice without
  // side effects (duplicate emails, duplicate license rows, etc).
  if (evt.id) {
    const seen = await env.LICENSES.get(`stripe:evt:${evt.id}`);
    if (seen) return json({ ok: true, deduped: true });
  }

  try {
    switch (type) {
      case "checkout.session.completed":       await onStripeCheckoutCompleted(obj, env); break;
      case "customer.subscription.updated":    await onStripeSubscriptionUpdated(obj, env); break;
      case "customer.subscription.deleted":    await onStripeSubscriptionDeleted(obj, env); break;
      case "invoice.paid":                     await onStripeInvoicePaid(obj, env); break;
      case "charge.refunded":                  await onStripeChargeRefunded(obj, env); break;
      case "charge.dispute.created":           await onStripeChargeDisputeCreated(obj, env); break;
      default: break;
    }
  } catch (e) {
    // Log and rethrow so Stripe retries transient failures.
    console.error(`stripe ${type} failed:`, e);
    throw e;
  }

  // Record the event as processed only AFTER successful dispatch, so a
  // transient failure above can still be retried.
  if (evt.id) {
    // 7-day TTL is plenty — Stripe stops retrying after ~3 days.
    await env.LICENSES.put(`stripe:evt:${evt.id}`, "1",
      { expirationTtl: 7 * 86400 });
  }

  return json({ ok: true });
}

async function onStripeCheckoutCompleted(session, env) {
  // Ignore sessions that haven't actually been paid yet (e.g. async bank
  // redirects that succeed later fire checkout.session.async_payment_succeeded
  // instead). Stripe's status vocabulary: "complete" | "expired" | "open".
  if (session.status !== "complete") return;
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    return;
  }

  const sessionId      = session.id;
  const customerId     = session.customer || null;
  const subscriptionId = session.subscription || null;
  const email          = (session.customer_details && session.customer_details.email)
    || session.customer_email
    || null;

  // Idempotency on session.id — Stripe guarantees one session per checkout,
  // so this collapses any retries of the same purchase.
  const existingFromSession = await env.LICENSES.get(`stripe:ses:${sessionId}`);
  if (existingFromSession) return;

  // Webhooks don't include line_items by default. Fetch them to learn the
  // price id the buyer actually picked (drives plan + lifetime counter).
  let priceId = null;
  try {
    const res = await stripeFetch(env,
      `/v1/checkout/sessions/${sessionId}/line_items?limit=1`);
    const data = await res.json().catch(() => ({}));
    const first = data && data.data && data.data[0];
    priceId = (first && first.price && first.price.id) || null;
  } catch (e) {
    console.error("stripe line_items fetch failed:", e);
  }
  const plan = planFromPriceId(priceId, env);

  // For subscriptions, fetch the subscription so we can pin expiresAt to
  // the real current_period_end (Stripe timestamps are unix seconds).
  let expiresAt = null;
  if (subscriptionId) {
    try {
      const res = await stripeFetch(env, `/v1/subscriptions/${subscriptionId}`);
      const sub = await res.json().catch(() => ({}));
      if (sub && sub.current_period_end) {
        expiresAt = new Date(sub.current_period_end * 1000).toISOString();
      }
    } catch (e) {
      console.error("stripe subscription fetch failed:", e);
    }
  }

  // Reuse existing license if this customer already has one (e.g. they
  // bought a sub, canceled, and came back for lifetime). Otherwise mint.
  let licenseKey = null;
  if (customerId) {
    licenseKey = await env.LICENSES.get(`stripe:cus:${customerId}`);
  }
  if (!licenseKey) licenseKey = generateLicenseKey();

  const existing = await getLicense(env, licenseKey);
  const isFirstPurchase = !existing;
  const rec = existing || emptyLicense(licenseKey, env);
  rec.email                    = email || rec.email;
  rec.status                   = "active";
  rec.plan                     = plan || rec.plan || "monthly";
  rec.provider                 = "stripe";
  rec.stripeCustomerId         = customerId || rec.stripeCustomerId;
  rec.stripeSubscriptionId     = subscriptionId || rec.stripeSubscriptionId || null;
  rec.stripeCheckoutSessionId  = rec.stripeCheckoutSessionId || sessionId || null;
  rec.stripePriceId            = priceId || rec.stripePriceId || null;
  rec.createdAt                = rec.createdAt || new Date().toISOString();
  rec.expiresAt                = expiresAt;
  await putLicense(env, rec);

  // Secondary indexes for O(1) lookup from later webhooks.
  if (customerId) {
    await env.LICENSES.put(`stripe:cus:${customerId}`, licenseKey);
  }
  if (subscriptionId) {
    await env.LICENSES.put(`stripe:sub:${subscriptionId}`, licenseKey);
  }
  await env.LICENSES.put(`stripe:ses:${sessionId}`, licenseKey);

  // Public lifetime-slot counter — guarded per-session so retries don't
  // double-count. We reuse the existing incrementLifetimeSold helper
  // and prefix the dedupe key with "stripe:ses:" so Paddle txn ids and
  // Stripe session ids can share the counter without collisions.
  if (rec.plan === "lifetime") {
    await incrementLifetimeSold(env, `stripe:ses:${sessionId}`);
  }

  // Email the key on first purchase only.
  if (isFirstPurchase && email && env.RESEND_API_KEY) {
    try {
      await sendLicenseEmail(env, email, licenseKey, rec.plan, {
        expiresAt: rec.expiresAt
      });
    } catch (e) { console.error("license email failed:", e); }
  }
}

async function onStripeSubscriptionUpdated(sub, env) {
  const licenseKey = await env.LICENSES.get(`stripe:sub:${sub.id}`);
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;

  // Plan might have changed (upgrade/downgrade). Prefer the new price id
  // if we recognise it — otherwise keep the existing plan.
  const newPriceId = sub.items && sub.items.data && sub.items.data[0]
    && sub.items.data[0].price && sub.items.data[0].price.id;
  if (newPriceId) {
    const newPlan = planFromPriceId(newPriceId, env);
    if (newPlan) rec.plan = newPlan;
    rec.stripePriceId = newPriceId;
  }

  if (sub.current_period_end) {
    rec.expiresAt = new Date(sub.current_period_end * 1000).toISOString();
  }

  // Stripe status vocabulary: active | trialing | past_due | unpaid |
  // canceled | incomplete | incomplete_expired | paused. We collapse to
  // our 4-state model.
  if (sub.status === "active" || sub.status === "trialing") {
    rec.status = "active";
  } else if (sub.status === "past_due" || sub.status === "unpaid") {
    rec.status = "paused";
  } else if (sub.status === "canceled" || sub.status === "incomplete_expired") {
    rec.status = "canceled";
  }
  await putLicense(env, rec);
}

async function onStripeSubscriptionDeleted(sub, env) {
  const licenseKey = await env.LICENSES.get(`stripe:sub:${sub.id}`);
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;

  const wasAlreadyCanceled = rec.status === "canceled";
  rec.status = "canceled";
  // Keep expiresAt as-is — user keeps access until the period ends, just
  // like the Paddle flow.
  if (sub.ended_at) {
    rec.expiresAt = new Date(sub.ended_at * 1000).toISOString();
  } else if (sub.current_period_end) {
    rec.expiresAt = new Date(sub.current_period_end * 1000).toISOString();
  }
  await putLicense(env, rec);

  if (!wasAlreadyCanceled && rec.email && env.RESEND_API_KEY) {
    try {
      await sendCancellationEmail(env, rec.email, {
        licenseKey: rec.licenseKey,
        plan:       rec.plan,
        expiresAt:  rec.expiresAt
      });
    } catch (e) { console.error("cancellation email failed:", e); }
  }
}

async function onStripeInvoicePaid(invoice, env) {
  const subscriptionId = invoice.subscription || null;
  if (!subscriptionId) return;
  const licenseKey = await env.LICENSES.get(`stripe:sub:${subscriptionId}`);
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;

  // Bump expiresAt from the invoice's period_end — this is the simplest
  // way to keep /verify happy across renewals without a second API call.
  const lineEnd = invoice.lines && invoice.lines.data && invoice.lines.data[0]
    && invoice.lines.data[0].period && invoice.lines.data[0].period.end;
  if (lineEnd) {
    rec.expiresAt = new Date(lineEnd * 1000).toISOString();
  } else if (invoice.period_end) {
    rec.expiresAt = new Date(invoice.period_end * 1000).toISOString();
  }
  if (rec.status !== "canceled") rec.status = "active";
  await putLicense(env, rec);
}

async function onStripeChargeRefunded(charge, env) {
  // A charge knows its customer but not its license directly — look up by
  // customer_id (indexed when we minted the license).
  const customerId = charge.customer || null;
  if (!customerId) return;
  const licenseKey = await env.LICENSES.get(`stripe:cus:${customerId}`);
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;
  rec.status = "refunded";
  await putLicense(env, rec);
}

async function onStripeChargeDisputeCreated(dispute, env) {
  // Dispute objects expose charge → customer. Resolve customer by fetching
  // the underlying charge.
  const chargeId = dispute.charge || null;
  if (!chargeId) return;
  try {
    const res = await stripeFetch(env, `/v1/charges/${chargeId}`);
    const charge = await res.json().catch(() => ({}));
    const customerId = charge && charge.customer;
    if (!customerId) return;
    const licenseKey = await env.LICENSES.get(`stripe:cus:${customerId}`);
    if (!licenseKey) return;
    const rec = await getLicense(env, licenseKey);
    if (!rec) return;
    rec.status = "chargebacked";
    await putLicense(env, rec);
  } catch (e) {
    console.error("stripe dispute lookup failed:", e);
  }
}

// ─── Stripe helpers ──────────────────────────────────────────────────────────

// Minimal fetch wrapper — same API base URL for test + live keys, the key
// prefix (sk_test_ vs sk_live_) decides which dataset you hit. We set
// Stripe-Version explicitly to pin behaviour; bump this when we
// consciously upgrade to newer event shapes.
function stripeFetch(env, path, opts = {}) {
  if (!env.STRIPE_API_KEY) {
    throw new Error("STRIPE_API_KEY not set");
  }
  const headers = {
    "Authorization": `Bearer ${env.STRIPE_API_KEY}`,
    "Stripe-Version": "2024-06-20",
    ...(opts.headers || {})
  };
  if (opts.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  return fetch(`https://api.stripe.com${path}`, { ...opts, headers });
}

// Stripe-Signature format:
//   t=1611001430,v1=<hex>,v1=<hex>,v0=<hex>
// Expected = HMAC-SHA256(secret, `${t}.${rawBody}`)
// Multiple v1 entries can appear during secret rotation — accept if any match.
async function verifyStripeSignature(body, header, secret) {
  if (!header || !secret) return false;

  let ts = null;
  const v1s = [];
  for (const seg of header.split(",")) {
    const idx = seg.indexOf("=");
    if (idx <= 0) continue;
    const k = seg.slice(0, idx).trim();
    const v = seg.slice(idx + 1).trim();
    if (k === "t") ts = v;
    else if (k === "v1") v1s.push(v);
  }
  if (!ts || v1s.length === 0) return false;

  const now   = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(ts, 10);
  if (!tsNum || Math.abs(now - tsNum) > 300) return false;

  const expected = await hmacSha256Hex(secret, `${ts}.${body}`);
  for (const candidate of v1s) {
    if (timingSafeEqual(expected, candidate)) return true;
  }
  return false;
}

// ─── Abandoned-cart recovery ─────────────────────────────────────────────────
//
// Two-tier recovery funnel, designed to work *alongside* Paddle's built-in
// 60-minute recovery email (which you enable in the Paddle dashboard at a
// conservative 15-20%):
//
//   T+60min  — Paddle sends their own recovery email @ ~15-20% off       (built-in)
//   T+72h    — We send a "final chance" email @ 33% off                  (this code)
//
// Paddle's own research shows 10-20% converts better than deeper
// discounts — going too deep anchors buyers on a low price and signals
// desperation. We only escalate to 33% for users who already ignored
// Paddle's first recovery nudge (i.e. genuinely cold leads), and cap the
// discount at 7-day validity + 1 use so it can't spread.
//
// KV schema:
//   pending:<txn_id> → {
//     email, plan, priceId, customerId,
//     createdAt,           // first seen (ISO)
//     lastSeenAt,          // most recent txn.updated (ISO)
//     notifiedAt?,         // ISO when we sent our recovery email (prevents dupes)
//     discountId?          // Paddle discount id we minted (for tracing)
//   }
//   Record gets TTL'd after 10 days via the cron sweep.
//
// ─────────────────────────────────────────────────────────────────────────────

const PENDING_PREFIX = "pending:";

// Fires on every transaction.created / transaction.updated webhook. We
// only care about "ready" or "billed" transactions that have a customer
// email but aren't completed — those are the carts a user could still
// come back to finish or abandon.
async function onTransactionCreatedOrUpdated(txn, env) {
  const txnId  = txn.id;
  const status = txn.status;   // draft | ready | billed | paid | completed | canceled
  if (!txnId) return;

  // Completed/paid transactions are handled by transaction.completed.
  // Draft = Paddle hasn't even asked for email yet. Skip both.
  if (status === "completed" || status === "paid") {
    await clearPendingCart(env, { transactionId: txnId });
    return;
  }
  if (status === "canceled") {
    // Keep the pending record — abandonment cron will still send a
    // recovery email if it's old enough. transaction.canceled only
    // fires on explicit cancels (rare).
    return;
  }
  if (status !== "ready" && status !== "billed") {
    return;   // draft or unknown state — no email captured yet
  }

  // Skip if Paddle hasn't yet surfaced an email / customer on this txn.
  // The txn.updated webhook fires again once it does.
  const customerId = txn.customer_id || null;
  let email = null;
  if (txn.customer && txn.customer.email) email = txn.customer.email;
  if (!email && customerId) {
    const cRes  = await paddleFetch(env, `/customers/${customerId}`);
    const cData = await cRes.json().catch(() => ({}));
    email = (cData.data && cData.data.email) || null;
  }
  if (!email) return;

  // Skip existing customers — we don't want to email recovery to
  // someone who already has an active license.
  if (customerId) {
    const existingKey = await env.LICENSES.get(`paddle:ctm:${customerId}`);
    if (existingKey) {
      const existingRec = await getLicense(env, existingKey);
      if (existingRec && existingRec.status === "active") return;
    }
  }

  // Work out which plan they were buying.
  const firstItem = txn.items && txn.items[0];
  const priceId   = (firstItem && firstItem.price && firstItem.price.id) || null;
  const plan      = planFromPriceId(priceId, env);

  // Abandoned-cart recovery mints a %-off Paddle discount. Exclude lifetime so
  // the $49 launch anchor is never undercut by recovery or stacked promos.
  if (plan === "lifetime") {
    return;
  }

  const key  = PENDING_PREFIX + txnId;
  const prev = await env.LICENSES.get(key, "json");
  const now  = new Date().toISOString();

  const rec = prev || {};
  rec.email       = email;
  rec.plan        = plan;
  rec.priceId     = priceId;
  rec.customerId  = customerId;
  rec.createdAt   = rec.createdAt || now;
  rec.lastSeenAt  = now;
  // notifiedAt / discountId preserved from prev if already set.

  // 10-day TTL — the cron will sweep long before this, but serves as a
  // safety net in case the cron ever stops running. 10 * 86400 = 864000.
  await env.LICENSES.put(key, JSON.stringify(rec), { expirationTtl: 864000 });
}

// Fires when Paddle tells us explicitly the transaction was canceled
// (user closed the window, time-out, etc). We keep the pending record
// so the recovery cron can still send an email.
async function onTransactionCanceled(txn, env) {
  // No-op for now; pending record stays in KV until the cron processes it.
  // Intentionally left lean — kept as a named function so future changes
  // to cancel-specific logic (e.g. instant recovery) have a landing spot.
}

// Delete a pending-cart record (called after a successful purchase).
// Accepts either a transactionId or an email match. Best-effort.
async function clearPendingCart(env, { transactionId, email }) {
  if (transactionId) {
    await env.LICENSES.delete(PENDING_PREFIX + transactionId);
  }
  if (email) {
    // Also sweep any other pending records for this email (same user might
    // have bounced once and come back with a different txn id).
    const list = await env.LICENSES.list({ prefix: PENDING_PREFIX });
    for (const k of list.keys) {
      const rec = await env.LICENSES.get(k.name, "json");
      if (rec && rec.email && rec.email.toLowerCase() === email.toLowerCase()) {
        await env.LICENSES.delete(k.name);
      }
    }
  }
}

// Map a Paddle price id to our plan slug. Configure these in wrangler.toml
// ([vars] PADDLE_PRICE_MONTHLY / _ANNUAL / _LIFETIME).
// Plan is inferred from whichever price id the webhook surfaced — we don't
// care which provider sent it, the env var match tells us what the buyer
// actually picked. Keeping both Paddle and Stripe lookups here means the
// downstream license-creation code stays provider-agnostic.
function planFromPriceId(priceId, env) {
  if (!priceId) return null;
  if (priceId === env.PADDLE_PRICE_MONTHLY)  return "monthly";
  if (priceId === env.PADDLE_PRICE_ANNUAL)   return "annual";
  if (priceId === env.PADDLE_PRICE_LIFETIME) return "lifetime";
  if (priceId === env.STRIPE_PRICE_MONTHLY)  return "monthly";
  if (priceId === env.STRIPE_PRICE_ANNUAL)   return "annual";
  if (priceId === env.STRIPE_PRICE_LIFETIME) return "lifetime";
  return null;
}

// ─── Paddle discount API ────────────────────────────────────────────────────
// Creates a one-shot percentage discount tied to a specific price id.
//
// Paddle's /discounts endpoint expects:
//   amount        — percentage as a STRING ("33" not 33)
//   type          — "percentage" | "flat" | "flat_per_seat"
//   code          — unique code buyers type at checkout
//   usage_limit   — 1 = can only be redeemed once total
//   expires_at    — ISO; after this, the code stops working
//   restrict_to   — [priceId] so it only applies to the intended plan
//   enabled_for_checkout — true so overlay checkout accepts it
//
// Docs: https://developer.paddle.com/api-reference/discounts/create-discount
async function createRecoveryDiscount(env, { percent, priceId, label }) {
  if (!env.PADDLE_API_KEY) {
    throw new Error("PADDLE_API_KEY not set — can't mint recovery discount");
  }

  // Generate a unique, human-typeable code. "COMEBACK-<6-char>" is short
  // enough to paste from email but unguessable (32^6 = 1B combos).
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const b of bytes) suffix += alpha[b % alpha.length];
  const code = "COMEBACK-" + suffix;

  // 7-day validity — long enough to get through a weekend, short enough
  // that the urgency of the email actually matters.
  const expiresAt = new Date(Date.now() + 7 * 864e5).toISOString();

  const body = {
    amount:      String(percent),
    type:        "percentage",
    description: label || `Recovery ${percent}%`,
    code,
    usage_limit: 1,
    expires_at:  expiresAt,
    enabled_for_checkout: true,
    ...(priceId ? { restrict_to: [priceId] } : {})
  };

  const r    = await paddleFetch(env, "/discounts", {
    method: "POST",
    body:   JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.data) {
    throw new Error("Paddle discount create failed: HTTP " + r.status +
                    " " + JSON.stringify(data));
  }
  return { id: data.data.id, code, expiresAt };
}

// ─── Email 3: abandoned-cart recovery (our custom follow-up) ────────────────
async function sendAbandonmentEmail(env, to, { plan, discountCode, percent }) {
  const d = planDetails(plan);

  // Checkout deep-link — the landing page's main.tsx handles ?plan=<slug>
  // by auto-opening the Paddle overlay for that plan. User can paste the
  // discount code in the overlay to redeem.
  const deepLink = "https://trysmartcut.com/?plan=" + (plan || "monthly") + "#pricing";

  const codeBlock = `
    <table role="presentation" class="sc-discount-wrap" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:22px 0;border:1px solid #fdba74;border-radius:12px;background:#fff7ed;">
      <tr><td style="padding:20px 22px;text-align:center;">
        <div class="sc-discount-label" style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c2410c;margin-bottom:10px;">Your discount code — ${percent}% off</div>
        <div class="sc-discount-code" style="font-family:'SFMono-Regular',Menlo,Monaco,Consolas,monospace;font-size:22px;font-weight:700;color:#9a3412;letter-spacing:0.06em;">${discountCode}</div>
        <div class="sc-discount-hint" style="font-size:12px;color:#b45309;margin-top:10px;">Valid for 7 days, single use</div>
      </td></tr>
    </table>`;

  const bodyHtml = `
    <p style="margin:0 0 14px;">Saw you checking out SmartCut — looks like something didn't click at checkout.</p>
    <p style="margin:0 0 14px;">If it was the price, here's one on us: <b style="color:#c2410c;">${percent}% off</b> any plan for the next 7 days.</p>
    ${codeBlock}
    <p style="margin:16px 0 0;">Just paste it into the discount field at checkout. No tricks — one-time use, yours alone.</p>
    <p style="margin:14px 0 0;color:#52525b;font-size:13.5px;">If it was something else — a feature, a bug, a question — just reply to this email. We read every one and usually respond within a few hours.</p>`;

  const text = [
    `Saw you checking out SmartCut — looks like something didn't click.`,
    ``,
    `If it was the price, here's ${percent}% off any plan for 7 days:`,
    ``,
    `    ${discountCode}`,
    ``,
    `Paste it into the discount field at checkout: ${deepLink}`,
    ``,
    `Valid 7 days, single use.`,
    ``,
    `If it was something else — a feature, a bug, a question — just`,
    `reply to this email. We read every one.`,
    ``,
    `— The SmartCut team`
  ].join("\n");

  await sendResendEmail(env, {
    to,
    subject: `${percent}% off SmartCut — 7 days only`,
    html:    renderEmailShell({
      preheader:  `${percent}% off any plan, valid 7 days. Here's your code.`,
      heading:    `One more try, on us.`,
      bodyHtml,
      ctaHref:    deepLink,
      ctaLabel:   `Claim ${percent}% off`,
      footerNote: `Single-use code, expires in 7 days. If you don't want emails like this, just reply "stop" and we'll never send another one.`
    }),
    text,
    replyTo: "support@trysmartcut.com"
  });
}

// ─── Scheduled: sweep abandoned carts, mint discounts, send recovery ────────
//
// Runs every hour (see wrangler.toml [triggers]). Finds pending-cart
// records that are:
//   • at least RECOVERY_MIN_AGE_HOURS old (default 72h — Paddle has already
//     sent its own 60-min recovery email by then, so we're the second touch)
//   • less than RECOVERY_MAX_AGE_HOURS old (default 168h / 7d — beyond that
//     the user has moved on, don't be annoying)
//   • not yet notified (notifiedAt missing)
//
// For each: mint a single-use 33% discount via Paddle API, send the
// recovery email, mark notifiedAt so we never email them twice.
async function sweepAbandonedCarts(env) {
  const minAgeH = parseInt(env.RECOVERY_MIN_AGE_HOURS || "72", 10);
  const maxAgeH = parseInt(env.RECOVERY_MAX_AGE_HOURS || "168", 10);
  const percent = parseInt(env.RECOVERY_DISCOUNT_PERCENT || "33", 10);
  const now     = Date.now();

  const list = await env.LICENSES.list({ prefix: PENDING_PREFIX });
  let sent = 0, skipped = 0, errored = 0;

  for (const k of list.keys) {
    try {
      const rec = await env.LICENSES.get(k.name, "json");
      if (!rec)                                 { skipped++; continue; }
      if (rec.notifiedAt)                       { skipped++; continue; }
      if (!rec.email || !rec.plan)              { skipped++; continue; }

      // Never send recovery discounts for lifetime — subscriptions only.
      if (rec.plan === "lifetime") {
        await env.LICENSES.delete(k.name);
        skipped++;
        continue;
      }

      const ageMs = now - new Date(rec.createdAt).getTime();
      const ageH  = ageMs / 36e5;
      if (ageH < minAgeH || ageH > maxAgeH)     { skipped++; continue; }

      // Defensive: re-check they haven't since purchased (race vs. webhooks).
      if (rec.customerId) {
        const existingKey = await env.LICENSES.get(`paddle:ctm:${rec.customerId}`);
        if (existingKey) {
          const existing = await getLicense(env, existingKey);
          if (existing && existing.status === "active") {
            await env.LICENSES.delete(k.name);
            skipped++; continue;
          }
        }
      }

      // Mint the discount (Paddle-side) and send the email.
      const discount = await createRecoveryDiscount(env, {
        percent,
        priceId: rec.priceId,
        label:   `Recovery ${percent}% for ${rec.email}`
      });
      await sendAbandonmentEmail(env, rec.email, {
        plan:         rec.plan,
        discountCode: discount.code,
        percent
      });

      rec.notifiedAt  = new Date().toISOString();
      rec.discountId  = discount.id;
      await env.LICENSES.put(k.name, JSON.stringify(rec), { expirationTtl: 864000 });
      sent++;
    } catch (e) {
      console.error("cart-recovery error for", k.name, e);
      errored++;
    }
  }

  return { sent, skipped, errored, scanned: list.keys.length };
}

// ─── Paddle API helper ──────────────────────────────────────────────────────
// Thin wrapper around Paddle's REST API for expanding webhook data, minting
// portal sessions, etc. Switches base URL based on PADDLE_ENV so the same
// worker can serve sandbox (testing) and production (real money).
async function paddleFetch(env, path, init = {}) {
  const base = env.PADDLE_ENV === "production"
    ? "https://api.paddle.com"
    : "https://sandbox-api.paddle.com";
  return fetch(base + path, {
    ...init,
    headers: {
      "Authorization": "Bearer " + env.PADDLE_API_KEY,
      "Content-Type":  "application/json",
      ...(init.headers || {})
    }
  });
}

// ─── License key format ─────────────────────────────────────────────────────
// 4×5-char groups from a crypto-safe alphabet. ~90 bits of entropy, easy for
// humans to read out over the phone. Example: "SC-7F4K9-M2XQT-5HNBV-JC8LR"
function generateLicenseKey() {
  const alpha = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I to avoid confusion
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const out = [];
  for (let i = 0; i < 20; i++) {
    out.push(alpha[bytes[i] % alpha.length]);
    if ((i + 1) % 5 === 0 && i < 19) out.push("-");
  }
  return "SC-" + out.join("");
}

// ─── Transactional-email infrastructure ─────────────────────────────────────
// Uses Resend (https://resend.com) — cheapest/simplest transactional provider
// that runs on a plain fetch. Swap for Postmark / SendGrid / SES by
// editing sendResendEmail() below. All message content is inlined here so
// you can tweak copy without chasing templates across files.
//
// The free tier (100/day, 3k/month) covers us until ~100 sales/day. After
// that it's $20/mo for 50k — still trivial vs. revenue.
//
// Human-readable plan catalog — kept in sync with config/paddle pricing.
// Single source of truth so every email says the same thing.
const PLAN_DETAILS = {
  monthly: {
    label:        "SmartCut Monthly",
    price:        "$29.99 / month",
    billing:      "Monthly subscription — renews automatically, cancel anytime",
    accessCopy:   "Your subscription renews on {renewDate}. You can cancel, change card, or switch plan any time.",
    isSubscription: true
  },
  annual: {
    label:        "SmartCut Annual",
    price:        "$199 / year",
    billing:      "Annual subscription — renews automatically, cancel anytime",
    accessCopy:   "Your subscription renews on {renewDate}. You can cancel, change card, or switch plan any time.",
    isSubscription: true
  },
  lifetime: {
    label:        "SmartCut Lifetime",
    price:        "$49 — one-time",
    billing:      "Lifetime access — you own it forever, no renewals",
    accessCopy:   "This is a one-time purchase. You'll get every future update to SmartCut included, forever, with no recurring charges.",
    isSubscription: false
  }
};

function planDetails(plan) {
  return PLAN_DETAILS[plan] || PLAN_DETAILS.monthly;
}

// Format an ISO timestamp as "Nov 12, 2026" — friendly but unambiguous.
function formatHumanDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric"
    });
  } catch (e) {
    return "";
  }
}

// Low-level Resend call. All send* helpers funnel through this.
async function sendResendEmail(env, { to, subject, html, text, replyTo }) {
  if (!env.RESEND_API_KEY) {
    console.warn("sendResendEmail skipped: RESEND_API_KEY not set");
    return;
  }
  const body = {
    from:    env.MAIL_FROM || "SmartCut <license@trysmartcut.com>",
    to:      Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
    ...(replyTo ? { reply_to: replyTo } : {})
  };
  const r = await fetch("https://api.resend.com/emails", {
    method:  "POST",
    headers: {
      "Authorization": "Bearer " + env.RESEND_API_KEY,
      "Content-Type":  "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error("Resend HTTP " + r.status + ": " + err);
  }
}

// Shared HTML shell — keeps all three email types (license / cancel /
// recovery) visually consistent. Uses table-based layout for max
// compatibility across mail clients (Gmail, Outlook, Apple Mail).
//
// Design: **light-first** (white card on soft gray) so the message reads
// naturally in default / light-mode inboxes. A `<style>` block with
// `@media (prefers-color-scheme: dark)` upgrades Apple Mail / iOS Mail
// and other capable clients to a dark theme. Gmail often ignores the
// media query but keeps the light inline styles — which is fine.
function renderEmailShell({ preheader, heading, bodyHtml, ctaHref, ctaLabel, footerNote }) {
  const cta = ctaHref && ctaLabel ? `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:24px auto 0">
      <tr><td style="border-radius:10px;background:#ea580c;">
        <a href="${ctaHref}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.01em;border-radius:10px;background:#ea580c;">${ctaLabel}</a>
      </td></tr>
    </table>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${heading}</title>
<style type="text/css">
  @media (prefers-color-scheme: dark) {
    .sc-body, .sc-wrap { background-color: #0a0a0b !important; }
    .sc-card { background-color: #18181b !important; border-color: #3f3f46 !important; }
    .sc-brand { color: #fb923c !important; }
    .sc-h1 { color: #fafafa !important; }
    .sc-main { color: #d4d4d8 !important; }
    .sc-main a { color: #fb923c !important; }
    .sc-footer { border-top-color: #3f3f46 !important; color: #a1a1aa !important; }
    .sc-footer a { color: #fdba74 !important; }
    .sc-footer-sig { color: #71717a !important; }
    .sc-panel { background-color: #09090b !important; border-color: #3f3f46 !important; }
    .sc-label { color: #a1a1aa !important; }
    .sc-strong { color: #fafafa !important; }
    .sc-muted { color: #a1a1aa !important; }
    .sc-small { color: #71717a !important; }
    .sc-key { color: #fafafa !important; }
    .sc-ol { color: #d4d4d8 !important; }
    .sc-btn-secondary { background-color: #27272a !important; border-color: #52525b !important; color: #fafafa !important; }
    .sc-discount-wrap { background: linear-gradient(135deg, #431407, #1f0a02) !important; border-color: #ea580c !important; }
    .sc-discount-label { color: #fb923c !important; }
    .sc-discount-code { color: #ffffff !important; }
    .sc-discount-hint { color: #fdba74 !important; }
  }
</style>
</head>
<body class="sc-body" style="margin:0;padding:0;background:#f4f4f5;color:#3f3f46;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<span style="display:none;font-size:0;line-height:0;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader || ""}</span>
<table role="presentation" class="sc-wrap" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f4f4f5;padding:40px 16px;">
  <tr><td align="center">
    <table role="presentation" class="sc-card" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;overflow:hidden;">
      <tr><td style="padding:32px 32px 8px 32px;">
        <div class="sc-brand" style="font-size:15px;font-weight:600;color:#ea580c;letter-spacing:-0.01em;">SmartCut</div>
      </td></tr>
      <tr><td style="padding:8px 32px 0 32px;">
        <h1 class="sc-h1" style="margin:0 0 12px 0;font-size:22px;font-weight:700;color:#18181b;letter-spacing:-0.01em;line-height:1.3;">${heading}</h1>
      </td></tr>
      <tr><td class="sc-main" style="padding:4px 32px 32px 32px;font-size:14.5px;line-height:1.6;color:#3f3f46;">
        ${bodyHtml}
        ${cta}
      </td></tr>
      <tr><td class="sc-footer" style="padding:16px 32px 32px 32px;border-top:1px solid #e4e4e7;font-size:12.5px;line-height:1.55;color:#71717a;">
        ${footerNote || ""}
        <div class="sc-footer-sig" style="margin-top:12px;color:#52525b;">— The SmartCut team · <a href="https://trysmartcut.com" style="color:#a16207;text-decoration:underline;">trysmartcut.com</a></div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ─── Email 1: license key delivery (on first purchase) ─────────────────────
async function sendLicenseEmail(env, to, licenseKey, plan, opts = {}) {
  const d          = planDetails(plan);
  const renewDate  = opts.expiresAt ? formatHumanDate(opts.expiresAt) : "";
  const accessCopy = d.accessCopy.replace("{renewDate}", renewDate || "your next billing date");

  // Key-gated download links. These point at /get-install/:platform which
  // validates the key and 302-redirects to a freshly-signed R2 URL. Safe
  // to ship in email: license keys are high-entropy, and the ZXP itself
  // is useless without a valid key (extension pings /verify on startup).
  const apiBase    = (env.PUBLIC_API_URL || "").replace(/\/+$/, "") ||
                     "https://smartcut-license.patient-dust-4377.workers.dev";
  const dlMac      = `${apiBase}/get-install/mac?key=${encodeURIComponent(licenseKey)}`;
  const dlWin      = `${apiBase}/get-install/win?key=${encodeURIComponent(licenseKey)}`;
  const macOnlyRel = shippingMacosOnly(env);

  // Billing-portal link. For Stripe subscriptions we use the
  // customer-portal login page (set via STRIPE_PORTAL_URL in wrangler.toml
  // — grab it from Stripe Dashboard → Settings → Billing → Customer
  // portal). If that isn't configured yet, we gracefully fall back to
  // emailing support. Lifetime buyers don't need a portal at all.
  const portalUrl  = env.STRIPE_PORTAL_URL || "";
  const manageHtml = d.isSubscription
    ? (portalUrl
        ? `You can manage your subscription <a href="${portalUrl}" style="color:#c2410c;text-decoration:underline;">here</a> — cancel, update your card, or switch plan any time.`
        : `Need to cancel or change your card? Email <a href="mailto:support@trysmartcut.com" style="color:#c2410c;text-decoration:underline;">support@trysmartcut.com</a> and we'll sort you out within a day.`)
    : `Keep this email somewhere safe — it's the only copy of your key. If you lose it, email <a href="mailto:support@trysmartcut.com" style="color:#c2410c;text-decoration:underline;">support@trysmartcut.com</a> and we'll resend it.`;
  const manageText = d.isSubscription
    ? (portalUrl
        ? `Manage your subscription: ${portalUrl}`
        : `Need to cancel or change card? Email support@trysmartcut.com.`)
    : `Keep this email somewhere safe — it's the only copy of your key.`;

  const keyBlock = `
    <table role="presentation" class="sc-panel" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0;border:1px solid #e4e4e7;border-radius:10px;background:#fafafa;">
      <tr><td style="padding:18px 22px;">
        <div class="sc-label" style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#71717a;margin-bottom:8px;">Your license key</div>
        <div class="sc-key" style="font-family:'SFMono-Regular',Menlo,Monaco,Consolas,monospace;font-size:16px;font-weight:600;color:#18181b;letter-spacing:0.02em;word-break:break-all;">${licenseKey}</div>
      </td></tr>
    </table>`;

  const planBlock = `
    <table role="presentation" class="sc-panel" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0;border:1px solid #e4e4e7;border-radius:10px;background:#fafafa;">
      <tr><td style="padding:16px 22px;">
        <div class="sc-label" style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#71717a;margin-bottom:6px;">Plan</div>
        <div class="sc-strong" style="font-size:15px;font-weight:600;color:#18181b;">${d.label}</div>
        <div class="sc-muted" style="font-size:13.5px;color:#52525b;margin-top:3px;">${d.price}</div>
        <div class="sc-small" style="font-size:12.5px;color:#71717a;margin-top:8px;">${d.billing}</div>
      </td></tr>
    </table>`;

  // Table layout survives Gmail / Outlook / Apple Mail. macOS-only launch
  // uses a single full-width button so we never imply a Windows download.
  const downloadBlock = macOnlyRel ? `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0 4px;">
      <tr><td>
          <a href="${dlMac}" style="display:block;padding:14px 18px;border-radius:10px;background:#ea580c;color:#ffffff;text-decoration:none;font-size:14.5px;font-weight:600;text-align:center;letter-spacing:0.01em;">
            Download for macOS
          </a>
      </td></tr>
    </table>
    <p class="sc-small" style="margin:8px 0 0;color:#71717a;font-size:12px;line-height:1.5;text-align:center;">
      You&apos;ll get a <b>.dmg</b> with <b>Install SmartCut</b> inside &mdash; no extra tools. Requires macOS with Premiere Pro 24+. <b>Windows</b> is coming soon &mdash; your license will work there too.
    </p>` : `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0 4px;">
      <tr>
        <td width="50%" style="padding-right:6px;">
          <a href="${dlMac}" style="display:block;padding:14px 18px;border-radius:10px;background:#ea580c;color:#ffffff;text-decoration:none;font-size:14.5px;font-weight:600;text-align:center;letter-spacing:0.01em;">
            Download for macOS
          </a>
        </td>
        <td width="50%" style="padding-left:6px;">
          <a href="${dlWin}" class="sc-btn-secondary" style="display:block;padding:14px 18px;border-radius:10px;background:#ffffff;border:1px solid #d4d4d8;color:#18181b;text-decoration:none;font-size:14.5px;font-weight:600;text-align:center;letter-spacing:0.01em;">
            Download for Windows
          </a>
        </td>
      </tr>
    </table>
    <p class="sc-small" style="margin:8px 0 0;color:#71717a;font-size:12px;line-height:1.5;text-align:center;">
      Links are private to your license. macOS: <b>.dmg</b> with <b>Install SmartCut</b>; Windows: installer from the same email when available.
    </p>`;

  const bodyHtml = `
    <p style="margin:0 0 12px;">Thanks for picking up SmartCut — you're all set.</p>
    ${planBlock}
    ${keyBlock}
    <p style="margin:20px 0 8px;font-weight:600;color:#18181b;">Download the extension</p>
    ${downloadBlock}
    <p style="margin:24px 0 8px;font-weight:600;color:#18181b;">How to activate</p>
    <ol class="sc-ol" style="margin:0 0 16px 20px;padding:0;color:#3f3f46;">
      <li style="margin-bottom:6px;">${macOnlyRel ? "Download the macOS installer above (a <b>.dmg</b> file)." : "Download the installer above for your platform."}</li>
      <li style="margin-bottom:6px;">${macOnlyRel
        ? `Open the <b>.dmg</b>, double-click <b>Install SmartCut</b>, and click OK when it finishes. (If macOS warns the app is from an unidentified developer, right-click <b>Install SmartCut</b> → <b>Open</b> once.)`
        : `On macOS, open the <b>.dmg</b> and run <b>Install SmartCut</b>. On Windows, run the installer from your download link and follow the steps.`}</li>
      <li style="margin-bottom:6px;">Open Premiere Pro and go to <b>Window → Extensions → SmartCut</b>.</li>
      <li style="margin-bottom:6px;">Paste the key above into the activation box, then click <b>Activate</b>.</li>
    </ol>
    <p style="margin:16px 0 0;">${accessCopy}</p>
    <p class="sc-muted" style="margin:12px 0 0;color:#52525b;font-size:13.5px;">One key activates on up to <b>2 machines</b> simultaneously. You can free up a slot any time from the extension's settings.</p>`;

  const text = [
    `SmartCut — your license key`,
    ``,
    `Plan:   ${d.label} (${d.price})`,
    `Terms:  ${d.billing}`,
    renewDate ? `Renews: ${renewDate}` : "",
    ``,
    `License key:`,
    `    ${licenseKey}`,
    ``,
    `Download the extension:`,
    `  macOS:   ${dlMac}`,
    ...(macOnlyRel ? [`  (Windows build not available yet — same license will work when we ship it.)`] : [`  Windows: ${dlWin}`]),
    ``,
    `To activate:`,
    macOnlyRel
      ? `  1. Download the macOS installer above`
      : `  1. Download the installer above for your platform`,
    macOnlyRel
      ? `  2. Open the .dmg, double-click Install SmartCut, confirm — if blocked, right-click → Open once`
      : `  2. macOS: open .dmg → Install SmartCut. Windows: run the installer from your link`,
    `  3. Open Premiere Pro → Window → Extensions → SmartCut`,
    `  4. Paste the key and click Activate`,
    ``,
    `${accessCopy}`,
    ``,
    `Activates on up to 2 machines. ${manageText}`,
    ``,
    `— The SmartCut team`
  ].filter(Boolean).join("\n");

  await sendResendEmail(env, {
    to,
    subject:    `Your SmartCut license (${d.label})`,
    html:       renderEmailShell({
      preheader:  `Your ${d.label} license key + download links are inside.`,
      heading:    `You're in!`,
      bodyHtml,
      footerNote: manageHtml
    }),
    text,
    replyTo:    "support@trysmartcut.com"
  });
}

// ─── Email 2: subscription canceled ─────────────────────────────────────────
// Fires the moment Paddle's subscription.canceled webhook arrives. Users
// keep access until expiresAt (the end of their current billing period)
// — we just want to (a) confirm the cancellation for their records and
// (b) give them a frictionless way to resubscribe if they change their
// mind. Standard in top-tier SaaS (Linear, Raycast, Cron, etc.).
async function sendCancellationEmail(env, to, { licenseKey, plan, expiresAt }) {
  const d       = planDetails(plan);
  const endDate = formatHumanDate(expiresAt);
  const subj    = `Your SmartCut subscription has been canceled`;
  const resubLink = "https://trysmartcut.com/?plan=" + (plan === "annual" ? "annual" : "monthly") + "#pricing";

  const accessBlock = endDate ? `
    <table role="presentation" class="sc-panel" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0;border:1px solid #e4e4e7;border-radius:10px;background:#fafafa;">
      <tr><td style="padding:16px 22px;">
        <div class="sc-label" style="font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#71717a;margin-bottom:6px;">Access continues until</div>
        <div class="sc-strong" style="font-size:18px;font-weight:600;color:#18181b;">${endDate}</div>
        <div class="sc-small" style="font-size:12.5px;color:#71717a;margin-top:6px;">You paid through the end of the current billing period — nothing changes until then.</div>
      </td></tr>
    </table>` : "";

  const bodyHtml = `
    <p style="margin:0 0 12px;">Your <b class="sc-strong" style="color:#18181b;">${d.label}</b> subscription has been canceled. No more charges will be made.</p>
    ${accessBlock}
    <p style="margin:16px 0 8px;">After that date, your license (<span style="font-family:'SFMono-Regular',Menlo,Monaco,Consolas,monospace;color:#52525b;">${licenseKey}</span>) will stop activating in Premiere. If you resubscribe later, we'll reuse the same key automatically.</p>
    <p class="sc-muted" style="margin:16px 0 0;color:#52525b;font-size:13.5px;">If you canceled by accident, you can resubscribe in one click — we keep your old key reserved for 30 days.</p>`;

  const text = [
    `Your SmartCut subscription has been canceled.`,
    ``,
    `Plan: ${d.label}`,
    endDate ? `Access continues until: ${endDate}` : "",
    ``,
    `After that date, license key ${licenseKey} will stop activating in`,
    `Premiere. If you resubscribe later, we'll reuse the same key.`,
    ``,
    `Resubscribe: ${resubLink}`,
    ``,
    `If something about SmartCut didn't work for you, we'd genuinely love`,
    `to hear why — just reply to this email.`,
    ``,
    `— The SmartCut team`
  ].filter(Boolean).join("\n");

  await sendResendEmail(env, {
    to,
    subject: subj,
    html:    renderEmailShell({
      preheader:  `No more charges. You keep access until ${endDate || "the end of the current billing period"}.`,
      heading:    `Sorry to see you go.`,
      bodyHtml,
      ctaHref:    resubLink,
      ctaLabel:   `Resubscribe`,
      footerNote: `If something didn't work for you, we'd genuinely love to hear why — just reply to this email. We read every one.`
    }),
    text,
    replyTo: "support@trysmartcut.com"
  });
}

// ─── /admin/release ─────────────────────────────────────────────────────────
async function handleAdminRelease(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  const body = await req.json().catch(() => ({}));
  if (!body.version) return json({ ok: false, reason: "bad_request" }, 400);

  await env.LICENSES.put("__release__", JSON.stringify({
    version:    body.version,
    notes:      body.notes || "",
    releasedAt: new Date().toISOString()
  }));
  return json({ ok: true, version: body.version });
}

// ─── /admin/recovery-sweep ──────────────────────────────────────────────────
// Runs the abandoned-cart sweep on demand. Useful for:
//   • Testing the whole flow without waiting an hour for cron
//   • Manual backfill after deploying cron for the first time
//   • Monitoring — returns scanned/sent/skipped counts in the response
//
// Header: Authorization: Bearer <ADMIN_TOKEN>
async function handleAdminRecoverySweep(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  const result = await sweepAbandonedCarts(env);
  return json({ ok: true, ...result });
}

// ─── /admin/grant ───────────────────────────────────────────────────────────
// Manually mint a license — useful for comp copies, press, support
// overrides, or lifetime upgrades that weren't processed through Paddle.
//
// Header: Authorization: Bearer <ADMIN_TOKEN>
// Body:   { email, plan: "monthly"|"annual"|"lifetime", expiresAt?, activationsMax? }
async function handleAdminGrant(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  const body = await req.json().catch(() => ({}));
  if (!body.email) return json({ ok: false, reason: "bad_request" }, 400);

  const licenseKey = generateLicenseKey();
  const rec = emptyLicense(licenseKey, env);
  rec.email       = body.email;
  rec.status      = "active";
  rec.plan        = body.plan || "lifetime";
  rec.expiresAt   = body.expiresAt || null;
  if (body.activationsMax) rec.activationsMax = parseInt(body.activationsMax, 10);
  await putLicense(env, rec);
  return json({ ok: true, licenseKey, email: rec.email, plan: rec.plan });
}

// ─── helpers ────────────────────────────────────────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

async function getLicense(env, key) {
  return await env.LICENSES.get("license:" + key, "json");
}
async function putLicense(env, rec) {
  await env.LICENSES.put("license:" + rec.licenseKey, JSON.stringify(rec));
}
function emptyLicense(licenseKey, env) {
  return {
    licenseKey,
    email: null,
    status: "active",
    plan: null,
    // provider = which payment processor minted this license. We keep both
    // Paddle and Stripe id families on the record (most will be null) so
    // either webhook flow can look up and mutate the same record, and so
    // switching providers mid-lifecycle (e.g. Paddle → Stripe migration)
    // doesn't require a schema change.
    provider: null,              // "paddle" | "stripe"
    paddleCustomerId: null,
    paddleSubscriptionId: null,
    paddleTransactionId: null,
    paddlePriceId: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeCheckoutSessionId: null,
    stripePriceId: null,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    machineIds: [],
    activationsMax: parseInt(env.ACTIVATIONS_MAX || "2", 10)
  };
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Paddle signature (Paddle Billing / webhook v1):
//
//   Paddle-Signature: ts=1704805940;h1=abc123...
//
// Expected = HMAC-SHA256(secret, `${ts}:${rawBody}`)
// Reject if timestamp is >5 min old to block replay attacks.
//
// Multiple h1 entries can coexist during key rotation — accept if ANY match.
async function verifyPaddleSignature(body, header, secret) {
  if (!header || !secret) return false;

  // Parse the semicolon-delimited key=value parts.
  const parts = {};
  const h1s   = [];
  for (const seg of header.split(";")) {
    const idx = seg.indexOf("=");
    if (idx <= 0) continue;
    const k = seg.slice(0, idx).trim();
    const v = seg.slice(idx + 1).trim();
    if (k === "h1") h1s.push(v);
    else parts[k] = v;
  }

  if (!parts.ts || h1s.length === 0) return false;

  const now = Math.floor(Date.now() / 1000);
  const ts  = parseInt(parts.ts, 10);
  if (!ts || Math.abs(now - ts) > 300) return false;

  const expected = await hmacSha256Hex(secret, `${parts.ts}:${body}`);
  for (const candidate of h1s) {
    if (timingSafeEqual(expected, candidate)) return true;
  }
  return false;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
