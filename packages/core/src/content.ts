import { randomUUID } from 'node:crypto'
import type {
  Block,
  ContentApi,
  ContentType,
  Entry,
  EntryChanges,
  EntryFields,
  EntryList,
  EntryQuery,
  EntryStatus,
} from '@otwdesign/sdk'
import { ContentError } from '@otwdesign/sdk'
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lt,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm'
import { cleanBlocks } from './blocks'
import type { MetaStore } from './content-meta'
import type { ContentRoutes } from './content-routes'
import { permalinksOf } from './site-content'
import { inSentence, type ContentTypeStore } from './content-types'
import { entryTermsCondition, type createTermService } from './terms'
import { entries, media, revisions, users } from './core-schema'
import type { DatabaseContext } from './database'
import type { HookBus } from './hooks'
import { firstFreeSlug, slugify, slugStem } from './slugs'

/** `cms.content` without the registrations, which only plugins make, in setup. */
export type ContentService = Omit<ContentApi, 'type' | 'taxonomy' | 'meta' | 'template'>

export interface ContentServiceOptions {
  db: DatabaseContext
  types: ContentTypeStore
  hooks: HookBus
  terms: ReturnType<typeof createTermService>
  meta: MetaStore
  /** Where entries live on the site, once every plugin has set up, and the static homepage. */
  links: { routes(): ContentRoutes | null; frontPage(): string | null }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NIL_UUID = '00000000-0000-0000-0000-000000000000'
const STATUSES: readonly EntryStatus[] = ['draft', 'pending', 'published', 'private', 'trash']
const WRITABLE: readonly EntryStatus[] = ['draft', 'pending', 'published', 'private']
/** Published and private entries own their slugs, as `wp_unique_post_slug()` has it. */
const OWNS_SLUG: readonly EntryStatus[] = ['published', 'private']
const FIELDS: readonly (keyof EntryFields)[] = [
  'status',
  'slug',
  'title',
  'body',
  'excerpt',
  'authorId',
  'parentId',
  'position',
  'thumbnailId',
  'publishedAt',
  'meta',
]
const MAX_TITLE = 500
const MAX_EXCERPT = 10_000
const MAX_BODY_BYTES = 2_000_000
const MAX_POSITION = 2_147_483_647
const DEFAULT_LIMIT = 20
/** A Parent dropdown's entries, at most: far more than a dropdown is good for. */
const MAX_OUTLINE = 5_000
const MAX_LIMIT = 100
/** Two saves can pick the same free slug; the unique index stops the second, which tries again. */
const SLUG_ATTEMPTS = 5
const CLOCK_SKEW_MS = 60_000

/**
 * A changed entry's `updated_at`: now, but always at least a millisecond after the last change,
 * so it orders changes even when the clock steps back, and the edit screen's stale-save check,
 * which compares it to the millisecond, sees every change.
 */
const TOUCHED = sql`greatest(now(), ${entries.updatedAt} + interval '1 millisecond')`

const NEW_ENTRY: EntryFields = {
  status: 'draft',
  slug: '',
  title: '',
  body: [],
  excerpt: '',
  authorId: null,
  parentId: null,
  position: 0,
  thumbnailId: null,
  publishedAt: null,
  meta: {},
}

const SORTS = {
  date: sql`coalesce(${entries.publishedAt}, ${entries.createdAt})`,
  updated: sql`${entries.updatedAt}`,
  title: sql`lower(${entries.title})`,
  position: sql`${entries.position}`,
} as const

function invalid(message: string): never {
  throw new ContentError('invalid_input', message)
}

function notFound(): never {
  throw new ContentError('not_found', 'That entry no longer exists')
}

/**
 * Entries of every content type, in one table as WordPress keeps posts. Writes run in a
 * transaction with their hooks, so what a `content.saved` handler writes is kept or rolled back
 * with the entry.
 */
export function createContentService({
  db,
  types,
  hooks,
  terms,
  meta,
  links,
}: ContentServiceOptions): ContentService {
  /** An entry as callers see it: its type's custom field defaults under what it stores. */
  const present = (row: Entry): Entry => ({ ...row, meta: meta.withDefaults(row.type, row.meta) })
  const presentOrNull = (row: Entry | undefined): Entry | null => (row ? present(row) : null)

  const requireType = (name: string): ContentType => {
    const type = types.get(name)
    if (!type) {
      throw new ContentError(
        'unknown_type',
        `No active plugin registers the content type "${name}"`,
      )
    }
    return type
  }

  /** Locks the entry's row until the transaction ends, so two saves can't interleave. */
  const lock = async (id: string): Promise<Entry> => {
    if (!UUID.test(id)) notFound()
    const [row] = await db.current
      .select()
      .from(entries)
      .where(eq(entries.id, id))
      .for('update')
      .limit(1)
    return row ?? notFound()
  }

  /** The first free form of `base` among the published and private entries beside `parentId`. */
  const freeSlug = async (
    type: string,
    parentId: string | null,
    base: string,
    except: readonly string[],
  ): Promise<string> => {
    const rows = await db.current
      .select({ slug: entries.slug })
      .from(entries)
      .where(
        and(
          eq(entries.type, type),
          sql`coalesce(${entries.parentId}, ${NIL_UUID}::uuid) = coalesce(${parentId}::uuid, ${NIL_UUID}::uuid)`,
          inArray(entries.status, OWNS_SLUG),
          notInArray(entries.id, [...except]),
          // Slugs hold only letters, marks, digits and dashes, so nothing in the stem is a wildcard.
          sql`${entries.slug} LIKE ${`${slugStem(base)}%`}`,
        ),
      )
    return firstFreeSlug(base, new Set(rows.map((row) => row.slug)))
  }

  /**
   * The fields to save: `changes` over `base`, custom fields merged key by key. Then the
   * `content.entry` filter, and the same checks again on what it returned: filters are any
   * plugin's.
   */
  const prepare = async (
    type: ContentType,
    base: EntryFields,
    changes: EntryChanges | undefined,
    previous: Entry | null,
  ): Promise<EntryFields> => {
    const fields = cleanFields(merge(base, changes))
    fields.meta = meta.merge(type.name, base.meta, changes?.meta)
    const result = await hooks.applyFilters('content.entry', fields, {
      type: type.name,
      previous: previous && present(previous),
    })
    const checked = cleanFields(result)
    checked.meta = meta.check(type.name, result.meta, base.meta)
    return checked
  }

  /**
   * The author must exist; a featured image must be an image in the library, for a type that has
   * them; the parent must be an entry of the same type, and not a descendant.
   */
  const checkRelations = async (
    type: ContentType,
    id: string,
    fields: EntryFields,
    previous: Entry | null,
  ): Promise<void> => {
    if (fields.authorId !== null && fields.authorId !== previous?.authorId) {
      const [user] = await db.current
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, fields.authorId))
        .limit(1)
      if (!user) invalid('No user has that id')
    }
    if (fields.thumbnailId !== null && fields.thumbnailId !== previous?.thumbnailId) {
      if (!type.supports.includes('thumbnail')) {
        invalid(`${type.labels.plural} don't have featured images`)
      }
      const [image] = await db.current
        .select({ mimeType: media.mimeType })
        .from(media)
        .where(eq(media.id, fields.thumbnailId))
        .limit(1)
      if (!image) invalid('That image is no longer in the media library')
      if (!image.mimeType.startsWith('image/')) invalid('The featured image must be an image')
    }
    if (fields.parentId === null || fields.parentId === previous?.parentId) return
    if (!type.hierarchical) invalid(`${type.labels.plural} don't have parents`)
    if (fields.parentId === id) invalid('An entry cannot be its own parent')
    const [parent] = await db.current
      .select({ type: entries.type, status: entries.status })
      .from(entries)
      .where(eq(entries.id, fields.parentId))
      .limit(1)
    if (!parent) invalid('The parent entry no longer exists')
    if (parent.type !== type.name)
      invalid(`The parent must be another ${inSentence(type.labels.singular)}`)
    if (parent.status === 'trash') invalid('The parent entry is in the trash')
    if (previous && (await isAncestor(id, fields.parentId))) {
      invalid('The parent cannot be one of the entry’s own descendants')
    }
  }

  /** Whether `ancestor` is `id` or above it. UNION stops at a loop instead of following it. */
  const isAncestor = async (ancestor: string, id: string): Promise<boolean> => {
    const result = await db.current.execute(sql`
      WITH RECURSIVE line (id, parent_id) AS (
        SELECT id, parent_id FROM cms_entries WHERE id = ${id}
        UNION
        SELECT e.id, e.parent_id FROM cms_entries e JOIN line ON e.id = line.parent_id
      )
      SELECT 1 FROM line WHERE id = ${ancestor} LIMIT 1
    `)
    return rowsOf(result).length > 0
  }

  /** Inserts or updates the row, giving a published or private entry a slug of its own. */
  const write = async (
    type: ContentType,
    id: string,
    fields: EntryFields,
    previous: Entry | null,
  ): Promise<Entry> => {
    const owns = OWNS_SLUG.includes(fields.status)
    const fallback = `${type.name.slice(type.pluginId.length + 1)}-${id.slice(0, 8)}`
    const base = fields.slug || slugify(fields.title) || fallback
    for (let attempt = 1; ; attempt++) {
      const slug = owns ? await freeSlug(type.name, fields.parentId, base, [id]) : fields.slug
      const values = {
        ...fields,
        slug,
        publishedAt: fields.publishedAt ?? (owns ? sql`now()` : null),
      }
      try {
        // A savepoint, so a clash leaves the surrounding transaction usable for the retry.
        return await db.transaction(async (tx) => {
          const [row] = previous
            ? await tx
                .update(entries)
                .set({ ...values, updatedAt: TOUCHED })
                .where(eq(entries.id, id))
                .returning()
            : await tx
                .insert(entries)
                .values({ ...values, id, type: type.name })
                .returning()
          return row!
        })
      } catch (error) {
        if (owns && attempt < SLUG_ATTEMPTS && isUniqueViolation(error)) continue
        throw error
      }
    }
  }

  const announce = async (entry: Entry, previous: Entry | null): Promise<void> => {
    if (previous?.status !== entry.status) {
      await hooks.doAction('content.status', {
        entry,
        from: previous?.status ?? null,
        to: entry.status,
      })
    }
    await hooks.doAction('content.saved', { entry, previous })
  }

  /**
   * A page of one type's entries in tree order, as WordPress lists pages: every entry of the type
   * takes its place under its parent (an entry whose parent is gone starts a branch), siblings by
   * position, title and id; then the query's filters pick the rows. Two queries: the order and
   * depths, then the entries.
   */
  const listTree = async (
    type: string,
    where: SQL,
    limit: number,
    offset: number,
  ): Promise<EntryList> => {
    const result = await db.current.execute(sql`
      WITH RECURSIVE ranked AS (
        SELECT id, parent_id,
          row_number() OVER (PARTITION BY parent_id ORDER BY position, lower(title), id) AS rank
        FROM cms_entries WHERE type = ${type}
      ), tree AS (
        SELECT id, ARRAY[rank] AS path, ARRAY[id] AS line FROM ranked
          WHERE parent_id IS NULL OR parent_id NOT IN (SELECT id FROM ranked)
        UNION ALL
        SELECT r.id, t.path || r.rank, t.line || r.id FROM ranked r
          JOIN tree t ON r.parent_id = t.id WHERE NOT r.id = ANY (t.line)
      )
      SELECT tree.id, cardinality(tree.path) - 1 AS depth, count(*) OVER () AS total
      FROM tree JOIN cms_entries ON cms_entries.id = tree.id
      WHERE ${where}
      ORDER BY tree.path
      LIMIT ${limit} OFFSET ${offset}
    `)
    const page = rowsOf(result) as { id: string; depth: number | string; total: number | string }[]
    if (page.length === 0) {
      const [count] = await db.current
        .select({ total: sql<number>`count(*)`.mapWith(Number) })
        .from(entries)
        .where(where)
      return { entries: [], total: count?.total ?? 0, depths: [] }
    }
    const rows = await db.current
      .select()
      .from(entries)
      .where(
        inArray(
          entries.id,
          page.map((row) => row.id),
        ),
      )
    const byId = new Map(rows.map((row) => [row.id, row]))
    const shown = page.filter((row) => byId.has(row.id))
    return {
      entries: shown.map((row) => present(byId.get(row.id)!)),
      total: Number(page[0]!.total),
      depths: shown.map((row) => Number(row.depth)),
    }
  }

  /**
   * Gives a deleted entry's children its parent, as `wp_delete_post()` does, renaming any whose
   * slug is taken at that level.
   */
  const moveChildrenUp = async (entry: Entry): Promise<void> => {
    const children = await db.current
      .select()
      .from(entries)
      .where(eq(entries.parentId, entry.id))
      .orderBy(asc(entries.createdAt), asc(entries.id))
      .for('update')
    for (const child of children) {
      const slug = OWNS_SLUG.includes(child.status)
        ? await freeSlug(child.type, entry.parentId, child.slug, [child.id, entry.id])
        : child.slug
      await db.current
        .update(entries)
        .set({ parentId: entry.parentId, slug, updatedAt: TOUCHED })
        .where(eq(entries.id, child.id))
    }
  }

  /**
   * Keeps a revision of what an author wrote, when a save changed it (not for a status alone),
   * and lets go of the oldest beyond the type's number, in the save's transaction.
   */
  const saveRevision = async (
    type: ContentType,
    row: Entry,
    previous: Entry | null,
    by: string | null | undefined,
  ): Promise<void> => {
    if (type.revisions === 0) return
    const written = (entry: Entry) =>
      JSON.stringify([entry.title, entry.body, entry.excerpt, entry.meta])
    if (previous && written(previous) === written(row)) return
    if (by !== undefined && by !== null && (typeof by !== 'string' || !UUID.test(by))) {
      invalid('Who saved it must be given by user id')
    }
    await db.current.insert(revisions).values({
      entryId: row.id,
      authorId: by ?? null,
      title: row.title,
      body: row.body,
      excerpt: row.excerpt,
      meta: row.meta,
      // Distinct times for saves in one transaction, which now() would give the same.
      createdAt: sql`clock_timestamp()`,
    })
    await db.current.execute(sql`
      DELETE FROM cms_revisions WHERE entry_id = ${row.id} AND id NOT IN (
        SELECT id FROM cms_revisions WHERE entry_id = ${row.id}
        ORDER BY created_at DESC, id DESC LIMIT ${type.revisions}
      )
    `)
  }

  const service: ContentService = {
    ...terms.service,
    types: () => types.list(),
    getType: (name) => types.get(name),
    metaFields: (type) => meta.list(type),
    permalinks: (list) => permalinksOf(db, links.routes(), links.frontPage(), list),
    termUrl: (term) => links.routes()?.termUrl(term) ?? null,
    archiveUrl: (type) => links.routes()?.archiveUrl(type) ?? null,
    previewUrl: (entry) => `/?preview=${entry.id}`,

    async revisions(entryId, { limit = DEFAULT_LIMIT, offset = 0 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        invalid(`The limit must be 1 to ${MAX_LIMIT}`)
      }
      if (!Number.isSafeInteger(offset) || offset < 0) invalid('The offset must be 0 or more')
      if (!UUID.test(entryId)) return { revisions: [], total: 0 }
      const rows = await db.current
        .select({
          ...getTableColumns(revisions),
          total: sql<number>`count(*) over ()`.mapWith(Number),
        })
        .from(revisions)
        .where(eq(revisions.entryId, entryId))
        .orderBy(desc(revisions.createdAt), desc(revisions.id))
        .limit(limit)
        .offset(offset)
      return {
        revisions: rows.map(({ total: _total, ...revision }) => revision),
        total: rows[0]?.total ?? 0,
      }
    },

    async getRevision(id) {
      if (!UUID.test(id)) return null
      const [row] = await db.current.select().from(revisions).where(eq(revisions.id, id)).limit(1)
      return row ?? null
    },

    restoreRevision: (id, options) =>
      db.transaction(async () => {
        const revision = await service.getRevision(id)
        if (!revision) throw new ContentError('not_found', 'That revision no longer exists')
        const entry = await service.get(revision.entryId)
        if (!entry) notFound()
        // The custom fields the type has now, as the revision had them; unset ones go.
        const meta: Record<string, unknown> = {}
        for (const field of service.metaFields(entry.type)) {
          meta[field.key] = (revision.meta as Record<string, unknown>)[field.key] ?? null
        }
        return service.update(
          entry.id,
          { title: revision.title, body: revision.body, excerpt: revision.excerpt, meta },
          options,
        )
      }),

    create: (typeName, input, options) =>
      db.transaction(async () => {
        const type = requireType(typeName)
        const id = randomUUID()
        const fields = await prepare(type, NEW_ENTRY, input, null)
        await checkRelations(type, id, fields, null)
        const row = await write(type, id, fields, null)
        await saveRevision(type, row, null, options?.by)
        const entry = present(row)
        await terms.applyDefaultTerms(entry)
        await announce(entry, null)
        return entry
      }),

    update: (id, changes, options) =>
      db.transaction(async () => {
        const previous = await lock(id)
        if (previous.status === 'trash') invalid('Restore the entry from the trash to change it')
        const type = requireType(previous.type)
        const fields = await prepare(type, fieldsOf(previous), changes, previous)
        await checkRelations(type, previous.id, fields, previous)
        const row = await write(type, previous.id, fields, previous)
        await saveRevision(type, row, previous, options?.by)
        const entry = present(row)
        await terms.applyDefaultTerms(entry)
        await announce(entry, present(previous))
        return entry
      }),

    async get(id) {
      if (!UUID.test(id)) return null
      const [row] = await db.current.select().from(entries).where(eq(entries.id, id)).limit(1)
      return presentOrNull(row)
    },

    async getBySlug(type, slug, { parentId = null } = {}) {
      if (parentId !== null && !UUID.test(parentId)) return null
      const [row] = await db.current
        .select()
        .from(entries)
        .where(
          and(
            eq(entries.type, type),
            eq(entries.slug, slug),
            inArray(entries.status, OWNS_SLUG),
            parentId === null ? isNull(entries.parentId) : eq(entries.parentId, parentId),
          ),
        )
        .limit(1)
      return presentOrNull(row)
    },

    async outline(type, { exclude, limit = MAX_OUTLINE } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OUTLINE) {
        invalid(`The limit must be 1 to ${MAX_OUTLINE}`)
      }
      const skip = exclude !== undefined && UUID.test(exclude) ? exclude : null
      // listTree's order, without the trash, and never descending into the excluded entry.
      const result = await db.current.execute(sql`
        WITH RECURSIVE ranked AS (
          SELECT id, parent_id, title,
            row_number() OVER (PARTITION BY parent_id ORDER BY position, lower(title), id) AS rank
          FROM cms_entries WHERE type = ${type} AND status <> 'trash'
        ), tree AS (
          SELECT id, title, ARRAY[rank] AS path, ARRAY[id] AS line FROM ranked
            WHERE (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM ranked))
              AND id IS DISTINCT FROM ${skip}::uuid
          UNION ALL
          SELECT r.id, r.title, t.path || r.rank, t.line || r.id FROM ranked r
            JOIN tree t ON r.parent_id = t.id
            WHERE NOT r.id = ANY (t.line) AND r.id IS DISTINCT FROM ${skip}::uuid
        )
        SELECT id, title, cardinality(path) - 1 AS depth FROM tree ORDER BY path LIMIT ${limit}
      `)
      return (rowsOf(result) as { id: string; title: string; depth: number | string }[]).map(
        (row) => ({ id: row.id, title: row.title, depth: Number(row.depth) }),
      )
    },

    async list(query) {
      const { where, limit, offset, orderBy, tree } = listQuery(query)
      if (where === null)
        return tree ? { entries: [], total: 0, depths: [] } : { entries: [], total: 0 }
      if (tree) return listTree(tree, where, limit, offset)
      const rows = await db.current
        .select({
          ...getTableColumns(entries),
          total: sql<number>`count(*) over ()`.mapWith(Number),
        })
        .from(entries)
        .where(where)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset)
      if (rows.length === 0 && offset > 0) {
        const [count] = await db.current
          .select({ total: sql<number>`count(*)`.mapWith(Number) })
          .from(entries)
          .where(where)
        return { entries: [], total: count?.total ?? 0 }
      }
      return {
        entries: rows.map(({ total: _total, ...entry }) => present(entry)),
        total: rows[0]?.total ?? 0,
      } satisfies EntryList
    },

    async count(type, { authorId } = {}) {
      const counts = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
        EntryStatus,
        number
      >
      if (authorId !== undefined && !UUID.test(authorId)) return counts
      const rows = await db.current
        .select({ status: entries.status, count: sql<number>`count(*)`.mapWith(Number) })
        .from(entries)
        .where(
          and(
            eq(entries.type, type),
            authorId === undefined ? undefined : eq(entries.authorId, authorId),
          ),
        )
        .groupBy(entries.status)
      for (const row of rows) counts[row.status] = row.count
      return counts
    },

    async months(type, { status = WRITABLE } = {}) {
      checkStatuses(status)
      if (status.length === 0) return []
      // In UTC, as the list's date filter takes it, until the site has a time zone setting.
      const month = sql`date_trunc('month', ${SORTS.date} AT TIME ZONE 'UTC')`
      const rows = await db.current
        .selectDistinct({
          year: sql<number>`extract(year from ${month})`.mapWith(Number),
          month: sql<number>`extract(month from ${month})`.mapWith(Number),
        })
        .from(entries)
        .where(and(eq(entries.type, type), inArray(entries.status, [...status])))
      return rows.sort((a, b) => b.year - a.year || b.month - a.month)
    },

    trash: (id) =>
      db.transaction(async () => {
        const previous = await lock(id)
        if (previous.status === 'trash') return present(previous)
        const [row] = await db.current
          .update(entries)
          .set({
            status: 'trash',
            trashedFrom: previous.status,
            trashedAt: sql`now()`,
            updatedAt: TOUCHED,
          })
          .where(eq(entries.id, previous.id))
          .returning()
        const entry = present(row!)
        await announce(entry, present(previous))
        await hooks.doAction('content.trashed', { entry })
        return entry
      }),

    restore: (id) =>
      db.transaction(async () => {
        const previous = await lock(id)
        if (previous.status !== 'trash') return present(previous)
        const [row] = await db.current
          .update(entries)
          .set({ status: 'draft', trashedFrom: null, trashedAt: null, updatedAt: TOUCHED })
          .where(eq(entries.id, previous.id))
          .returning()
        const entry = present(row!)
        await announce(entry, present(previous))
        await hooks.doAction('content.restored', { entry })
        return entry
      }),

    delete: (id) =>
      db.transaction(async () => {
        const entry = await lock(id)
        await moveChildrenUp(entry)
        await db.current.delete(entries).where(eq(entries.id, entry.id))
        await hooks.doAction('content.deleted', { entry: present(entry) })
      }),
  }
  return service
}

function fieldsOf(entry: Entry): EntryFields {
  return Object.fromEntries(FIELDS.map((key) => [key, entry[key]])) as unknown as EntryFields
}

/** `changes` over `base`. Unknown fields are refused rather than dropped, so typos show. */
function merge(base: EntryFields, changes: EntryChanges | undefined): EntryFields {
  if (changes === undefined) return base
  if (typeof changes !== 'object' || changes === null)
    invalid('Pass the entry’s fields as an object')
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(changes)) {
    if (!(FIELDS as readonly string[]).includes(key)) invalid(`Unknown entry field "${key}"`)
    // Custom fields merge key by key, through the meta store.
    if (value !== undefined && key !== 'meta') merged[key] = value
  }
  return merged as unknown as EntryFields
}

/** Checks and tidies every field. Callers may be plain JavaScript, and filters any plugin's. */
export function cleanFields(fields: EntryFields): EntryFields {
  if (!WRITABLE.includes(fields.status)) {
    invalid(
      (fields.status as EntryStatus) === 'trash'
        ? 'Move entries to the trash with trash()'
        : `Unknown status "${String(fields.status)}"`,
    )
  }
  return {
    status: fields.status,
    slug: cleanSlug(fields.slug),
    title: cleanTitle(fields.title),
    body: cleanBody(fields.body),
    excerpt: cleanExcerpt(fields.excerpt),
    authorId: cleanId(fields.authorId, 'The author'),
    parentId: cleanId(fields.parentId, 'The parent'),
    position: cleanPosition(fields.position),
    thumbnailId: cleanId(fields.thumbnailId, 'The featured image'),
    publishedAt: cleanDate(fields.publishedAt),
    meta: fields.meta,
  }
}

function cleanSlug(slug: unknown): string {
  if (typeof slug !== 'string') invalid('The slug must be text')
  return slug === '' ? '' : slugify(slug)
}

/** One line: control characters, line breaks included, become spaces. */
function cleanTitle(title: unknown): string {
  if (typeof title !== 'string') invalid('The title must be text')
  const clean = title.replace(/\p{Cc}+/gu, ' ').trim()
  if (clean.length > MAX_TITLE) invalid(`Titles are limited to ${MAX_TITLE} characters`)
  return clean
}

/** Keeps line breaks and tabs; other control characters go. */
function cleanExcerpt(excerpt: unknown): string {
  if (typeof excerpt !== 'string') invalid('The excerpt must be text')
  const clean = excerpt.replace(/(?![\n\t])\p{Cc}/gu, '').trim()
  if (clean.length > MAX_EXCERPT) invalid(`Excerpts are limited to ${MAX_EXCERPT} characters`)
  return clean
}

/** Blocks the editor's schema allows, that survive JSON and Postgres's text: no NUL characters. */
function cleanBody(body: unknown): Block[] {
  if (!Array.isArray(body)) invalid('The body must be a list of blocks')
  let json: string
  try {
    json = JSON.stringify(body)
  } catch {
    invalid('The body must be plain data')
  }
  if (Buffer.byteLength(json) > MAX_BODY_BYTES) invalid('The body is too large')
  if (json.includes('\\u0000')) invalid('The body cannot contain NUL characters')
  return cleanBlocks(JSON.parse(json))
}

function cleanId(id: unknown, what: string): string | null {
  if (id === null) return null
  if (typeof id !== 'string' || !UUID.test(id)) invalid(`${what} must be given by id`)
  return id.toLowerCase()
}

function cleanPosition(position: unknown): number {
  if (!Number.isSafeInteger(position) || Math.abs(position as number) > MAX_POSITION) {
    invalid('The position must be a whole number')
  }
  return position as number
}

/** Backdating is fine; scheduling waits for the job queue that would publish on time. */
function cleanDate(date: unknown): Date | null {
  if (date === null) return null
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) invalid('Invalid publish date')
  if (date.getTime() > Date.now() + CLOCK_SKEW_MS)
    invalid('The publish date cannot be in the future')
  return date
}

/** The `WHERE`, page and order a query asks for; `where` is `null` when nothing can match. */
function checkStatuses(statuses: readonly EntryStatus[]): void {
  const unknown = statuses.filter((status) => !STATUSES.includes(status))
  if (unknown.length > 0) invalid(`Unknown status "${String(unknown[0])}"`)
}

/**
 * An entry's words, title, excerpt and the body's text: a column the database keeps from them
 * (migration core/0010_entry_search), indexed, and left out of the schema so entries never carry
 * it.
 */
const SEARCH_VECTOR = sql`"cms_entries"."search_vector"`
const MAX_SEARCH_LENGTH = 200

/**
 * Every word of the search must start a word of the title, the excerpt or the body's text:
 * `photo` finds "photography". Postgres splits the search as it split the entries, so
 * `example.com` and `ed@example` match as they were written, and the index finds them without
 * reading every entry, where WordPress's LIKE reads them all. A search with no words finds
 * nothing.
 */
function searchCondition(search: string): SQL | undefined {
  if (typeof search !== 'string') invalid('Search for text')
  const text = search.trim().slice(0, MAX_SEARCH_LENGTH)
  if (text === '') return undefined
  // Each word of the search, quoted, as a prefix: 'photo':* & 'ed@example':*.
  return sql`${SEARCH_VECTOR} @@ to_tsquery('simple', (SELECT string_agg(quote_literal(lexeme) || ':*', ' & ') FROM unnest(to_tsvector('simple', ${text}))))`
}

function dateBound(value: unknown, what: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) invalid(`${what} must be a date`)
  return value
}

function listQuery(query: EntryQuery) {
  const typeNames: readonly string[] = typeof query.type === 'string' ? [query.type] : query.type
  if (!Array.isArray(typeNames) || typeNames.length === 0) invalid('Name at least one content type')
  const statuses: readonly EntryStatus[] =
    query.status === undefined
      ? WRITABLE
      : typeof query.status === 'string'
        ? [query.status]
        : query.status
  checkStatuses(statuses)

  const limit = query.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    invalid(`The limit must be 1 to ${MAX_LIMIT}`)
  }
  const offset = query.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) invalid('The offset must be 0 or more')

  const orderBy = query.orderBy ?? 'date'
  if (orderBy !== 'tree' && !(orderBy in SORTS)) {
    invalid(`Cannot order entries by "${String(orderBy)}"`)
  }
  if (orderBy === 'tree' && typeNames.length !== 1) invalid('List one content type as a tree')
  const ascending =
    (query.order ?? (orderBy === 'title' || orderBy === 'position' ? 'asc' : 'desc')) === 'asc'
  const direction = ascending ? asc : desc

  const { authorId, parentId, search, after, before } = query
  if (query.ids !== undefined && !Array.isArray(query.ids)) invalid('ids must be a list')
  const byTerms = entryTermsCondition(query.terms)
  const ids = query.ids?.filter((id) => typeof id === 'string' && UUID.test(id))
  // Ids that can't exist match nothing, as a filter by a stale link would.
  const impossible =
    statuses.length === 0 ||
    (authorId !== undefined && !UUID.test(authorId)) ||
    (parentId !== undefined && parentId !== null && !UUID.test(parentId)) ||
    ids?.length === 0 ||
    byTerms === null
  const where = impossible
    ? null
    : and(
        inArray(entries.type, [...typeNames]),
        inArray(entries.status, [...statuses]),
        authorId === undefined ? undefined : eq(entries.authorId, authorId),
        parentId === undefined
          ? undefined
          : parentId === null
            ? isNull(entries.parentId)
            : eq(entries.parentId, parentId),
        ids === undefined ? undefined : inArray(entries.id, ids),
        metaCondition(query.meta),
        byTerms ?? undefined,
        search === undefined ? undefined : searchCondition(search),
        after === undefined ? undefined : gte(SORTS.date, dateBound(after, 'after')),
        before === undefined ? undefined : lt(SORTS.date, dateBound(before, 'before')),
      )!
  const sort = orderBy === 'tree' ? SORTS.date : SORTS[orderBy]
  return {
    where,
    limit,
    offset,
    orderBy: [direction(sort), direction(entries.id)],
    tree: orderBy === 'tree' ? typeNames[0]! : null,
  }
}

/** `meta` @> the values: jsonb containment, which the GIN index answers. */
function metaCondition(values: EntryQuery['meta']): SQL | undefined {
  if (values === undefined) return undefined
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    invalid('meta must be an object of custom field values')
  }
  return sql`cms_entries.meta @> ${JSON.stringify(values)}::jsonb`
}

/** A unique index refused the write, however the driver wraps the error. */
export function isUniqueViolation(error: unknown): boolean {
  for (let cause = error; cause instanceof Object; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: unknown }).code === '23505') return true
  }
  return false
}

/** node-postgres returns `{ rows }`; PGlite does too, but typed loosely. */
function rowsOf(result: unknown): unknown[] {
  return (result as { rows?: unknown[] }).rows ?? []
}
