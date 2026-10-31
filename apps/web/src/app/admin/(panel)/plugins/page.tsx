import { FormButton, ListTable, Notice, TableNav, Views } from '@cms/admin-ui'
import type { PluginStatus } from '@cms/core'
import type { SearchParams } from '@cms/sdk'
import type { Metadata } from 'next'
import { AdminScreen } from '@/components/admin'
import { firstParam } from '@/cms/search-params'
import { requireAdmin } from '@/cms/session'

export const metadata: Metadata = { title: 'Plugins' }

const FILTERS = ['active', 'inactive', 'failed'] as const
type Filter = (typeof FILTERS)[number]

const FILTER_LABELS: Record<Filter, string> = {
  active: 'Active',
  inactive: 'Inactive',
  failed: 'Failed to load',
}

function filterFrom(value: string | undefined): Filter | undefined {
  return FILTERS.find((filter) => filter === value)
}

/** plugins.php: every installed plugin, active ones highlighted, actions under the name. */
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
  const filter = filterFrom(firstParam(params.plugin_status))
  const plugins = kernel.plugins()
  const shown = filter ? plugins.filter((plugin) => plugin.status === filter) : plugins
  const count = (status: Filter) => plugins.filter((plugin) => plugin.status === status).length
  const href = (status?: Filter) =>
    status ? `/admin/plugins?plugin_status=${status}` : '/admin/plugins'

  const action = (plugin: PluginStatus) => {
    const on = plugin.status !== 'inactive'
    const label = on ? 'Deactivate' : 'Activate'
    return (
      <FormButton
        key="toggle"
        action={kernel.actionUrl('core', on ? 'deactivate-plugin' : 'activate-plugin')}
        fields={{ plugin: plugin.id }}
        variant="link"
        disabled={pinned || plugin.blockers.length > 0}
        aria-describedby={plugin.blockers.length > 0 ? `blockers-${plugin.id}` : undefined}
      >
        {label}
        <span className="screen-reader-text"> {plugin.name}</span>
      </FormButton>
    )
  }

  return (
    <AdminScreen title="Plugins" flash={kernel.readFlash(params.flash)}>
      {pinned && (
        <Notice type="info">
          <p>
            The active plugins are set by <code>CMS_ACTIVE_PLUGINS</code>, so they can&apos;t be
            changed here.
          </p>
        </Notice>
      )}
      <Views
        label="Filter plugins"
        views={[
          { label: 'All', count: plugins.length, href: href(), current: !filter },
          ...FILTERS.filter((status) => status !== 'failed' || count(status) > 0).map((status) => ({
            label: FILTER_LABELS[status],
            count: count(status),
            href: href(status),
            current: filter === status,
          })),
        ]}
      />
      <TableNav total={shown.length} noun={['item', 'items']} />
      <ListTable
        caption="Installed plugins"
        className="plugins"
        striped={false}
        rows={shown}
        rowKey={(plugin) => plugin.id}
        rowClassName={(plugin) => (plugin.status === 'inactive' ? 'inactive' : 'active')}
        rowActions={(plugin) => [action(plugin)]}
        empty="No plugins found."
        columns={[
          {
            key: 'name',
            label: 'Plugin',
            render: (plugin) => <strong>{plugin.name}</strong>,
          },
          {
            key: 'description',
            label: 'Description',
            render: (plugin) => (
              <>
                {plugin.description && <p>{plugin.description}</p>}
                {plugin.reason && <p className="plugin-error">{plugin.reason}</p>}
                {plugin.blockers.length > 0 && (
                  <p className="description" id={`blockers-${plugin.id}`}>
                    {plugin.blockers.join(' ')}
                  </p>
                )}
                <p className="plugin-version">
                  Version {plugin.version}
                  {plugin.status === 'failed' && ' | Switched on, but not loaded'}
                </p>
              </>
            ),
          },
        ]}
      />
    </AdminScreen>
  )
}
