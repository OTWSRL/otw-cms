# @otwdesign/cli

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
