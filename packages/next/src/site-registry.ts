import type { Brand } from '@otw/core'
import type {
  AdminDefinition,
  ArchiveTemplateProps,
  EntryTemplateProps,
  PluginDefinition,
} from '@otw/sdk'
import type { ReactNode } from 'react'

type Template<P> = (props: P) => ReactNode | Promise<ReactNode>

/**
 * A site's own templates, from `src/cms/templates.tsx`, like a theme's: by view, then by content
 * type or taxonomy name, or `*` for every one. They win over plugins' templates and the defaults.
 */
export interface SiteTemplates {
  single?: Readonly<Record<string, Template<EntryTemplateProps>>>
  archive?: Readonly<Record<string, Template<ArchiveTemplateProps>>>
  term?: Readonly<Record<string, Template<ArchiveTemplateProps>>>
}

/** What a site gives the CMS. `cms generate` writes it to `src/cms/site.generated.ts`. */
export interface Site {
  /** The installed plugins, in `cms.config.json` order. */
  plugins: readonly PluginDefinition[]
  /**
   * The plugins' admin entries. Only the admin's site module, `src/cms/admin.generated.ts`, has
   * them: the admin and the API routes import it, the site's pages don't, so admin components
   * never reach visitors.
   */
  admin?: readonly AdminDefinition[]
  /** Each plugin's npm package, in the same order, for matching update checks to plugins. */
  packages?: readonly string[]
  /** New paths for plugin pages, by qualified name, from `cms.config.json`. */
  routes?: Readonly<Record<string, string>>
  /** The name the admin shows for the CMS, from `cms.config.json`. */
  brand?: Brand
  /** The site's own templates, when it has `src/cms/templates.tsx`. */
  templates?: SiteTemplates
}

// Module-scoped, not global: Next compiles server components and route handlers separately, and
// each must boot plugins compiled for its own bundle. Each bundle's routes import the site module,
// which registers it here.
let registered: Site | undefined

/** Registers the site for this bundle and returns it. Called by the generated site module. */
export function defineSite(site: Site): Site {
  registered = site
  return site
}

export function currentSite(): Site {
  if (!registered) {
    throw new Error(
      'No site is registered. Import src/cms/site.generated.ts (written by `cms generate`) in this route or its layout.',
    )
  }
  return registered
}
