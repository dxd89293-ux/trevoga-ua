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

1. The KV namespace `TREVOGA_PUSH_SUBSCRIPTIONS` has already been created. Its ID is configured in `wrangler.toml`; do not create a second namespace or replace the ID.
2. In this folder run `npm install`.
3. Run `npm run generateKeys` once in a trusted local environment. Save the public key, private key, and subject privately. Never commit the private key or send it in chat.
4. Set the Worker secrets in Cloudflare (the values must be entered privately):
   - `npx wrangler secret put VAPID_PUBLIC_KEY`
   - `npx wrangler secret put VAPID_PRIVATE_KEY`
   - `npx wrangler secret put VAPID_SUBJECT`
5. Deploy from this folder with `npm run deploy`. Cloudflare will provide a `workers.dev` URL.
6. Set `window.TREVOGA_PUSH_API` in the repository's root `push-config.js` to that Worker URL. Render auto-deploys the static site from `main`.
7. Open the site, press **Включить push при закрытом сайте**, and allow notifications. Install the PWA on iOS before subscribing; Android Chrome can subscribe from the browser.

## Security notes

- The VAPID private key belongs only in Cloudflare Worker secrets. Never put it in `push-config.js`, GitHub, or the browser.
- The Worker only accepts subscription endpoints on HTTPS and known browser push-service hostnames.
- Subscription endpoints are bearer secrets. Do not log them or publish the KV contents.
- This starter backend uses an allowlisted site Origin. If the Render domain changes, update `ALLOWED_ORIGIN` in `wrangler.toml` and redeploy.
- The public feeds are community aggregators and may share upstream data. Push is supplementary, not an official emergency alert service.

## Important

The Worker code is prepared in the repository but is not live until it is deployed to a Cloudflare account, KV is bound, and VAPID secrets are configured. Until then the site's closed-tab push button remains hidden.
