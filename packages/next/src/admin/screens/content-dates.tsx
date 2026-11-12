import { formatDateTime, SCHEDULE_AHEAD_MS } from '@otwdesign/core'
import type { Entry } from '@otwdesign/sdk'

/** How late a scheduled entry may be before the list says so: the runner may be about to publish it. */
const MISSED_MS = 60_000

/**
 * A date in the site's locale. In UTC, and saying so, until the site has a time zone setting;
 * the list's month filter counts in UTC too.
 */
export const formatDate = formatDateTime

/** Whether saving with this publish date would schedule the entry: a minute or more ahead. */
export function schedules(date: Date | null | undefined, now: number = Date.now()): boolean {
  return date != null && date.getTime() - now >= SCHEDULE_AHEAD_MS
}

/** The list's Date column, as WordPress's: when it was published, or last changed if it wasn't. */
export function entryDate(entry: Entry, locale: string | undefined) {
  const status = entry.trashedFrom ?? entry.status
  const published = (status === 'published' || status === 'private') && entry.publishedAt
  const scheduled = status === 'scheduled' && entry.publishedAt
  const date = published || scheduled ? entry.publishedAt! : entry.updatedAt
  // Still scheduled past its date: nothing ran the job that publishes it, as when a serverless
  // site has no cron request. WordPress says the same of a post WP-Cron missed.
  const missed =
    entry.status === 'scheduled' && scheduled && date.getTime() < Date.now() - MISSED_MS
  return (
    <>
      {missed ? (
        <strong className="error-message">Missed schedule</strong>
      ) : published ? (
        'Published'
      ) : scheduled ? (
        'Scheduled'
      ) : (
        'Last Modified'
      )}
      <br />
      <time dateTime={date.toISOString()}>{formatDate(date, locale)}</time>
    </>
  )
}
