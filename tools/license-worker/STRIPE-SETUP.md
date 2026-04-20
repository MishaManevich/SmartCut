# Stripe setup — SmartCut

Complete, click-by-click. Follow this top-to-bottom and you will have a
working Stripe checkout + license-creation loop with the Worker you
already deployed. The Paddle setup stays untouched as a fallback.

> **If Stripe ever breaks / the account gets paused / Radar locks payouts**,
> see **[PROVIDER-ROLLBACK.md](./PROVIDER-ROLLBACK.md)** — one env-var flip
> + one redeploy takes you back to Paddle in ~2 minutes. Keep that doc
> handy; re-read it ~monthly to keep the fallback warm.

> **Test first, live second.** Do the whole thing in **test mode** before
> flipping any switches. All of step 1–7 can be done with test keys, test
> products, test links, test webhook, test purchase. Step 8 is the
> migration to live mode at the end.

---

## 1. Create the 3 Products + Prices

Stripe Dashboard → **Product catalog** → **+ Add product**. Create three.
(If you already made some during earlier testing, skip — just confirm the
pricing matches.)

| Product | Price | Billing |
|---|---|---|
| SmartCut — Monthly | $29.99 | Recurring, monthly |
| SmartCut — Annual  | $199.00 | Recurring, yearly |
| SmartCut — Lifetime | $49.00 | One-off |

After saving each product, click into it → **Pricing** section → next to
each price row there's a `price_…` id. **Copy all three.** You'll paste
them into wrangler in step 4.

---

## 2. Create the 3 Payment Links

Stripe Dashboard → **Payment Links** → **+ New**.

Do this **three times**, one per plan:

1. **Product** → pick the matching product from step 1.
2. **After payment** → select **"Don't show confirmation page"** → **"Redirect customers to your website"** → paste:
   ```
   https://trysmartcut.com/thanks?session_id={CHECKOUT_SESSION_ID}
   ```
   (Leave the `{CHECKOUT_SESSION_ID}` literal — Stripe substitutes it.)
3. **Advanced settings**:
   - **Collect customer addresses**: Billing only (for tax compliance — you need this even if you don't currently charge tax).
   - **Automatic tax**: ON if you've set up Stripe Tax; OFF otherwise. Can flip this later.
   - **Allow promotion codes**: ON.
   - **Save payment details for future use**: only applies to recurring; ON is fine.
4. Click **Create link**. Copy the `https://buy.stripe.com/…` URL.

Paste each URL into a scratch note — you'll paste them into Cloudflare in step 5.

---

## 3. Create the webhook endpoint

Stripe Dashboard → **Developers** → **Webhooks** → **+ Add endpoint**.

- **Endpoint URL**:
  ```
  https://smartcut-license.patient-dust-4377.workers.dev/webhook/stripe
  ```
- **Events to send** — click "Select events" and tick exactly these six:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `charge.refunded`
  - `charge.dispute.created`
- Click **Add endpoint**.
- On the endpoint's detail page, under **Signing secret**, click **Reveal** and copy the `whsec_…` value. You'll set it as a Worker secret in step 4.

---

## 4. Set Worker secrets + env vars

From this directory (`smartcut-pro/tools/license-worker`):

```bash
# Stripe secret key (sk_test_… in test mode; sk_live_… later)
npx wrangler secret put STRIPE_API_KEY

# Webhook signing secret from step 3
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Then paste the three `price_…` ids from step 1 into `wrangler.toml`
(look for the `STRIPE_PRICE_*` block) and redeploy:

```bash
npx wrangler deploy
```

The Worker is now set up to verify Stripe webhooks and mint licenses.

---

## 5. Configure the landing-page build

Cloudflare Dashboard → the landing page project → **Settings → Environment
variables → Production**.

Add these (fill values from earlier steps — paste raw, no quotes):

| Var | Value |
|---|---|
| `VITE_CHECKOUT_PROVIDER` | `stripe` |
| `VITE_STRIPE_MODE` | `test` |
| `VITE_STRIPE_LINK_MONTHLY` | `https://buy.stripe.com/test_...` (from step 2) |
| `VITE_STRIPE_LINK_ANNUAL` | `https://buy.stripe.com/test_...` |
| `VITE_STRIPE_LINK_LIFETIME` | `https://buy.stripe.com/test_...` |

Trigger a **Redeploy** from the Deployments tab (these are build-time
vars, so an env change needs a fresh build).

---

## 6. Test end-to-end (still in test mode)

1. In one terminal tab, start tailing Worker logs:
   ```bash
   cd smartcut-pro/tools/license-worker
   npx wrangler tail
   ```
2. Open `https://trysmartcut.com` in a fresh incognito window.
3. Click any **Buy / Subscribe** CTA. You should be redirected to `checkout.stripe.com`.
4. Pay with the test card `4242 4242 4242 4242`, any future expiry, any CVC, a real email you can check.
5. You're redirected back to `/thanks?session_id=cs_test_…`.
6. Watch Tab 1 — within a few seconds you should see a log line for `checkout.session.completed`.
7. Check the email inbox — the license-key email arrives from `license@trysmartcut.com`.
8. Paste the key into the SmartCut extension in Premiere Pro → **Activate** → green badge.

If any step fails, `wrangler tail` will tell you why. Common issues:

- `Bad signature` (401) from the webhook → `STRIPE_WEBHOOK_SECRET` doesn't match the endpoint (copy-paste glitch, wrong endpoint).
- Webhook 200 but no license email → `RESEND_API_KEY` not set, or the Resend domain isn't verified yet. `wrangler tail` will surface the Resend error.
- Redirect goes to `/thanks` but no `session_id` param → Payment Link's redirect URL missing `?session_id={CHECKOUT_SESSION_ID}` — edit the link.

---

## 7. Test cancellation + refund

While still in test mode:

**Cancellation:**
1. In Stripe Dashboard (test mode): **Customers** → the customer you just created → **Subscriptions** → **Cancel subscription**.
2. Watch `wrangler tail` — `customer.subscription.deleted` fires.
3. A "subscription canceled" email lands in your inbox.
4. `/verify` calls from the panel continue to return `active` until the period end (expiresAt), then flip to `canceled`. Good — that's the grace-period design working.

**Refund:**
1. In Stripe Dashboard (test mode): **Payments** → your test payment → **Refund**.
2. `charge.refunded` fires → license flips to `status: refunded`.
3. Panel `/verify` now returns `refunded` → extension blocks.

---

## 8. Flip to live mode

Only after **every** step above passed cleanly with test data.

1. In Stripe Dashboard, switch the top-left toggle from **Test mode** to **Live mode**.
2. Repeat steps 1–3:
   - Recreate the three products + prices (live ids are different).
   - Recreate the three Payment Links (live URLs start `https://buy.stripe.com/…` — same shape, different scope).
   - Recreate the webhook endpoint (same URL, new `whsec_…`).
3. Rotate Worker secrets to live values:
   ```bash
   npx wrangler secret put STRIPE_API_KEY          # sk_live_...
   npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_... (from live endpoint)
   ```
4. Update `wrangler.toml` `STRIPE_PRICE_*` ids → **live** price ids. Redeploy:
   ```bash
   npx wrangler deploy
   ```
5. In Cloudflare → landing page env vars:
   - `VITE_STRIPE_MODE=live`
   - `VITE_STRIPE_LINK_*` → live URLs
   - (keep `VITE_CHECKOUT_PROVIDER=stripe`)
   - Redeploy the landing page.
6. Do a **real** $49 lifetime purchase with your own card.
7. Refund yourself in Stripe Dashboard.
8. Ship.

---

## If Stripe ever breaks — rolling back to Paddle

One env var flip, one redeploy, and you're back on Paddle without any
code change:

1. Cloudflare → landing page env vars → set `VITE_CHECKOUT_PROVIDER=paddle`.
2. Redeploy the landing page.

The Worker already handles both providers, so licenses continue to be
minted (now via the Paddle webhook path). Existing Stripe customers keep
their licenses — refunds and cancellations for them will still come
through the `/webhook/stripe` endpoint and mutate the same records.

---

## Reference — everything that got wired

- **Worker route**: `POST /webhook/stripe`
- **Worker secrets**: `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`
- **Worker env vars** (`wrangler.toml`): `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`, `STRIPE_PRICE_LIFETIME`
- **KV indexes** (written by the Stripe webhook): `stripe:cus:`, `stripe:sub:`, `stripe:ses:`, `stripe:evt:`
- **Landing env vars**: `VITE_CHECKOUT_PROVIDER`, `VITE_STRIPE_MODE`, `VITE_STRIPE_LINK_{MONTHLY,ANNUAL,LIFETIME}`
- **Files that changed**: `tools/license-worker/src/index.js`, `tools/license-worker/wrangler.toml`, `smartcut-landing/client/src/config.ts`, `smartcut-landing/client/src/lib/stripe.ts` (new), `smartcut-landing/client/src/lib/checkout.ts` (new), and three 1-line import swaps in `main.tsx`, `PricingSection.tsx`, `AnnouncementBar.tsx`.
