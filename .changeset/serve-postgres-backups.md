---
'@otwdesign/cli': patch
---

`cms serve` backs up Postgres before an update's migrations into the site's own `.data/backups`, as
`cms migrate` does, rather than into the release's folder, which was deleted with the release.
Without `pg_dump`, its error now names `cms serve --no-backup` rather than `cms migrate`'s option.
