# Push backend for Тревога UA

This folder contains the separate Cloudflare Worker required for real Web Push while the site is closed. The existing Render service is static hosting and cannot run this backend.

## What it does

- Stores browser push subscriptions in Cloudflare KV.
- Exposes `GET /config`, `POST /subscribe`, and `DELETE /subscribe`.
- Checks the two public alert feeds every minute with a Cloudflare Cron Trigger.
- Sends a push only when both feeds are available and fresh, and a region's state changes.
- Establishes a baseline on its first successful check; it does not send a burst of old alerts on first start.
- Does not send predicted routes or inferred threat directions.

## One-time setup

1. Create a Cloudflare account and a KV namespace named for example `TREVOGA_PUSH_SUBSCRIPTIONS`.
2. Replace `REPLACE_WITH_CLOUDFLARE_KV_NAMESPACE_ID` in `wrangler.toml` with that namespace ID.
3. In this folder run `npm install`.
4. Run `npm run generateKeys` once. Save the three output values privately. Never commit the private key.
5. Set the Worker secrets:
   - `npx wrangler secret put VAPID_PUBLIC_KEY`
   - `npx wrangler secret put VAPID_PRIVATE_KEY`
   - `npx wrangler secret put VAPID_SUBJECT`
6. Deploy with `npm run deploy`. Cloudflare will provide a `workers.dev` URL.
7. Open the repository's root `push-config.js` and set `window.TREVOGA_PUSH_API` to that URL, then commit the change. Render auto-deploys the static site from `main`.
8. Open the site, press **Включить push при закрытом сайте**, and allow notifications. Install the PWA on iOS before subscribing; Android Chrome can subscribe from the browser.

## Security notes

- The VAPID private key belongs only in Cloudflare Worker secrets. Never put it in `push-config.js`, GitHub, or the browser.
- The Worker only accepts subscription endpoints on HTTPS and known browser push-service hostnames.
- Subscription endpoints are bearer secrets. Do not log them or publish the KV contents.
- This starter backend uses an allowlisted site Origin. If the Render domain changes, update `ALLOWED_ORIGIN` in `wrangler.toml` and redeploy.
- The public feeds are community aggregators and may share upstream data. Push is supplementary, not an official emergency alert service.

## Important

The Worker code is prepared in the repository but is not live until it is deployed to a Cloudflare account, KV is bound, and VAPID secrets are configured. Until then the site's closed-tab push button remains hidden.
