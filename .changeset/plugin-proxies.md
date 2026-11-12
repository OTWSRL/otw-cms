---
'@otwdesign/sdk': minor
'@otwdesign/next': minor
'@otwdesign/cli': minor
---

A plugin can have a proxy: the default export of its package's `./proxy` entry sees every request
before the site does, and may answer it, as a page cache does. `cms generate` writes the site's
`proxy.ts` for the plugins that have one, with `createProxy()` from `@otwdesign/next/proxy`. A
site with no such plugin has no proxy, as before.
