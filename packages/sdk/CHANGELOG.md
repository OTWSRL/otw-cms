# @otwdesign/sdk

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

## 1.2.0

No changes in this release.

## 1.1.0

No changes in this release.

## 1.0.2

No changes in this release.

## 1.0.1

No changes in this release.
