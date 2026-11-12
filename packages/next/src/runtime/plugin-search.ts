import { PLUGIN_KEYWORD } from '@otwdesign/core'

/** A plugin as npm's search lists it. */
export interface FoundPlugin {
  /** The npm package, such as `@acme/forum`. */
  name: string
  /** Its newest version. */
  version: string
  description: string
  /** Who published it on npm. */
  publisher: string | null
  /** When that version was published, ISO 8601. */
  date: string | null
  /** Its page on npm. */
  url: string
}

const SEARCH = 'https://registry.npmjs.org/-/v1/search'
const RESULTS = 24
const TIMEOUT_MS = 8_000
export const MAX_QUERY = 100

interface NpmSearch {
  objects?: {
    package?: {
      name?: unknown
      version?: unknown
      description?: unknown
      keywords?: unknown
      date?: unknown
      publisher?: { username?: unknown }
    }
  }[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Plugins on npm, which is the directory: packages tagged with the plugin keyword, narrowed by
 * what was typed. Only npm's public registry is searched; a private plugin is added by its name.
 */
export async function searchPlugins(
  query: string,
  fetchImpl: typeof fetch = fetch,
  // A registry of your own that has npm's search, such as a mirror: CMS_PLUGIN_SEARCH_URL.
  endpoint: string = process.env.CMS_PLUGIN_SEARCH_URL || SEARCH,
): Promise<FoundPlugin[]> {
  const words = query.trim().slice(0, MAX_QUERY)
  const url = `${endpoint}?${new URLSearchParams({
    text: `keywords:${PLUGIN_KEYWORD}${words ? ` ${words}` : ''}`,
    size: String(RESULTS),
  })}`
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `npm couldn’t be reached: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    )
  }
  if (!response.ok) throw new Error(`npm’s search answered ${response.status}.`)
  const { objects = [] } = (await response.json()) as NpmSearch
  return objects.flatMap(({ package: found }) => {
    const name = text(found?.name)
    const keywords = Array.isArray(found?.keywords) ? found.keywords : []
    // The keyword qualifier narrows the search, but what comes back is checked: only packages
    // that say they are plugins are offered.
    if (!name || !keywords.includes(PLUGIN_KEYWORD)) return []
    return [
      {
        name,
        version: text(found?.version),
        description: text(found?.description),
        publisher: text(found?.publisher?.username) || null,
        date: text(found?.date) || null,
        url: `https://www.npmjs.com/package/${name}`,
      },
    ]
  })
}
