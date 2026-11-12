# @otwdesign/core

## 1.5.0

### Minor Changes

- 98503d1: **Plugins › Add Plugin**, as WordPress's Add Plugins, with npm as the directory: plugins tagged
  `otw-cms-plugin` are listed and searched, and any plugin is installed by its package name. **Delete**
  on an inactive plugin removes its data and its package. Both rebuild the site through `cms serve`
  or the GitHub update workflow, and take the new `core.install_plugins` capability.

  `cms plugin add <package>` and `cms plugin remove <package>` do the same from the command line.
  A new site's update workflow takes `add_plugin` and `remove_plugin`; replace an older site's
  `.github/workflows/cms-update.yml` to add plugins from the admin there.

### Patch Changes

- Updated dependencies [98503d1]
  - @otwdesign/sdk@1.5.0

## 1.4.0

### Minor Changes

- 7aef5e6: `cms.cache`, as WordPress's object cache and transients: `get`, `set`, `delete`, `remember` and
  `flush`, each plugin in keys of its own. Values live in the server's memory, in the database with
  `durable` (they then survive a restart and are the same on every server), or in a store one plugin
  provides with `cms.cache.store()`, such as Redis. Migration `core/0015_cache` adds the durable
  values' table.
- 03a08aa: **Delete Data** on the Plugins screen, as WordPress's Delete runs a plugin's `uninstall.php`: an
  inactive plugin's data is deleted after a page that says what will go. A plugin's new
  `uninstall({ db })` removes what it made, such as its tables; core then forgets its migrations, and
  deletes its saved settings, jobs and cached values, all in one transaction.

### Patch Changes

- Updated dependencies [7aef5e6]
- Updated dependencies [03a08aa]
  - @otwdesign/sdk@1.4.0

## 1.3.0

### Minor Changes

- b9ca928: Background jobs, as WordPress's Action Scheduler: `cms.jobs.define()` and `enqueue()` run work
  now, at a time, once per unique key or on a repeat (`everySeconds`), with retries, timeouts and a
  log. A job is queued in the caller's transaction. The site's own process runs them where it keeps
  running, with one timer and no polling; on serverless hosts a scheduled request to
  `/api/p/core/cron` with `CRON_SECRET` does, and a new site's `vercel.json` has the cron entry.

  **Tools › Scheduled Actions** lists the queue, and runs or cancels a job, for the new
  `core.manage_jobs` capability. Core queues two daily jobs of its own: `core.cleanup` deletes
  sessions and emailed links that ran out, and `core.empty_trash` deletes what has been in the
  Trash 30 days.

  **Scheduled publishing**, WordPress's `future`: an entry published with a date a minute or more
  ahead gets the new status `scheduled`, and the site publishes it on its date (the
  `core.publish_entry` job). The Publish box has the date and a Schedule button; lists have a
  Scheduled view. `EntryStatus` has a new member, so code that handles every status needs a case
  for it. Migrations `core/0012_jobs` and `core/0013_scheduled_entries` add the queue's table and
  widen the entries' status checks and slug index.

  **Events and webhooks.** `cms.events.define()` and `emit()` tell other systems what happened:
  each webhook subscribed to an event in the new **Settings › Webhooks** screen (the
  `core.manage_webhooks` capability) gets a signed POST, queued with the caller's transaction and
  tried five times. Deliveries follow the Standard Webhooks specification. Core emits
  `content.saved`, `content.deleted`, `media.uploaded` and `media.deleted`. Migration
  `core/0014_webhooks` adds the webhooks' table.

### Patch Changes

- 08225ab: A site boots faster: the router sorted every route each time one was added, and now sorts once.
  With core's own routes, a boot went from 4.0 ms to 2.8 ms.
- 6f96610: A text setting whose value reads as JSON (a number such as `90`, `true`, `null`) keeps it: the
  value was saved, then ignored at the next start with "Must be text", so the setting went back to
  its default.
- Updated dependencies [b9ca928]
  - @otwdesign/sdk@1.3.0

## 1.2.0

### Patch Changes

- @otwdesign/sdk@1.2.0

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
