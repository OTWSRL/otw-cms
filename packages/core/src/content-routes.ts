import type { ContentType, Taxonomy, Term } from '@otwdesign/sdk'

/** Paths the CMS's own routes and Next.js use: content can't live under them. */
const RESERVED = ['api', '_next', 'admin', 'uploads']
const SEGMENT = /^[a-z0-9][a-z0-9._~-]*$/i
const CORE = 'core'

/** Where one kind of content page lives: the static segments before the slug, if any. */
export interface SingleRoute {
  type: ContentType
  prefix: readonly string[]
}

export interface ArchiveRoute {
  type: ContentType
  path: readonly string[]
}

export interface TermRoute {
  taxonomy: Taxonomy
  prefix: readonly string[]
}

/** What a path might be, in the order to try: the first that finds content wins. */
export type RouteCandidate =
  | { kind: 'archive'; route: ArchiveRoute }
  | { kind: 'term'; route: TermRoute; slug: string }
  | { kind: 'single'; route: SingleRoute; path: readonly string[] }

function splitPath(pathname: string): string[] | null {
  try {
    return pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
  } catch {
    return null
  }
}

function samePrefix(prefix: readonly string[], parts: readonly string[]): boolean {
  return prefix.every((segment, i) => parts[i] === segment)
}

/**
 * A site's override of where content lives, from `routes` in cms.config.json: static segments,
 * then `:slug` for entries and terms, or nothing for archives.
 */
function parseOverride(key: string, pattern: string, withSlug: boolean): string[] {
  const parts = pattern.split('/').filter(Boolean)
  const statics = withSlug ? parts.slice(0, -1) : parts
  if (
    !pattern.startsWith('/') ||
    (withSlug && parts.at(-1) !== ':slug') ||
    statics.some((part) => !SEGMENT.test(part))
  ) {
    throw new Error(
      `Route "${key}" must be ${withSlug ? 'static segments then /:slug, as "/blog/:slug"' : 'a static path, as "/courses"'}, not "${pattern}"`,
    )
  }
  if (RESERVED.includes(statics[0] ?? '')) {
    throw new Error(`Route "${key}" cannot use reserved path "${pattern}"`)
  }
  return statics
}

/**
 * Where content lives on the site, as WordPress's rewrite rules have it: pages at their path,
 * posts at `/:slug` after pages ("Post name"), a plugin's type at `/{name}/:slug` and its archive
 * at `/{plural}`, a taxonomy's terms at `/{name}/:slug` (`/category/news`). A site moves any of
 * them with `routes` in cms.config.json, under `{type}.single`, `{type}.archive` and
 * `{taxonomy}.term`: `"core.post.single": "/blog/:slug"`. The suffix keeps them apart from a
 * plugin's own page routes, which may share a type's name.
 */
export class ContentRoutes {
  readonly singles: SingleRoute[] = []
  readonly archives: ArchiveRoute[] = []
  readonly terms: TermRoute[] = []

  constructor(input: {
    types: readonly ContentType[]
    taxonomies: readonly Taxonomy[]
    overrides: Readonly<Record<string, string>>
    /** Records which overrides were used, for the warning about unused ones. */
    used(key: string): void
  }) {
    const override = (key: string, withSlug: boolean, fallback: string[]) => {
      const pattern = input.overrides[key]
      if (pattern === undefined) return fallback
      input.used(key)
      return parseOverride(key, pattern, withSlug)
    }
    for (const type of input.types.filter((t) => t.public)) {
      const name = type.name.slice(type.pluginId.length + 1)
      // Core's posts and pages are at the top, as WordPress has them; a plugin's under its name.
      const prefix = type.pluginId === CORE ? [] : [name]
      this.singles.push({ type, prefix: override(`${type.name}.single`, true, prefix) })
      if (type.hasArchive) {
        this.archives.push({ type, path: override(`${type.name}.archive`, false, [type.plural]) })
      }
    }
    for (const taxonomy of input.taxonomies.filter((t) => t.public)) {
      const name = taxonomy.name.slice(taxonomy.pluginId.length + 1)
      this.terms.push({ taxonomy, prefix: override(`${taxonomy.name}.term`, true, [name]) })
    }
  }

  /**
   * What `pathname` might be, most specific first: archives, terms, entries under a prefix (the
   * longest first), then entries at the top, hierarchical ones (pages) before the rest (posts).
   */
  candidates(pathname: string): RouteCandidate[] {
    const parts = splitPath(pathname)
    if (!parts || parts.length === 0) return []
    const found: RouteCandidate[] = []
    for (const route of this.archives) {
      if (route.path.length === parts.length && samePrefix(route.path, parts)) {
        found.push({ kind: 'archive', route })
      }
    }
    for (const route of this.terms) {
      if (parts.length === route.prefix.length + 1 && samePrefix(route.prefix, parts)) {
        found.push({ kind: 'term', route, slug: parts.at(-1)! })
      }
    }
    const singles = [...this.singles].sort(
      (a, b) =>
        b.prefix.length - a.prefix.length ||
        Number(b.type.hierarchical) - Number(a.type.hierarchical),
    )
    for (const route of singles) {
      const rest = parts.slice(route.prefix.length)
      const fits = route.type.hierarchical ? rest.length >= 1 : rest.length === 1
      if (fits && samePrefix(route.prefix, parts)) found.push({ kind: 'single', route, path: rest })
    }
    return found
  }

  single(type: string): SingleRoute | undefined {
    return this.singles.find((route) => route.type.name === type)
  }

  archiveUrl(type: string): string | null {
    const route = this.archives.find((r) => r.type.name === type)
    return route ? join(route.path) : null
  }

  termUrl(term: Term): string | null {
    const route = this.terms.find((r) => r.taxonomy.name === term.taxonomy)
    return route ? join([...route.prefix, term.slug]) : null
  }

  /** An entry's address from its slugs: its own, or its ancestors' and its own for a page. */
  entryUrl(type: string, slugs: readonly string[]): string | null {
    const route = this.single(type)
    return route && slugs.length > 0 ? join([...route.prefix, ...slugs]) : null
  }
}

function join(parts: readonly string[]): string {
  return `/${parts.map(encodeURIComponent).join('/')}`
}
