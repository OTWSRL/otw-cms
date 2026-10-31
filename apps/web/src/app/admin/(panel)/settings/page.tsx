import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { forbidden, notFound } from 'next/navigation'
import { AdminScreen } from '@/components/admin'
import { SettingsForm } from '@/components/settings-form'
import { requireAdmin } from '@/cms/session'

export const metadata: Metadata = { title: 'General settings' }

/** Settings › General. Plugin settings pages render the same form from the catch-all route. */
export default async function GeneralSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [{ kernel, user }, params] = await Promise.all([
    requireAdmin('/admin/settings'),
    searchParams,
  ])
  const page = kernel.settingsPage('core.general', user)
  if (page.kind === 'forbidden') forbidden()
  if (page.kind === 'not-found') notFound()

  return (
    <AdminScreen title={page.title} flash={kernel.readFlash(params.flash)}>
      <SettingsForm view={page.view} saveUrl={kernel.actionUrl('core', 'save-settings')} />
    </AdminScreen>
  )
}
