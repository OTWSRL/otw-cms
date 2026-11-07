# @otwdesign/next

## 1.2.0

### Minor Changes

- 0738169: The PostgreSQL pool's size and idle timeout are settings: `CMS_DB_POOL_MAX` (10) and
  `CMS_DB_POOL_IDLE_MS` (10000), read once when the pool opens. Serverless instances each keep a
  pool, and many at once could reach the database's limit, as Supabase's session pooler's "max
  clients reached".

  On Supabase's pooler, the site now connects in transaction mode (port 6543) even when
  `DATABASE_URL` names session mode's 5432. The CMS keeps nothing on a connection between
  transactions, so it works there unchanged; `CMS_DB_POOL_MODE=session` keeps session mode for a
  plugin that needs it. Other addresses are used as they are. The hosting docs show Supabase's
  `uselibpqcompat=true&sslmode=require` and Neon's pooled host.

### Patch Changes

- @otwdesign/admin-ui@1.2.0
  - @otwdesign/core@1.2.0
  - @otwdesign/sdk@1.2.0

## 1.1.0

### Minor Changes

- 9ee2102: A lighter server. A new embedded database is created by a short-lived process of its own, so the
  site's server no longer keeps the 700 MB that takes until it restarts, and the embedded database
  keeps a 16 MB cache instead of PostgreSQL's 128 MB, which `CMS_SHARED_BUFFERS` can raise. sharp
  loads with the first image, and OpenTelemetry's SDK once a plugin turns tracing on. Measured on
  the CMS's test site: a first start used about 340 MB, down from about 950 MB, and a running site
  about 310 MB, down from about 440 MB.
- e4e5d69: A new site's Dockerfile builds an image of Next.js's standalone server, with `CMS_STANDALONE=1`:
  the site adds about 65 MB to Node.js's image, down from about 550 MB. A `migrate` target runs
  `cms migrate` for sites on several containers. Sites made before keep their Dockerfile, which
  still works.

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
- Updated dependencies [b4b391e]
- Updated dependencies [9ee2102]
  - @otwdesign/core@1.1.0
  - @otwdesign/admin-ui@1.1.0
  - @otwdesign/sdk@1.1.0

## 1.0.2

### Patch Changes

- @otwdesign/admin-ui@1.0.2
  - @otwdesign/core@1.0.2
  - @otwdesign/sdk@1.0.2

## 1.0.1

### Patch Changes

- @otwdesign/admin-ui@1.0.1
  - @otwdesign/core@1.0.1
  - @otwdesign/sdk@1.0.1
