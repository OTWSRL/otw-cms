# @otwdesign/sdk

The plugin API of OTW CMS: `definePlugin()`, actions and filters, content types, settings,
capabilities, slots and the types every plugin builds on.

```sh
npm install --save-dev @otwdesign/sdk
```

A plugin lists it as a peer dependency (`"@otwdesign/sdk": "^1.0.0"`), so it uses the site's copy,
and says which versions of the CMS it supports with `requires: { core: '^1.0.0' }`.

Part of [OTW CMS](https://github.com/OTWSRL/otw-cms), a WordPress-style CMS for Next.js and
PostgreSQL. Licensed under the Apache License 2.0.
