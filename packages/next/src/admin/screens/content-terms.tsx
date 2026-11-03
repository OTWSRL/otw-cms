import { Button, ListTable, SubmitButton, TableNav } from '@otwdesign/admin-ui'
import { inSentence, type Kernel } from '@otwdesign/core'
import type { SearchParams, Taxonomy, TaxonomyName, Term, User } from '@otwdesign/sdk'
import { firstParam } from '../../runtime/search-params'
import { AdminScreen } from '../screen'

const PER_PAGE = 20
/** A Parent dropdown lists at most this many terms. */
const MAX_PARENTS = 1000

/** A taxonomy's terms in tree order, for Parent dropdowns, without `term`'s own branch. */
export async function parentTerms(kernel: Kernel, taxonomy: Taxonomy, term: Term | null) {
  const { terms, depths = [] } = await kernel.content.listTerms({
    taxonomy: taxonomy.name,
    orderBy: 'tree',
    limit: MAX_PARENTS,
  })
  const choices = terms.map((item, i) => ({ term: item, depth: depths[i] ?? 0 }))
  const self = choices.findIndex((choice) => choice.term.id === term?.id)
  if (self < 0) return choices
  const end = choices.findIndex((choice, i) => i > self && choice.depth <= choices[self]!.depth)
  return [...choices.slice(0, self), ...(end < 0 ? [] : choices.slice(end))]
}

/** The Parent dropdown of the add and edit forms, for hierarchical taxonomies. */
export function ParentSelect({
  choices,
  value,
}: {
  choices: readonly { term: Term; depth: number }[]
  value: string
}) {
  return (
    <select id="term-parent" name="parent" defaultValue={value}>
      <option value="">None</option>
      {choices.map(({ term, depth }) => (
        <option key={term.id} value={term.id}>
          {'   '.repeat(depth)}
          {term.name}
        </option>
      ))}
    </select>
  )
}

/**
 * edit-tags.php: the form to add a term beside the list of terms, as WordPress lays it out, with
 * each term's count of published entries linking to them.
 */
export async function ContentTermsScreen({
  kernel,
  user,
  taxonomy,
  searchParams,
}: {
  kernel: Kernel
  user: User
  taxonomy: Taxonomy
  searchParams: SearchParams
}) {
  const caps = taxonomy.capabilities
  const singular = taxonomy.labels.singular
  const plural = inSentence(taxonomy.labels.plural)
  const search = (firstParam(searchParams.s) ?? '').slice(0, 200)
  const pageParam = Number(firstParam(searchParams.paged) ?? 1)
  const page = Number.isSafeInteger(pageParam) && pageParam > 0 ? pageParam : 1
  const tree = taxonomy.hierarchical && !search
  const [list, parents] = await Promise.all([
    kernel.content.listTerms({
      taxonomy: taxonomy.name as TaxonomyName,
      search: search || undefined,
      orderBy: tree ? 'tree' : 'name',
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    }),
    taxonomy.hierarchical ? parentTerms(kernel, taxonomy, null) : [],
  ])
  const counts = new Map(list.terms.map((term, i) => [term.id, list.counts[i] ?? 0]))
  const depths = new Map(list.terms.map((term, i) => [term.id, list.depths?.[i] ?? 0]))
  const entriesType = kernel.content.getType(
    taxonomy.types.find((type) => kernel.content.getType(type)?.adminPath) ?? '',
  )
  const pageUrl = (target: number) => {
    const query = new URLSearchParams()
    if (search) query.set('s', search)
    if (target > 1) query.set('paged', String(target))
    const text = query.toString()
    return text ? `${taxonomy.adminPath}?${text}` : taxonomy.adminPath!
  }
  const canAdd = kernel.can(user, caps.edit)

  return (
    <AdminScreen title={taxonomy.labels.plural} flash={kernel.readFlash(searchParams.flash)}>
      <form method="get" action={taxonomy.adminPath!} className="search-form">
        <p className="search-box">
          <label className="screen-reader-text" htmlFor="term-search">
            Search {plural}
          </label>
          <input type="search" id="term-search" name="s" defaultValue={search} />
          <Button type="submit">Search {taxonomy.labels.plural}</Button>
        </p>
      </form>
      <div className="col-wrap">
        {canAdd && (
          <div className="col-left">
            <h2>Add New {singular}</h2>
            <form method="post" action={kernel.actionUrl('core', 'create-term')}>
              <input type="hidden" name="taxonomy" value={taxonomy.name} />
              <div className="form-field">
                <label htmlFor="term-name">Name</label>
                <input type="text" id="term-name" name="name" required maxLength={200} />
                <p className="description">The name is how it appears on your site.</p>
              </div>
              <div className="form-field">
                <label htmlFor="term-slug">Slug</label>
                <input type="text" id="term-slug" name="slug" maxLength={200} />
                <p className="description">
                  The address-friendly version of the name, made from it if left empty.
                </p>
              </div>
              {taxonomy.hierarchical && (
                <div className="form-field">
                  <label htmlFor="term-parent">Parent {singular}</label>
                  <ParentSelect choices={parents} value="" />
                </div>
              )}
              <div className="form-field">
                <label htmlFor="term-description">Description</label>
                <textarea id="term-description" name="description" rows={4} maxLength={2000} />
              </div>
              <SubmitButton>Add New {singular}</SubmitButton>
            </form>
          </div>
        )}
        <div className="col-right">
          <form method="post" action={kernel.actionUrl('core', 'bulk-terms')}>
            <input type="hidden" name="taxonomy" value={taxonomy.name} />
            <TableNav
              total={list.total}
              noun={['item', 'items']}
              page={page}
              pages={Math.max(1, Math.ceil(list.total / PER_PAGE))}
              pageUrl={pageUrl}
            >
              <label className="screen-reader-text" htmlFor="bulk-term-action">
                Select bulk action
              </label>
              <select id="bulk-term-action" name="bulk" defaultValue="">
                <option value="">Bulk actions</option>
                <option value="delete">Delete</option>
              </select>
              <Button type="submit">Apply</Button>
            </TableNav>
            <ListTable
              caption={taxonomy.labels.plural}
              rows={list.terms}
              rowKey={(term) => term.id}
              select={{
                name: 'ids',
                value: (term) => term.id,
                label: (term) => term.name,
                enabled: (term) => kernel.can(user, caps.deleteTerm, term),
              }}
              rowActions={(term) => [
                ...(kernel.can(user, caps.editTerm, term)
                  ? [
                      <a
                        key="edit"
                        href={`${taxonomy.adminPath}/${term.id}`}
                        aria-label={`Edit “${term.name}”`}
                      >
                        Edit
                      </a>,
                    ]
                  : []),
                ...(kernel.can(user, caps.deleteTerm, term)
                  ? [
                      <button
                        key="delete"
                        type="submit"
                        formAction={kernel.actionUrl('core', 'delete-term')}
                        name="id"
                        value={term.id}
                        className="button-link button-link-delete submitdelete"
                      >
                        Delete
                      </button>,
                    ]
                  : []),
              ]}
              columns={[
                {
                  key: 'name',
                  label: 'Name',
                  primary: true,
                  render: (term) => (
                    <strong>
                      {'— '.repeat(depths.get(term.id) ?? 0)}
                      {kernel.can(user, caps.editTerm, term) ? (
                        <a className="row-title" href={`${taxonomy.adminPath}/${term.id}`}>
                          {term.name}
                        </a>
                      ) : (
                        term.name
                      )}
                    </strong>
                  ),
                },
                {
                  key: 'description',
                  label: 'Description',
                  render: (term) => term.description || '—',
                },
                { key: 'slug', label: 'Slug', render: (term) => term.slug },
                {
                  key: 'posts',
                  label: 'Count',
                  numeric: true,
                  render: (term) =>
                    entriesType?.adminPath ? (
                      <a href={`${entriesType.adminPath}?term=${term.id}`}>{counts.get(term.id)}</a>
                    ) : (
                      counts.get(term.id)
                    ),
                },
              ]}
              empty={`No ${plural} found.`}
            />
          </form>
          {taxonomy.defaultTerm && (
            <p className="description">
              Deleting a {inSentence(singular)} doesn’t delete its entries: those it leaves with no{' '}
              {inSentence(singular)} get the default, {taxonomy.defaultTerm.name}, which can’t be
              deleted.
            </p>
          )}
        </div>
      </div>
    </AdminScreen>
  )
}
