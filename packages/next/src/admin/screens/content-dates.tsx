import type { Entry } from '@otw/sdk'

/**
 * A date in the site's locale. In UTC, and saying so, until the site has a time zone setting;
 * the list's month filter counts in UTC too.
 */
export function formatDate(date: Date, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale ?? 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(date)
}

/** The list's Date column, as WordPress's: when it was published, or last changed if it wasn't. */
export function entryDate(entry: Entry, locale: string | undefined) {
  const status = entry.trashedFrom ?? entry.status
  const published = (status === 'published' || status === 'private') && entry.publishedAt
  const date = published ? entry.publishedAt! : entry.updatedAt
  return (
    <>
      {published ? 'Published' : 'Last Modified'}
      <br />
      <time dateTime={date.toISOString()}>{formatDate(date, locale)}</time>
    </>
  )
}
