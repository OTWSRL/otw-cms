---
'@otwdesign/sdk': minor
'@otwdesign/core': minor
'@otwdesign/next': minor
---

`cms.cache`, as WordPress's object cache and transients: `get`, `set`, `delete`, `remember` and
`flush`, each plugin in keys of its own. Values live in the server's memory, in the database with
`durable` (they then survive a restart and are the same on every server), or in a store one plugin
provides with `cms.cache.store()`, such as Redis. Migration `core/0015_cache` adds the durable
values' table.
