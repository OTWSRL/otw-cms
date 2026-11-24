# @otwdesign/cli

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
