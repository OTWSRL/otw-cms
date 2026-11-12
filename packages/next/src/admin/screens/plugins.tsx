import { ButtonLink, FormButton, ListTable, Notice, TableNav, Views } from '@otwdesign/admin-ui'
import type { Kernel, PluginStatus, PluginUpdate, UninstallPlan } from '@otwdesign/core'
import Link from 'next/link'
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
  const deleting = plugins.find((plugin) => plugin.id === firstParam(params.delete))
  if (deleting) {
    const plan = await kernel.uninstallPlan(deleting.id)
    if (plan) return <DeleteData kernel={kernel} plugin={deleting} plan={plan} pinned={pinned} />
  }
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
        rowActions={(plugin) => [
          action(plugin),
          // As WordPress offers Delete once a plugin is deactivated.
          ...(plugin.status === 'inactive' && !pinned
            ? [
                <Link
                  key="delete"
                  className="button-link-delete"
                  href={`/admin/plugins?delete=${plugin.id}`}
                  aria-label={`Delete ${plugin.name}’s data`}
                >
                  Delete Data
                </Link>,
              ]
            : []),
        ]}
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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * WordPress's "You are about to remove the following plugin" screen, for the plugin's data: what
 * will go, and a button that says so. The package stays installed.
 */
function DeleteData({
  kernel,
  plugin,
  plan,
  pinned,
}: {
  kernel: Kernel
  plugin: PluginStatus
  plan: UninstallPlan
  pinned: boolean
}) {
  const blocked =
    plugin.status !== 'inactive'
      ? `Deactivate ${plugin.name} first: only an inactive plugin’s data can be deleted.`
      : pinned
        ? 'The active plugins are set by CMS_ACTIVE_PLUGINS, so plugins can’t be changed here.'
        : null
  const core = [
    plan.settings > 0 && plural(plan.settings, 'saved setting', 'saved settings'),
    plan.jobs > 0 && plural(plan.jobs, 'scheduled action', 'scheduled actions'),
    plan.cached > 0 && plural(plan.cached, 'cached value', 'cached values'),
  ].filter(Boolean)
  return (
    <AdminScreen title={`Delete ${plugin.name}’s data`} flash={null}>
      {blocked ? (
        <Notice type="warning">
          <p>{blocked}</p>
        </Notice>
      ) : (
        <>
          <p>
            You are about to delete the data of the following plugin: <strong>{plugin.name}</strong>
            .
          </p>
          <ul className="ul-disc">
            {plan.removesItsOwn ? (
              <li>
                What {plugin.name} stored itself, such as its tables. Activated again, it starts
                from nothing.
              </li>
            ) : (
              <li>
                {plugin.name} doesn’t say how to remove what it stored itself, so its tables, if it
                has any, are kept.
              </li>
            )}
            <li>
              What the site kept for it:{' '}
              {core.length > 0
                ? core.join(', ')
                : 'no settings, scheduled actions or cached values'}
              .
            </li>
          </ul>
          <p>
            The plugin itself stays installed, and inactive. This can’t be undone: back up the
            database first if you may want the data again.
          </p>
          <div className="para">
            <FormButton
              action={kernel.actionUrl('core', 'delete-plugin-data')}
              fields={{ plugin: plugin.id }}
              variant="primary"
            >
              Yes, delete this data
            </FormButton>{' '}
            <ButtonLink href="/admin/plugins">No, return me to the plugin list</ButtonLink>
          </div>
        </>
      )}
      {blocked && (
        <p>
          <Link href="/admin/plugins">← Go to Plugins</Link>
        </p>
      )}
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
