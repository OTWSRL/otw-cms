import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { forbidden, notFound } from 'next/navigation'
import { cache } from 'react'
import { AdminScreen } from '@/components/admin'
import { SettingsForm } from '@/components/settings-form'
import { parseSearchParams, pathnameFromSegments, serializeSearchParams } from '@/cms/search-params'
import { requireAdmin } from '@/cms/session'

interface Props {
  params: Promise<{ plugin: string; path?: string[] }>
  searchParams: Promise<SearchParams>
}

// generateMetadata and the page both need the page; cache() runs the plugin's loader once.
const loadAdminPage = cache(async (pathname: string, query: string) => {
  const { kernel, user } = await requireAdmin(pathname)
  const searchParams = parseSearchParams(query)
  return {
    kernel,
    searchParams,
    resolution: await kernel.resolveAdminPage(pathname, searchParams, user),
  }
})

async function pageFor({ params, searchParams }: Props) {
  const { plugin, path = [] } = await params
  const pathname = pathnameFromSegments(['admin', plugin, ...path])
  const {
    kernel,
    searchParams: query,
    resolution,
  } = await loadAdminPage(pathname, serializeSearchParams(await searchParams))
  if (resolution.kind === 'not-found') notFound()
  if (resolution.kind === 'forbidden') forbidden()
  return { kernel, query, page: resolution }
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { page } = await pageFor(props)
  return { title: page.title }
}

/** Admin screens and settings pages contributed by plugins, mounted at /admin/{pluginId}/... */
export default async function PluginAdminPage(props: Props) {
  const { kernel, query, page } = await pageFor(props)
  const flash = kernel.readFlash(query.flash)
  if (page.kind === 'settings') {
    return (
      <AdminScreen title={page.title} flash={flash}>
        <SettingsForm view={page.view} saveUrl={kernel.actionUrl('core', 'save-settings')} />
      </AdminScreen>
    )
  }
  const { Component } = page
  return (
    <AdminScreen title={page.title} flash={flash}>
      <Component {...page.props} />
    </AdminScreen>
  )
}
