---
'@otwdesign/next': minor
'create-otw-cms': minor
---

A new site's Dockerfile builds an image of Next.js's standalone server, with `CMS_STANDALONE=1`:
the site adds about 65 MB to Node.js's image, down from about 550 MB. A `migrate` target runs
`cms migrate` for sites on several containers. Sites made before keep their Dockerfile, which
still works.
