import { AdminIcon, Notice, Postbox } from '@cms/admin-ui'
import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import Link from 'next/link'
import { AdminScreen, adminTitle } from '@/components/admin'
import { Slot } from '@/components/slot'
import { getKernel } from '@/cms/kernel'
import { requireAdmin } from '@/cms/session'

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
  const managesPlugins = kernel.can(user, 'core.manage_plugins')
  const plugins = `${kernel.active.length} ${kernel.active.length === 1 ? 'plugin' : 'plugins'} active`

  return (
    <AdminScreen title="Dashboard" flash={kernel.readFlash(params.flash)}>
      {managesPlugins && kernel.skipped.length > 0 && (
        <Notice type="error" title="Some plugins did not load">
          <ul>
            {kernel.skipped.map((plugin) => (
              <li key={plugin.id}>
                <strong>{plugin.id}</strong>: {plugin.reason}
              </li>
            ))}
          </ul>
          <p>
            <Link href="/admin/plugins">Review plugins</Link>
          </p>
        </Notice>
      )}
      {managesPlugins && kernel.warnings.length > 0 && (
        <Notice type="warning" title="Warnings">
          <ul>
            {kernel.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="dashboard-widgets">
        <Postbox id="dashboard-at-a-glance" title="At a Glance">
          <ul className="at-a-glance">
            <li>
              <AdminIcon icon="plugins" />
              {managesPlugins ? <Link href="/admin/plugins">{plugins}</Link> : plugins}
            </li>
            <li>
              <AdminIcon icon="dashboard" />
              Next CMS {kernel.coreVersion}
            </li>
          </ul>
          <p>Signed in as {user.name || user.email}.</p>
        </Postbox>
        <Slot name="admin.dashboard" props={{ user }} />
      </div>
    </AdminScreen>
  )
}
