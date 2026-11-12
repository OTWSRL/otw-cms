import { Button, ListTable, TableNav, type Column } from '@otwdesign/admin-ui'
import type { Kernel } from '@otwdesign/core'
import type {
  ContentTypeName,
  Entry,
  MediaItem,
  MediaKind,
  MediaQuery,
  SearchParams,
  User,
} from '@otwdesign/sdk'
import type { ReactNode } from 'react'
import { firstParam } from '../../runtime/search-params'
import { AdminScreen } from '../screen'
import { formatDate } from './content-dates'
import { MediaThumbnail } from './media-thumbnail'

const PATH = '/admin/media'
const PER_PAGE = { list: 20, grid: 40 } as const
const MONTH = /^(\d{4})(\d{2})$/
const ALL_STATUSES = ['draft', 'pending', 'scheduled', 'published', 'private', 'trash'] as const

/** WordPress's "All media items" dropdown: each kind, then Unattached and Mine. */
const TYPE_FILTERS: readonly { value: string; label: string }[] = [
  { value: 'image', label: 'Images' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
  { value: 'document', label: 'Documents' },
  { value: 'spreadsheet', label: 'Spreadsheets' },
  { value: 'archive', label: 'Archives' },
  { value: 'detached', label: 'Unattached' },
  { value: 'mine', label: 'Mine' },
]

/** What the library shows, from its query string: WordPress's mode, attachment-filter, m, s. */
interface LibraryState {
  mode: 'list' | 'grid'
  filter: string | null
  /** `YYYYMM`, as WordPress's `m`. */
  month: string | null
  search: string
  orderby: 'title' | 'date' | null
  order: 'asc' | 'desc' | null
  page: number
}

function readState(params: SearchParams): LibraryState {
  const filter = firstParam(params.filter) ?? ''
  const month = firstParam(params.m) ?? ''
  const orderby = firstParam(params.orderby)
  const order = firstParam(params.order)
  const page = Number(firstParam(params.paged) ?? 1)
  return {
    mode: firstParam(params.mode) === 'list' ? 'list' : 'grid',
    filter: TYPE_FILTERS.some((choice) => choice.value === filter) ? filter : null,
    month: MONTH.test(month) ? month : null,
    search: (firstParam(params.s) ?? '').slice(0, 200),
    orderby: orderby === 'title' || orderby === 'date' ? orderby : null,
    order: order === 'asc' || order === 'desc' ? order : null,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  }
}

/** The library's URL with `changes`; defaults are left out, as WordPress does. */
function libraryUrl(state: LibraryState, changes: Partial<LibraryState> = {}): string {
  const next = { ...state, page: 1, ...changes }
  const query = new URLSearchParams()
  if (next.mode === 'list') query.set('mode', 'list')
  if (next.filter) query.set('filter', next.filter)
  if (next.month) query.set('m', next.month)
  if (next.search) query.set('s', next.search)
  if (next.orderby) query.set('orderby', next.orderby)
  if (next.order) query.set('order', next.order)
  if (next.page > 1) query.set('paged', String(next.page))
  const search = query.toString()
  return search ? `${PATH}?${search}` : PATH
}

function toQuery(state: LibraryState, user: User): MediaQuery {
  const perPage = PER_PAGE[state.mode]
  const month = state.month ? `${state.month.slice(0, 4)}-${state.month.slice(4)}` : undefined
  return {
    ...(state.filter === 'detached'
      ? { entryId: null }
      : state.filter === 'mine'
        ? { authorId: user.id }
        : state.filter
          ? { kind: state.filter as MediaKind }
          : {}),
    search: state.search || undefined,
    month,
    orderBy: state.orderby ?? 'date',
    order: state.order ?? (state.orderby === 'title' ? 'asc' : 'desc'),
    limit: perPage,
    offset: (state.page - 1) * perPage,
  }
}

/** upload.php: the media library, as a grid of thumbnails or a list, with filters. */
export async function MediaLibraryScreen({
  kernel,
  user,
  searchParams,
}: {
  kernel: Kernel
  user: User
  searchParams: SearchParams
}) {
  const state = readState(searchParams)
  const [{ items, total }, months] = await Promise.all([
    kernel.media.list(toQuery(state, user)),
    kernel.media.months(),
  ])
  // The page's uploaders and the entries they're uploaded to, each in one query.
  const entryIds = [...new Set(items.map((item) => item.entryId).filter((id) => id !== null))]
  const [authors, entries] = await Promise.all([
    kernel.auth.getUsers(items.map((item) => item.authorId).filter((id) => id !== null)),
    entryIds.length > 0
      ? kernel.content.list({
          type: kernel.content.types().map((type) => type.name as ContentTypeName),
          ids: entryIds,
          status: ALL_STATUSES,
          limit: entryIds.length,
        })
      : { entries: [] as Entry[] },
  ])
  const authorById = new Map(authors.map((author) => [author.id, author]))
  const entryById = new Map(entries.entries.map((entry) => [entry.id, entry]))
  const locale = kernel.setting('site.locale')
  const canEdit = (item: MediaItem) => kernel.can(user, 'core.edit_media', item)
  const canDelete = (item: MediaItem) => kernel.can(user, 'core.delete_media', item)
  const editUrl = (item: MediaItem) => `${PATH}/${item.id}`
  const pages = Math.max(1, Math.ceil(total / PER_PAGE[state.mode]))
  const formatMonth = new Intl.DateTimeFormat(locale ?? 'en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const sortBy = (column: 'title' | 'date') => {
    const current =
      state.orderby === column || (!state.orderby && column === 'date')
        ? (state.order ?? (column === 'title' ? 'asc' : 'desc'))
        : undefined
    const next =
      current === 'asc' ? 'desc' : current === 'desc' ? 'asc' : column === 'title' ? 'asc' : 'desc'
    return { url: libraryUrl(state, { orderby: column, order: next }), current }
  }

  const uploadedTo = (item: MediaItem): ReactNode => {
    const entry = item.entryId ? entryById.get(item.entryId) : undefined
    if (!entry) return '(Unattached)'
    const type = kernel.content.getType(entry.type)
    const title = entry.title || '(no title)'
    return type?.adminPath && kernel.can(user, type.capabilities.editEntry, entry) ? (
      <a href={`${type.adminPath}/${entry.id}`}>{title}</a>
    ) : (
      title
    )
  }

  const columns: Column<MediaItem>[] = [
    {
      key: 'title',
      label: 'File',
      primary: true,
      sort: sortBy('title'),
      render: (item) => {
        const title = item.title || '(no title)'
        return (
          <div className="media-file">
            <MediaThumbnail item={item} />
            <div>
              <strong>
                {canEdit(item) ? (
                  <a className="row-title" href={editUrl(item)} aria-label={`“${title}” (Edit)`}>
                    {title}
                  </a>
                ) : (
                  title
                )}
              </strong>
              <p className="filename">
                <span className="screen-reader-text">File name: </span>
                {item.file.split('/').pop()}
              </p>
            </div>
          </div>
        )
      },
    },
    {
      key: 'author',
      label: 'Author',
      render: (item) => {
        const author = item.authorId ? authorById.get(item.authorId) : undefined
        return author ? author.name || author.email : '—'
      },
    },
    { key: 'parent', label: 'Uploaded to', render: uploadedTo },
    {
      key: 'date',
      label: 'Date',
      sort: sortBy('date'),
      render: (item) => (
        <time dateTime={item.createdAt.toISOString()}>{formatDate(item.createdAt, locale)}</time>
      ),
    },
  ]

  const rowActions = (item: MediaItem): ReactNode[] => {
    const title = item.title || '(no title)'
    const actions: ReactNode[] = []
    if (canEdit(item)) {
      actions.push(
        <a key="edit" href={editUrl(item)} aria-label={`Edit “${title}”`}>
          Edit
        </a>,
      )
    }
    if (canDelete(item)) {
      actions.push(
        <button
          key="delete"
          type="submit"
          formAction={kernel.actionUrl('core', 'delete-media')}
          name="id"
          value={item.id}
          className="button-link button-link-delete submitdelete"
          aria-label={`Delete “${title}” permanently`}
        >
          Delete Permanently
        </button>,
      )
    }
    actions.push(
      <a key="view" href={item.url} rel="bookmark" aria-label={`View “${title}”`}>
        View
      </a>,
      <a key="download" href={item.url} download={item.filename} aria-label={`Download “${title}”`}>
        Download file
      </a>,
    )
    return actions
  }

  const empty =
    state.search || state.filter || state.month ? (
      'No media files found.'
    ) : (
      <>
        No media files yet. <a href={`${PATH}/new`}>Upload one</a>.
      </>
    )

  return (
    <AdminScreen
      title="Media Library"
      titleAction={{ label: 'Add New Media File', url: `${PATH}/new` }}
      flash={kernel.readFlash(searchParams.flash)}
    >
      <nav className="media-modes" aria-label="View mode">
        <a
          href={libraryUrl(state, { mode: 'list', page: state.page })}
          aria-current={state.mode === 'list' ? 'page' : undefined}
        >
          List
        </a>{' '}
        |{' '}
        <a
          href={libraryUrl(state, { mode: 'grid', page: state.page })}
          aria-current={state.mode === 'grid' ? 'page' : undefined}
        >
          Grid
        </a>
      </nav>
      <form method="get" action={PATH} id="media-filter" className="search-form">
        {state.mode === 'list' && <input type="hidden" name="mode" value="list" />}
        <p className="search-box">
          <label className="screen-reader-text" htmlFor="media-search">
            Search media
          </label>
          <input type="search" id="media-search" name="s" defaultValue={state.search} />
          <Button type="submit">Search Media</Button>
        </p>
      </form>
      <form method="post" action={kernel.actionUrl('core', 'delete-media')}>
        <TableNav
          total={total}
          noun={['item', 'items']}
          page={state.page}
          pages={pages}
          pageUrl={(page) => libraryUrl(state, { page })}
        >
          <label className="screen-reader-text" htmlFor="bulk-action">
            Select bulk action
          </label>
          <select id="bulk-action" name="bulk" defaultValue="">
            <option value="">Bulk actions</option>
            <option value="delete">Delete permanently</option>
          </select>
          <Button type="submit">Apply</Button>
          <label className="screen-reader-text" htmlFor="filter-by-type">
            Filter by type
          </label>
          <select
            id="filter-by-type"
            name="filter"
            form="media-filter"
            defaultValue={state.filter ?? ''}
          >
            <option value="">All media items</option>
            {TYPE_FILTERS.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          {months.length > 0 && (
            <>
              <label className="screen-reader-text" htmlFor="filter-by-date">
                Filter by date
              </label>
              <select
                id="filter-by-date"
                name="m"
                form="media-filter"
                defaultValue={state.month ?? ''}
              >
                <option value="">All dates</option>
                {months.map((month) => (
                  <option key={month} value={month.replace('-', '')}>
                    {formatMonth.format(new Date(`${month}-01T00:00:00Z`))}
                  </option>
                ))}
              </select>
            </>
          )}
          <Button type="submit" form="media-filter">
            Filter
          </Button>
        </TableNav>
        {state.mode === 'list' ? (
          <ListTable
            caption="Media Library"
            rows={items}
            rowKey={(item) => item.id}
            select={{
              name: 'ids',
              value: (item) => item.id,
              label: (item) => item.title || item.filename,
              enabled: canDelete,
            }}
            rowActions={rowActions}
            columns={columns}
            empty={empty}
          />
        ) : items.length === 0 ? (
          <p className="no-media">{empty}</p>
        ) : (
          <ul className="media-grid" aria-label="Media Library">
            {items.map((item) => {
              const title = item.title || item.filename
              return (
                <li key={item.id}>
                  {canDelete(item) && (
                    <input
                      type="checkbox"
                      name="ids"
                      value={item.id}
                      aria-label={`Select ${title}`}
                    />
                  )}
                  <a
                    href={canEdit(item) ? editUrl(item) : item.url}
                    aria-label={canEdit(item) ? `Edit “${title}”` : `View “${title}”`}
                  >
                    <MediaThumbnail item={item} large />
                    <span className="media-grid-title">{title}</span>
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </form>
    </AdminScreen>
  )
}
