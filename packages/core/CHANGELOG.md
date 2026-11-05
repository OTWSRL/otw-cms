# @otwdesign/core

## 1.1.0

### Patch Changes

- b4b391e: Faster lists and archives, and an embedded database that looks after itself. List screens read
  each status's count and the date filter's months from totals a trigger keeps (migration
  core/0011_entry_counts), instead of reading every entry: at 31,500 posts, about 30 ms became
  under 0.5 ms. Category and tag filters find the terms once per query. The embedded database
  analyzes and vacuums itself on autovacuum's rules, which PGlite never ran, so its query plans
  fit the data. Its lock also records when its process started, so a container that restarts
  takes it over instead of failing with "open in another process" until the lock is deleted. A
  1.0 site's lock, which has no start time, is taken over once the process with its id started
  after the lock was written, as when the site upgrades into a new container.
- 9ee2102: A lighter server. A new embedded database is created by a short-lived process of its own, so the
  site's server no longer keeps the 700 MB that takes until it restarts, and the embedded database
  keeps a 16 MB cache instead of PostgreSQL's 128 MB, which `CMS_SHARED_BUFFERS` can raise. sharp
  loads with the first image, and OpenTelemetry's SDK once a plugin turns tracing on. Measured on
  the CMS's test site: a first start used about 340 MB, down from about 950 MB, and a running site
  about 310 MB, down from about 440 MB.
- @otwdesign/sdk@1.1.0

## 1.0.2

### Patch Changes

- @otwdesign/sdk@1.0.2

## 1.0.1

### Patch Changes

- @otwdesign/sdk@1.0.1
