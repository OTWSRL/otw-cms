---
'@otwdesign/sdk': minor
'@otwdesign/core': minor
'@otwdesign/next': minor
'create-otw-cms': minor
---

Background jobs, as WordPress's Action Scheduler: `cms.jobs.define()` and `enqueue()` run work
now, at a time, once per unique key or on a repeat (`everySeconds`), with retries, timeouts and a
log. A job is queued in the caller's transaction. The site's own process runs them where it keeps
running, with one timer and no polling; on serverless hosts a scheduled request to
`/api/p/core/cron` with `CRON_SECRET` does, and a new site's `vercel.json` has the cron entry.

**Tools › Scheduled Actions** lists the queue, and runs or cancels a job, for the new
`core.manage_jobs` capability. Core queues two daily jobs of its own: `core.cleanup` deletes
sessions and emailed links that ran out, and `core.empty_trash` deletes what has been in the
Trash 30 days.
