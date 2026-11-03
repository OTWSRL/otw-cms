import type { Brand } from '@otwdesign/core'
import type {
  AdminDefinition,
  AccountTemplateProps,
  ArchiveTemplateProps,
  EntryTemplateProps,
  PluginDefinition,
} from '@otwdesign/sdk'
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
  /** The account pages, every view (`props.view` says which). */
  account?: Template<AccountTemplateProps>
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
  /**
   * The site's own templates, when it has `src/cms/templates.tsx`. `cms generate` gives a function
   * that imports them, so the module stays importable outside Next.js (scripts, tests): templates
   * render with the kernel, which only runs inside it.
   */
  templates?: SiteTemplates | (() => Promise<{ default: SiteTemplates }>)
}

// Module-scoped, not global: Next compiles server components and route handlers separately, and
// each must boot plugins compiled for its own bundle. Each bundle's routes import a site module,
// which registers it here. One bundle can have both: the site's pages and the admin share this
// module, and each registers its part, the site's templates or the admin's entries, which the
// other's must not overwrite.
let pages: Site | undefined
let admin: Site | undefined
let latest: Site | undefined
let combined: Site | undefined

/** Registers a site module for this bundle and returns it. Called by the generated modules. */
export function defineSite(site: Site): Site {
  if (site.admin) admin = site
  else pages = site
  latest = site
  combined = undefined
  return site
}

/**
 * The site: the plugins and settings the last registered module gave (a dev reload's newest), the
 * admin module's entries, and the site module's templates. The same object until a module
 * registers again, so the kernel booted for it is reused.
 */
export function currentSite(): Site {
  if (!latest) {
    throw new Error(
      'No site is registered. Import src/cms/site.generated.ts (written by `cms generate`) in this route or its layout.',
    )
  }
  combined ??=
    pages && admin
      ? { ...latest, admin: admin.admin, templates: pages.templates ?? admin.templates }
      : latest
  return combined
}

/** The site's own templates, for its pages, imported on first use when the module gives them so. */
export async function siteTemplates(): Promise<SiteTemplates | undefined> {
  const { templates } = currentSite()
  return typeof templates === 'function' ? (await templates()).default : templates
}
