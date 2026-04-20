# Payment-provider rollback — Stripe ↔ Paddle

This is the "oh no, Stripe just broke" / "oh no, Paddle just broke" runbook.
Keep it short, keep it mechanical. It assumes both providers are already
wired (they are — see `STRIPE-SETUP.md` and `PADDLE-SETUP.md`).

> **Core idea:** the landing page and the license Worker both support
> Stripe and Paddle simultaneously. The build-time env var
> `VITE_CHECKOUT_PROVIDER` on the landing page decides which checkout
> button users see. The Worker listens to **both** webhook endpoints
> regardless, so existing customers on either provider continue to have
> their licenses minted, renewed, canceled, and refunded correctly.
>
> A rollback is therefore *one env-var flip + one redeploy*. No code
> changes. No data migration. No downtime for existing customers.

---

## When to roll back

Roll back **from Stripe to Paddle** if any of these happen:

- Stripe's Radar flags our account and pauses payouts.
- A surge in disputes triggers an account review.
- Stripe emails us with a "we're closing this account" notice.
- Real users report the checkout is failing and you can reproduce it.

Roll back **from Paddle to Stripe** if:

- Paddle pauses the account or flags the product in verification.
- Paddle outage affecting checkout availability.
- Tax / MoR rules change in a way that matters more with Paddle.

---

## The rollback procedure (≈2 minutes)

### A. Stripe → Paddle

1. **Landing page env var flip**
   Cloudflare Dashboard → the **landing page** project (not the Worker)
   → **Settings → Environment variables → Production** →
   set `VITE_CHECKOUT_PROVIDER` to:
   ```
   paddle
   ```
   Save.

2. **Redeploy the landing page**
   Deployments tab → **Retry / Redeploy** on the latest deployment.
   Vite rebuilds with the new value. ~90 seconds.

3. **Confirm**
   Visit `trysmartcut.com` in incognito, open DevTools → Network, click
   a Buy button. You should see the Paddle overlay pop up (not a
   redirect to `buy.stripe.com`). If it redirects to `checkout.stripe.com`
   instead, your Cloudflare env didn't update yet — try a hard refresh.

That's it. From this point on, every new buyer goes through Paddle.

### B. Paddle → Stripe (reverse)

Same three steps, but set `VITE_CHECKOUT_PROVIDER=stripe` in step 1.

---

## What happens to existing customers after a rollback

Nothing bad. Both webhook handlers stay alive in the Worker regardless
of which provider the landing page points at.

| Scenario | Behaviour |
|---|---|
| Stripe subscriber renews after a Stripe→Paddle rollback | `invoice.paid` fires → Worker bumps `expiresAt` → renewal works. |
| Stripe subscriber cancels after rollback | `customer.subscription.deleted` fires → cancellation email sent → `/verify` locks them out at `expiresAt`. |
| Stripe buyer asks for a refund after rollback | You refund in Stripe Dashboard → `charge.refunded` fires → license flips to `status: refunded` → panel blocks. |
| Paddle buyer after a Paddle→Stripe rollback | Same story — `transaction.completed`, `subscription.canceled`, `adjustment.created` all continue to work. |
| Same customer buys again on the new provider | Worker mints a fresh key (different provider = different customer object, no cross-provider linkage). Send them a one-off "here's your new key" note if they're confused. |

The only thing a rollback stops is *new* purchases going through the
paused provider. Lifecycle events for already-purchased licenses keep
flowing.

---

## Things to check if a rollback isn't working

1. **Env var didn't save / didn't rebuild**
   In Cloudflare, the "Production" tab vs "Preview" tab vs "Plaintext" vs "Encrypted" can all trip you up. Set it on **Production**, **Plaintext**, and trigger a fresh build (env vars are build-time, not runtime).

2. **Cached JS in the user's browser**
   The landing page caches its JS bundles. A hard refresh (Cmd+Shift+R) proves the new build is reaching the client. Most users will naturally pick up the new bundle within an hour as their cache expires — no manual cache-bust usually needed.

3. **Provider-specific env vars missing**
   If you flip to `paddle` but `VITE_PADDLE_CLIENT_TOKEN` isn't set, the Buy button will just scroll to #pricing (graceful degradation built into `lib/paddle.ts`). Double-check all 5 `VITE_PADDLE_*` vars are populated — same if flipping to `stripe` and `VITE_STRIPE_LINK_*` are blank.

4. **The Worker endpoint for the target provider was never configured**
   Less likely (we did both during setup), but if after a flip no new license emails arrive, verify:
   - Paddle: `PADDLE_API_KEY` + `PADDLE_WEBHOOK_SECRET` secrets set, webhook destination exists in Paddle → Notifications pointing at `https://smartcut-license.patient-dust-4377.workers.dev/webhook/paddle`.
   - Stripe: `STRIPE_API_KEY` + `STRIPE_WEBHOOK_SECRET` secrets set, webhook endpoint exists in Stripe → Developers → Webhooks pointing at `https://smartcut-license.patient-dust-4377.workers.dev/webhook/stripe`.

---

## Periodic maintenance — keep both paths healthy

Because we rarely actually use Paddle while Stripe is primary (and vice
versa), both can quietly rot. Once a month:

- [ ] Confirm the idle provider's webhook destination is still configured and enabled in its dashboard.
- [ ] Confirm the idle provider's API key hasn't been rotated without the Worker secret being updated.
- [ ] If the idle provider is Paddle, confirm sandbox/production matches `PADDLE_ENV` in `wrangler.toml`.
- [ ] Spot-check `wrangler secret list` — both `PADDLE_*` and `STRIPE_*` secrets should still be listed.
- [ ] Spot-check `trysmartcut.com` in the idle provider's mode by temporarily flipping `VITE_CHECKOUT_PROVIDER` + doing a test checkout, then flipping back. Takes 5 minutes end-to-end.

That's the cost of keeping a warm backup — a few minutes a month buys
you a two-minute rollback instead of a two-day migration the next time
something goes sideways.

---

## Reference — which files know about the dual-provider split

Code:
- `smartcut-landing/client/src/config.ts` — defines `CHECKOUT_PROVIDER`, both `STRIPE_*` and `PADDLE_*` env vars.
- `smartcut-landing/client/src/lib/checkout.ts` — the dispatcher that picks Stripe or Paddle at click time.
- `smartcut-landing/client/src/lib/stripe.ts` — Stripe Payment Link redirect.
- `smartcut-landing/client/src/lib/paddle.ts` — Paddle.js overlay. Untouched.
- `smartcut-pro/tools/license-worker/src/index.js` — both `/webhook/stripe` and `/webhook/paddle` routes + handlers, in that file.
- `smartcut-pro/tools/license-worker/wrangler.toml` — `STRIPE_PRICE_*` and `PADDLE_PRICE_*` blocks.

Docs:
- `STRIPE-SETUP.md` — create Payment Links + webhook + go-live checklist.
- `PADDLE-SETUP.md` — Paddle equivalent.
- `PROVIDER-ROLLBACK.md` — this file.
- `smartcut-landing/DEPLOY.md` — full env-var reference for both providers.
