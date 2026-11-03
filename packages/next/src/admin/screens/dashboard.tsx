import { AdminIcon, Notice, Postbox } from '@otwdesign/admin-ui'
import Link from 'next/link'
import { AdminScreen } from '../screen'
import type { ScreenContext } from './context'
import { Slot } from '../../site/slot'

export async function DashboardScreen({ kernel, user, searchParams: params }: ScreenContext) {
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
              {kernel.brand.name} {kernel.coreVersion}
            </li>
          </ul>
          <p>Signed in as {user.name || user.email}.</p>
        </Postbox>
        <Slot name="admin.dashboard" props={{ user }} />
      </div>
    </AdminScreen>
  )
}
