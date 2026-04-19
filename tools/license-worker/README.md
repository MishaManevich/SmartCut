# SmartCut — License Worker

Tiny Cloudflare Worker that:

- Ingests **Paddle** webhooks and stores license keys in Workers KV
- Serves `POST /verify` so the Premiere panel can activate / revalidate
- Serves `POST /download-url` that hands back a short-lived signed URL for
  the latest `.zxp` (stored in R2) — license-gated
- Serves a public `GET /latest-version` for the panel's update check

## One-time setup

```bash
cd tools/license-worker
npm install

# Authenticate Wrangler with your Cloudflare account
npx wrangler login

# Create the KV namespace & R2 bucket
npx wrangler kv:namespace create LICENSES     # paste id into wrangler.toml
npx wrangler r2 bucket create smartcutpro-releases

# Set secrets
npx wrangler secret put PADDLE_WEBHOOK_SECRET   # from Paddle → Notifications
npx wrangler secret put PADDLE_API_KEY          # from Paddle → Developer Tools → API keys
npx wrangler secret put DOWNLOAD_SIGNING_KEY    # any random 32+ char string
npx wrangler secret put ADMIN_TOKEN             # any random 32+ char string (for POST /admin/release)

# Deploy
npx wrangler deploy
```

Your worker URL (e.g. `https://smartcutpro-license.<you>.workers.dev`) goes
into the panel at `client/lib/License.js → BACKEND_BASE`. Point a custom
domain at it (e.g. `license.smartcutpro.app`) and use that instead.

## Paddle setup

1. In Paddle (Billing), create a **product** + **price** for SmartCut.
2. At checkout-creation time (your landing page JS), pass a freshly
   generated **license key** as `custom_data.license_key` on the item.
   That same key is what the customer pastes in the panel.

   ```js
   // rough shape (your landing page)
   Paddle.Checkout.open({
     items: [{
       priceId: "pri_abc123",
       custom_data: { license_key: newUuidV4() }
     }],
     customer: { email: emailFromForm }
   });
   ```

   Deliver the key to the customer via Paddle's post-purchase email
   template (add the `{{custom_data.license_key}}` token).

3. In **Paddle → Notifications**, create a webhook pointing to
   `https://<your-worker>/webhook/paddle`. Copy the signing secret into
   the `PADDLE_WEBHOOK_SECRET` Worker secret.

## Releasing a new version

SmartCut ships as two separate `.zxp` installers — one per OS — because
each one bundles a platform-specific `whisper-cli` binary for offline
transcription. The Worker picks the right file based on the `platform`
the panel reports at download time.

Filename contract (in order of the Worker's preference):

```
SmartCut-<version>-mac.zxp    ← served to macOS users
SmartCut-<version>-win.zxp    ← served to Windows users
SmartCut-<version>.zxp        ← fallback (unknown platform / legacy)
```

```bash
# 1. Build the .zxp for each platform
#    (on Mac: produces SmartCut-1.0.1-mac.zxp;
#     on Windows: produces SmartCut-1.0.1-win.zxp)
npm run build:zxp

# 2. Upload each platform build to R2
npx wrangler r2 object put smartcutpro-releases/SmartCut-1.0.1-mac.zxp \
  --file ../../dist/SmartCut-1.0.1-mac.zxp
npx wrangler r2 object put smartcutpro-releases/SmartCut-1.0.1-win.zxp \
  --file ../../dist/SmartCut-1.0.1-win.zxp

# 3. Bump the public version pointer (single call — covers both platforms)
curl -X POST https://<your-worker>/admin/release \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"version":"1.0.1","notes":"Bug fixes and UI polish"}'
```

It's fine to release the Mac build first and add Windows later — the
Worker returns `{ ok: false, reason: "no_build" }` for the missing
platform with a friendly message, and paid users keep running the
current version until the matching build lands.

Existing paid users will see the update banner on next launch and can
download the new `.zxp` from inside the panel. Unpaid users never get a
working download link.
