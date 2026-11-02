import type {
  CapabilityName,
  ContentType,
  Taxonomy,
  TaxonomyName,
  Entry,
  EntryChanges,
  EntryFields,
  EntryStatus,
  MetaCapabilityName,
  User,
} from '@otw/sdk'
import { ActionError, ContentError, ForbiddenError } from '@otw/sdk'
import { safeRedirectPath, type InternalAction } from './admin'
import type { ContentService } from './content'
import type { ContentScreenStore } from './content-screens'
import { inSentence, type ContentTypeStore } from './content-types'
import { firstSpellings } from './terms'

export interface ContentActionDependencies {
  content: ContentService
  types: ContentTypeStore
  screens: ContentScreenStore
  can(user: User, capability: CapabilityName | MetaCapabilityName, ...args: unknown[]): boolean
  transaction<T>(fn: () => Promise<T>): Promise<T>
}

/** What the Publish box asks for: Save Draft (or Update), or Publish (or Submit for Review). */
export type SaveIntent = 'save' | 'publish'

const ALL_STATUSES: readonly EntryStatus[] = ['draft', 'pending', 'published', 'private', 'trash']
const MAX_BULK = 100
const PAGE = 100

export const STALE_MESSAGE =
  'This changed after you opened it, so your changes were not saved. The editor has kept them: restore them after the screen reloads, then save again.'

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

const isPublished = (status: EntryStatus | undefined) =>
  status === 'published' || status === 'private'

/**
 * The status a save asks for, as WordPress's Publish box sets it. Publish publishes, privately
 * when visibility says so; Save keeps a published entry published (or private) unless the status
 * dropdown changes it, and otherwise saves the dropdown's draft or pending.
 */
export function requestedStatus(input: {
  intent: SaveIntent
  status: string
  visibility: string
  previous: Entry | null
}): Exclude<EntryStatus, 'trash'> {
  const published = input.visibility === 'private' ? 'private' : 'published'
  if (input.intent === 'publish') return published
  if (input.status === 'published') return published
  if (input.status === 'draft' || input.status === 'pending') return input.status
  return isPublished(input.previous?.status) ? published : 'draft'
}

/** WordPress's messages after a save: "Post published.", "Post submitted.", and so on. */
export function savedNotice(type: ContentType, previous: Entry | null, entry: Entry): string {
  const name = type.labels.singular
  const changed = previous?.status !== entry.status
  if (entry.status === 'pending' && changed) return `${name} submitted.`
  if (entry.status === 'published' && changed) return `${name} published.`
  if (entry.status === 'private' && changed) return `${name} published privately.`
  if (entry.status === 'draft') return `${name} draft updated.`
  return `${name} updated.`
}

/** "1 post", "3 posts". */
function countOf(type: ContentType, count: number): string {
  return `${count} ${inSentence(count === 1 ? type.labels.singular : type.labels.plural)}`
}

function draftOf(type: ContentType, fields: EntryChanges, user: User): Entry {
  const now = new Date()
  return {
    id: '',
    type: type.name,
    status: 'draft',
    slug: '',
    title: '',
    body: [],
    excerpt: '',
    authorId: user.id,
    parentId: null,
    position: 0,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
    trashedFrom: null,
    trashedAt: null,
    ...(fields as Partial<EntryFields>),
  }
}

/** The content service's input errors are the user's to fix: they go back to the form. */
async function asActionError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof ContentError) throw new ActionError(error.message)
    throw error
  }
}

/**
 * The content screens' form actions: save from the edit screen, trash, restore and delete one
 * entry, and the list's bulk actions. Each checks the type's meta capabilities against the
 * entries themselves, as WordPress's post.php and edit.php do, whatever the form offered.
 */
export function contentActions(deps: ContentActionDependencies): InternalAction[] {
  const { content, can } = deps

  /** A type with screens, named by the form. */
  const screenType = (name: string): ContentType => {
    const type = deps.types.get(name)
    if (!type?.adminPath) throw new ActionError('That content type is not available.')
    return type
  }

  const entryOf = async (id: string): Promise<{ entry: Entry; type: ContentType }> => {
    const entry = await content.get(id)
    const type = entry ? deps.types.get(entry.type) : undefined
    if (!entry || !type) throw new ActionError('That entry no longer exists.')
    return { entry, type }
  }

  /** The form's changes to the entry's fields, for what the type supports. */
  const changesFrom = (form: FormData, type: ContentType): EntryChanges => {
    const changes: EntryChanges = { title: field(form, 'title'), slug: field(form, 'slug') }
    if (form.has('body')) {
      try {
        changes.body = JSON.parse(field(form, 'body')) as EntryFields['body']
      } catch {
        throw new ActionError('The content could not be read. Reload the screen and try again.')
      }
    }
    if (type.supports.includes('excerpt') && form.has('excerpt')) {
      changes.excerpt = field(form, 'excerpt')
    }
    if (type.hierarchical && form.has('parent')) changes.parentId = field(form, 'parent') || null
    if (type.supports.includes('position') && form.has('position')) {
      const position = Number(field(form, 'position') || 0)
      if (!Number.isSafeInteger(position))
        throw new ActionError('The order must be a whole number.')
      changes.position = position
    }
    return changes
  }

  const save: InternalAction = {
    name: 'save-entry',
    capability: 'core.access_admin',
    handler: ({ form, user: signedIn }) => {
      const user = signedIn!
      const type = screenType(field(form, 'type'))
      const caps = type.capabilities
      const id = field(form, 'id')
      return deps.transaction(async () => {
        const previous = id ? await content.get(id) : null
        if (id && previous?.type !== type.name) {
          throw new ActionError(`That ${inSentence(type.labels.singular)} no longer exists.`)
        }
        if (previous) {
          if (!can(user, caps.editEntry, previous)) throw new ForbiddenError()
          if (previous.status === 'trash') {
            throw new ActionError(
              `This ${inSentence(type.labels.singular)} is in the Trash. Restore it to edit it.`,
            )
          }
          if (field(form, 'updatedAt') !== previous.updatedAt.toISOString()) {
            throw new ActionError(STALE_MESSAGE)
          }
        } else if (!can(user, caps.edit)) {
          throw new ForbiddenError()
        }

        const changes = changesFrom(form, type)
        const author = previous ? previous.authorId : user.id
        changes.authorId = form.has('author') ? field(form, 'author') || null : author
        if (changes.authorId !== author && !can(user, caps.editOthers)) throw new ForbiddenError()

        let status = requestedStatus({
          intent: field(form, 'intent') === 'publish' ? 'publish' : 'save',
          status: field(form, 'status'),
          visibility: field(form, 'visibility'),
          previous,
        })
        // Publishing, or switching between public and private, takes the publish capability;
        // without it, Publish submits for review, as in WordPress.
        if (isPublished(status) && status !== previous?.status) {
          const candidate = { ...(previous ?? draftOf(type, changes, user)), ...changes, status }
          if (!can(user, caps.publishEntry, candidate)) status = 'pending'
        }
        changes.status = status

        const entry = await asActionError(() =>
          previous ? content.update(previous.id, changes) : content.create(type.name, changes),
        )
        await saveTerms(entry, type, form, user)
        for (const box of deps.screens.for(type.name).metaBoxes) {
          await box.save?.({ entry, form, user })
        }
        return {
          redirect: `${type.adminPath}/${entry.id}`,
          notice: savedNotice(type, previous, entry),
        }
      })
    },
  }

  /**
   * The taxonomy boxes' choices: ticked ids for hierarchical taxonomies, comma-separated names for
   * flat ones, as WordPress's category checklist and tags box send them. Only the boxes the form
   * had (named in `taxonomies`), each needing the taxonomy's `assign_`.
   */
  const saveTerms = async (entry: Entry, type: ContentType, form: FormData, user: User) => {
    const shown = new Set(form.getAll('taxonomies').filter((name) => typeof name === 'string'))
    for (const taxonomy of content.taxonomies(type.name)) {
      if (!shown.has(taxonomy.name) || !taxonomy.showUi) continue
      if (!can(user, taxonomy.capabilities.assign)) throw new ForbiddenError()
      const terms = taxonomy.hierarchical
        ? { ids: form.getAll(`terms.${taxonomy.name}`).filter((id) => typeof id === 'string') }
        : { names: tagNames(field(form, `tags.${taxonomy.name}`)) }
      await asActionError(() => content.setEntryTerms(entry.id, taxonomy.name, terms))
    }
  }

  /** A taxonomy with a screen, named by the form. */
  const screenTaxonomy = (name: string): Taxonomy => {
    const taxonomy = content.getTaxonomy(name)
    if (!taxonomy?.adminPath) throw new ActionError('That taxonomy is not available.')
    return taxonomy
  }

  const termOf = async (id: string) => {
    const term = await content.getTerm(id)
    const taxonomy = term ? content.getTaxonomy(term.taxonomy) : undefined
    if (!term || !taxonomy) throw new ActionError('That term no longer exists.')
    return { term, taxonomy }
  }

  const termForms: InternalAction[] = [
    {
      name: 'create-term',
      capability: 'core.access_admin',
      async handler({ form, user }) {
        const taxonomy = screenTaxonomy(field(form, 'taxonomy'))
        const caps = taxonomy.capabilities
        if (!can(user!, caps.manage) || !can(user!, caps.edit)) throw new ForbiddenError()
        await asActionError(() =>
          content.createTerm(taxonomy.name as TaxonomyName, {
            name: field(form, 'name'),
            slug: field(form, 'slug'),
            description: field(form, 'description'),
            parentId: field(form, 'parent') || null,
          }),
        )
        return { notice: `${taxonomy.labels.singular} added.` }
      },
    },
    {
      name: 'update-term',
      capability: 'core.access_admin',
      async handler({ form, user }) {
        const { term, taxonomy } = await termOf(field(form, 'id'))
        if (!can(user!, taxonomy.capabilities.editTerm, term)) throw new ForbiddenError()
        await asActionError(() =>
          content.updateTerm(term.id, {
            name: field(form, 'name'),
            slug: field(form, 'slug'),
            description: field(form, 'description'),
            ...(taxonomy.hierarchical ? { parentId: field(form, 'parent') || null } : {}),
          }),
        )
        return { notice: `${taxonomy.labels.singular} updated.` }
      },
    },
    {
      name: 'delete-term',
      capability: 'core.access_admin',
      async handler({ form, user }) {
        const { term, taxonomy } = await termOf(field(form, 'id'))
        if (!can(user!, taxonomy.capabilities.deleteTerm, term)) throw new ForbiddenError()
        await asActionError(() => content.deleteTerm(term.id))
        return {
          redirect: safeRedirectPath(field(form, 'redirect')) ?? undefined,
          notice: `${taxonomy.labels.singular} deleted.`,
        }
      },
    },
    {
      name: 'bulk-terms',
      capability: 'core.access_admin',
      async handler({ form, user }) {
        const taxonomy = screenTaxonomy(field(form, 'taxonomy'))
        if (!can(user!, taxonomy.capabilities.manage)) throw new ForbiddenError()
        if (field(form, 'bulk') !== 'delete') throw new ActionError('Choose a bulk action.')
        const ids = form.getAll('ids').filter((id): id is string => typeof id === 'string')
        const plural = inSentence(taxonomy.labels.plural)
        if (ids.length === 0) throw new ActionError(`Select the ${plural} to delete.`)
        if (ids.length > MAX_BULK) throw new ActionError(`Change at most ${MAX_BULK} at a time.`)
        const { terms } = await content.listTerms({
          taxonomy: taxonomy.name as TaxonomyName,
          ids,
          limit: MAX_BULK,
        })
        let deleted = 0
        await deps.transaction(async () => {
          for (const term of terms) {
            if (!can(user!, taxonomy.capabilities.deleteTerm, term)) continue
            await asActionError(() => content.deleteTerm(term.id))
            deleted++
          }
        })
        const skipped = ids.length - deleted
        const noun = inSentence(deleted === 1 ? taxonomy.labels.singular : taxonomy.labels.plural)
        return { notice: `${deleted} ${noun} deleted.${skippedNote(skipped)}` }
      },
    },
  ]

  const single = (
    name: string,
    run: (entry: Entry) => Promise<unknown>,
    done: (type: ContentType) => string,
  ): InternalAction => ({
    name,
    capability: 'core.access_admin',
    async handler({ form, user }) {
      const { entry, type } = await entryOf(field(form, 'id'))
      if (!can(user!, type.capabilities.deleteEntry, entry)) throw new ForbiddenError()
      await run(entry)
      return {
        redirect: safeRedirectPath(field(form, 'redirect')) ?? undefined,
        notice: done(type),
      }
    },
  })

  /** Deletes the type's trashed entries this user may delete, a page at a time. */
  const emptyTrash = async (type: ContentType, user: User): Promise<string> => {
    let deleted = 0
    let skipped = 0
    for (;;) {
      const { entries } = await content.list({
        type: type.name,
        status: 'trash',
        limit: PAGE,
        offset: skipped,
        orderBy: 'updated',
        order: 'asc',
      })
      if (entries.length === 0) break
      for (const entry of entries) {
        if (can(user, type.capabilities.deleteEntry, entry)) {
          await content.delete(entry.id)
          deleted++
        } else {
          skipped++
        }
      }
    }
    return `${countOf(type, deleted)} permanently deleted.${skippedNote(skipped)}`
  }

  const bulk: InternalAction = {
    name: 'bulk-entries',
    capability: 'core.access_admin',
    async handler({ form, user: signedIn }) {
      const user = signedIn!
      const type = screenType(field(form, 'type'))
      // Empty Trash is a button beside the Bulk actions dropdown, which posts a choice too.
      if (form.getAll('bulk').includes('empty-trash')) {
        return { notice: await emptyTrash(type, user) }
      }
      const choice = field(form, 'bulk')
      if (!choice) throw new ActionError('Choose a bulk action.')
      const ids = form.getAll('ids').filter((id): id is string => typeof id === 'string')
      if (ids.length === 0) {
        throw new ActionError(`Select the ${inSentence(type.labels.plural)} to change.`)
      }
      if (ids.length > MAX_BULK) throw new ActionError(`Change at most ${MAX_BULK} at a time.`)
      const { entries } = await content.list({
        type: type.name,
        ids,
        status: ALL_STATUSES,
        limit: MAX_BULK,
      })

      const plugin = deps.screens.for(type.name).bulkActions.find((action) => action.key === choice)
      if (plugin) {
        if (!can(user, plugin.capability)) throw new ForbiddenError()
        return {
          notice: await deps.transaction(async () => plugin.handler({ entries, type, user })),
        }
      }

      const core = CORE_BULK[choice]
      if (!core) throw new ActionError('Choose a bulk action.')
      let done = 0
      let skipped = ids.length - entries.length
      await deps.transaction(async () => {
        for (const entry of entries) {
          if (!core.applies(entry) || !can(user, type.capabilities.deleteEntry, entry)) {
            skipped++
            continue
          }
          await core.run(content, entry)
          done++
        }
      })
      return { notice: `${countOf(type, done)} ${core.done}.${skippedNote(skipped)}` }
    },
  }

  return [
    save,
    ...termForms,
    single(
      'trash-entry',
      (entry) => content.trash(entry.id),
      (type) => `${countOf(type, 1)} moved to the Trash.`,
    ),
    single(
      'restore-entry',
      (entry) => content.restore(entry.id),
      (type) => `${countOf(type, 1)} restored from the Trash.`,
    ),
    single(
      'delete-entry',
      (entry) => content.delete(entry.id),
      (type) => `${countOf(type, 1)} permanently deleted.`,
    ),
    bulk,
  ]
}

/** WordPress's bulk actions: Move to Trash; Restore and Delete Permanently in the Trash. */
const CORE_BULK: Readonly<
  Record<
    string,
    {
      applies(entry: Entry): boolean
      run(content: ContentService, entry: Entry): Promise<unknown>
      done: string
    }
  >
> = {
  trash: {
    applies: (entry) => entry.status !== 'trash',
    run: (content, entry) => content.trash(entry.id),
    done: 'moved to the Trash',
  },
  restore: {
    applies: (entry) => entry.status === 'trash',
    run: (content, entry) => content.restore(entry.id),
    done: 'restored from the Trash',
  },
  delete: {
    applies: (entry) => entry.status === 'trash',
    run: (content, entry) => content.delete(entry.id),
    done: 'permanently deleted',
  },
}

/** "news, Local Events ,, news" → ["news", "Local Events"]: as WordPress splits a tags field. */
export function tagNames(value: string): string[] {
  return firstSpellings(
    value
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  )
}

function skippedNote(skipped: number): string {
  return skipped === 0
    ? ''
    : ` ${skipped} skipped: you may not change ${skipped === 1 ? 'it' : 'them'}, or ${skipped === 1 ? 'it is' : 'they are'} gone.`
}
