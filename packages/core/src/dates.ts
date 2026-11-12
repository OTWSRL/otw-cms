/**
 * A date and time in the site's locale, as the admin shows them. In UTC, and saying so, until the
 * site has a time zone setting; the lists' month filters count in UTC too.
 */
export function formatDateTime(date: Date, locale: string | undefined): string {
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

const DATE_FIELD = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * A date as a `datetime-local` input holds it, to the minute and in UTC like every date the admin
 * shows: `2026-11-14T09:30`.
 */
export function toDateField(date: Date): string {
  return date.toISOString().slice(0, 16)
}

/** The date a `datetime-local` input sent, read as UTC; `null` when it isn't one. */
export function fromDateField(text: string): Date | null {
  const match = DATE_FIELD.exec(text)
  if (!match) return null
  const [, year, month, day, hour, minute, second = '00'] = match
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`)
  // "2026-02-31" parses in some engines by rolling over: only a date that reads back is one.
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
    ? null
    : date
}
