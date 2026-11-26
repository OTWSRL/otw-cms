# @otwdesign/cli

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

- Updated dependencies [db6d69f]
- Updated dependencies [201744e]
  - @otwdesign/core@1.11.0
  - @otwdesign/next@1.11.0
  - @otwdesign/sdk@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [35e9bba]
  - @otwdesign/sdk@1.10.0
  - @otwdesign/core@1.10.0
  - @otwdesign/next@1.10.0

## 1.9.2

### Patch Changes

- The admin's links no longer ask the server about their pages before they're clicked. Next.js
  fetches every link in view ahead of a click, and the admin's screens are made per request, so
  each of those was a wasted request: 14 to 24 on every screen, and again after every save. A new
  site's header links do the same; in an existing site, add `prefetch={false}` to the `<Link>`s in
  `src/app/(site)/layout.tsx`.
- Updated dependencies
  - @otwdesign/sdk@1.9.2
  - @otwdesign/core@1.9.2
  - @otwdesign/next@1.9.2

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
  - @otwdesign/core@1.9.1
  - @otwdesign/next@1.9.1

## 1.9.0

### Minor Changes

- 8db9b47: Uploads straight to storage, for hosts that cap a request's size. A `MediaStorage` can take
  large files from the browser (`directUploads`): the site signs an address, the browser sends the
  bytes there, and the site reads the file back and stores it as any upload. `cms.media.disk`
  reads the disk's files, for a storage plugin to copy them. Sites on the disk are unchanged.

### Patch Changes

- Updated dependencies [8db9b47]
  - @otwdesign/sdk@1.9.0
  - @otwdesign/core@1.9.0
  - @otwdesign/next@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies [aa64b5e]
  - @otwdesign/sdk@1.8.0
  - @otwdesign/core@1.8.0
  - @otwdesign/next@1.8.0

## 1.7.1

### Patch Changes

- ce4f572: The `proxy.ts` that `cms generate` writes for plugins' proxies quotes every import the same way,
  as Prettier would, so a site that checks its formatting passes with it.
- @otwdesign/core@1.7.1
  - @otwdesign/next@1.7.1
  - @otwdesign/sdk@1.7.1

## 1.7.0

### Patch Changes

- Updated dependencies [8f31621]
  - @otwdesign/sdk@1.7.0
  - @otwdesign/core@1.7.0
  - @otwdesign/next@1.7.0

## 1.6.0

### Minor Changes

- 5887261: A plugin can have a proxy: the default export of its package's `./proxy` entry sees every request
  before the site does, and may answer it, as a page cache does. `cms generate` writes the site's
  `proxy.ts` for the plugins that have one, with `createProxy()` from `@otwdesign/next/proxy`. A
  site with no such plugin has no proxy, as before.

### Patch Changes

- Updated dependencies [5887261]
  - @otwdesign/sdk@1.6.0
  - @otwdesign/next@1.6.0
  - @otwdesign/core@1.6.0

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
  - @otwdesign/core@1.5.0
  - @otwdesign/next@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [7aef5e6]
- Updated dependencies [03a08aa]
  - @otwdesign/sdk@1.4.0
  - @otwdesign/core@1.4.0
  - @otwdesign/next@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [b9ca928]
- Updated dependencies [c7a82e6]
- Updated dependencies [6f96610]
  - @otwdesign/sdk@1.3.0
  - @otwdesign/core@1.3.0
  - @otwdesign/next@1.3.0

## 1.2.0

### Patch Changes

- 0738169: `cms migrate` and `cms serve` back up PostgreSQL from a `DATABASE_URL` with `uselibpqcompat=true`,
  which `pg_dump` refused ("invalid URI query parameter"), and dump Supabase's pooler in session
  mode, as a dump runs in one session.
- Updated dependencies [0738169]
  - @otwdesign/next@1.2.0
  - @otwdesign/core@1.2.0
  - @otwdesign/sdk@1.2.0

## 1.1.0

### Patch Changes

- 85c513b: `cms serve` backs up Postgres before an update's migrations into the site's own `.data/backups`, as
  `cms migrate` does, rather than into the release's folder, which was deleted with the release.
  Without `pg_dump`, its error now names `cms serve --no-backup` rather than `cms migrate`'s option.
- Updated dependencies [b4b391e]
- Updated dependencies [9ee2102]
- Updated dependencies [e4e5d69]
  - @otwdesign/core@1.1.0
  - @otwdesign/next@1.1.0
  - @otwdesign/sdk@1.1.0

## 1.0.2

### Patch Changes

- @otwdesign/core@1.0.2
  - @otwdesign/next@1.0.2
  - @otwdesign/sdk@1.0.2

## 1.0.1

### Patch Changes

- @otwdesign/core@1.0.1
  - @otwdesign/next@1.0.1
  - @otwdesign/sdk@1.0.1
