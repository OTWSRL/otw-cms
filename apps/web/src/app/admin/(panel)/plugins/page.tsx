import type { PluginStatus } from '@cms/core'
import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { AdminScreen } from '@/components/admin'
import { requireAdmin } from '@/cms/session'

export const metadata: Metadata = { title: 'Plugins' }

const STATUS_LABELS: Record<PluginStatus['status'], string> = {
  active: 'Active',
  inactive: 'Inactive',
  failed: 'Failed to load',
}

export default async function PluginsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const [{ kernel }, params] = await Promise.all([
    requireAdmin('/admin/plugins', 'core.manage_plugins'),
    searchParams,
  ])
  const pinned = kernel.activation === 'pinned'

  return (
    <AdminScreen title="Plugins" flash={kernel.readFlash(params.flash)}>
      {pinned && (
        <p className="cms-notice">
          The active plugins are set by <code>CMS_ACTIVE_PLUGINS</code>, so they can&apos;t be
          changed here.
        </p>
      )}
      <table className="cms-table">
        <thead>
          <tr>
            <th scope="col">Plugin</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="cms-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {kernel.plugins().map((plugin) => {
            const on = plugin.status !== 'inactive'
            return (
              <tr key={plugin.id} data-testid={`plugin-${plugin.id}`}>
                <td>
                  <strong>{plugin.name}</strong> <small>{plugin.version}</small>
                  {plugin.description && <p>{plugin.description}</p>}
                  {plugin.reason && <p className="cms-error">{plugin.reason}</p>}
                </td>
                <td>{STATUS_LABELS[plugin.status]}</td>
                <td>
                  <form
                    method="post"
                    action={kernel.actionUrl('core', on ? 'deactivate-plugin' : 'activate-plugin')}
                  >
                    <input type="hidden" name="plugin" value={plugin.id} />
                    <button
                      type="submit"
                      className="cms-button"
                      disabled={pinned || plugin.blockers.length > 0}
                      aria-describedby={
                        plugin.blockers.length > 0 ? `blockers-${plugin.id}` : undefined
                      }
                    >
                      {on ? 'Deactivate' : 'Activate'}
                      <span className="cms-visually-hidden"> {plugin.name}</span>
                    </button>
                  </form>
                  {plugin.blockers.length > 0 && (
                    <small id={`blockers-${plugin.id}`}>{plugin.blockers.join(' ')}</small>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </AdminScreen>
  )
}
