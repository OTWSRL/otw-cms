import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { cache } from 'react'
import { getKernel } from '../runtime/kernel'
import {
  parseSearchParams,
  pathnameFromSegments,
  serializeSearchParams,
} from '../runtime/search-params'

export interface SiteRouteProps {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<SearchParams>
}

// generateMetadata and the page both need the page; cache() runs the plugin's loader once.
const loadPage = cache(async (pathname: string, query: string) => {
  const kernel = await getKernel()
  return kernel.resolvePage(pathname, parseSearchParams(query))
})

async function pageFor({ params, searchParams }: SiteRouteProps) {
  const { slug } = await params
  return {
    slug,
    page: await loadPage(pathnameFromSegments(slug), serializeSearchParams(await searchParams)),
  }
}

export async function generateSiteMetadata(props: SiteRouteProps): Promise<Metadata> {
  const { page } = await pageFor(props)
  return page ? page.metadata() : {}
}

/** Every storefront URL a plugin route claims; the home page when none does. */
export async function SitePage(props: SiteRouteProps) {
  const { slug, page } = await pageFor(props)
  if (!page) {
    if (!slug?.length) return <DefaultHome />
    notFound()
  }
  const { Component, props: pageProps } = page
  return <Component {...pageProps} />
}

function DefaultHome() {
  return (
    <section>
      <h1>Your site is running</h1>
      <p>No plugin has claimed the home page yet. Install or activate one to add content here.</p>
    </section>
  )
}
