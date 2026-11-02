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
} from '@otw/sdk'
import { ContentError } from '@otw/sdk'
import { and, asc, desc, eq, getTableColumns, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import { inSentence, type ContentTypeStore } from './content-types'
import { entries, users } from './core-schema'
import type { DatabaseContext } from './database'
import type { HookBus } from './hooks'
import { firstFreeSlug, slugify, slugStem } from './slugs'

/** `cms.content` without `type()`, which only plugins call, in setup. */
export type ContentService = Omit<ContentApi, 'type'>

export interface ContentServiceOptions {
  db: DatabaseContext
  types: ContentTypeStore
  hooks: HookBus
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
  'publishedAt',
]
const MAX_TITLE = 500
const MAX_EXCERPT = 10_000
const MAX_BODY_BYTES = 2_000_000
const MAX_POSITION = 2_147_483_647
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
/** Two saves can pick the same free slug; the unique index stops the second, which tries again. */
const SLUG_ATTEMPTS = 5
const CLOCK_SKEW_MS = 60_000

const NEW_ENTRY: EntryFields = {
  status: 'draft',
  slug: '',
  title: '',
  body: [],
  excerpt: '',
  authorId: null,
  parentId: null,
  position: 0,
  publishedAt: null,
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
export function createContentService({ db, types, hooks }: ContentServiceOptions): ContentService {
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

  /** Runs the `content.entry` filter, then checks what it returned: the filters are any plugin's. */
  const filtered = async (
    type: ContentType,
    fields: EntryFields,
    previous: Entry | null,
  ): Promise<EntryFields> =>
    cleanFields(await hooks.applyFilters('content.entry', fields, { type: type.name, previous }))

  /** The author must exist; the parent must be an entry of the same type, and not a descendant. */
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
                .set({ ...values, updatedAt: sql`now()` })
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
        .set({ parentId: entry.parentId, slug, updatedAt: sql`now()` })
        .where(eq(entries.id, child.id))
    }
  }

  return {
    types: () => types.list(),
    getType: (name) => types.get(name),

    create: (typeName, input) =>
      db.transaction(async () => {
        const type = requireType(typeName)
        const id = randomUUID()
        const fields = await filtered(type, cleanFields(merge(NEW_ENTRY, input)), null)
        await checkRelations(type, id, fields, null)
        const entry = await write(type, id, fields, null)
        await announce(entry, null)
        return entry
      }),

    update: (id, changes) =>
      db.transaction(async () => {
        const previous = await lock(id)
        if (previous.status === 'trash') invalid('Restore the entry from the trash to change it')
        const type = requireType(previous.type)
        const fields = await filtered(
          type,
          cleanFields(merge(fieldsOf(previous), changes)),
          previous,
        )
        await checkRelations(type, previous.id, fields, previous)
        const entry = await write(type, previous.id, fields, previous)
        await announce(entry, previous)
        return entry
      }),

    async get(id) {
      if (!UUID.test(id)) return null
      const [row] = await db.current.select().from(entries).where(eq(entries.id, id)).limit(1)
      return row ?? null
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
      return row ?? null
    },

    async list(query) {
      const { where, limit, offset, orderBy } = listQuery(query)
      if (where === null) return { entries: [], total: 0 }
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
        entries: rows.map(({ total: _total, ...entry }) => entry),
        total: rows[0]?.total ?? 0,
      } satisfies EntryList
    },

    trash: (id) =>
      db.transaction(async () => {
        const previous = await lock(id)
        if (previous.status === 'trash') return previous
        const [entry] = await db.current
          .update(entries)
          .set({
            status: 'trash',
            trashedFrom: previous.status,
            trashedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(entries.id, previous.id))
          .returning()
        await announce(entry!, previous)
        await hooks.doAction('content.trashed', { entry: entry! })
        return entry!
      }),

    restore: (id) =>
      db.transaction(async () => {
        const previous = await lock(id)
        if (previous.status !== 'trash') return previous
        const [entry] = await db.current
          .update(entries)
          .set({ status: 'draft', trashedFrom: null, trashedAt: null, updatedAt: sql`now()` })
          .where(eq(entries.id, previous.id))
          .returning()
        await announce(entry!, previous)
        await hooks.doAction('content.restored', { entry: entry! })
        return entry!
      }),

    delete: (id) =>
      db.transaction(async () => {
        const entry = await lock(id)
        await moveChildrenUp(entry)
        await db.current.delete(entries).where(eq(entries.id, entry.id))
        await hooks.doAction('content.deleted', { entry })
      }),
  }
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
    if (value !== undefined) merged[key] = value
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
    publishedAt: cleanDate(fields.publishedAt),
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

/** A list of blocks that survives JSON, and Postgres's: no NUL characters. */
function cleanBody(body: unknown): Block[] {
  if (!Array.isArray(body)) invalid('The body must be a list of blocks')
  for (const block of body) {
    const type: unknown = (block as Partial<Block> | null)?.type
    if (typeof block !== 'object' || Array.isArray(block) || typeof type !== 'string' || !type) {
      invalid('Every block in the body needs a type')
    }
  }
  let json: string
  try {
    json = JSON.stringify(body)
  } catch {
    invalid('The body must be plain data')
  }
  if (Buffer.byteLength(json) > MAX_BODY_BYTES) invalid('The body is too large')
  if (json.includes('\\u0000')) invalid('The body cannot contain NUL characters')
  return JSON.parse(json) as Block[]
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
function listQuery(query: EntryQuery) {
  const typeNames: readonly string[] = typeof query.type === 'string' ? [query.type] : query.type
  if (!Array.isArray(typeNames) || typeNames.length === 0) invalid('Name at least one content type')
  const statuses: readonly EntryStatus[] =
    query.status === undefined
      ? WRITABLE
      : typeof query.status === 'string'
        ? [query.status]
        : query.status
  const unknown = statuses.filter((status) => !STATUSES.includes(status))
  if (unknown.length > 0) invalid(`Unknown status "${String(unknown[0])}"`)

  const limit = query.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    invalid(`The limit must be 1 to ${MAX_LIMIT}`)
  }
  const offset = query.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) invalid('The offset must be 0 or more')

  const orderBy = query.orderBy ?? 'date'
  if (!(orderBy in SORTS)) invalid(`Cannot order entries by "${String(orderBy)}"`)
  const ascending =
    (query.order ?? (orderBy === 'title' || orderBy === 'position' ? 'asc' : 'desc')) === 'asc'
  const direction = ascending ? asc : desc

  const { authorId, parentId } = query
  // Ids that can't exist match nothing, as a filter by a stale link would.
  const impossible =
    statuses.length === 0 ||
    (authorId !== undefined && !UUID.test(authorId)) ||
    (parentId !== undefined && parentId !== null && !UUID.test(parentId))
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
      )!
  return { where, limit, offset, orderBy: [direction(SORTS[orderBy]), direction(entries.id)] }
}

function isUniqueViolation(error: unknown): boolean {
  for (let cause = error; cause instanceof Object; cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: unknown }).code === '23505') return true
  }
  return false
}

/** node-postgres returns `{ rows }`; PGlite does too, but typed loosely. */
function rowsOf(result: unknown): unknown[] {
  return (result as { rows?: unknown[] }).rows ?? []
}
