---
'@otwdesign/next': minor
---

The PostgreSQL pool's size and idle timeout are settings: `CMS_DB_POOL_MAX` (10) and
`CMS_DB_POOL_IDLE_MS` (10000), read once when the pool opens. Serverless instances each keep a
pool, and many at once could reach the database's limit, as Supabase's session pooler's "max
clients reached".

On Supabase's pooler, the site now connects in transaction mode (port 6543) even when
`DATABASE_URL` names session mode's 5432. The CMS keeps nothing on a connection between
transactions, so it works there unchanged; `CMS_DB_POOL_MODE=session` keeps session mode for a
plugin that needs it. Other addresses are used as they are. The hosting docs show Supabase's
`uselibpqcompat=true&sslmode=require` and Neon's pooled host.
