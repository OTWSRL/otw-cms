---
'@otwdesign/cli': patch
---

`cms migrate` and `cms serve` back up PostgreSQL from a `DATABASE_URL` with `uselibpqcompat=true`,
which `pg_dump` refused ("invalid URI query parameter"), and dump Supabase's pooler in session
mode, as a dump runs in one session.
