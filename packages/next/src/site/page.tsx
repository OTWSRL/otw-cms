import type { ContentResolution } from '@otw/core'
import type { SearchParams } from '@otw/sdk'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { currentSite } from '../site-registry'
import { getKernel } from '../runtime/kernel'
import { getCurrentUser } from '../runtime/session'
import { ArchiveTemplate, EntryTemplate } from './templates'
import {
  parseSearchParams,
  pathnameFromSegments,
  serializeSearchParams,
} from '../runtime/search-params'

/** What Next.js passes the storefront's routes: the path's segments and the query string. */
export interface SiteRouteProps {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<SearchParams>
}

// generateMetadata and the page both need the page; cache() runs the plugin's loader once.
const loadPage = cache(async (pathname: string, query: string) => {
  const kernel = await getKernel()
  return kernel.resolvePage(pathname, parseSearchParams(query))
})

// The viewer matters here: previews and private entries are theirs to see.
const loadContent = cache(async (pathname: string, query: string) => {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
  return kernel.resolveContent(pathname, parseSearchParams(query), user)
})

/**
 * What the path shows: a plugin's page, then content (a page, a post, an archive), as WordPress
 * lets plugins' rewrite rules come first. A preview link is for content wherever it points.
 */
async function resolve({ params, searchParams }: SiteRouteProps) {
  const { slug } = await params
  const pathname = pathnameFromSegments(slug)
  const query = await searchParams
  const serialized = serializeSearchParams(query)
  const preview = query.preview !== undefined
  const page = preview ? null : await loadPage(pathname, serialized)
  return { slug, preview, page, content: page ? null : await loadContent(pathname, serialized) }
}

/** The page's title and description, from the plugin page or the content at this path. */
export async function generateSiteMetadata(props: SiteRouteProps): Promise<Metadata> {
  const { page, content } = await resolve(props)
  if (page) return page.metadata()
  if (!content) return {}
  const { title, description, noindex } = content.metadata
  return { title, description, robots: noindex ? { index: false, follow: false } : undefined }
}

/** Every site URL: a plugin's page, the content there, or the default home page. */
export async function SitePage(props: SiteRouteProps) {
  const { slug, preview, page, content } = await resolve(props)
  if (page) {
    const { Component, props: pageProps } = page
    return <Component {...pageProps} />
  }
  if (content) return <Content resolution={content} />
  // A preview this viewer may not see is a 404, wherever it points, not the home page.
  if (!slug?.length && !preview) return <DefaultHome />
  notFound()
}

/**
 * The content in its template: the site's own (`src/cms/templates.tsx`), else a plugin's, else
 * the default, as a theme's templates win over a plugin's in WordPress.
 */
async function Content({ resolution }: { resolution: ContentResolution }) {
  const kernel = await getKernel()
  const own = currentSite().templates
  if (resolution.view === 'single') {
    const Template =
      own?.single?.[resolution.name] ??
      own?.single?.['*'] ??
      (kernel.contentTemplate('single', resolution.name) as typeof EntryTemplate | undefined) ??
      EntryTemplate
    return <Template {...resolution.props} />
  }
  const Template =
    own?.[resolution.view]?.[resolution.name] ??
    own?.[resolution.view]?.['*'] ??
    (kernel.contentTemplate(resolution.view, resolution.name) as
      typeof ArchiveTemplate | undefined) ??
    ArchiveTemplate
  return <Template {...resolution.props} />
}

function DefaultHome() {
  return (
    <section>
      <h1>Your site is running</h1>
      <p>No plugin has claimed the home page yet. Install or activate one to add content here.</p>
    </section>
  )
}
