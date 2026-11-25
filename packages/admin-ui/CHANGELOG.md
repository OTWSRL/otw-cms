# @otwdesign/admin-ui

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

### Patch Changes

- Updated dependencies [8f31621]
  - @otwdesign/sdk@1.7.0

## 1.6.0

### Patch Changes

- Updated dependencies [5887261]
  - @otwdesign/sdk@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [98503d1]
  - @otwdesign/sdk@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [7aef5e6]
- Updated dependencies [03a08aa]
  - @otwdesign/sdk@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [b9ca928]
  - @otwdesign/sdk@1.3.0

## 1.2.0

### Patch Changes

- @otwdesign/sdk@1.2.0

## 1.1.0

### Patch Changes

- @otwdesign/sdk@1.1.0

## 1.0.2

### Patch Changes

- @otwdesign/sdk@1.0.2

## 1.0.1

### Patch Changes

- @otwdesign/sdk@1.0.1
