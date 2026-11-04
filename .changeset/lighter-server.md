---
'@otwdesign/core': patch
'@otwdesign/next': minor
'@otwdesign/testing': patch
---

A lighter server. A new embedded database is created by a short-lived process of its own, so the
site's server no longer keeps the 700 MB that takes until it restarts, and the embedded database
keeps a 16 MB cache instead of PostgreSQL's 128 MB, which `CMS_SHARED_BUFFERS` can raise. sharp
loads with the first image, and OpenTelemetry's SDK once a plugin turns tracing on. Measured on
the CMS's test site: a first start used about 340 MB, down from about 950 MB, and a running site
about 310 MB, down from about 440 MB.
