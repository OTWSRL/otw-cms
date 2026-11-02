import type {
  ArchiveTemplateProps,
  CapabilityName,
  ContentType,
  ContentTypeName,
  Entry,
  EntryTemplateProps,
  MetaCapabilityName,
  SearchParams,
  Taxonomy,
  TaxonomyName,
  Term,
  User,
} from '@otw/sdk'
import { inArray, sql } from 'drizzle-orm'
import type { ContentService } from './content'
import type { ContentRoutes } from './content-routes'
import { entries as entriesTable } from './core-schema'
import type { DatabaseContext } from './database'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const POST = 'core.post'
const PAGE = 'core.page'
const DEFAULT_PER_PAGE = 10
/** Deeper than any real page tree; stops a loop the database somehow holds. */
const MAX_DEPTH = 50

/** The page's `<title>`, description, and whether search engines should skip it. */
export interface ContentMetadata {
  title?: string
  description?: string
  noindex: boolean
}

/** Content found at a path: which view, whose, the template's props and the page's metadata. */
export type ContentResolution =
  | { view: 'single'; name: string; props: EntryTemplateProps; metadata: ContentMetadata }
  | {
      view: 'archive' | 'term'
      name: string
      props: ArchiveTemplateProps
      metadata: ContentMetadata
    }

export interface SiteContentOptions {
  db: DatabaseContext
  content: ContentService
  /** Built once every plugin has set up; `null` before. */
  routes(): ContentRoutes | null
  can(user: User, capability: CapabilityName | MetaCapabilityName, ...args: unknown[]): boolean
  setting(key: string): string | undefined
  getUsers(ids: readonly string[]): Promise<User[]>
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Entries' addresses on the site, for a page of them at once. A page's path is its ancestors'
 * slugs and its own, from one recursive query; any ancestor that isn't published or private
 * leaves it without one, as its path wouldn't resolve. The static homepage is `/`.
 */
export async function permalinksOf(
  db: DatabaseContext,
  routes: ContentRoutes | null,
  frontPage: string | null,
  entries: readonly Entry[],
): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>(entries.map((entry) => [entry.id, null]))
  if (!routes) return found
  const live = (status: string) => status === 'published' || status === 'private'
  const nested: Entry[] = []
  for (const entry of entries) {
    const route = routes.single(entry.type)
    if (!route || !live(entry.status) || !entry.slug) continue
    if (entry.id === frontPage) found.set(entry.id, '/')
    else if (route.type.hierarchical && entry.parentId) nested.push(entry)
    else found.set(entry.id, routes.entryUrl(entry.type, [entry.slug]))
  }
  if (nested.length === 0) return found
  const result = (await db.current.execute(sql`
    WITH RECURSIVE line AS (
      SELECT id AS origin, parent_id, slug, status, 0 AS depth
        FROM cms_entries WHERE ${inArray(
          entriesTable.id,
          nested.map((entry) => entry.id),
        )}
      UNION ALL
      SELECT line.origin, e.parent_id, e.slug, e.status, line.depth + 1
        FROM cms_entries e JOIN line ON e.id = line.parent_id
        WHERE line.depth < ${MAX_DEPTH}
    )
    SELECT origin, slug, status FROM line ORDER BY origin, depth DESC
  `)) as { rows?: { origin: string; slug: string; status: string }[] }
  const lines = new Map<string, { slug: string; status: string }[]>()
  for (const row of result.rows ?? []) {
    lines.set(row.origin, [...(lines.get(row.origin) ?? []), row])
  }
  for (const entry of nested) {
    const line = lines.get(entry.id) ?? []
    const whole = line.every((step) => live(step.status) && step.slug)
    found.set(
      entry.id,
      whole
        ? routes.entryUrl(
            entry.type,
            line.map((step) => step.slug),
          )
        : null,
    )
  }
  return found
}

/**
 * What the site shows at a path, after plugins' routes: a preview, the homepage (latest posts or
 * a static page, as Settings › Reading says), a type's or term's archive, a page by its path,
 * then a post by its slug, as WordPress resolves them with "Post name" permalinks.
 */
export function createSiteContent(options: SiteContentOptions) {
  const { content, can } = options

  const readable = (type: ContentType, entry: Entry, user: User | null): boolean =>
    entry.status === 'published' ||
    (entry.status === 'private' && user !== null && can(user, type.capabilities.readEntry, entry))

  const perPage = () => {
    const value = Number(options.setting('reading.posts_per_page') ?? DEFAULT_PER_PAGE)
    return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : DEFAULT_PER_PAGE
  }

  /** The static homepage and posts page, when Settings › Reading has the homepage show a page. */
  const reading = () => {
    if (options.setting('reading.show_on_front') !== 'page') return { front: null, posts: null }
    const id = (key: string) => {
      const value = options.setting(key)
      return value && UUID.test(value) ? value.toLowerCase() : null
    }
    return { front: id('reading.page_on_front'), posts: id('reading.page_for_posts') }
  }

  const single = async (
    type: ContentType,
    entry: Entry,
    preview: boolean,
  ): Promise<ContentResolution> => {
    const routes = options.routes()
    const [links, terms, authors] = await Promise.all([
      content.permalinks([entry]),
      content.entryTerms([entry.id]),
      entry.authorId ? options.getUsers([entry.authorId]) : [],
    ])
    const publicTaxonomies = new Set<string>(
      content
        .taxonomies(type.name)
        .filter((taxonomy) => taxonomy.public)
        .map((taxonomy) => taxonomy.name),
    )
    // A visitor sees the author's name, never their email address.
    const author = authors[0]?.name ? { id: authors[0].id, name: authors[0].name } : null
    return {
      view: 'single',
      name: type.name,
      props: {
        entry,
        type,
        url: links.get(entry.id) ?? null,
        author,
        terms: (terms.get(entry.id) ?? []).filter((term) => publicTaxonomies.has(term.taxonomy)),
        termUrl: (term) => routes?.termUrl(term) ?? null,
        preview,
      },
      metadata: {
        title: entry.title || undefined,
        description: entry.excerpt || undefined,
        noindex: preview || entry.status !== 'published',
      },
    }
  }

  const list = async (
    view: 'archive' | 'term',
    name: string,
    input: {
      types: ContentTypeName[]
      type: ContentType
      title: string
      description: string
      taxonomy?: Taxonomy
      term?: Term
      pathname: string
      page: number
    },
  ): Promise<ContentResolution> => {
    const limit = perPage()
    const { entries, total } = await content.list({
      type: input.types,
      status: 'published',
      terms: input.term ? { [input.term.taxonomy as TaxonomyName]: [input.term.id] } : undefined,
      limit,
      offset: (input.page - 1) * limit,
    })
    const links = await content.permalinks(entries)
    return {
      view,
      name,
      props: {
        title: input.title,
        description: input.description,
        type: input.type,
        taxonomy: input.taxonomy ?? null,
        term: input.term ?? null,
        items: entries.map((entry) => ({ entry, url: links.get(entry.id) ?? null })),
        total,
        page: input.page,
        pages: Math.max(1, Math.ceil(total / limit)),
        pageUrl: (page) => (page > 1 ? `${input.pathname}?page=${page}` : input.pathname),
      },
      metadata: {
        title: input.title || undefined,
        description: input.description || undefined,
        noindex: false,
      },
    }
  }

  /** The latest posts: the homepage's, or the posts page's under its title. */
  const latestPosts = (pathname: string, page: number, title: string) => {
    const type = content.getType(POST)
    if (!type?.public) return null
    return list('archive', POST, {
      types: [POST as ContentTypeName],
      type,
      title,
      description: '',
      pathname,
      page,
    })
  }

  /** A page or other hierarchical entry by its path, parent by parent. */
  const byPath = async (type: ContentType, path: readonly string[]): Promise<Entry | null> => {
    let entry: Entry | null = null
    for (const slug of path) {
      entry = await content.getBySlug(type.name, slug, { parentId: entry?.id ?? null })
      if (!entry) return null
    }
    return entry
  }

  return async function resolveContent(
    pathname: string,
    searchParams: SearchParams,
    user: User | null,
  ): Promise<ContentResolution | null> {
    const pageParam = Number(first(searchParams.page) ?? 1)
    const page = Number.isSafeInteger(pageParam) && pageParam >= 1 ? pageParam : 1

    // WordPress's ?preview=true: the saved entry, for those who may read it, whatever its status.
    const preview = first(searchParams.preview)
    if (preview !== undefined) {
      const entry = await content.get(preview)
      const type = entry ? content.getType(entry.type) : undefined
      if (!entry || !type?.public || entry.status === 'trash') return null
      if (!user || !can(user, type.capabilities.readEntry, entry)) return null
      return single(type, entry, true)
    }

    const { front, posts } = reading()
    if (pathname === '/') {
      const pageType = content.getType(PAGE)
      const home = front ? await content.get(front) : null
      if (pageType && home?.type === PAGE && home.status === 'published') {
        return single(pageType, home, false)
      }
      return latestPosts('/', page, '')
    }

    for (const candidate of options.routes()?.candidates(pathname) ?? []) {
      if (candidate.kind === 'archive') {
        const { type } = candidate.route
        return list('archive', type.name, {
          types: [type.name],
          type,
          title: type.labels.plural,
          description: type.description,
          pathname,
          page,
        })
      }
      if (candidate.kind === 'term') {
        const { taxonomy } = candidate.route
        const term = await content.getTermBySlug(taxonomy.name, candidate.slug)
        const types = taxonomy.types.filter((name) => content.getType(name)?.public)
        const type = types.length > 0 ? content.getType(types[0]!) : undefined
        if (!term || !type) continue
        return list('term', taxonomy.name, {
          types,
          type,
          title: term.name,
          description: term.description,
          taxonomy,
          term,
          pathname,
          page,
        })
      }
      const { type } = candidate.route
      const entry = type.hierarchical
        ? await byPath(type, candidate.path)
        : await content.getBySlug(type.name, candidate.path[0]!)
      if (!entry || !readable(type, entry, user)) continue
      if (entry.id === posts) return latestPosts(pathname, page, entry.title)
      return single(type, entry, false)
    }
    return null
  }
}
