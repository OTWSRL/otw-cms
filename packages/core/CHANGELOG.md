# @otwdesign/core

## 1.11.0

### Minor Changes

- db6d69f: Fewer bytes on every admin screen, and on every click between them.

  - **The admin's frame is a layout.** The bar, the menu with its counts, and the footer are drawn
    once per page load, by `app/(cms)/admin/layout.tsx`, which `cms generate` now writes (a site's
    `dev` and `build` scripts run it). A click on a menu link fetches the screen alone: 42% fewer
    bytes for a click from Settings to Users, and about 0.2 ms less server time. Each page still
    checks who may open it. The `admin.footer` slot stays with each screen, so a fill can show that
    request, as the performance bar does. A screen someone may not open now shows inside the frame.
  - **A plugin's drawn icon and a sign-in button's mark come from an address.** Core serves them
    (`/api/p/core/icons/{plugin}`, to people who can open the admin, and
    `/api/p/core/sign-in/{provider}/image`), and browsers keep them for a year. Pages carry the
    address instead of the base64 image, which went out twice, or three times for a menu icon.
    Plugins change nothing.
  - **`AdminIcon` writes its image once**: the admin's stylesheet holds the mask, with and without
    the `-webkit-` prefix.
  - **`Tabs`** in `@otwdesign/admin-ui`: WordPress's tabs across a screen, for a plugin that keeps
    one link in the menu. A tab opens the next screen as a menu link does, without loading the page
    again; so does any link with `data-admin-link` (`ADMIN_LINK`).

### Patch Changes

- 201744e: A signed value passes only with its signature as it was written. The admin's one-time messages
  and the sign-in provider cookie compared decoded bytes, so one signature also passed with its
  last character swapped for its neighbour, which decodes alike. Nothing could be forged with it:
  it was the same signature, written another way.
- Updated dependencies [db6d69f]
  - @otwdesign/sdk@1.11.0

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

### Patch Changes

- Updated dependencies [35e9bba]
  - @otwdesign/sdk@1.10.0

## 1.9.2

### Patch Changes

- The admin's links no longer ask the server about their pages before they're clicked. Next.js
  fetches every link in view ahead of a click, and the admin's screens are made per request, so
  each of those was a wasted request: 14 to 24 on every screen, and again after every save. A new
  site's header links do the same; in an existing site, add `prefetch={false}` to the `<Link>`s in
  `src/app/(site)/layout.tsx`.
- Updated dependencies
  - @otwdesign/sdk@1.9.2

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

- Updated dependencies
  - @otwdesign/sdk@1.9.1

## 1.9.0

### Minor Changes

- 8db9b47: Uploads straight to storage, for hosts that cap a request's size. A `MediaStorage` can take
  large files from the browser (`directUploads`): the site signs an address, the browser sends the
  bytes there, and the site reads the file back and stores it as any upload. `cms.media.disk`
  reads the disk's files, for a storage plugin to copy them. Sites on the disk are unchanged.

### Patch Changes

- Updated dependencies [8db9b47]
  - @otwdesign/sdk@1.9.0

## 1.8.0

### Minor Changes

- aa64b5e: Settings pages gain what a plugin needed its own screen for:

  - **`roles` settings**: a checkbox for each of the site's roles, plugins' included.
  - **`pairs` settings**: rows of a name and a value, added and removed in the admin, such as a
    request's headers.
  - **`multiline`** on a text setting: a box of several lines.
  - **`showWhen`** on a setting or a section: it shows only while another setting has a value, such
    as a provider's own fields once that provider is chosen. It follows the form as it's changed,
    before saving, with a style rule and no script; a hidden field keeps its value.
  - **`link`** on a section: a button under its fields, to a screen that goes with them.

  `FormField` takes `row`, for attributes on its table row.

### Patch Changes

- Updated dependencies [aa64b5e]
  - @otwdesign/sdk@1.8.0

## 1.7.1

### Patch Changes

- @otwdesign/sdk@1.7.1

## 1.7.0

### Minor Changes

- 8f31621: A plugin can add a step between a correct password and being signed in, as two-factor plugins
  do, with `cms.auth.signInStep()`. Core holds the sign-in for ten minutes, shows the screen that
  asks for the code (in the admin's sign-in frame, and as the account pages' new `verify` view),
  counts wrong codes (five in fifteen minutes end it), and can remember a browser; the plugin says
  which ways a person has, sends codes and checks them. A password set from an emailed link goes
  through the step too. Without such a plugin, signing in is as before, with no added query.

  Also new: `cms.auth.checkPassword()`, and the `admin.profile` and `admin.user` slots, for a
  plugin's sections on the Profile and Edit User screens.

  A site with its own account template shows the new `verify` view only once that template
  handles it: `props.signIn`, `actions.verify` and `actions.sendCode`.

### Patch Changes

- Updated dependencies [8f31621]
  - @otwdesign/sdk@1.7.0

## 1.6.0

### Patch Changes

- Updated dependencies [5887261]
  - @otwdesign/sdk@1.6.0

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
