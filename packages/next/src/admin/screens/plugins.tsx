import { FormButton, ListTable, Notice, TableNav, Views } from '@otwdesign/admin-ui'
import type { PluginStatus, PluginUpdate } from '@otwdesign/core'
import { currentSite } from '../../site-registry'
import { AdminScreen } from '../screen'
import { updateOverview } from '../update-overview'
import type { ScreenContext } from './context'
import { firstParam } from '../../runtime/search-params'

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
export async function PluginsScreen({ kernel, user, searchParams: params }: ScreenContext) {
  const pinned = kernel.activation === 'pinned'
  const filter = filterFrom(firstParam(params.plugin_status))
  const plugins = kernel.plugins()
  const shown = filter ? plugins.filter((plugin) => plugin.status === filter) : plugins
  const count = (status: Filter) => plugins.filter((plugin) => plugin.status === status).length
  const href = (status?: Filter) =>
    status ? `/admin/plugins?plugin_status=${status}` : '/admin/plugins'

  // Update checks speak in package names; the site module says which package is which plugin.
  const overview = await updateOverview(kernel, user)
  const site = currentSite()
  const updates = new Map(
    overview?.channel === 'serve'
      ? (overview.lastCheck?.plugins ?? []).flatMap((update) => {
          const plugin = site.plugins.find((_, i) => site.packages?.[i] === update.name)
          return plugin && update.to ? [[plugin.id, update] as const] : []
        })
      : [],
  )

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
                <UpdateMessage
                  update={updates.get(plugin.id)}
                  name={plugin.name}
                  action={kernel.actionUrl('core', 'update')}
                />
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

/** "There is a new version of Forum available. Update now", as on WordPress's plugins screen. */
function UpdateMessage({
  update,
  name,
  action,
}: {
  update: PluginUpdate | undefined
  name: string
  action: string
}) {
  if (!update?.to) return null
  return (
    <div className="notice inline notice-warning update-message">
      <div className="para">
        There is a new version of {name} available: {update.to}.{' '}
        <FormButton action={action} fields={{ packages: update.name }} variant="link">
          Update now<span className="screen-reader-text"> {name}</span>
        </FormButton>
      </div>
    </div>
  )
}
