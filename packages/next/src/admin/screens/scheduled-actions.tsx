import type { StoredJob } from '@otwdesign/core'
import type { JobStatus } from '@otwdesign/sdk'
import { Button, FormButton, ListTable, TableNav, Views } from '@otwdesign/admin-ui'
import type { ReactNode } from 'react'
import { firstParam } from '../../runtime/search-params'
import { AdminScreen } from '../screen'
import type { ScreenContext } from './context'
import { formatDate } from './content-dates'

const PER_PAGE = 20
const PATH = '/admin/tools/scheduled-actions'

/** Action Scheduler's names for them, in its order. */
const STATUSES: readonly { status: JobStatus; label: string }[] = [
  { status: 'pending', label: 'Pending' },
  { status: 'running', label: 'In-progress' },
  { status: 'done', label: 'Complete' },
  { status: 'failed', label: 'Failed' },
  { status: 'cancelled', label: 'Cancelled' },
]

const UNITS: readonly [seconds: number, one: string, many: string][] = [
  [86_400, 'day', 'days'],
  [3600, 'hour', 'hours'],
  [60, 'minute', 'minutes'],
  [1, 'second', 'seconds'],
]

/** `Every 6 hours`, `Every day`: the largest unit that divides it. */
export function recurrence(everySeconds: number | null): string {
  if (everySeconds === null) return 'Non-repeating'
  const [size, one, many] = UNITS.find(([unit]) => everySeconds % unit === 0)!
  const count = everySeconds / size
  return count === 1 ? `Every ${one}` : `Every ${count} ${many}`
}

/** `In 5 minutes`, `2 hours ago`: how far a time is from now, in its largest unit. */
export function fromNow(date: Date, now: number = Date.now()): string {
  const seconds = Math.round((date.getTime() - now) / 1000)
  const [size, one, many] = UNITS.find(([unit]) => Math.abs(seconds) >= unit) ?? UNITS.at(-1)!
  const count = Math.floor(Math.abs(seconds) / size)
  if (count === 0) return 'Now'
  const amount = `${count} ${count === 1 ? one : many}`
  return seconds > 0 ? `In ${amount}` : `${amount} ago`
}

/** The arguments as `key: value` lines, as Action Scheduler lists an action's. */
function Arguments({ args }: { args: Record<string, unknown> }): ReactNode {
  const entries = Object.entries(args)
  if (entries.length === 0) return '—'
  return (
    <ul className="job-arguments">
      {entries.map(([key, value]) => (
        <li key={key}>
          <code>
            {key}: {typeof value === 'string' ? value : JSON.stringify(value)}
          </code>
        </li>
      ))}
    </ul>
  )
}

function Log({ job }: { job: StoredJob }): ReactNode {
  const tries = job.attempts === 1 ? '1 try' : `${job.attempts} tries`
  if (job.lastError) {
    return (
      <>
        {tries}. <span className="job-error">{job.lastError}</span>
      </>
    )
  }
  if (!job.defined) return 'Its plugin isn’t active, so it waits.'
  return job.attempts === 0 ? '—' : tries
}

/**
 * Tools › Scheduled Actions, as Action Scheduler has it: the job queue by status, with what each
 * job was given, when it runs or ran, and why it failed. A waiting or failed job can be run now,
 * a waiting one cancelled.
 */
export async function ScheduledActionsScreen({ kernel, searchParams: params }: ScreenContext) {
  const status = STATUSES.find((entry) => entry.status === firstParam(params.status))?.status
  const search = (firstParam(params.s) ?? '').trim().slice(0, 100)
  const requested = Number(firstParam(params.paged) ?? 1)
  const page = Number.isSafeInteger(requested) && requested > 0 ? requested : 1
  const [{ jobs, total }, counts] = await Promise.all([
    kernel.jobs.list({ status, search, page, perPage: PER_PAGE }),
    kernel.jobs.counts(),
  ])
  const everything = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const locale = kernel.setting('site.locale')
  const listUrl = (changes: { status?: JobStatus | null; paged?: number }) => {
    const query = new URLSearchParams()
    const shown = changes.status === undefined ? status : changes.status
    if (shown) query.set('status', shown)
    if (search) query.set('s', search)
    if (changes.paged && changes.paged > 1) query.set('paged', String(changes.paged))
    const text = query.toString()
    return text ? `${PATH}?${text}` : PATH
  }
  const action = (name: string, job: StoredJob, label: string) => (
    <FormButton
      key={name}
      action={kernel.actionUrl('core', name)}
      fields={{ id: job.id }}
      variant="link"
      aria-label={`${label} “${job.label}”`}
    >
      {label}
    </FormButton>
  )

  return (
    <AdminScreen title="Scheduled Actions" flash={kernel.readFlash(params.flash)}>
      <Views
        label="Filter actions by status"
        views={[
          { label: 'All', count: everything, href: listUrl({ status: null }), current: !status },
          ...STATUSES.filter((entry) => counts[entry.status] > 0).map((entry) => ({
            label: entry.label,
            count: counts[entry.status],
            href: listUrl({ status: entry.status }),
            current: status === entry.status,
          })),
        ]}
      />
      <form method="get" action={PATH} className="search-form">
        {status && <input type="hidden" name="status" value={status} />}
        <p className="search-box">
          <label className="screen-reader-text" htmlFor="job-search">
            Search actions by name
          </label>
          <input type="search" id="job-search" name="s" defaultValue={search} />
          <Button type="submit">Search actions</Button>
        </p>
      </form>
      <TableNav
        total={total}
        noun={['item', 'items']}
        page={page}
        pages={Math.max(1, Math.ceil(total / PER_PAGE))}
        pageUrl={(paged) => listUrl({ paged })}
      />
      <ListTable
        caption="Scheduled actions"
        rows={jobs}
        rowKey={(job) => job.id}
        empty="No actions found."
        rowActions={(job) => [
          ...(job.status === 'pending' || job.status === 'failed'
            ? [action('run-job', job, 'Run')]
            : []),
          ...(job.status === 'pending' ? [action('cancel-job', job, 'Cancel')] : []),
        ]}
        columns={[
          {
            key: 'action',
            label: 'Action',
            render: (job) => (
              <>
                <strong>{job.label}</strong>
                {job.label !== job.name && (
                  <>
                    <br />
                    <code>{job.name}</code>
                  </>
                )}
              </>
            ),
          },
          {
            key: 'status',
            label: 'Status',
            render: (job) => STATUSES.find((entry) => entry.status === job.status)!.label,
          },
          { key: 'arguments', label: 'Arguments', render: (job) => <Arguments args={job.args} /> },
          { key: 'recurrence', label: 'Recurrence', render: (job) => recurrence(job.everySeconds) },
          {
            key: 'scheduled',
            label: 'Scheduled Date',
            render: (job) => (
              <>
                <time dateTime={job.runAt.toISOString()}>{formatDate(job.runAt, locale)}</time>
                <br />
                <span className="description">{fromNow(job.runAt)}</span>
              </>
            ),
          },
          { key: 'log', label: 'Log', render: (job) => <Log job={job} /> },
        ]}
      />
    </AdminScreen>
  )
}
