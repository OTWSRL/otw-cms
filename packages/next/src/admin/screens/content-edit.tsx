import { Button, EditColumns, FormButton, Notice, Postbox } from '@otwdesign/admin-ui'
import { inSentence, type Kernel } from '@otwdesign/core'
import type {
  ContentType,
  ContentTypeName,
  Entry,
  SearchParams,
  Taxonomy,
  Term,
  User,
} from '@otwdesign/sdk'
import { EditorLoader } from '../editor/editor-loader'
import { FeaturedImage } from '../featured-image'
import type { PickedMedia } from '../media-picker'
import { AdminScreen } from '../screen'
import { formatDate } from './content-dates'
import { MetaFields } from './meta-fields'

/** A parent dropdown lists at most this many entries, as a page of 100 at a time. */

/** The type's other entries in tree order, for the Parent dropdown, without `entry`'s own branch. */
function parentChoices(kernel: Kernel, type: ContentType, entry: Entry | null) {
  return kernel.content.outline(type.name as ContentTypeName, { exclude: entry?.id })
}

/** Who may be named as the author: users whose role may write entries of the type. */
async function authorChoices(kernel: Kernel, type: ContentType, entry: Entry | null) {
  const roles = kernel
    .roles()
    .filter((role) => role.capabilities.includes(type.capabilities.edit))
    .map((role) => role.id)
  const users = await kernel.auth.listUsers({ roles })
  const current = entry?.authorId
  if (current && !users.some((user) => user.id === current)) {
    users.unshift(...(await kernel.auth.getUsers([current])))
  }
  return users
}

/**
 * post.php and post-new.php: the title, the editor and the boxes in WordPress's two columns, with
 * the Publish box first in the sidebar. What it offers follows the user's capabilities; the save
 * action checks them again, whatever the form sends.
 */
export async function ContentEditScreen({
  kernel,
  user,
  type,
  entry,
  searchParams,
}: {
  kernel: Kernel
  user: User
  type: ContentType
  entry: Entry | null
  searchParams: SearchParams
}) {
  const caps = type.capabilities
  const singular = type.labels.singular
  const lower = inSentence(singular)
  const flash = kernel.readFlash(searchParams.flash)
  const title = entry ? `Edit ${singular}` : `Add New ${singular}`
  const addNew = entry ? { label: `Add New ${singular}`, url: `${type.adminPath}/new` } : null

  if (entry?.status === 'trash') {
    return (
      <AdminScreen title={title} titleAction={addNew} flash={flash}>
        <Notice type="warning" title={`This ${lower} is in the Trash.`}>
          <p>Restore it to edit it.</p>
          {kernel.can(user, caps.deleteEntry, entry) && (
            <p>
              <FormButton
                action={kernel.actionUrl('core', 'restore-entry')}
                fields={{ id: entry.id }}
                variant="primary"
              >
                Restore
              </FormButton>
            </p>
          )}
        </Notice>
      </AdminScreen>
    )
  }

  const supports = (feature: ContentType['supports'][number]) => type.supports.includes(feature)
  const extensions = kernel.contentScreens(type.name)
  const published = entry?.status === 'published' || entry?.status === 'private'
  const canPublish = entry
    ? kernel.can(user, caps.publishEntry, entry)
    : kernel.can(user, caps.publish)
  const canChooseAuthor = supports('author') && kernel.can(user, caps.editOthers)
  const [authors, parents] = await Promise.all([
    canChooseAuthor ? authorChoices(kernel, type, entry) : [],
    type.hierarchical ? parentChoices(kernel, type, entry) : [],
  ])
  // The category checklist and tags boxes, for those who may give entries the taxonomy's terms.
  const taxonomies = kernel.content
    .taxonomies(type.name)
    .filter((taxonomy) => taxonomy.showUi && kernel.can(user, taxonomy.capabilities.assign))
  const [assigned, checklists] = await Promise.all([
    entry ? kernel.content.entryTerms([entry.id]) : new Map<string, Term[]>(),
    Promise.all(
      taxonomies.map((taxonomy) =>
        taxonomy.hierarchical
          ? kernel.content.listTerms({ taxonomy: taxonomy.name, orderBy: 'tree', limit: 1000 })
          : null,
      ),
    ),
  ])
  const current = entry ? (assigned.get(entry.id) ?? []) : []
  const taxonomyBoxes = taxonomies.map((taxonomy, i) => (
    <TaxonomyBox
      key={taxonomy.name}
      taxonomy={taxonomy}
      current={current.filter((term) => term.taxonomy === taxonomy.name)}
      choices={checklists[i] ?? null}
      canManage={kernel.can(user, taxonomy.capabilities.manage)}
    />
  ))
  // A field box's custom fields, in its order, as far as they're registered for this type.
  const typeFields = new Map(
    kernel.content.metaFields(type.name).map((field) => [field.key, field]),
  )
  const boxes = (context: 'normal' | 'side') =>
    extensions.metaBoxes
      .filter((box) => (box.context ?? 'normal') === context)
      .map(({ key, title, fields, component: Box }) => (
        <Postbox key={key} id={`box-${key.replace('.', '-')}`} title={title}>
          {fields ? (
            <MetaFields
              fields={fields.flatMap((name) => typeFields.get(name) ?? [])}
              meta={entry?.meta ?? {}}
              editable={(field) =>
                !field.definition.capability || kernel.can(user, field.definition.capability)
              }
            />
          ) : (
            Box && <Box entry={entry} type={type} user={user} />
          )}
        </Postbox>
      ))
  const newKey = `new:${type.name}`
  const locale = kernel.setting('site.locale')
  const permalink =
    entry && type.public ? (await kernel.content.permalinks([entry])).get(entry.id) : null
  // What the Featured image box starts with: the few fields it shows, not the whole item.
  const thumbnailItem =
    entry?.thumbnailId && supports('thumbnail') ? await kernel.media.get(entry.thumbnailId) : null
  const thumbnail: PickedMedia | null = thumbnailItem && {
    id: thumbnailItem.id,
    url: thumbnailItem.url,
    title: thumbnailItem.title,
    filename: thumbnailItem.filename,
    alt: thumbnailItem.alt,
    kind: thumbnailItem.kind,
    width: thumbnailItem.width,
    height: thumbnailItem.height,
    sizes: Object.fromEntries(
      Object.entries(thumbnailItem.sizes).map(([name, size]) => [
        name,
        { url: size.url, width: size.width, height: size.height },
      ]),
    ),
  }
  // WordPress shows Revisions once there's something to compare: two or more.
  const revisionCount =
    entry && type.revisions > 0 ? (await kernel.content.revisions(entry.id, { limit: 1 })).total : 0

  const publishBox = (
    <Postbox id="submitdiv" title="Publish">
      <div className="submitbox">
        <div className="minor-publishing">
          {(!published || (entry && type.public)) && (
            <div className="minor-publishing-actions">
              {!published && (
                <Button type="submit" name="intent" value="save">
                  Save Draft
                </Button>
              )}{' '}
              {/* The saved entry: save first to preview changes, as there's no autosave yet. */}
              {entry && type.public && (
                <a
                  className="button"
                  href={permalink ?? kernel.content.previewUrl(entry)}
                  target="_blank"
                  rel="noopener"
                >
                  {permalink ? `View ${singular}` : 'Preview'}
                </a>
              )}
            </div>
          )}
          <div className="misc-publishing-actions">
            <div className="misc-pub-section">
              <label htmlFor="entry-status">Status:</label>{' '}
              <select
                id="entry-status"
                name="status"
                defaultValue={published ? 'published' : (entry?.status ?? 'draft')}
              >
                {published && (
                  <option value="published">
                    {entry.status === 'private' ? 'Privately Published' : 'Published'}
                  </option>
                )}
                <option value="pending">Pending Review</option>
                <option value="draft">Draft</option>
              </select>
            </div>
            {canPublish && (
              <fieldset className="misc-pub-section">
                <legend>Visibility:</legend>
                <label>
                  <input
                    type="radio"
                    name="visibility"
                    value="public"
                    defaultChecked={entry?.status !== 'private'}
                  />{' '}
                  Public
                </label>{' '}
                <label>
                  <input
                    type="radio"
                    name="visibility"
                    value="private"
                    defaultChecked={entry?.status === 'private'}
                  />{' '}
                  Private
                </label>
              </fieldset>
            )}
            {entry && revisionCount >= 2 && (
              <div className="misc-pub-section">
                Revisions: <b>{revisionCount}</b>{' '}
                <a href={`${type.adminPath}/${entry.id}/revisions`}>Browse</a>
              </div>
            )}
            <div className="misc-pub-section">
              {published && entry.publishedAt ? (
                <>
                  Published on: <b>{formatDate(entry.publishedAt, locale)}</b>
                </>
              ) : (
                <>
                  Publish <b>immediately</b>
                </>
              )}
            </div>
          </div>
        </div>
        {/* Update or Publish comes first in the form, so Enter in a field never trashes. */}
        <div className="major-publishing-actions">
          <div className="publishing-action">
            <Button
              type="submit"
              name="intent"
              value={published ? 'save' : 'publish'}
              variant="primary"
            >
              {published ? 'Update' : canPublish ? 'Publish' : 'Submit for Review'}
            </Button>
          </div>
          {entry && kernel.can(user, caps.deleteEntry, entry) && (
            <div className="delete-action">
              <button
                type="submit"
                formAction={kernel.actionUrl('core', 'trash-entry')}
                className="button-link button-link-delete submitdelete"
              >
                Move to Trash
              </button>
            </div>
          )}
        </div>
      </div>
    </Postbox>
  )

  const main = (
    <>
      <div className="titlediv">
        <label className="screen-reader-text" htmlFor="title">
          Add title
        </label>
        <input
          type="text"
          id="title"
          name="title"
          className="entry-title"
          defaultValue={entry?.title ?? ''}
          placeholder="Add title"
          maxLength={500}
          autoComplete="off"
          spellCheck
        />
        {permalink && (
          <p className="entry-permalink">
            Permalink: <a href={permalink}>{permalink}</a>
          </p>
        )}
      </div>
      {supports('body') && (
        <div className="entry-body">
          <input
            type="hidden"
            id="entry-body"
            name="body"
            defaultValue={JSON.stringify(entry?.body ?? [])}
          />
          <EditorLoader
            inputId="entry-body"
            initial={entry?.body ?? []}
            backupKey={entry ? entry.id : newKey}
            firstSaveKey={newKey}
            label={`${singular} content`}
            entryId={entry?.id}
          />
          <noscript>
            <p className="description">
              The editor needs JavaScript. The other fields still save, and the content stays as it
              is.
            </p>
          </noscript>
        </div>
      )}
      {supports('excerpt') && (
        <Postbox id="postexcerpt" title="Excerpt">
          <label className="screen-reader-text" htmlFor="excerpt">
            Excerpt
          </label>
          <textarea id="excerpt" name="excerpt" rows={3} defaultValue={entry?.excerpt ?? ''} />
          <p className="description">An optional summary, for lists and search results.</p>
        </Postbox>
      )}
      <Postbox id="slugdiv" title="Slug">
        <label className="screen-reader-text" htmlFor="slug">
          Slug
        </label>
        <input type="text" id="slug" name="slug" defaultValue={entry?.slug ?? ''} />
        <p className="description">
          Made from the title when the {lower} is published, unless you set one.
        </p>
      </Postbox>
      {canChooseAuthor && (
        <Postbox id="authordiv" title="Author">
          <label className="screen-reader-text" htmlFor="author">
            Author
          </label>
          <select id="author" name="author" defaultValue={entry ? (entry.authorId ?? '') : user.id}>
            {entry && !entry.authorId && <option value="">(no author)</option>}
            {authors.map((author) => (
              <option key={author.id} value={author.id}>
                {author.name || author.email}
              </option>
            ))}
          </select>
        </Postbox>
      )}
      {boxes('normal')}
    </>
  )

  const side = (
    <>
      {publishBox}
      {supports('thumbnail') && (
        <Postbox id="postimagediv" title="Featured image">
          <FeaturedImage initial={thumbnail} entryId={entry?.id} />
          <noscript>
            <p className="description">Choosing a featured image needs JavaScript.</p>
          </noscript>
        </Postbox>
      )}
      {taxonomyBoxes}
      {(type.hierarchical || supports('position')) && (
        <Postbox id="pageparentdiv" title={`${singular} Attributes`}>
          {type.hierarchical && (
            <p>
              <label htmlFor="parent">Parent</label>
              <select id="parent" name="parent" defaultValue={entry?.parentId ?? ''}>
                <option value="">(no parent)</option>
                {parents.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {'   '.repeat(parent.depth)}
                    {parent.title || '(no title)'}
                  </option>
                ))}
              </select>
            </p>
          )}
          {supports('position') && (
            <p>
              <label htmlFor="position">Order</label>
              <input
                type="number"
                id="position"
                name="position"
                step={1}
                className="small-text"
                defaultValue={entry?.position ?? 0}
              />
            </p>
          )}
        </Postbox>
      )}
      {boxes('side')}
    </>
  )

  return (
    <AdminScreen title={title} titleAction={addNew} flash={flash}>
      <form method="post" action={kernel.actionUrl('core', 'save-entry')} className="entry-form">
        <input type="hidden" name="type" value={type.name} />
        {entry && (
          <>
            <input type="hidden" name="id" value={entry.id} />
            <input type="hidden" name="updatedAt" value={entry.updatedAt.toISOString()} />
            {/* Where Move to Trash goes; saving ignores it. */}
            <input type="hidden" name="redirect" value={type.adminPath!} />
          </>
        )}
        <EditColumns main={main} side={side} />
      </form>
    </AdminScreen>
  )
}

/**
 * A taxonomy's box: a checklist of every term, indented as a tree, for hierarchical taxonomies
 * (WordPress's Categories box); a comma-separated field for flat ones (its Tags box), where a
 * name no tag has adds one. `taxonomies` tells the save which boxes the form had.
 */
function TaxonomyBox({
  taxonomy,
  current,
  choices,
  canManage,
}: {
  taxonomy: Taxonomy
  current: readonly Term[]
  choices: { terms: Term[]; depths?: number[] } | null
  canManage: boolean
}) {
  const id = `taxonomy-${taxonomy.name.replace('.', '-')}`
  const plural = inSentence(taxonomy.labels.plural)
  const checked = new Set(current.map((term) => term.id))
  return (
    <Postbox id={id} title={taxonomy.labels.plural}>
      <input type="hidden" name="taxonomies" value={taxonomy.name} />
      {choices ? (
        choices.terms.length > 0 ? (
          <ul className="categorychecklist" aria-label={taxonomy.labels.plural}>
            {choices.terms.map((term, i) => (
              <li
                key={term.id}
                style={{ marginInlineStart: `${(choices.depths?.[i] ?? 0) * 18}px` }}
              >
                <label>
                  <input
                    type="checkbox"
                    name={`terms.${taxonomy.name}`}
                    value={term.id}
                    defaultChecked={checked.has(term.id)}
                  />{' '}
                  {term.name}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="description">
            No {plural} yet.{' '}
            {canManage && taxonomy.adminPath && <a href={taxonomy.adminPath}>Add some</a>}
          </p>
        )
      ) : (
        <>
          <label className="screen-reader-text" htmlFor={`${id}-names`}>
            {taxonomy.labels.plural}
          </label>
          <input
            type="text"
            id={`${id}-names`}
            name={`tags.${taxonomy.name}`}
            defaultValue={current.map((term) => term.name).join(', ')}
            autoComplete="off"
          />
          <p className="howto description">Separate {plural} with commas</p>
        </>
      )}
    </Postbox>
  )
}
