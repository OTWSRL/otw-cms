# @otwdesign/testing

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

## 1.8.0

### Patch Changes

- Updated dependencies [aa64b5e]
  - @otwdesign/sdk@1.8.0
  - @otwdesign/core@1.8.0

## 1.7.1

### Patch Changes

- @otwdesign/core@1.7.1
  - @otwdesign/sdk@1.7.1

## 1.7.0

### Patch Changes

- Updated dependencies [8f31621]
  - @otwdesign/sdk@1.7.0
  - @otwdesign/core@1.7.0

## 1.6.0

### Patch Changes

- Updated dependencies [5887261]
  - @otwdesign/sdk@1.6.0
  - @otwdesign/core@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [98503d1]
  - @otwdesign/sdk@1.5.0
  - @otwdesign/core@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [7aef5e6]
- Updated dependencies [03a08aa]
  - @otwdesign/sdk@1.4.0
  - @otwdesign/core@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [b9ca928]
- Updated dependencies [6f96610]
  - @otwdesign/sdk@1.3.0
  - @otwdesign/core@1.3.0

## 1.2.0

### Patch Changes

- @otwdesign/core@1.2.0
  - @otwdesign/sdk@1.2.0

## 1.1.0

### Patch Changes

- 9ee2102: A lighter server. A new embedded database is created by a short-lived process of its own, so the
  site's server no longer keeps the 700 MB that takes until it restarts, and the embedded database
  keeps a 16 MB cache instead of PostgreSQL's 128 MB, which `CMS_SHARED_BUFFERS` can raise. sharp
  loads with the first image, and OpenTelemetry's SDK once a plugin turns tracing on. Measured on
  the CMS's test site: a first start used about 340 MB, down from about 950 MB, and a running site
  about 310 MB, down from about 440 MB.
- Updated dependencies [b4b391e]
- Updated dependencies [9ee2102]
  - @otwdesign/core@1.1.0
  - @otwdesign/sdk@1.1.0

## 1.0.2

### Patch Changes

- @otwdesign/core@1.0.2
  - @otwdesign/sdk@1.0.2

## 1.0.1

### Patch Changes

- @otwdesign/core@1.0.1
  - @otwdesign/sdk@1.0.1
