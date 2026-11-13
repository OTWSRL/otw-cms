---
'@otwdesign/cli': patch
---

The `proxy.ts` that `cms generate` writes for plugins' proxies quotes every import the same way,
as Prettier would, so a site that checks its formatting passes with it.
