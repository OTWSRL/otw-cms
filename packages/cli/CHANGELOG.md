# @otwdesign/cli

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
