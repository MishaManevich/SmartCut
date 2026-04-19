// ═══════════════════════════════════════════════════════════════════════════
// SmartCut — License Worker (Cloudflare)
// ═══════════════════════════════════════════════════════════════════════════
//
// Responsibilities:
//   1. Accept Paddle webhooks  → store license keys in KV
//   2. POST /verify            → verify / activate a license (panel calls)
//   3. POST /deactivate        → drop a machine from the activation list
//   4. POST /download-url      → hand back a short-lived signed URL to the
//                                 latest .zxp hosted in R2. License-gated.
//   5. GET  /latest-version    → public: { version, notes, releasedAt }
//   6. POST /admin/release     → (admin-only) bump LATEST_VERSION after
//                                 uploading a new .zxp to R2
//
// ─── KV schema ──────────────────────────────────────────────────────────────
//   key:    license:<licenseKey>
//   value:  {
//     licenseKey, email, paddleTransactionId, productId,
//     status: "active"|"refunded"|"paused",  // paused = subscription lapsed
//     createdAt, expiresAt|null,
//     machineIds: [{ id, meta, activatedAt }],
//     activationsMax
//   }
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
        case "/":                  return json({ ok: true, service: "smartcutpro-license" });
        case "/latest-version":    return handleLatestVersion(env);
        case "/webhook/paddle":    return handlePaddleWebhook(req, env);
        case "/verify":            return handleVerify(req, env);
        case "/deactivate":        return handleDeactivate(req, env);
        case "/download-url":      return handleDownloadUrl(req, env);
        case "/admin/release":     return handleAdminRelease(req, env);
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
// KV-stored release data wins over env-var defaults, so /admin/release can
// bump versions without a redeploy.
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
    // First activation on this machine — record it if the caller asked for one.
    if (activation) {
      rec.machineIds.push({
        id: machineId,
        meta: machineMeta || {},
        activatedAt: new Date().toISOString()
      });
      await putLicense(env, rec);
    } else {
      // Revalidation from a machine we don't recognize.
      return json({ ok: false, reason: "unknown_machine",
        message: "This license isn't activated on this machine. Re-enter your key to activate." });
    }
  }

  return json({
    ok: true, kind: "full",
    email: rec.email || null,
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
  if (!rec) return json({ ok: true }); // nothing to do

  rec.machineIds = (rec.machineIds || []).filter(m => m.id !== machineId);
  await putLicense(env, rec);
  return json({ ok: true });
}

// ─── /download-url ──────────────────────────────────────────────────────────
// License-gated. Returns a short-lived URL for the latest .zxp. The URL is
// signed so it can't be shared widely.
//
// Platform handling: Mac and Windows ship as separate .zxp files because
// each bundles a platform-specific whisper-cli binary. The client sends
// `platform: "mac"|"win"`. We look up the matching object in R2; if that
// name isn't present yet (e.g. you've only uploaded the Mac build), we
// fall back to the legacy platform-less filename so old releases keep
// working.
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

  // The URL points back at this same Worker: /download/<file>?exp=…&sig=…
  // The Worker validates the signature and streams from R2.
  const toSign = `${fileName}|${expiresAt}|${machineId}`;
  const sig = await hmacSha256Hex(env.DOWNLOAD_SIGNING_KEY || "dev-insecure-key", toSign);
  const origin = new URL(req.url).origin;
  const url = `${origin}/download/${encodeURIComponent(fileName)}?exp=${expiresAt}&mid=${encodeURIComponent(machineId)}&sig=${sig}`;

  return json({
    ok: true,
    url, version,
    platform,
    fileName,
    expiresAt: new Date(expiresAt * 1000).toISOString()
  });
}

// Normalize whatever the client sent into { mac | win | unknown }.
function normalizePlatform(raw) {
  const p = String(raw || "").toLowerCase();
  if (p === "mac" || p === "darwin" || p === "osx") return "mac";
  if (p === "win" || p === "windows" || p.startsWith("win"))  return "win";
  return "unknown";
}

// Candidate filenames, in order of preference. Ship separate .zxp per
// platform so each bundle can carry its matching whisper-cli binary.
// Historical/unknown platforms fall back to the legacy platform-less name.
async function pickReleaseFile(env, version, platform) {
  const candidates = [];
  if (platform === "mac" || platform === "win") {
    candidates.push(`SmartCut-${version}-${platform}.zxp`);
    candidates.push(`SmartCutPro-${version}-${platform}.zxp`); // legacy name
  }
  candidates.push(`SmartCut-${version}.zxp`);
  candidates.push(`SmartCutPro-${version}.zxp`); // legacy, platform-agnostic
  for (const name of candidates) {
    const head = await env.RELEASES.head(name);
    if (head) return name;
  }
  return null;
}

// ─── /download/<file>?exp=&sig= ─────────────────────────────────────────────
// (handled via a path prefix below instead of in the main switch)
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

// ─── /webhook/paddle ────────────────────────────────────────────────────────
//
// Paddle sends signed webhooks. We verify the signature, then upsert the
// license record. This handler treats Paddle Billing's event shape:
//   transaction.completed   → create license
//   subscription.updated    → refresh expiresAt
//   subscription.canceled   → set status=paused, keep record
//   adjustment.created with action=refund → status=refunded
//
// Paddle delivers the buyer's license key via the customer-facing email
// OR via a custom_data field we set at checkout. Easiest path: set
// `custom_data.license_key` at checkout creation (server-side) using a
// fresh random uuid. That's the key we store and the user pastes in.
async function handlePaddleWebhook(req, env) {
  const rawBody = await req.text();
  const sigHeader = req.headers.get("Paddle-Signature") || "";
  if (!await verifyPaddleSignature(rawBody, sigHeader, env.PADDLE_WEBHOOK_SECRET)) {
    return new Response("Bad signature", { status: 401 });
  }

  const evt = JSON.parse(rawBody);
  const type = evt.event_type;
  const data = evt.data || {};

  switch (type) {
    case "transaction.completed": {
      const licenseKey = (data.custom_data && data.custom_data.license_key)
                     || (data.items && data.items[0] && data.items[0].custom_data
                         && data.items[0].custom_data.license_key);
      if (!licenseKey) {
        console.warn("Paddle transaction missing custom_data.license_key", data.id);
        break;
      }
      const rec = (await getLicense(env, licenseKey)) || emptyLicense(licenseKey, env);
      rec.email = (data.customer && data.customer.email) || rec.email;
      rec.paddleTransactionId = data.id;
      rec.productId = (data.items && data.items[0] && data.items[0].price && data.items[0].price.product_id) || null;
      rec.status = "active";
      rec.createdAt = rec.createdAt || new Date().toISOString();
      rec.expiresAt = data.subscription_id
        ? (data.next_billed_at || null)
        : null; // one-time purchase = no expiry
      await putLicense(env, rec);
      break;
    }
    case "subscription.updated": {
      // Iterate known licenses linked to this subscription id. Simple path:
      // custom_data.license_key is present on items.
      const licenseKey = data.custom_data && data.custom_data.license_key;
      if (!licenseKey) break;
      const rec = await getLicense(env, licenseKey);
      if (!rec) break;
      rec.status    = data.status === "canceled" ? "paused" : "active";
      rec.expiresAt = data.next_billed_at || rec.expiresAt;
      await putLicense(env, rec);
      break;
    }
    case "subscription.canceled": {
      const licenseKey = data.custom_data && data.custom_data.license_key;
      if (!licenseKey) break;
      const rec = await getLicense(env, licenseKey);
      if (!rec) break;
      rec.status = "paused";
      await putLicense(env, rec);
      break;
    }
    case "adjustment.created": {
      if (data.action !== "refund") break;
      const txn = data.transaction_id;
      // Find any license record with this transaction id.
      // (KV has no secondary index, so we accept a small read cost.)
      const list = await env.LICENSES.list();
      for (const k of list.keys) {
        const rec = await env.LICENSES.get(k.name, "json");
        if (rec && rec.paddleTransactionId === txn) {
          rec.status = "refunded";
          await putLicense(env, rec);
        }
      }
      break;
    }
  }
  return json({ ok: true });
}

// ─── /admin/release ─────────────────────────────────────────────────────────
// Bump the distributable version after you upload a new .zxp to R2. Header:
//   Authorization: Bearer <ADMIN_TOKEN>
// Body: { version, notes }
async function handleAdminRelease(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ ok: false, reason: "unauthorized" }, 401);
  }
  const body = await req.json().catch(() => ({}));
  if (!body.version) return json({ ok: false, reason: "bad_request" }, 400);

  // Persist into KV under a reserved key (easier than editing env vars).
  await env.LICENSES.put("__release__", JSON.stringify({
    version:    body.version,
    notes:      body.notes || "",
    releasedAt: new Date().toISOString()
  }));
  return json({ ok: true, version: body.version });
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
    licenseKey, email: null,
    paddleTransactionId: null, productId: null,
    status: "active",
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

// Paddle Billing signature format:
//   Paddle-Signature: ts=<unix>;h1=<hex hmac-sha256 of "<ts>:<body>">
async function verifyPaddleSignature(body, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(";").map(p => p.trim().split("=")));
  if (!parts.ts || !parts.h1) return false;
  const expected = await hmacSha256Hex(secret, `${parts.ts}:${body}`);
  return timingSafeEqual(expected, parts.h1);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
