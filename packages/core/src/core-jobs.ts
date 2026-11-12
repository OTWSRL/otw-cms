import type { Logger } from '@otwdesign/sdk'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import { PUBLISH_JOB, SCHEDULE_AHEAD_MS, type ContentService } from './content'
import { entries, loginFailures, sessions, userTokens } from './core-schema'
import type { DatabaseContext } from './database'
import type { JobService, JobStore } from './jobs'

const CORE = 'core'
const DAY = 24 * 60 * 60
/** WordPress's `EMPTY_TRASH_DAYS`: how long an entry stays in the Trash. */
export const EMPTY_TRASH_DAYS = 30
/** How long a finished job stays in Tools › Scheduled Actions, as Action Scheduler keeps its. */
export const JOB_LOG_DAYS = 30
/** Entries one run deletes for good; a run that reaches it queues another. */
const TRASH_BATCH = 100

export interface CoreJobDependencies {
  store: JobStore
  db: DatabaseContext
  logger: Logger
  content: Pick<ContentService, 'delete' | 'get' | 'update'>
  jobs: Pick<JobService, 'enqueue' | 'prune'>
}

/** The site's own housekeeping, which WordPress does with WP-Cron. */
export function registerCoreJobs(deps: CoreJobDependencies): void {
  const { store, db, logger, content, jobs } = deps

  // What only a visit used to clean, or nothing did: sign-ins that ran out, emailed links never
  // used, failed sign-ins long past the window that counts them, and the job log itself.
  store.define(CORE, 'core.cleanup', {
    label: 'Clear out expired sessions, links and old logs',
    everySeconds: DAY,
    handler: async () => {
      await db.root.delete(sessions).where(lt(sessions.expiresAt, sql`now()`))
      await db.root.delete(userTokens).where(lt(userTokens.expiresAt, sql`now()`))
      await db.root
        .delete(loginFailures)
        .where(lt(loginFailures.failedAt, sql`now() - interval '1 day'`))
      await jobs.prune(JOB_LOG_DAYS)
    },
  })

  // WordPress's check_and_publish_future_post(): publishes a scheduled entry whose date has
  // come, through the content service, so content.status and content.saved run as for any
  // publish. An entry that is no longer scheduled, or is gone, is left alone.
  store.define(CORE, PUBLISH_JOB, {
    label: 'Publish a scheduled entry',
    // The entry stays scheduled if this fails for good, so a passing problem gets more tries.
    attempts: 3,
    handler: async (args) => {
      const { id } = args as { id: string }
      const entry = await content.get(id)
      if (!entry || entry.status !== 'scheduled' || !entry.publishedAt) return
      // Whether its date has come is decided as a save decides it, to the same minute, so a
      // clock a moment behind the database's doesn't send the job round again.
      if (entry.publishedAt.getTime() - Date.now() >= SCHEDULE_AHEAD_MS) {
        // Run before its time, from Tools › Scheduled Actions say: it waits for its date again.
        await jobs.enqueue(PUBLISH_JOB, { id }, { at: entry.publishedAt, unique: id })
        return
      }
      await content.update(id, { status: 'published' })
    },
  })

  // WordPress's wp_scheduled_delete: what has been in the Trash for 30 days goes for good.
  store.define(CORE, 'core.empty_trash', {
    label: 'Empty the Trash of what has been there 30 days',
    everySeconds: DAY,
    handler: async () => {
      const old = await db.root
        .select({ id: entries.id })
        .from(entries)
        .where(
          and(
            eq(entries.status, 'trash'),
            lt(entries.trashedAt, sql`now() - make_interval(days => ${EMPTY_TRASH_DAYS}::int)`),
          ),
        )
        .orderBy(asc(entries.trashedAt))
        .limit(TRASH_BATCH)
      for (const { id } of old) {
        try {
          await content.delete(id)
        } catch (error) {
          // One entry that can't go mustn't keep the rest in the Trash.
          logger.error('An entry could not be deleted from the Trash', { entry: id, error })
        }
      }
      if (old.length === TRASH_BATCH) await jobs.enqueue('core.empty_trash', {}, { unique: 'more' })
    },
  })
}
