import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { AdminScreen, adminTitle } from '@/components/admin'
import { Slot } from '@/components/slot'
import { getKernel } from '@/cms/kernel'
import { requireAdmin } from '@/cms/session'
import Link from 'next/link'

// The layout's title template only reaches child segments, and this page shares its segment.
export async function generateMetadata(): Promise<Metadata> {
  const site = (await getKernel()).setting('site.title') ?? 'Next CMS'
  return { title: { absolute: adminTitle(site, 'Dashboard') } }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [{ kernel, user }, params] = await Promise.all([requireAdmin('/admin'), searchParams])
  const showPlugins = kernel.can(user, 'core.manage_plugins')
  return (
    <AdminScreen title="Dashboard" flash={kernel.readFlash(params.flash)}>
      <p>Signed in as {user.name || user.email}.</p>
      <div className="cms-widgets">
        <Slot name="admin.dashboard" props={{ user }} />
      </div>
      {showPlugins && kernel.skipped.length > 0 && (
        <section className="cms-notice cms-notice-error">
          <h2>Plugins that did not load</h2>
          <ul>
            {kernel.skipped.map((plugin) => (
              <li key={plugin.id}>
                <strong>{plugin.id}</strong>: {plugin.reason}
              </li>
            ))}
          </ul>
          <Link href="/admin/plugins">Review plugins</Link>
        </section>
      )}
      {showPlugins && kernel.warnings.length > 0 && (
        <section className="cms-notice">
          <h2>Warnings</h2>
          <ul>
            {kernel.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}
    </AdminScreen>
  )
}
