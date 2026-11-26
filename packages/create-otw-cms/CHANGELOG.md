# create-otw-cms

## 1.11.0

No changes in this release.

## 1.10.0

### Minor Changes

- 35e9bba: Sign-in providers: a plugin can add a way to sign in at another service, such as "Continue with
  Google", with `cms.auth.signInProvider()`.

  - Core shows the provider's button on the admin's sign-in page and on the account page
    (`providers` in the account template's props), and owns the two addresses a sign-in leaves by
    and comes back to. The state that ties the way back to the browser that left, the account an
    identity signs in to, and the session are core's; the provider only builds the address to send
    the person to, and reads who came back.
  - A person is found by the provider's own id for them (`cms_identities`), never by address once
    they're linked. An address joins the account that already has it only when the provider is the
    authority for the address; someone without an account gets one when the provider names a role
    for new people, on an address the provider verified.
  - A sign-in step (two-step sign-in) still asks for its code afterwards.
  - `cms.auth.linkIdentity()` and `unlinkIdentity()` let a plugin link a signed-in person's id at
    its provider by hand. Deleting a plugin's data removes its identities.
  - With no provider, the sign-in pages are as they were and run no extra query.

## 1.9.2

### Patch Changes

- The admin's links no longer ask the server about their pages before they're clicked. Next.js
  fetches every link in view ahead of a click, and the admin's screens are made per request, so
  each of those was a wasted request: 14 to 24 on every screen, and again after every save. A new
  site's header links do the same; in an existing site, add `prefetch={false}` to the `<Link>`s in
  `src/app/(site)/layout.tsx`.

## 1.9.1

### Patch Changes

- Direct uploads, hardened after a security review, and files served with one storage call:

  - An upload that's given up or refused keeps its record until its signed address has run out,
    so bytes sent afterwards are swept, not left in storage; given-up uploads count against the
    account, and a deleted account's uploads are still swept.
  - Beginning an upload is refused by its length before its body is read; the limit of twenty
    under way holds when requests come together; a name with control characters is refused.
  - An image whose pixels don't decode is refused as not an image (it was a server error), and an
    upload that fails five times is given up.
  - Two requests can no longer both store one upload; the sweep leaves alone one being stored.
  - A waiting upload is never served from inside a folder either, for buckets two sites share.
  - `/uploads/…`: a plain request asks the storage once, not twice.
  - The testing kit sends a body's length, as browsers do.

## 1.9.0

### Minor Changes

- 8db9b47: Uploads straight to storage, for hosts that cap a request's size. A `MediaStorage` can take
  large files from the browser (`directUploads`): the site signs an address, the browser sends the
  bytes there, and the site reads the file back and stores it as any upload. `cms.media.disk`
  reads the disk's files, for a storage plugin to copy them. Sites on the disk are unchanged.

## 1.8.0

No changes in this release.

## 1.7.1

No changes in this release.

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
