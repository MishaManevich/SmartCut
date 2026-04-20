# SmartCut — License Worker

Tiny Cloudflare Worker that:

- Ingests **Stripe** webhooks and stores license keys in Workers KV
- Emails each new license key to the buyer via Resend
- Serves `POST /verify` so the Premiere panel can activate / revalidate
- Serves `POST /download-url` → short-lived signed URL for the latest `.zxp` (R2, license-gated)
- Serves `POST /portal-url` → one-click Stripe Billing Portal link (cancel, change card, switch plan)
- Serves `GET /latest-version` for the panel's update check

See **[STRIPE-SETUP.md](./STRIPE-SETUP.md)** for the one-time Stripe Dashboard walkthrough (products, prices, Payment Links, webhook endpoint, billing portal).

## One-time setup

```bash
cd tools/license-worker
npm install

# Authenticate Wrangler with your Cloudflare account
npx wrangler login

# Create the KV namespace & R2 bucket
npx wrangler kv:namespace create LICENSES           # paste id into wrangler.toml
npx wrangler r2 bucket create smartcut-releases

# Set secrets (see STRIPE-SETUP.md for where to grab each)
npx wrangler secret put STRIPE_SECRET_KEY           # sk_live_... or sk_test_...
npx wrangler secret put STRIPE_WEBHOOK_SECRET       # endpoint signing secret
npx wrangler secret put DOWNLOAD_SIGNING_KEY        # any random 32+ char string
npx wrangler secret put ADMIN_TOKEN                 # any random 32+ char string
npx wrangler secret put RESEND_API_KEY              # optional — enables license emails

# Deploy
npx wrangler deploy
```

Your Worker URL (e.g. `https://smartcut-license.<you>.workers.dev`) goes into the panel at `client/lib/License.js → BACKEND_BASE`. Point a custom domain at it (e.g. `license.trysmartcut.com`) and use that instead.

## Pricing (wired into `wrangler.toml`)

| Plan     | Price            | Stripe price var           |
|----------|------------------|----------------------------|
| Monthly  | $29.99/mo        | `STRIPE_PRICE_MONTHLY`     |
| Annual   | $199/year        | `STRIPE_PRICE_ANNUAL`      |
| Lifetime | $49 (launch)     | `STRIPE_PRICE_LIFETIME`    |

## Releasing a new version

SmartCut ships as two separate `.zxp` installers (one per OS) because each one bundles a platform-specific `whisper-cli`. The Worker picks the right file based on the `platform` the panel reports at download time.

Filename contract (Worker's preference order):

```
SmartCut-<version>-mac.zxp    ← served to macOS users
SmartCut-<version>-win.zxp    ← served to Windows users
SmartCut-<version>.zxp        ← legacy fallback
```

```bash
# 1. Build on each platform
npm run build:zxp

# 2. Upload each to R2
npx wrangler r2 object put smartcut-releases/SmartCut-1.0.1-mac.zxp \
  --file ../../dist/SmartCut-1.0.1-mac.zxp
npx wrangler r2 object put smartcut-releases/SmartCut-1.0.1-win.zxp \
  --file ../../dist/SmartCut-1.0.1-win.zxp

# 3. Bump the public version pointer
curl -X POST https://<your-worker>/admin/release \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"version":"1.0.1","notes":"Bug fixes and UI polish"}'
```

It's fine to release the Mac build first and add Windows later — the Worker returns `{ ok:false, reason:"no_build" }` for the missing platform with a friendly message. Paying users keep running the current version until the matching build lands.

## Comp copies / manual grants

Need to hand out a license key outside Stripe (press, reviewers, support overrides)?

```bash
curl -X POST https://<your-worker>/admin/grant \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"email":"reviewer@example.com","plan":"lifetime"}'
# → { ok: true, licenseKey: "SC-…", email: "…", plan: "lifetime" }
```
