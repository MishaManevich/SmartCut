# SmartCut — License Worker

Small Cloudflare Worker that handles everything post-checkout. Dual-provider
by design — **Stripe is the primary payment path; Paddle is kept fully wired
as a fallback**. A landing-page env var flip switches between them in ~2 min.

**License lifecycle**
- Ingests **Stripe** webhooks (primary) and **Paddle** webhooks (fallback) and stores license keys in Workers KV
- Emails each new license key to the buyer via Resend (HTML, plan-aware)
- Emails a "sorry to see you go" note on subscription cancellation with their last-access date
- Serves `POST /verify` so the Premiere panel can activate / revalidate
- Serves `POST /deactivate` so the panel can free a machine slot
- Serves `POST /portal-url` → one-click Paddle Customer Portal link (cancel, change card, switch plan)

**Revenue recovery (two-touch funnel)**
- Tracks pending carts from `transaction.created` / `transaction.updated` webhooks
- Hourly cron sweeps carts 72h–168h old and sends a 33%-off "final chance" email with a single-use Paddle discount code (Paddle's own 60-min recovery email handles the first touch — configure it in the dashboard at ~15-20%)

**Releases**
- Serves `POST /download-url` → short-lived signed URL for the latest `.zxp` (R2, license-gated)
- Serves `GET /latest-version` for the panel's update check
- Serves `GET /lifetime-stats` for the landing-page "X of 1000 slots left" counter

**Admin**
- `POST /admin/release` → bump the active version
- `POST /admin/grant` → mint a comp license
- `POST /admin/recovery-sweep` → trigger the abandoned-cart sweep manually

**Provider setup docs** (one-time walkthroughs for each dashboard):
- **[STRIPE-SETUP.md](./STRIPE-SETUP.md)** — primary path. Payment Links, webhook, test → live migration.
- **[PADDLE-SETUP.md](./PADDLE-SETUP.md)** — fallback. Products, prices, checkout settings, webhook destination, customer portal.
- **[PROVIDER-ROLLBACK.md](./PROVIDER-ROLLBACK.md)** — **read this when something breaks.** Steps to flip from Stripe → Paddle (or back) in ~2 minutes + how to keep both paths warm.

## One-time setup

```bash
cd tools/license-worker
npm install

# Authenticate Wrangler with your Cloudflare account
npx wrangler login

# Create the KV namespace & R2 bucket
npx wrangler kv:namespace create LICENSES           # paste id into wrangler.toml
npx wrangler r2 bucket create smartcut-releases

# Set secrets (see PADDLE-SETUP.md for where to grab each)
npx wrangler secret put PADDLE_API_KEY              # pdl_sdbx_apikey_... (sandbox) or pdl_apikey_... (prod)
npx wrangler secret put PADDLE_WEBHOOK_SECRET       # endpoint secret from Notifications → destination
npx wrangler secret put DOWNLOAD_SIGNING_KEY        # any random 32+ char string
npx wrangler secret put ADMIN_TOKEN                 # any random 32+ char string
npx wrangler secret put RESEND_API_KEY              # optional — enables license emails

# Deploy
npx wrangler deploy
```

Your Worker URL (e.g. `https://smartcut-license.<you>.workers.dev`) goes into the panel at `client/lib/License.js → BACKEND_BASE`. Point a custom domain at it (e.g. `license.trysmartcut.com`) and use that instead.

## Pricing (wired into `wrangler.toml`)

| Plan     | Price            | Paddle price var           |
|----------|------------------|----------------------------|
| Monthly  | $29.99/mo        | `PADDLE_PRICE_MONTHLY`     |
| Annual   | $199/year        | `PADDLE_PRICE_ANNUAL`      |
| Lifetime | $49 (launch)     | `PADDLE_PRICE_LIFETIME`    |

The worker maps the `pri_...` id on each incoming `transaction.completed` event to one of these plan slugs. If you add a new tier, update both `wrangler.toml` and `planFromPriceId()` in `src/index.js`.

## Sandbox ↔ Production

`PADDLE_ENV` in `wrangler.toml` controls which Paddle API base URL the worker talks to:

- `"sandbox"` → `https://sandbox-api.paddle.com`
- `"production"` → `https://api.paddle.com`

Flip it (and rotate `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, and all three `PADDLE_PRICE_*` values) when you're ready to take real money. The three Products need to be mirrored from Sandbox → Production inside the Paddle Dashboard; IDs do **not** carry over.

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

Need to hand out a license key outside Paddle (press, reviewers, support overrides)?

```bash
curl -X POST https://<your-worker>/admin/grant \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"email":"reviewer@example.com","plan":"lifetime"}'
# → { ok: true, licenseKey: "SC-…", email: "…", plan: "lifetime" }
```
