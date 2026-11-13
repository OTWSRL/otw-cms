# create-otw-cms

## 1.7.0

No changes in this release.

## 1.6.0

No changes in this release.

## 1.5.0

### Minor Changes

- 98503d1: **Plugins › Add Plugin**, as WordPress's Add Plugins, with npm as the directory: plugins tagged
  `otw-cms-plugin` are listed and searched, and any plugin is installed by its package name. **Delete**
  on an inactive plugin removes its data and its package. Both rebuild the site through `cms serve`
  or the GitHub update workflow, and take the new `core.install_plugins` capability.

  `cms plugin add <package>` and `cms plugin remove <package>` do the same from the command line.
  A new site's update workflow takes `add_plugin` and `remove_plugin`; replace an older site's
  `.github/workflows/cms-update.yml` to add plugins from the admin there.

## 1.4.0

No changes in this release.

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

### Minor Changes

- e4e5d69: A new site's Dockerfile builds an image of Next.js's standalone server, with `CMS_STANDALONE=1`:
  the site adds about 65 MB to Node.js's image, down from about 550 MB. A `migrate` target runs
  `cms migrate` for sites on several containers. Sites made before keep their Dockerfile, which
  still works.

## 1.0.2

### Patch Changes

- d6c8349: Plugins named with `--plugins` get a range on their own newest version, looked up with `npm view`
  (so a site's `.npmrc` applies), not on the scaffolder's version. A third-party plugin, or one of
  the CMS's own released apart from it, installs again. A plugin npm can't find stops the scaffolder
  before it writes anything.

## 1.0.1

### Patch Changes

- 01f3172: The scaffolder's help and README say that `--plugins` takes a short name for one of the CMS's own
  plugins, such as `performance` for `@otwdesign/plugin-performance`, as well as npm package names.
