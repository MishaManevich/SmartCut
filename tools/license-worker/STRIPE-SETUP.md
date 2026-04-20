# SmartCut — Stripe Setup

One-time walkthrough for wiring Stripe to the license Worker. Do these in order; each step depends on the previous.

## 0. Accounts you'll need

- [Stripe](https://stripe.com) — payments
- [Resend](https://resend.com) — transactional email for license keys (free tier covers 3k emails/mo)
- [Cloudflare](https://dash.cloudflare.com) — Worker + KV + R2 (already set up per main README)

## 1. Create the three products

In the Stripe Dashboard → **Product catalog** → **Add product**, create three:

### Monthly
- **Name:** SmartCut — Monthly
- **Price:** $29.99 USD, recurring, monthly
- After saving, copy the **price ID** (starts with `price_…`)

### Annual
- **Name:** SmartCut — Annual
- **Price:** $199 USD, recurring, yearly
- Copy the price ID

### Lifetime (launch special)
- **Name:** SmartCut — Lifetime (launch)
- **Price:** $49 USD, one-time
- Copy the price ID

Paste all three into `wrangler.toml` under `[vars]`:

```toml
STRIPE_PRICE_MONTHLY  = "price_…"
STRIPE_PRICE_ANNUAL   = "price_…"
STRIPE_PRICE_LIFETIME = "price_…"
```

## 2. Create Payment Links

Dashboard → **Payment Links** → **New**. Do this three times, one per price.

For **each** link:

- Select the price from Step 1
- **After payment:** "Don't show a confirmation page" is fine, or point at `https://trysmartcut.com/thanks`
- **Customer information:** turn on "Collect email"
- **Advanced:** turn on "Limit the number of payments" only for the lifetime link if you want to cap the launch price (e.g. first 500 purchases); otherwise leave off

Save each, copy the URL (e.g. `https://buy.stripe.com/abc…`), and drop them into `client/lib/License.js → CHECKOUT_LINKS`:

```js
var CHECKOUT_LINKS = {
  monthly:  "https://buy.stripe.com/…",
  annual:   "https://buy.stripe.com/…",
  lifetime: "https://buy.stripe.com/…"
};
```

## 3. Configure the Billing Portal

Dashboard → **Settings** → **Billing** → **Customer portal**.

Turn on the features you want users to control from the "Manage subscription" button:

- ✅ Update payment method
- ✅ Cancel subscriptions
- ✅ Switch between monthly and annual (optional but nice)
- ✅ View invoice history

**Save**. The portal is live once enabled — no separate URL to copy, because the Worker mints per-customer session URLs on demand via `billing_portal/sessions`.

## 4. Set up the webhook endpoint

Dashboard → **Developers** → **Webhooks** → **Add endpoint**.

- **Endpoint URL:** `https://license.trysmartcut.com/webhook/stripe` (or your `workers.dev` URL if you haven't pointed a custom domain yet)
- **Events to send** — select these exactly:
  - `checkout.session.completed`
  - `invoice.paid`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `charge.refunded`
- **Create endpoint**. You'll land on the endpoint detail page.
- Click **Reveal signing secret** → copy the `whsec_…` value.

Back in your terminal:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
# paste the whsec_... value when prompted
```

## 5. Grab your Stripe secret key

Dashboard → **Developers** → **API keys** → copy the **Secret key** (`sk_live_…` for production, `sk_test_…` for testing).

```bash
npx wrangler secret put STRIPE_SECRET_KEY
# paste the sk_... value when prompted
```

## 6. Set up Resend for license-key emails

1. Sign up at [resend.com](https://resend.com). Free tier is 100 emails/day, 3k/month — plenty for launch.
2. Add your domain (e.g. `trysmartcut.com`) under **Domains** → **Add Domain** and follow the DNS instructions (three DNS records: SPF, DKIM, return-path).
3. Wait for verification (usually under 10 minutes).
4. **API Keys** → **Create API key** → scope: sending. Copy the `re_…` value.

```bash
npx wrangler secret put RESEND_API_KEY
# paste the re_... value when prompted
```

Update `wrangler.toml`:

```toml
MAIL_FROM = "SmartCut <license@trysmartcut.com>"   # any address on your verified domain
```

## 7. Deploy and test

```bash
cd tools/license-worker
npx wrangler deploy
```

### Test a purchase end-to-end

1. Dashboard → **Developers** → toggle **View test data** on (top-right).
2. Recreate the Payment Links in test mode (they don't carry over from live), OR use Stripe's test card `4242 4242 4242 4242` with your live link in a test account.
3. Buy the Monthly plan with test-mode email of your choice.
4. Check `https://<your-worker>/webhook/stripe` logs:
   ```bash
   npx wrangler tail
   ```
   You should see `checkout.session.completed` arrive.
5. Check your inbox — the Resend-sent license key email should arrive within a few seconds.
6. Paste the key into the SmartCut panel → Analyze → Apply. Should activate.
7. Click **Manage subscription** inside the extension → should open Stripe's portal in your browser.
8. In Stripe, refund the test charge. Next time the panel revalidates (or when you force a revalidate), `/verify` should return `reason: "refunded"`.

### When everything works in test mode

Flip the Dashboard back to **Live mode**, re-create the Payment Links with live prices, re-add the webhook endpoint in live mode (the signing secret is different!), and update the `STRIPE_*` secrets on the Worker:

```bash
npx wrangler secret put STRIPE_SECRET_KEY       # live sk_live_…
npx wrangler secret put STRIPE_WEBHOOK_SECRET   # live whsec_…
```

## 8. Tax

Stripe is **not** a merchant of record. You're responsible for VAT / US sales tax / UK VAT collection and filing in any jurisdictions where you hit thresholds.

Options:

- **Stripe Tax** (Dashboard → Tax → Enable). Calculates tax per sale for $0.50/txn or 0.5% of the sale, whichever is lower. You still have to register and file yourself.
- **CPA / bookkeeping service** — outsource the filings.
- **Switch back to a merchant-of-record** (Paddle, LemonSqueezy, Polar) later if the tax overhead isn't worth it.

At a minimum, set up Stripe Tax for the calculation side before your first EU sale so you're not back-filling records.

## 9. Common pitfalls

- **`Bad signature` on webhooks** — you're using the live `whsec_…` in test mode (or vice versa). Each mode has its own signing secret.
- **No license email arrives** — check `wrangler tail` for `license email failed`. Usually means the Resend domain isn't verified yet or `MAIL_FROM` isn't on the verified domain.
- **Billing Portal button does nothing for lifetime buyers** — that's by design; lifetime purchases have no subscription to manage. The panel falls back to `mailto:support@trysmartcut.com`.
- **Customer can't find their license key email** — spam folder, or the email on their Stripe account differs from the address they gave at checkout. Use `/admin/grant` to manually reissue.

## 10. Smoke-test checklist before launch

- [ ] Monthly purchase → activation works, renewal webhook extends expiry
- [ ] Annual purchase → activation works
- [ ] Lifetime purchase → no expiry, no portal, manage-button falls back to mailto
- [ ] Refund from Stripe → `/verify` returns `refunded` on next revalidation
- [ ] Cancel subscription in Portal → user keeps access until `expiresAt`, then flips to `canceled`
- [ ] Switch plans (Monthly → Annual) in Portal → webhook updates `plan` + `stripePriceId`
- [ ] Try `/admin/grant` for a lifetime comp copy → key activates in panel
- [ ] 3rd activation → works; 4th → `too_many_activations`
- [ ] Disconnect internet → grace period holds; reconnect → revalidates
