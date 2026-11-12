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

**Scheduled publishing**, WordPress's `future`: an entry published with a date a minute or more
ahead gets the new status `scheduled`, and the site publishes it on its date (the
`core.publish_entry` job). The Publish box has the date and a Schedule button; lists have a
Scheduled view. `EntryStatus` has a new member, so code that handles every status needs a case
for it. Migrations `core/0012_jobs` and `core/0013_scheduled_entries` add the queue's table and
widen the entries' status checks and slug index.
