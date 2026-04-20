// ═══════════════════════════════════════════════════════════════════════════
// SmartCut — License Worker (Cloudflare, Stripe-backed)
// ═══════════════════════════════════════════════════════════════════════════
//
// Responsibilities:
//   1. Stripe webhooks       → store license keys in KV, reflect status
//   2. POST /verify          → verify / activate a license (panel calls)
//   3. POST /deactivate      → drop a machine from the activation list
//   4. POST /download-url    → hand back a short-lived signed URL to the
//                              latest .zxp hosted in R2. License-gated.
//   5. GET  /latest-version  → public: { version, notes, releasedAt }
//   6. POST /portal-url      → mint a Stripe Billing Portal session for the
//                              caller's license (one-click "Manage sub")
//   7. POST /admin/release   → (admin-only) bump LATEST_VERSION after
//                              uploading a new .zxp to R2
//   8. POST /admin/grant     → (admin-only) manually create a license
//                              (for comp copies, support overrides, etc)
//
// ─── KV schema ──────────────────────────────────────────────────────────────
//   key:    license:<licenseKey>
//   value:  {
//     licenseKey,
//     email,
//     status: "active" | "paused" | "refunded" | "canceled",
//     plan:   "monthly" | "annual" | "lifetime",
//     stripeCustomerId,                // for portal sessions
//     stripeSubscriptionId | null,     // null for lifetime
//     stripePriceId,
//     createdAt,
//     expiresAt | null,                // next_billed_at for subs, null for lifetime
//     machineIds: [{ id, meta, activatedAt }],
//     activationsMax
//   }
//
//   Secondary index (so webhooks can look a license up by Stripe IDs):
//   key:    stripe:cus:<customer_id>   → licenseKey
//   key:    stripe:sub:<sub_id>        → licenseKey
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
      switch (url.pathname) {
        case "/":                         return json({ ok: true, service: "smartcut-license" });
        case "/latest-version":           return handleLatestVersion(env);
        case "/webhook/stripe":           return handleStripeWebhook(req, env);
        case "/verify":                   return handleVerify(req, env);
        case "/deactivate":               return handleDeactivate(req, env);
        case "/download-url":             return handleDownloadUrl(req, env);
        case "/portal-url":               return handlePortalUrl(req, env);
        case "/stripe/lifetime-stats":    return handleLifetimeStats(env);
        case "/admin/release":            return handleAdminRelease(req, env);
        case "/admin/grant":              return handleAdminGrant(req, env);
      }
      return json({ ok: false, reason: "not_found" }, 404);
    } catch (e) {
      console.error("Worker error:", e);
      return json({ ok: false, reason: "server_error",
        message: e.message || String(e) }, 500);
    }
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
    if (rec.machineIds.length >= (rec.activationsMax || 3)) {
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
    activationsMax:  rec.activationsMax || 3,
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
// Mint a Stripe Billing Portal session for the caller's license so the
// "Manage subscription" button in the extension can open straight into
// their account with one click. Lifetime licenses don't have a portal —
// they get null back and the client falls back to a mailto.
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
  // Lifetime licenses have no subscription to manage.
  if (rec.plan === "lifetime" || !rec.stripeCustomerId) {
    return json({ ok: false, reason: "no_subscription",
      message: "Lifetime licenses don't have a subscription portal. " +
               "Email support@trysmartcut.com if you need help." });
  }

  const form = new URLSearchParams();
  form.set("customer",   rec.stripeCustomerId);
  form.set("return_url", env.PORTAL_RETURN_URL || "https://trysmartcut.com/thanks");

  const res = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method:  "POST",
    headers: {
      "Authorization":  "Bearer " + env.STRIPE_SECRET_KEY,
      "Content-Type":   "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("portal session failed", data);
    return json({ ok: false, reason: "stripe_error",
      message: "Stripe could not open the billing portal right now." });
  }
  return json({ ok: true, url: data.url });
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

  const kvRel = await env.LICENSES.get("__release__", "json");
  const version = (kvRel && kvRel.version) || env.LATEST_VERSION;
  const fileName = await pickReleaseFile(env, version, platform);
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

async function pickReleaseFile(env, version, platform) {
  const candidates = [];
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

  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "private, max-age=60"
    }
  });
}

// ─── /webhook/stripe ────────────────────────────────────────────────────────
//
// Stripe sends signed webhooks. We verify the signature (HMAC-SHA256 of
// "<timestamp>.<body>" with the endpoint-specific STRIPE_WEBHOOK_SECRET),
// then dispatch on `type`.
//
// Event flow:
//
//   checkout.session.completed
//     → First touchpoint after a successful purchase. We mint a brand-new
//       licenseKey, store a license record with the Stripe customer_id +
//       subscription_id, and email the key to the buyer.
//
//   invoice.paid (subscription renewal)
//     → Extend expiresAt to the new current_period_end.
//
//   customer.subscription.updated
//     → Plan switches (monthly ↔ annual), pauses, resumes. Reflect
//       status + expiresAt.
//
//   customer.subscription.deleted
//     → Sub canceled. Mark status=canceled; license will fail /verify
//       after this point.
//
//   charge.refunded
//     → Mark status=refunded.
async function handleStripeWebhook(req, env) {
  const rawBody   = await req.text();
  const sigHeader = req.headers.get("Stripe-Signature") || "";
  if (!await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET)) {
    return new Response("Bad signature", { status: 401 });
  }

  const evt = JSON.parse(rawBody);
  const type = evt.type;
  const obj  = (evt.data && evt.data.object) || {};

  switch (type) {
    case "checkout.session.completed":      await onCheckoutCompleted(obj, env); break;
    case "invoice.paid":                    await onInvoicePaid(obj, env); break;
    case "customer.subscription.updated":   await onSubscriptionUpdated(obj, env); break;
    case "customer.subscription.deleted":   await onSubscriptionDeleted(obj, env); break;
    case "charge.refunded":                 await onChargeRefunded(obj, env); break;
    default:
      // Ignore unhandled events; Stripe sends many we don't care about.
      break;
  }
  return json({ ok: true });
}

async function onCheckoutCompleted(session, env) {
  // `mode` tells us whether this was a subscription or one-time (lifetime).
  const mode = session.mode;                      // "subscription" | "payment"
  const customerId = session.customer || null;
  const subscriptionId = session.subscription || null;
  const email = (session.customer_details && session.customer_details.email)
             || session.customer_email || null;

  // Pull the price id so we can tell monthly vs annual vs lifetime.
  // For subscriptions the price lives on the sub object; for one-time
  // payments it's in line_items (we expand it via a GET).
  let priceId = null;
  let expiresAt = null;
  let plan = null;

  if (mode === "subscription" && subscriptionId) {
    const sub = await stripeGet(env, `/v1/subscriptions/${subscriptionId}`);
    if (sub && sub.items && sub.items.data && sub.items.data[0]) {
      priceId = sub.items.data[0].price && sub.items.data[0].price.id;
    }
    if (sub && sub.current_period_end) {
      expiresAt = new Date(sub.current_period_end * 1000).toISOString();
    }
    plan = planFromPriceId(priceId, env);
  } else if (mode === "payment") {
    // Lifetime — expand line items to grab the price.
    const items = await stripeGet(env,
      `/v1/checkout/sessions/${session.id}/line_items?expand[]=data.price`);
    if (items && items.data && items.data[0] && items.data[0].price) {
      priceId = items.data[0].price.id;
    }
    plan = planFromPriceId(priceId, env) || "lifetime";
    expiresAt = null; // lifetime never expires
  }

  // Reuse an existing license if the customer came back to buy again;
  // otherwise mint a fresh key.
  let licenseKey = null;
  if (customerId) {
    licenseKey = await env.LICENSES.get(`stripe:cus:${customerId}`);
  }
  if (!licenseKey) {
    licenseKey = generateLicenseKey();
  }

  const existing = await getLicense(env, licenseKey);
  const rec = existing || emptyLicense(licenseKey, env);
  rec.email                = email || rec.email;
  rec.status               = "active";
  rec.plan                 = plan || rec.plan || "monthly";
  rec.stripeCustomerId     = customerId || rec.stripeCustomerId;
  rec.stripeSubscriptionId = subscriptionId || rec.stripeSubscriptionId || null;
  rec.stripePriceId        = priceId || rec.stripePriceId || null;
  rec.createdAt            = rec.createdAt || new Date().toISOString();
  rec.expiresAt            = expiresAt;
  await putLicense(env, rec);

  // Secondary indexes so webhook lookups by Stripe id are O(1).
  if (customerId) {
    await env.LICENSES.put(`stripe:cus:${customerId}`, licenseKey);
  }
  if (subscriptionId) {
    await env.LICENSES.put(`stripe:sub:${subscriptionId}`, licenseKey);
  }

  // Track lifetime slot consumption for the public counter on the
  // landing page. Guarded with a per-session marker so webhook retries
  // (Stripe retries `checkout.session.completed` on failure) don't
  // double-count the same purchase.
  if (rec.plan === "lifetime") {
    await incrementLifetimeSold(env, session.id);
  }

  // Email the license key to the buyer. Best-effort — we don't fail the
  // webhook if email delivery hiccups; Stripe will otherwise retry the
  // whole event and we'd double-process.
  if (email && env.RESEND_API_KEY) {
    try { await sendLicenseEmail(env, email, licenseKey, rec.plan); }
    catch (e) { console.error("license email failed:", e); }
  }
}

// ─── Lifetime slot counter ──────────────────────────────────────────────────
// Idempotent: marks the session id as seen before incrementing so retries
// are safe. KV reads are eventually consistent but at 1 purchase/minute
// scale the racing is not a concern.
async function incrementLifetimeSold(env, sessionId) {
  const seenKey = `lifetime:seen:${sessionId}`;
  const seen    = await env.LICENSES.get(seenKey);
  if (seen) return;
  await env.LICENSES.put(seenKey, "1");

  const curr = parseInt((await env.LICENSES.get("lifetime:sold")) || "0", 10) || 0;
  await env.LICENSES.put("lifetime:sold", String(curr + 1));
}

// ─── /stripe/lifetime-stats (public) ────────────────────────────────────────
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

async function onInvoicePaid(invoice, env) {
  const subId = invoice.subscription;
  if (!subId) return;
  const licenseKey = await env.LICENSES.get(`stripe:sub:${subId}`);
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;
  // Refresh expiresAt from the sub itself — invoices don't always carry it.
  const sub = await stripeGet(env, `/v1/subscriptions/${subId}`);
  if (sub && sub.current_period_end) {
    rec.expiresAt = new Date(sub.current_period_end * 1000).toISOString();
  }
  rec.status = "active";
  await putLicense(env, rec);
}

async function onSubscriptionUpdated(sub, env) {
  const licenseKey = await env.LICENSES.get(`stripe:sub:${sub.id}`);
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;
  // Plan swap?
  if (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price) {
    rec.stripePriceId = sub.items.data[0].price.id;
    rec.plan = planFromPriceId(rec.stripePriceId, env) || rec.plan;
  }
  if (sub.current_period_end) {
    rec.expiresAt = new Date(sub.current_period_end * 1000).toISOString();
  }
  // Stripe statuses: active | trialing | past_due | canceled | unpaid | paused
  if (sub.status === "active" || sub.status === "trialing") {
    rec.status = "active";
  } else if (sub.status === "past_due" || sub.status === "unpaid" || sub.status === "paused") {
    rec.status = "paused";
  } else if (sub.status === "canceled") {
    rec.status = "canceled";
  }
  await putLicense(env, rec);
}

async function onSubscriptionDeleted(sub, env) {
  const licenseKey = await env.LICENSES.get(`stripe:sub:${sub.id}`);
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;
  rec.status = "canceled";
  await putLicense(env, rec);
}

async function onChargeRefunded(charge, env) {
  // Charges can belong to a subscription invoice or a one-time payment.
  // For subs we follow charge → invoice → sub → license; for lifetime we
  // fall back to finding the customer's license.
  let licenseKey = null;
  if (charge.invoice) {
    const inv = await stripeGet(env, `/v1/invoices/${charge.invoice}`);
    if (inv && inv.subscription) {
      licenseKey = await env.LICENSES.get(`stripe:sub:${inv.subscription}`);
    }
  }
  if (!licenseKey && charge.customer) {
    licenseKey = await env.LICENSES.get(`stripe:cus:${charge.customer}`);
  }
  if (!licenseKey) return;
  const rec = await getLicense(env, licenseKey);
  if (!rec) return;
  rec.status = "refunded";
  await putLicense(env, rec);
}

// Map a Stripe price id to our plan slug. Configure these in wrangler.toml
// ([vars] STRIPE_PRICE_MONTHLY / _ANNUAL / _LIFETIME).
function planFromPriceId(priceId, env) {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_MONTHLY)  return "monthly";
  if (priceId === env.STRIPE_PRICE_ANNUAL)   return "annual";
  if (priceId === env.STRIPE_PRICE_LIFETIME) return "lifetime";
  return null;
}

// Thin Stripe GET helper for expanding webhook data when we need it.
async function stripeGet(env, path) {
  const r = await fetch("https://api.stripe.com" + path, {
    headers: { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

// ─── License key format ─────────────────────────────────────────────────────
// 4×5-char groups from a crypto-safe alphabet. ~90 bits of entropy, easy for
// humans to read out over the phone. Example: "7F4K9-M2XQT-5HNBV-JC8LR"
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

// ─── License-key email ──────────────────────────────────────────────────────
// Uses Resend (https://resend.com) because it's the cheapest
// transactional-email provider that runs on a plain fetch. Swap in
// Postmark / SendGrid / SES by changing this one function.
async function sendLicenseEmail(env, to, licenseKey, plan) {
  const planLabel =
    plan === "annual"   ? "annual" :
    plan === "lifetime" ? "lifetime" :
                          "monthly";
  const subject = `Your SmartCut license key (${planLabel})`;
  const text = [
    "Thanks for picking up SmartCut — your license key is below.",
    "",
    "    " + licenseKey,
    "",
    "To activate:",
    "  1. Open Premiere Pro → Window → Extensions → SmartCut",
    "  2. Paste the key above into the activation box",
    "  3. Start cutting",
    "",
    "You can use this key on up to 3 machines. Need help? Just reply to this email.",
    "",
    "— The SmartCut team"
  ].join("\n");

  const body = {
    from:    env.MAIL_FROM || "SmartCut <license@trysmartcut.com>",
    to:      [to],
    subject: subject,
    text:    text
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

// ─── /admin/grant ───────────────────────────────────────────────────────────
// Manually mint a license — useful for comp copies, press, support
// overrides, or lifetime upgrades that weren't processed through Stripe.
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
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    machineIds: [],
    activationsMax: parseInt(env.ACTIVATIONS_MAX || "3", 10)
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

// Stripe signature:
//   Stripe-Signature: t=<unix>,v1=<hex>,v1=<hex>,...
// Expected = HMAC-SHA256(secret, "<t>.<rawBody>")
// Accept if any v1 in the header matches. Reject if timestamp is >5min
// old to block replay attacks.
async function verifyStripeSignature(body, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map(p => {
      const [k, v] = p.trim().split("=");
      return [k, v];
    })
  );
  if (!parts.t || !parts.v1) return false;

  const now = Math.floor(Date.now() / 1000);
  const ts  = parseInt(parts.t, 10);
  if (!ts || Math.abs(now - ts) > 300) return false;

  const expected = await hmacSha256Hex(secret, `${parts.t}.${body}`);

  // Stripe can put multiple v1= entries in the header; re-parse manually.
  const v1s = header.split(",")
    .map(p => p.trim())
    .filter(p => p.startsWith("v1="))
    .map(p => p.slice(3));
  for (const candidate of v1s) {
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
