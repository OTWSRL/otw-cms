# @otwdesign/plugin-commerce-stripe

Card payments through Stripe Checkout for OTW CMS's Commerce plugin, confirmed by Stripe's
signed webhooks. It needs `@otwdesign/plugin-commerce`.

```sh
npm install @otwdesign/plugin-commerce-stripe
```

Add `"@otwdesign/plugin-commerce-stripe"` to `plugins` in the site's `cms.config.json`, restart or rebuild the site, and
activate it on the Plugins screen.

Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in the site's environment.

Part of [OTW CMS](https://github.com/OTWSRL/otw-cms), a WordPress-style CMS for Next.js and
PostgreSQL. Licensed under the Apache License 2.0.
