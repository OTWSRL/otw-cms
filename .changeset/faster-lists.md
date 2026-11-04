---
'@otwdesign/core': patch
'@otwdesign/next': patch
---

Faster lists and archives, and an embedded database that looks after itself. List screens read
each status's count and the date filter's months from totals a trigger keeps (migration
core/0011_entry_counts), instead of reading every entry: at 31,500 posts, about 30 ms became
under 0.5 ms. Category and tag filters find the terms once per query. The embedded database
analyzes and vacuums itself on autovacuum's rules, which PGlite never ran, so its query plans
fit the data. Its lock also records when its process started, so a container that restarts
takes it over instead of failing with "open in another process" until the lock is deleted.
