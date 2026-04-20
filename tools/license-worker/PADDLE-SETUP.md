# SmartCut — Paddle Setup

One-time walkthrough for wiring Paddle to the license Worker. Do these in order; each step depends on the previous.

> **Paddle is the fallback provider — Stripe is primary.** This doc is still the source of truth for everything Paddle-related; the landing page just doesn't point at it by default. If Stripe ever goes down / gets paused, **[PROVIDER-ROLLBACK.md](./PROVIDER-ROLLBACK.md)** flips the switch back in ~2 minutes. Keep the Paddle setup warm (re-verify monthly — see the maintenance checklist in that file).

Paddle is a **Merchant of Record**, which means they handle global tax compliance, chargebacks, and fraud on our behalf. The tradeoff vs Stripe is a ~5% + $0.50 per-transaction fee and monthly (optionally bi-weekly after your first payout) payouts instead of rolling daily.

## 0. Accounts you'll need

- [Paddle](https://paddle.com) — payments + MoR. Sign up for both **Sandbox** (dev) and **Production** (real money).
- [Resend](https://resend.com) — transactional email for license keys (free tier covers 3k emails/mo)
- [Cloudflare](https://dash.cloudflare.com) — Worker + KV + R2 (already set up per main README)

> ⚠️ Sandbox and Production are fully separate accounts with their own API keys, webhook secrets, product IDs, and price IDs. Finish the sandbox loop end-to-end, then mirror every config value into production when Paddle approves your KYC.

## 1. Create the three products

Paddle Dashboard → **Catalog** → **Products** → **New product**. Do this three times:

### Monthly
- **Name:** SmartCut — Monthly
- **Tax category:** Standard digital goods
- After saving, go to the **Prices** tab → **Add price**
  - Amount: **$29.99 USD**
  - Billing: **Recurring, every 1 month**
  - Save, then copy the price ID (starts with `pri_…`)

### Annual
- **Name:** SmartCut — Annual
- Tax category: Standard digital goods
- Prices → Add price: **$199 USD**, recurring every **1 year**
- Copy the price ID

### Lifetime (launch special)
- **Name:** SmartCut — Lifetime (launch)
- Tax category: Standard digital goods
- Prices → Add price: **$49 USD**, **one-time** billing
- Copy the price ID

> 💡 A Product ID (`pro_…`) and a Price ID (`pri_…`) are different things. The worker needs **price IDs**. You'll find them under the product's **Prices** tab — click the price row, then "Copy ID".

Paste all three into `wrangler.toml` under `[vars]`:

```toml
PADDLE_PRICE_MONTHLY  = "pri_…"
PADDLE_PRICE_ANNUAL   = "pri_…"
PADDLE_PRICE_LIFETIME = "pri_…"
```

## 2. Approve the checkout domain

The Paddle.js overlay only runs on explicitly approved domains.

Dashboard → **Checkout** → **Settings** → **Website approval** → add:

- `trysmartcut.com`

If you're testing from a local dev build first, also add `localhost`. Sandbox and production each keep their own approved-domains list.

## 3. Set the Default Payment Link

Still on Checkout → Settings. Set **Default Payment Link** to:

```
https://trysmartcut.com/
```

Even though we use the overlay (which never redirects), Paddle will still 400 on checkout if this field is blank. Ask me how I know.

## 4. Generate a client-side token

Dashboard → **Developer tools** → **Authentication** → **Client-side tokens** → **Generate token**.

- Name it `smartcut-web`
- It's prefixed `test_…` in Sandbox, `live_…` in Production

This is what the landing page's Paddle.js uses. Paste it into the Cloudflare landing page build env vars:

- `VITE_PADDLE_ENV` → `sandbox` (or `production`)
- `VITE_PADDLE_CLIENT_TOKEN` → the `test_…` / `live_…` token
- `VITE_PADDLE_PRICE_MONTHLY` / `_ANNUAL` / `_LIFETIME` → the three `pri_…` IDs

> ⚠️ Never put an **API key** (`pdl_sdbx_apikey_…`) in the client-side token field. API keys are server-only. If you accidentally paste one into a frontend env var, revoke it immediately from the Authentication screen.

## 5. Generate an API key (worker → Paddle)

Dashboard → Developer tools → **Authentication** → **API keys** → **Generate new key**.

Scope it to at minimum:

- `customer:read`
- `subscription:read`
- `transaction:read`
- `customer-portal-session:write` (so `/portal-url` can mint portal sessions)
- `discount:write` (so the Worker can mint recovery discount codes)

Copy the key and push it to the worker as a secret:

```bash
npx wrangler secret put PADDLE_API_KEY
# paste pdl_sdbx_apikey_… (sandbox) or pdl_apikey_… (production)
```

## 6. Create the webhook destination

Dashboard → **Notifications** → **Destinations** → **New destination**.

- **Description:** `smartcut-license-worker`
- **URL:** `https://license.trysmartcut.com/webhook/paddle`  (or your Worker URL before the custom domain is attached)
- **Events to subscribe to** (tick these and nothing else):
  - `transaction.created`        ← abandoned-cart tracking
  - `transaction.updated`        ← abandoned-cart tracking
  - `transaction.canceled`       ← abandoned-cart tracking
  - `transaction.completed`
  - `subscription.activated`
  - `subscription.updated`
  - `subscription.canceled`      ← fires the "sorry to see you go" email
  - `subscription.paused`
  - `subscription.resumed`
  - `adjustment.created`         ← refunds / chargebacks

Save, then click the destination → copy the **endpoint secret** (looks like `pdl_ntfset_…`). Push it to the worker:

```bash
npx wrangler secret put PADDLE_WEBHOOK_SECRET
```

## 6.5 Enable Paddle's built-in abandoned-cart recovery

We run a **two-touch** recovery funnel:

1. **T+60 min** — Paddle sends its built-in recovery email (~15-20% off). Configure this in the Paddle Dashboard so it runs automatically.
2. **T+72 h** — Our Worker sends a deeper **33% off** "final chance" email via Resend for carts that still haven't converted. This runs automatically once you deploy the Worker (the hourly cron trigger in `wrangler.toml` does the sweep).

Configure step 1:

Paddle Dashboard → **Checkout** → **Recovery** → **Enable**

- **Discount amount:** 15% (Paddle's own data shows 10-20% converts best — deeper discounts anchor buyers on a low price)
- **Email template:** use the default, or customize with your branding
- **From name:** `SmartCut`

If you skip this step, only the T+72h email fires. Two touches is proven to roughly double recovery vs. one.

> 💡 The deeper 33% discount in our second email is justified because it only targets carts that already ignored Paddle's first nudge — these are genuinely cold leads where a bigger incentive makes sense. The code is single-use and expires in 7 days so it can't spread.

Tune the timing or discount without redeploying the Worker: edit `[vars]` in `wrangler.toml`:

```toml
RECOVERY_MIN_AGE_HOURS    = "72"    # when we send (after T+60min Paddle email)
RECOVERY_MAX_AGE_HOURS    = "168"   # stop after 7 days
RECOVERY_DISCOUNT_PERCENT = "33"
```

## 7. Deploy the worker

```bash
cd tools/license-worker
npx wrangler deploy
```

If you haven't yet: point `license.trysmartcut.com` at the worker in the Cloudflare dashboard → Workers → smartcut-license → Custom Domains → `license.trysmartcut.com`.

## 8. Sandbox end-to-end test

### 8a. License-key email (purchase flow)

1. Open `https://trysmartcut.com/` (deployed with sandbox env vars)
2. Click **Get Lifetime Deal** — the Paddle overlay opens
3. Use a [Paddle test card](https://developer.paddle.com/concepts/payment-methods/credit-debit-card#test-cards): `4000 0566 5566 5556` / any future expiry / `100`
4. Use a real email you can check
5. Submit — you should land on `/thanks`
6. Within ~10s you should receive a license key email from Resend (plan name, price, renewal date, key)
7. Open Premiere → SmartCut → paste the key → activate
8. In Cloudflare → Workers → smartcut-license → Logs, confirm the `transaction.completed` webhook was received and returned 200

### 8b. Cancellation email

1. After the sandbox purchase above (use a **monthly** product for this test), open the Paddle Sandbox dashboard → **Customers** → find your test customer → **Subscriptions** → **Cancel**
2. The `subscription.canceled` webhook should arrive at the Worker (check Logs)
3. Within ~10s you should receive the "Sorry to see you go" email with your last-access date (end of billing period) and a resubscribe CTA

### 8c. Abandoned-cart recovery

1. Open `https://trysmartcut.com/`, click any pricing CTA
2. Enter an email in the Paddle overlay, enter the test card, but **close the window before submitting**
3. In Worker Logs you should see `transaction.updated` events creating a `pending:<txn_id>` record in KV
4. Trigger the sweep manually without waiting for cron (adjust min-age to 0 first, or use the admin endpoint):

   ```bash
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://license.trysmartcut.com/admin/recovery-sweep
   ```

   With production config (72h min-age) it'll return `{ sent: 0, skipped: N }` because the cart isn't old enough. Temporarily set `RECOVERY_MIN_AGE_HOURS = "0"` in `wrangler.toml`, redeploy, and re-run to actually send.

5. Check the email arrives with a `COMEBACK-XXXXXX` code and the correct deep-link
6. In Paddle Sandbox → Discounts, verify the discount was created and scoped to the right price ID
7. Paste the code into a fresh Paddle overlay checkout — it should apply the 33% off
8. Restore `RECOVERY_MIN_AGE_HOURS = "72"` before going to production

If the email doesn't arrive, check:

- Worker logs for `license email failed:` entries
- Resend dashboard for deliverability
- That `MAIL_FROM` in `wrangler.toml` uses a domain you've verified in Resend

If the webhook returns 401 (Bad signature), the `PADDLE_WEBHOOK_SECRET` doesn't match the one in Paddle → Notifications → destination. Rotate it.

## 9. Going live

When Paddle approves your production KYC:

1. In the **Production** Paddle dashboard, recreate the three products + prices (IDs will be different)
2. Approve `trysmartcut.com` in Production → Checkout → Settings
3. Set the Default Payment Link to `https://trysmartcut.com/` in Production
4. Generate a **production** client-side token (`live_…`) and a **production** API key (`pdl_apikey_…`)
5. Create the webhook destination in Production and copy its endpoint secret
6. Update Cloudflare:
   - Landing page build env: `VITE_PADDLE_ENV=production`, new `VITE_PADDLE_CLIENT_TOKEN`, new three `VITE_PADDLE_PRICE_*`
   - Worker secrets: rotate `PADDLE_API_KEY` + `PADDLE_WEBHOOK_SECRET`
   - Worker `wrangler.toml`: `PADDLE_ENV = "production"` + swap the three `PADDLE_PRICE_*` values
7. Redeploy both (landing page + worker)
8. Run one real $49 lifetime purchase yourself to smoke-test, then refund it in Paddle — you'll see `adjustment.created` come through and the license flip to `status: "refunded"`
