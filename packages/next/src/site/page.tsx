import {
  ACCOUNT_VERIFY_PATH,
  type AccountResolution,
  type ContentResolution,
} from '@otwdesign/core'
import { ForbiddenError, PageRedirect, type SearchParams } from '@otwdesign/sdk'
import type { Metadata } from 'next'
import { forbidden, notFound, redirect } from 'next/navigation'
import { cache } from 'react'
import { siteTemplates } from '../site-registry'
import { getKernel } from '../runtime/kernel'
import { getCurrentUser, signInCookies } from '../runtime/session'
import { AccountTemplate } from './account'
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
// The user is looked up only if the page asks for it.
const loadPage = cache(async (pathname: string, query: string) => {
  const kernel = await getKernel()
  return kernel.resolvePage(pathname, parseSearchParams(query), { user: getCurrentUser })
})

/**
 * A plugin's page, or how its loader answered instead: a redirect (to sign in, say), which Next
 * sends as a 307, or a 403.
 */
async function pluginPage(pathname: string, query: string) {
  try {
    return await loadPage(pathname, query)
  } catch (error) {
    if (error instanceof PageRedirect) redirect(error.location)
    if (error instanceof ForbiddenError) forbidden()
    throw error
  }
}

// The viewer matters here: previews and private entries are theirs to see.
const loadContent = cache(async (pathname: string, query: string) => {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
  return kernel.resolveContent(pathname, parseSearchParams(query), user)
})

// The account pages are the viewer's: signed in, the details; signed out, the sign-in form.
const loadAccount = cache(async (pathname: string, query: string) => {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
  // Only the page that asks for a sign-in's code reads that sign-in's cookies.
  const cookies = pathname === ACCOUNT_VERIFY_PATH ? await signInCookies() : undefined
  return kernel.resolveAccount(pathname, parseSearchParams(query), user, cookies)
})

/**
 * What the path shows: a plugin's page, then the account pages, then content (a page, a post, an
 * archive), as WordPress lets plugins' rewrite rules come first. A preview link is for content
 * wherever it points.
 */
async function resolve({ params, searchParams }: SiteRouteProps) {
  const { slug } = await params
  const pathname = pathnameFromSegments(slug)
  const query = await searchParams
  const serialized = serializeSearchParams(query)
  const preview = query.preview !== undefined
  const page = preview ? null : await pluginPage(pathname, serialized)
  const account = page || preview ? null : await loadAccount(pathname, serialized)
  const content = page || account ? null : await loadContent(pathname, serialized)
  return { slug, preview, page, account, content }
}

/** The page's title and description, from the plugin page or the content at this path. */
export async function generateSiteMetadata(props: SiteRouteProps): Promise<Metadata> {
  const { page, account, content } = await resolve(props)
  if (page) return page.metadata()
  if (account) {
    const { title, referrer } = account.metadata
    return { title, robots: { index: false, follow: false }, ...(referrer ? { referrer } : {}) }
  }
  if (!content) return {}
  const { title, description, noindex } = content.metadata
  return { title, description, robots: noindex ? { index: false, follow: false } : undefined }
}

/** Every site URL: a plugin's page, the content there, or the default home page. */
export async function SitePage(props: SiteRouteProps) {
  const { slug, preview, page, account, content } = await resolve(props)
  if (page) {
    const { Component, props: pageProps } = page
    return <Component {...pageProps} />
  }
  if (account) return <Account resolution={account} />
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
  const [kernel, own] = await Promise.all([getKernel(), siteTemplates()])
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

/** The account pages in the site's own template, or the default. */
async function Account({ resolution }: { resolution: AccountResolution }) {
  const Template = (await siteTemplates())?.account ?? AccountTemplate
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
