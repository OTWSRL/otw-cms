---
'create-otw-cms': patch
---

Plugins named with `--plugins` get a range on their own newest version, looked up with `npm view`
(so a site's `.npmrc` applies), not on the scaffolder's version. A third-party plugin, or one of
the CMS's own released apart from it, installs again. A plugin npm can't find stops the scaffolder
before it writes anything.
