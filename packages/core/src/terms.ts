import { randomUUID } from 'node:crypto'
import type { ContentApi, Entry, EntryQuery, Taxonomy, Term, TermList } from '@otw/sdk'
import { ContentError } from '@otw/sdk'
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { inSentence } from './content-types'
import { entries, entryTerms, terms } from './core-schema'
import type { DatabaseContext } from './database'
import type { HookBus } from './hooks'
import { firstFreeSlug, slugify, slugStem } from './slugs'
import { isDefaultTerm, type TaxonomyStore } from './taxonomies'

/** The term half of `cms.content`, without `taxonomy()`, which plugins call in setup. */
export type TermService = Pick<
  ContentApi,
  | 'taxonomies'
  | 'getTaxonomy'
  | 'createTerm'
  | 'updateTerm'
  | 'deleteTerm'
  | 'getTerm'
  | 'getTermBySlug'
  | 'listTerms'
  | 'entryTerms'
  | 'setEntryTerms'
>

export interface TermServiceOptions {
  db: DatabaseContext
  taxonomies: TaxonomyStore
  hooks: HookBus
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NAME = 200
const MAX_DESCRIPTION = 2000
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const MAX_ASSIGNED = 200
const SLUG_ATTEMPTS = 5

/**
 * Published entries with the term, as WordPress counts them (`_update_post_term_count`). The
 * outer table is named in full: Drizzle leaves a lone table's columns unqualified, and inside
 * this subquery a bare `id` would be the entry's.
 */
const COUNT = sql<number>`(
  SELECT count(*) FROM cms_entry_terms et JOIN cms_entries e ON e.id = et.entry_id
  WHERE et.term_id = cms_terms.id AND e.status = 'published'
)`.mapWith(Number)

function invalid(message: string): never {
  throw new ContentError('invalid_input', message)
}

function notFound(): never {
  throw new ContentError('not_found', 'That term no longer exists')
}

/** The constraint a unique violation broke, from the error or its causes. */
function uniqueViolation(error: unknown): string | null {
  for (let cause = error; cause instanceof Object; cause = (cause as { cause?: unknown }).cause) {
    const { code, constraint } = cause as { code?: unknown; constraint?: unknown }
    if (code === '23505') return typeof constraint === 'string' ? constraint : ''
  }
  return null
}

function cleanName(name: unknown, what: string): string {
  if (typeof name !== 'string') invalid(`The ${what}'s name must be text`)
  const clean = name.replace(/\p{Cc}+/gu, ' ').trim()
  if (clean === '') invalid(`The ${what} needs a name`)
  if (clean.length > MAX_NAME) invalid(`Names are limited to ${MAX_NAME} characters`)
  return clean
}

function cleanDescription(description: unknown): string {
  if (typeof description !== 'string') invalid('The description must be text')
  const clean = description.replace(/(?![\n\t])\p{Cc}/gu, '').trim()
  if (clean.length > MAX_DESCRIPTION) {
    invalid(`Descriptions are limited to ${MAX_DESCRIPTION} characters`)
  }
  return clean
}

/** `%`, `_` and `\` match themselves in a LIKE pattern. */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

/**
 * Terms and which entries have them, in two tables as WordPress keeps them. Counts are computed
 * when a list asks, not stored, so they never drift and saving an entry costs nothing more.
 */
export function createTermService({ db, taxonomies, hooks }: TermServiceOptions) {
  const requireTaxonomy = (name: string): Taxonomy => {
    const taxonomy = taxonomies.get(name)
    if (!taxonomy) {
      throw new ContentError('unknown_type', `No active plugin registers the taxonomy "${name}"`)
    }
    return taxonomy
  }

  const lock = async (id: string): Promise<Term> => {
    if (!UUID.test(id)) notFound()
    const [row] = await db.current
      .select()
      .from(terms)
      .where(eq(terms.id, id))
      .for('update')
      .limit(1)
    return row ?? notFound()
  }

  const freeSlug = async (taxonomy: string, base: string, except: string): Promise<string> => {
    const rows = await db.current
      .select({ slug: terms.slug })
      .from(terms)
      .where(
        and(
          eq(terms.taxonomy, taxonomy),
          ne(terms.id, except),
          sql`${terms.slug} LIKE ${`${slugStem(base)}%`}`,
        ),
      )
    return firstFreeSlug(base, new Set(rows.map((row) => row.slug)))
  }

  /** Whether `ancestor` is `id` or above it. UNION stops at a loop instead of following it. */
  const isAncestor = async (ancestor: string, id: string): Promise<boolean> => {
    const result = (await db.current.execute(sql`
      WITH RECURSIVE line (id, parent_id) AS (
        SELECT id, parent_id FROM cms_terms WHERE id = ${id}
        UNION
        SELECT t.id, t.parent_id FROM cms_terms t JOIN line ON t.id = line.parent_id
      )
      SELECT 1 FROM line WHERE id = ${ancestor} LIMIT 1
    `)) as { rows?: unknown[] }
    return (result.rows ?? []).length > 0
  }

  const checkParent = async (taxonomy: Taxonomy, id: string, parentId: unknown) => {
    if (parentId === null || parentId === undefined) return null
    if (typeof parentId !== 'string' || !UUID.test(parentId))
      invalid('The parent must be given by id')
    const what = inSentence(taxonomy.labels.singular)
    if (!taxonomy.hierarchical) invalid(`${taxonomy.labels.plural} don't have parents`)
    if (parentId === id) invalid(`A ${what} cannot be its own parent`)
    const [parent] = await db.current
      .select({ taxonomy: terms.taxonomy })
      .from(terms)
      .where(eq(terms.id, parentId))
      .limit(1)
    if (parent?.taxonomy !== taxonomy.name) invalid(`The parent must be another ${what}`)
    if (await isAncestor(id, parentId))
      invalid(`The parent cannot be one of the ${what}'s own children`)
    return parentId.toLowerCase()
  }

  /**
   * Writes the term, numbering its slug if another term of the taxonomy has it. A name a sibling
   * already has is refused, as WordPress refuses it.
   */
  const write = async (
    taxonomy: Taxonomy,
    id: string,
    values: { name: string; slug: string; description: string; parentId: string | null },
    previous: Term | null,
  ): Promise<Term> => {
    const fallback = `${taxonomy.name.slice(taxonomy.pluginId.length + 1)}-${id.slice(0, 8)}`
    const base = values.slug || slugify(values.name) || fallback
    for (let attempt = 1; ; attempt++) {
      const slug = await freeSlug(taxonomy.name, base, id)
      try {
        return await db.transaction(async (tx) => {
          const [row] = previous
            ? await tx
                .update(terms)
                .set({ ...values, slug, updatedAt: sql`now()` })
                .where(eq(terms.id, id))
                .returning()
            : await tx
                .insert(terms)
                .values({ ...values, slug, id, taxonomy: taxonomy.name })
                .returning()
          return row!
        })
      } catch (error) {
        const constraint = uniqueViolation(error)
        if (constraint === 'cms_terms_name_key') {
          invalid(
            `A ${inSentence(taxonomy.labels.singular)} called “${values.name}” is already there`,
          )
        }
        if (constraint !== null && attempt < SLUG_ATTEMPTS) continue
        throw error
      }
    }
  }

  /** The default term, created the first time it's needed. Safe when two saves need it at once. */
  const defaultTermOf = async (taxonomy: Taxonomy): Promise<Term | null> => {
    const wanted = taxonomy.defaultTerm
    if (!wanted) return null
    await db.current
      .insert(terms)
      .values({ taxonomy: taxonomy.name, ...wanted })
      .onConflictDoNothing()
    const [row] = await db.current
      .select()
      .from(terms)
      .where(and(eq(terms.taxonomy, taxonomy.name), eq(terms.slug, wanted.slug)))
      .limit(1)
    return row ?? null
  }

  const termsOfEntry = async (entryId: string, taxonomy: string): Promise<Term[]> =>
    db.current
      .select(getTableColumns(terms))
      .from(entryTerms)
      .innerJoin(terms, eq(terms.id, entryTerms.termId))
      .where(and(eq(entryTerms.entryId, entryId), eq(terms.taxonomy, taxonomy)))
      .orderBy(asc(sql`lower(${terms.name})`), asc(terms.id))

  /** Term ids for `names`, adding those no term of the taxonomy has, as WordPress does. */
  const idsForNames = async (taxonomy: Taxonomy, names: readonly unknown[]): Promise<string[]> => {
    const what = inSentence(taxonomy.labels.singular)
    const clean = firstSpellings(names.map((name) => cleanName(name, what)))
    if (clean.length === 0) return []
    const existing = await db.current
      .select({ id: terms.id, name: terms.name })
      .from(terms)
      .where(
        and(
          eq(terms.taxonomy, taxonomy.name),
          inArray(
            sql`lower(${terms.name})`,
            clean.map((name) => name.toLowerCase()),
          ),
        ),
      )
      .orderBy(sql`${terms.parentId} IS NOT NULL`, asc(terms.createdAt))
    const byName = new Map<string, string>()
    for (const row of existing) {
      if (!byName.has(row.name.toLowerCase())) byName.set(row.name.toLowerCase(), row.id)
    }
    const ids: string[] = []
    for (const name of clean) {
      ids.push(
        byName.get(name.toLowerCase()) ?? (await service.createTerm(taxonomy.name, { name })).id,
      )
    }
    return ids
  }

  const service = {
    taxonomies: (type?: string) => taxonomies.list(type),
    getTaxonomy: (name: string) => taxonomies.get(name),

    createTerm: (taxonomyName, input) =>
      db.transaction(async () => {
        const taxonomy = requireTaxonomy(taxonomyName)
        if (typeof input !== 'object' || input === null) invalid('Pass the term as an object')
        const id = randomUUID()
        const what = inSentence(taxonomy.labels.singular)
        const term = await write(
          taxonomy,
          id,
          {
            name: cleanName(input.name, what),
            slug: typeof input.slug === 'string' && input.slug ? slugify(input.slug) : '',
            description: cleanDescription(input.description ?? ''),
            parentId: await checkParent(taxonomy, id, input.parentId),
          },
          null,
        )
        await hooks.doAction('content.term.saved', { term, previous: null })
        return term
      }),

    updateTerm: (id, changes) =>
      db.transaction(async () => {
        const previous = await lock(id)
        const taxonomy = requireTaxonomy(previous.taxonomy)
        if (typeof changes !== 'object' || changes === null)
          invalid('Pass the changes as an object')
        const what = inSentence(taxonomy.labels.singular)
        const slug =
          changes.slug === undefined
            ? previous.slug
            : typeof changes.slug === 'string'
              ? slugify(changes.slug)
              : invalid('The slug must be text')
        if (isDefaultTerm(taxonomy, previous) && slug !== previous.slug) {
          invalid(`The default ${what} keeps its slug; rename it instead`)
        }
        const term = await write(
          taxonomy,
          previous.id,
          {
            name: changes.name === undefined ? previous.name : cleanName(changes.name, what),
            slug,
            description:
              changes.description === undefined
                ? previous.description
                : cleanDescription(changes.description),
            parentId:
              changes.parentId === undefined
                ? previous.parentId
                : await checkParent(taxonomy, previous.id, changes.parentId),
          },
          previous,
        )
        await hooks.doAction('content.term.saved', { term, previous })
        return term
      }),

    deleteTerm: (id) =>
      db.transaction(async () => {
        const term = await lock(id)
        const taxonomy = taxonomies.get(term.taxonomy)
        const what = inSentence(taxonomy?.labels.singular ?? 'term')
        if (taxonomy && isDefaultTerm(taxonomy, term)) {
          invalid(`The default ${what} cannot be deleted`)
        }
        // Its children take its place, as wp_delete_term() moves them.
        try {
          await db.transaction((tx) =>
            tx
              .update(terms)
              .set({ parentId: term.parentId, updatedAt: sql`now()` })
              .where(eq(terms.parentId, term.id)),
          )
        } catch (error) {
          if (uniqueViolation(error) === 'cms_terms_name_key') {
            invalid(
              `One of its children has the name of a ${what} where they would move; rename it first`,
            )
          }
          throw error
        }
        // Entries this leaves with no term of the taxonomy get the default one.
        const fallback = taxonomy ? await defaultTermOf(taxonomy) : null
        if (fallback) {
          await db.current.execute(sql`
            INSERT INTO cms_entry_terms (entry_id, term_id)
            SELECT et.entry_id, ${fallback.id}::uuid FROM cms_entry_terms et
            WHERE et.term_id = ${term.id}
              AND NOT EXISTS (
                SELECT 1 FROM cms_entry_terms other JOIN cms_terms t ON t.id = other.term_id
                WHERE other.entry_id = et.entry_id AND t.taxonomy = ${term.taxonomy}
                  AND other.term_id <> ${term.id}
              )
            ON CONFLICT DO NOTHING
          `)
        }
        await db.current.delete(terms).where(eq(terms.id, term.id))
        await hooks.doAction('content.term.deleted', { term })
      }),

    async getTerm(id) {
      if (!UUID.test(id)) return null
      const [row] = await db.current.select().from(terms).where(eq(terms.id, id)).limit(1)
      return row ?? null
    },

    async getTermBySlug(taxonomy, slug) {
      const [row] = await db.current
        .select()
        .from(terms)
        .where(and(eq(terms.taxonomy, taxonomy), eq(terms.slug, slug)))
        .limit(1)
      return row ?? null
    },

    async listTerms(query) {
      const limit = query.limit ?? DEFAULT_LIMIT
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        invalid(`The limit must be 1 to ${MAX_LIMIT}`)
      }
      const offset = query.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) invalid('The offset must be 0 or more')
      const orderBy = query.orderBy ?? 'name'
      if (!['name', 'count', 'tree'].includes(orderBy)) {
        invalid(`Cannot order terms by "${String(orderBy)}"`)
      }
      const { parentId, ids, search } = query
      const validIds = ids?.filter((id) => typeof id === 'string' && UUID.test(id))
      if (
        (parentId !== undefined && parentId !== null && !UUID.test(parentId)) ||
        validIds?.length === 0
      ) {
        return { terms: [], counts: [], total: 0, ...(orderBy === 'tree' ? { depths: [] } : {}) }
      }
      const words = typeof search === 'string' ? search.trim().split(/\s+/).filter(Boolean) : []
      const where = and(
        eq(terms.taxonomy, query.taxonomy),
        parentId === undefined
          ? undefined
          : parentId === null
            ? isNull(terms.parentId)
            : eq(terms.parentId, parentId),
        validIds === undefined ? undefined : inArray(terms.id, validIds),
        ...words.map((word) =>
          or(
            ilike(terms.name, likeTerm(word)),
            ilike(terms.slug, likeTerm(word)),
            ilike(terms.description, likeTerm(word)),
          ),
        ),
        query.hideEmpty ? sql`${COUNT} > 0` : undefined,
      )!
      if (orderBy === 'tree') return listTree(query.taxonomy, where, limit, offset)
      const direction =
        (query.order ?? (orderBy === 'count' ? 'desc' : 'asc')) === 'asc' ? asc : desc
      const rows = await db.current
        .select({
          ...getTableColumns(terms),
          count: COUNT,
          total: sql<number>`count(*) over ()`.mapWith(Number),
        })
        .from(terms)
        .where(where)
        .orderBy(
          orderBy === 'count' ? direction(COUNT) : direction(sql`lower(${terms.name})`),
          direction(terms.id),
        )
        .limit(limit)
        .offset(offset)
      return {
        terms: rows.map(({ count: _count, total: _total, ...term }) => term),
        counts: rows.map((row) => row.count),
        total: rows[0]?.total ?? (offset > 0 ? await countWhere(where) : 0),
      } satisfies TermList
    },

    async entryTerms(entryIds, taxonomy) {
      const ids = [...new Set(entryIds)].filter((id) => typeof id === 'string' && UUID.test(id))
      const found = new Map<string, Term[]>(ids.map((id) => [id, []]))
      if (ids.length === 0) return found
      const rows = await db.current
        .select({ entryId: entryTerms.entryId, term: getTableColumns(terms) })
        .from(entryTerms)
        .innerJoin(terms, eq(terms.id, entryTerms.termId))
        .where(
          and(
            inArray(entryTerms.entryId, ids),
            taxonomy === undefined ? undefined : eq(terms.taxonomy, taxonomy),
          ),
        )
        .orderBy(asc(sql`lower(${terms.name})`), asc(terms.id))
      for (const { entryId, term } of rows) found.get(entryId)!.push(term)
      return found
    },

    setEntryTerms: (entryId, taxonomyName, input) =>
      db.transaction(async () => {
        const taxonomy = requireTaxonomy(taxonomyName)
        if (!UUID.test(entryId)) throw new ContentError('not_found', 'That entry no longer exists')
        const [entry] = await db.current
          .select({ id: entries.id, type: entries.type })
          .from(entries)
          .where(eq(entries.id, entryId))
          .limit(1)
        if (!entry) throw new ContentError('not_found', 'That entry no longer exists')
        if (!taxonomy.types.includes(entry.type as never)) {
          invalid(`${taxonomy.labels.plural} don't classify that entry's type`)
        }
        const givenIds = input?.ids ?? []
        const names = input?.names ?? []
        if (!Array.isArray(givenIds) || !Array.isArray(names))
          invalid('Pass ids and names as lists')
        if (givenIds.length + names.length > MAX_ASSIGNED) {
          invalid(`An entry can have at most ${MAX_ASSIGNED} terms of a taxonomy`)
        }
        const ids = [...new Set(givenIds.map((id) => String(id).toLowerCase()))]
        if (ids.some((id) => !UUID.test(id))) invalid('Terms must be given by id')
        if (ids.length > 0) {
          const known = await db.current
            .select({ id: terms.id })
            .from(terms)
            .where(and(inArray(terms.id, ids), eq(terms.taxonomy, taxonomy.name)))
          if (known.length !== ids.length) {
            invalid(`Unknown ${inSentence(taxonomy.labels.singular)}`)
          }
        }
        const wanted = new Set([...ids, ...(await idsForNames(taxonomy, names))])
        if (wanted.size === 0) {
          const fallback = await defaultTermOf(taxonomy)
          if (fallback) wanted.add(fallback.id)
        }
        const previous = await termsOfEntry(entry.id, taxonomy.name)
        const removed = previous.filter((term) => !wanted.has(term.id)).map((term) => term.id)
        if (removed.length > 0) {
          await db.current
            .delete(entryTerms)
            .where(and(eq(entryTerms.entryId, entry.id), inArray(entryTerms.termId, removed)))
        }
        if (wanted.size > 0) {
          await db.current
            .insert(entryTerms)
            .values([...wanted].map((termId) => ({ entryId: entry.id, termId })))
            .onConflictDoNothing()
        }
        const current = await termsOfEntry(entry.id, taxonomy.name)
        await hooks.doAction('content.entry.terms', {
          entryId: entry.id,
          taxonomy: taxonomy.name,
          terms: current,
          previous,
        })
        return current
      }),
  } satisfies TermService

  const countWhere = async (where: SQL): Promise<number> => {
    const [row] = await db.current
      .select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(terms)
      .where(where)
    return row?.total ?? 0
  }

  /** As entries' tree: every term of the taxonomy under its parent, then the filters pick rows. */
  const listTree = async (
    taxonomy: string,
    where: SQL,
    limit: number,
    offset: number,
  ): Promise<TermList> => {
    const result = (await db.current.execute(sql`
      WITH RECURSIVE ranked AS (
        SELECT id, parent_id,
          row_number() OVER (PARTITION BY parent_id ORDER BY lower(name), id) AS rank
        FROM cms_terms WHERE taxonomy = ${taxonomy}
      ), tree AS (
        SELECT id, ARRAY[rank] AS path, ARRAY[id] AS line FROM ranked
          WHERE parent_id IS NULL OR parent_id NOT IN (SELECT id FROM ranked)
        UNION ALL
        SELECT r.id, t.path || r.rank, t.line || r.id FROM ranked r
          JOIN tree t ON r.parent_id = t.id WHERE NOT r.id = ANY (t.line)
      )
      SELECT tree.id, cardinality(tree.path) - 1 AS depth, count(*) OVER () AS total
      FROM tree JOIN cms_terms ON cms_terms.id = tree.id
      WHERE ${where}
      ORDER BY tree.path
      LIMIT ${limit} OFFSET ${offset}
    `)) as { rows?: { id: string; depth: number | string; total: number | string }[] }
    const page = result.rows ?? []
    if (page.length === 0)
      return { terms: [], counts: [], total: await countWhere(where), depths: [] }
    const rows = await db.current
      .select({ ...getTableColumns(terms), count: COUNT })
      .from(terms)
      .where(
        inArray(
          terms.id,
          page.map((row) => row.id),
        ),
      )
    const byId = new Map(rows.map(({ count, ...term }) => [term.id, { term, count }]))
    const shown = page.filter((row) => byId.has(row.id))
    return {
      terms: shown.map((row) => byId.get(row.id)!.term),
      counts: shown.map((row) => byId.get(row.id)!.count),
      total: Number(page[0]!.total),
      depths: shown.map((row) => Number(row.depth)),
    }
  }

  /**
   * Gives an entry the default term of each of its type's taxonomies it has none of, as
   * `wp_insert_post()` does for categories. Runs in the entry's save.
   */
  const applyDefaultTerms = async (entry: Pick<Entry, 'id' | 'type'>): Promise<void> => {
    for (const taxonomy of taxonomies.list(entry.type)) {
      if (!taxonomy.defaultTerm) continue
      const [has] = await db.current
        .select({ id: entryTerms.termId })
        .from(entryTerms)
        .innerJoin(terms, eq(terms.id, entryTerms.termId))
        .where(and(eq(entryTerms.entryId, entry.id), eq(terms.taxonomy, taxonomy.name)))
        .limit(1)
      if (has) continue
      const fallback = await defaultTermOf(taxonomy)
      if (fallback) {
        await db.current
          .insert(entryTerms)
          .values({ entryId: entry.id, termId: fallback.id })
          .onConflictDoNothing()
      }
    }
  }

  return { service, applyDefaultTerms }
}

/** Names once each, ignoring case, in the first spelling given: "Summer, summer" → "Summer". */
export function firstSpellings(names: readonly string[]): string[] {
  const seen = new Map<string, string>()
  for (const name of names) if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name)
  return [...seen.values()]
}

/**
 * The `terms` filter of an entry query, like a `tax_query`: per taxonomy, entries with any of
 * the terms or their descendants. `null` when no id is valid, so nothing can match.
 */
export function entryTermsCondition(filter: EntryQuery['terms']): SQL | undefined | null {
  if (filter === undefined) return undefined
  if (typeof filter !== 'object' || filter === null) invalid('terms must name taxonomies')
  const conditions: SQL[] = []
  for (const [taxonomy, ids] of Object.entries(filter)) {
    if (!Array.isArray(ids)) invalid(`terms.${taxonomy} must be a list of term ids`)
    const valid = (ids as unknown[]).filter(
      (id): id is string => typeof id === 'string' && UUID.test(id),
    )
    if (valid.length === 0) return null
    conditions.push(sql`EXISTS (
      SELECT 1 FROM cms_entry_terms et WHERE et.entry_id = cms_entries.id AND et.term_id IN (
        WITH RECURSIVE wanted (id) AS (
          SELECT id FROM cms_terms
            WHERE taxonomy = ${taxonomy} AND id IN (${sql.join(
              valid.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
          UNION
          SELECT t.id FROM cms_terms t JOIN wanted ON t.parent_id = wanted.id
        )
        SELECT id FROM wanted
      )
    )`)
  }
  return conditions.length === 0 ? undefined : and(...conditions)!
}
