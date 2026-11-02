import { Button, ListTable, TableNav, Views, type Column, type View } from '@otw/admin-ui'
import { inSentence, type Kernel } from '@otw/core'
import type {
  ContentType,
  Entry,
  EntryQuery,
  EntryStatus,
  SearchParams,
  Taxonomy,
  Term,
  User,
} from '@otw/sdk'
import type { ReactNode } from 'react'
import { firstParam } from '../../runtime/search-params'
import { AdminScreen } from '../screen'
import { entryDate } from './content-dates'

const PER_PAGE = 20
const STATUS_VIEWS: readonly { status: EntryStatus; label: string }[] = [
  { status: 'published', label: 'Published' },
  { status: 'draft', label: 'Drafts' },
  { status: 'pending', label: 'Pending' },
  { status: 'private', label: 'Private' },
  { status: 'trash', label: 'Trash' },
]
const STATES: Partial<Record<EntryStatus, string>> = {
  draft: 'Draft',
  pending: 'Pending',
  private: 'Private',
}
const MONTH = /^(\d{4})(\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What the list shows, from its query string: WordPress's post_status, author, s, m, orderby. */
interface ListState {
  status: EntryStatus | null
  author: string | null
  search: string
  /** `YYYYMM`, as WordPress's `m`. */
  month: string | null
  orderby: 'title' | 'date' | null
  order: 'asc' | 'desc' | null
  page: number
  /** Term ids, from a taxonomy column's link or dropdown: entries with each of them. */
  terms: string[]
}

function readState(params: SearchParams): ListState {
  const status = firstParam(params.status)
  const orderby = firstParam(params.orderby)
  const order = firstParam(params.order)
  const month = firstParam(params.m) ?? ''
  const page = Number(firstParam(params.paged) ?? 1)
  return {
    status: STATUS_VIEWS.some((view) => view.status === status) ? (status as EntryStatus) : null,
    author: firstParam(params.author) || null,
    search: (firstParam(params.s) ?? '').slice(0, 200),
    month: MONTH.test(month) ? month : null,
    orderby: orderby === 'title' || orderby === 'date' ? orderby : null,
    order: order === 'asc' || order === 'desc' ? order : null,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    terms: [params.term].flat().filter((id): id is string => !!id && UUID.test(id)),
  }
}

/** The list's URL with `changes`; page 1 and empty values are left out, as WordPress does. */
function listUrl(type: ContentType, state: ListState, changes: Partial<ListState> = {}): string {
  const next = { ...state, page: 1, ...changes }
  const query = new URLSearchParams()
  if (next.status) query.set('status', next.status)
  if (next.author) query.set('author', next.author)
  if (next.search) query.set('s', next.search)
  if (next.month) query.set('m', next.month)
  if (next.orderby) query.set('orderby', next.orderby)
  if (next.order) query.set('order', next.order)
  for (const term of next.terms) query.append('term', term)
  if (next.page > 1) query.set('paged', String(next.page))
  const search = query.toString()
  return search ? `${type.adminPath}?${search}` : type.adminPath!
}

function monthRange(month: string): { after: Date; before: Date } {
  const [, year, number] = MONTH.exec(month)!
  return {
    after: new Date(Date.UTC(Number(year), Number(number) - 1, 1)),
    before: new Date(Date.UTC(Number(year), Number(number), 1)),
  }
}

/**
 * Places plugins' columns: after the column they name, or before the date. Unknown names fall
 * back to before the date too, so a column for an inactive plugin's column still shows.
 */
function placeColumns<T>(base: Column<T>[], added: readonly (Column<T> & { after?: string })[]) {
  const columns = [...base]
  for (const column of added) {
    const after = column.after ? columns.findIndex((c) => c.key === column.after) : -1
    const date = columns.findIndex((c) => c.key === 'date')
    columns.splice(after >= 0 ? after + 1 : date >= 0 ? date : columns.length, 0, column)
  }
  return columns
}

/** edit.php: a content type's entries, with views, search, the month filter and bulk actions. */
export async function ContentListScreen({
  kernel,
  user,
  type,
  searchParams,
}: {
  kernel: Kernel
  user: User
  type: ContentType
  searchParams: SearchParams
}) {
  const state = readState(searchParams)
  const caps = type.capabilities
  const extensions = kernel.contentScreens(type.name)
  const plural = inSentence(type.labels.plural)
  const trashView = state.status === 'trash'

  const filterTerms = (
    await Promise.all(state.terms.map((id) => kernel.content.getTerm(id)))
  ).filter((term): term is Term => term !== null)
  const byTaxonomy: Record<string, string[]> = {}
  for (const term of filterTerms) (byTaxonomy[term.taxonomy] ??= []).push(term.id)
  const tree =
    type.hierarchical && !state.orderby && !state.search && !state.month && !state.terms.length
  const query: EntryQuery = {
    type: type.name,
    status: state.status ?? undefined,
    authorId: state.author ?? undefined,
    search: state.search || undefined,
    ...(state.month ? monthRange(state.month) : {}),
    orderBy: tree ? 'tree' : (state.orderby ?? 'date'),
    order: state.order ?? undefined,
    limit: PER_PAGE,
    offset: (state.page - 1) * PER_PAGE,
    terms: filterTerms.length > 0 ? byTaxonomy : undefined,
  }
  const [list, counts, mine, months] = await Promise.all([
    kernel.content.list(query),
    kernel.content.count(type.name),
    kernel.content.count(type.name, { authorId: user.id }),
    kernel.content.months(type.name, { status: trashView ? ['trash'] : undefined }),
  ])
  const authorIds = list.entries.map((entry) => entry.authorId).filter((id) => id !== null)
  const authors = new Map((await kernel.auth.getUsers(authorIds)).map((u) => [u.id, u]))
  // Taxonomy columns: every entry's terms on the page in one query, as for the authors.
  const columnTaxonomies = kernel.content
    .taxonomies(type.name)
    .filter((taxonomy) => taxonomy.showAdminColumn && taxonomy.showUi)
  const filterTaxonomies = columnTaxonomies.filter((taxonomy) => taxonomy.hierarchical)
  const [assigned, dropdowns] = await Promise.all([
    columnTaxonomies.length > 0
      ? kernel.content.entryTerms(list.entries.map((entry) => entry.id))
      : new Map<string, Term[]>(),
    Promise.all(
      filterTaxonomies.map((taxonomy) =>
        kernel.content.listTerms({ taxonomy: taxonomy.name, orderBy: 'tree', limit: 1000 }),
      ),
    ),
  ])
  const columnData = new Map(
    await Promise.all(
      extensions.columns.map(
        async (column) => [column.key, await column.load?.(list.entries, { user, type })] as const,
      ),
    ),
  )

  const sum = (statuses: readonly EntryStatus[], from: Record<EntryStatus, number>) =>
    statuses.reduce((total, status) => total + from[status], 0)
  const live: EntryStatus[] = ['draft', 'pending', 'published', 'private']
  const all = sum(live, counts)
  const ownCount = sum(live, mine)
  const views: View[] = [
    {
      label: 'All',
      count: all,
      href: listUrl(type, state, { status: null, author: null }),
      current: !state.status && !state.author,
    },
    ...(ownCount > 0 && ownCount !== all
      ? [
          {
            label: 'Mine',
            count: ownCount,
            href: listUrl(type, state, { status: null, author: user.id }),
            current: !state.status && state.author === user.id,
          },
        ]
      : []),
    ...STATUS_VIEWS.filter(({ status }) => counts[status] > 0).map(({ status, label }) => ({
      label,
      count: counts[status],
      href: listUrl(type, state, { status, author: null }),
      current: state.status === status,
    })),
  ]

  const canEdit = (entry: Entry) => kernel.can(user, caps.editEntry, entry)
  const canDelete = (entry: Entry) => kernel.can(user, caps.deleteEntry, entry)
  const depth = new Map(list.entries.map((entry, i) => [entry.id, list.depths?.[i] ?? 0]))
  const editUrl = (entry: Entry) => `${type.adminPath}/${entry.id}`
  const sortBy = (column: 'title' | 'date') => {
    const current =
      state.orderby === column || (!state.orderby && column === 'date' && !tree)
        ? (state.order ?? (column === 'title' ? 'asc' : 'desc'))
        : undefined
    const next =
      current === 'asc' ? 'desc' : current === 'desc' ? 'asc' : column === 'title' ? 'asc' : 'desc'
    return { url: listUrl(type, state, { orderby: column, order: next }), current }
  }

  const base: Column<Entry>[] = [
    {
      key: 'title',
      label: 'Title',
      primary: true,
      sort: sortBy('title'),
      render: (entry) => {
        const title = entry.title || '(no title)'
        // "— Draft" and the like, except in the view of that status, as WordPress shows them.
        const label = entry.status === state.status ? undefined : STATES[entry.status]
        return (
          <strong>
            {'— '.repeat(depth.get(entry.id) ?? 0)}
            {canEdit(entry) && !trashView ? (
              <a className="row-title" href={editUrl(entry)} aria-label={`“${title}” (Edit)`}>
                {title}
              </a>
            ) : (
              title
            )}
            {label && (
              <>
                {' — '}
                <span className="post-state">{label}</span>
              </>
            )}
          </strong>
        )
      },
    },
    ...(type.supports.includes('author')
      ? [
          {
            key: 'author',
            label: 'Author',
            render: (entry: Entry): ReactNode => {
              const author = entry.authorId ? authors.get(entry.authorId) : undefined
              return author ? (
                <a href={listUrl(type, state, { author: author.id, status: null })}>
                  {author.name || author.email}
                </a>
              ) : (
                '—'
              )
            },
          },
        ]
      : []),
    {
      key: 'date',
      label: 'Date',
      sort: tree ? undefined : sortBy('date'),
      render: (entry) => entryDate(entry, kernel.setting('site.locale')),
    },
  ]
  const taxonomyColumn = (taxonomy: Taxonomy): Column<Entry> => ({
    key: `taxonomy-${taxonomy.name.replace('.', '-')}`,
    label: taxonomy.labels.plural,
    render: (entry) => {
      const terms = (assigned.get(entry.id) ?? []).filter((t) => t.taxonomy === taxonomy.name)
      if (terms.length === 0) return '—'
      return terms.map((term, i) => (
        <span key={term.id}>
          {i > 0 && ', '}
          <a href={listUrl(type, state, { terms: [term.id] })}>{term.name}</a>
        </span>
      ))
    },
  })
  const date = base.findIndex((column) => column.key === 'date')
  base.splice(date, 0, ...columnTaxonomies.map(taxonomyColumn))
  const columns = placeColumns(
    base,
    extensions.columns.map((column) => ({
      key: column.key.replace('.', '-'),
      label: column.label,
      after: column.after?.replace('.', '-'),
      render: (entry: Entry) => column.render(entry, columnData.get(column.key)),
    })),
  )

  const rowActions = (entry: Entry): ReactNode[] => {
    const actions: ReactNode[] = []
    if (trashView) {
      if (canDelete(entry)) {
        actions.push(
          <RowButton key="restore" action={kernel.actionUrl('core', 'restore-entry')} id={entry.id}>
            Restore
          </RowButton>,
          <RowButton
            key="delete"
            action={kernel.actionUrl('core', 'delete-entry')}
            id={entry.id}
            danger
          >
            Delete Permanently
          </RowButton>,
        )
      }
      return actions
    }
    if (canEdit(entry)) {
      actions.push(
        <a key="edit" href={editUrl(entry)} aria-label={`Edit “${entry.title || '(no title)'}”`}>
          Edit
        </a>,
      )
    }
    if (canDelete(entry)) {
      actions.push(
        <RowButton
          key="trash"
          action={kernel.actionUrl('core', 'trash-entry')}
          id={entry.id}
          danger
        >
          Trash
        </RowButton>,
      )
    }
    for (const action of extensions.rowActions) {
      const link = action.link(entry, user)
      if (link) {
        actions.push(
          <a key={action.key} href={link.url}>
            {link.label}
          </a>,
        )
      }
    }
    return actions
  }

  const bulkChoices = [
    ...(trashView
      ? [
          { value: 'restore', label: 'Restore' },
          { value: 'delete', label: 'Delete Permanently' },
        ]
      : [{ value: 'trash', label: 'Move to Trash' }]),
    ...extensions.bulkActions
      .filter((action) => kernel.can(user, action.capability))
      .map((action) => ({ value: action.key, label: action.label })),
  ]
  const pages = Math.max(1, Math.ceil(list.total / PER_PAGE))
  const formatMonth = new Intl.DateTimeFormat(kernel.setting('site.locale') ?? 'en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

  return (
    <AdminScreen
      title={type.labels.plural}
      titleAction={{ label: `Add New ${type.labels.singular}`, url: `${type.adminPath}/new` }}
      flash={kernel.readFlash(searchParams.flash)}
    >
      <Views label={`Filter ${plural} by status`} views={views} />
      <form method="get" action={type.adminPath!} id="entries-filter" className="search-form">
        {state.status && <input type="hidden" name="status" value={state.status} />}
        {state.author && <input type="hidden" name="author" value={state.author} />}
        {filterTerms
          .filter((term) => !filterTaxonomies.some((taxonomy) => taxonomy.name === term.taxonomy))
          .map((term) => (
            <input key={term.id} type="hidden" name="term" value={term.id} />
          ))}
        <p className="search-box">
          <label className="screen-reader-text" htmlFor="entry-search">
            Search {plural}
          </label>
          <input type="search" id="entry-search" name="s" defaultValue={state.search} />
          <Button type="submit">Search {type.labels.plural}</Button>
        </p>
      </form>
      <form method="post" action={kernel.actionUrl('core', 'bulk-entries')}>
        <input type="hidden" name="type" value={type.name} />
        <TableNav
          total={list.total}
          noun={['item', 'items']}
          page={state.page}
          pages={pages}
          pageUrl={(page) => listUrl(type, state, { page })}
        >
          <label className="screen-reader-text" htmlFor="bulk-action">
            Select bulk action
          </label>
          <select id="bulk-action" name="bulk" defaultValue="">
            <option value="">Bulk actions</option>
            {bulkChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          <Button type="submit">Apply</Button>
          {filterTaxonomies.map((taxonomy, i) => (
            <span key={taxonomy.name}>
              <label className="screen-reader-text" htmlFor={`filter-by-${taxonomy.name}`}>
                Filter by {inSentence(taxonomy.labels.singular)}
              </label>
              <select
                id={`filter-by-${taxonomy.name}`}
                name="term"
                form="entries-filter"
                defaultValue={filterTerms.find((term) => term.taxonomy === taxonomy.name)?.id ?? ''}
              >
                <option value="">All {taxonomy.labels.plural}</option>
                {dropdowns[i]!.terms.map((term, j) => (
                  <option key={term.id} value={term.id}>
                    {'\u00a0\u00a0\u00a0'.repeat(dropdowns[i]!.depths?.[j] ?? 0)}
                    {term.name}
                  </option>
                ))}
              </select>
            </span>
          ))}
          {months.length > 0 && (
            <>
              <label className="screen-reader-text" htmlFor="filter-by-date">
                Filter by date
              </label>
              <select
                id="filter-by-date"
                name="m"
                form="entries-filter"
                defaultValue={state.month ?? ''}
              >
                <option value="">All dates</option>
                {months.map(({ year, month }) => (
                  <option
                    key={`${year}-${month}`}
                    value={`${year}${String(month).padStart(2, '0')}`}
                  >
                    {formatMonth.format(new Date(Date.UTC(year, month - 1, 1)))}
                  </option>
                ))}
              </select>
            </>
          )}
          {(months.length > 0 || filterTaxonomies.length > 0) && (
            <Button type="submit" form="entries-filter">
              Filter
            </Button>
          )}
          {trashView && counts.trash > 0 && kernel.can(user, caps.delete) && (
            <Button type="submit" name="bulk" value="empty-trash">
              Empty Trash
            </Button>
          )}
        </TableNav>
        <ListTable
          caption={type.labels.plural}
          rows={list.entries}
          rowKey={(entry) => entry.id}
          select={{
            name: 'ids',
            value: (entry) => entry.id,
            label: (entry) => entry.title || '(no title)',
            enabled: (entry) => canDelete(entry) || canEdit(entry),
          }}
          rowActions={rowActions}
          columns={columns}
          empty={trashView ? `No ${plural} found in Trash.` : `No ${plural} found.`}
        />
      </form>
    </AdminScreen>
  )
}

/**
 * A row action that changes the entry: a button in the list's form, posting to its own action
 * with the entry's id (forms can't nest, and admin actions take only POST).
 */
function RowButton({
  action,
  id,
  danger,
  children,
}: {
  action: string
  id: string
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="submit"
      formAction={action}
      name="id"
      value={id}
      className={danger ? 'button-link button-link-delete submitdelete' : 'button-link'}
    >
      {children}
    </button>
  )
}
