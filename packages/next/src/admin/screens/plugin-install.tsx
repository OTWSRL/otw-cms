import { Button, FormButton, ListTable, Notice, SubmitButton } from '@otwdesign/admin-ui'
import Link from 'next/link'
import { MAX_QUERY, searchPlugins, type FoundPlugin } from '../../runtime/plugin-search'
import { firstParam } from '../../runtime/search-params'
import { currentSite } from '../../site-registry'
import { AdminScreen } from '../screen'
import type { ScreenContext } from './context'

const PATH = '/admin/plugins/new'
/** How long a search's results are reused: npm's index doesn't change by the minute. */
const SEARCH_TTL_SECONDS = 600

/**
 * plugin-install.php: plugins on npm, which is the directory, found by the keyword they're
 * tagged with, and any plugin by its package name. Installing rebuilds the site, so it's offered
 * where the site's hosting can: `cms serve`, or a GitHub repository.
 */
export async function PluginInstallScreen({ kernel, searchParams: params }: ScreenContext) {
  const query = (firstParam(params.s) ?? '').trim().slice(0, MAX_QUERY)
  const canInstall = typeof kernel.updates?.install === 'function'
  const installed = new Set(currentSite().packages ?? [])
  const installUrl = kernel.actionUrl('core', 'install-plugin')

  let results: readonly FoundPlugin[] = []
  let problem: string | null = null
  try {
    results = await kernel.cache.remember(`plugin-search:${query}`, () => searchPlugins(query), {
      ttlSeconds: SEARCH_TTL_SECONDS,
    })
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error)
  }

  return (
    <AdminScreen title="Add Plugins" flash={kernel.readFlash(params.flash)}>
      {!canInstall && (
        <Notice type="info" title="Plugins can’t be added from here on this site.">
          <p>
            Adding a plugin rebuilds the site, which the admin can do when the site runs under{' '}
            <code>cms serve</code> or builds from a GitHub repository. Here, whoever deploys the
            site runs <code>cms plugin add</code> with the plugin’s package name, then rebuilds.
          </p>
        </Notice>
      )}
      <p>
        Plugins are npm packages. The ones listed here are tagged <code>otw-cms-plugin</code> on
        npm; any other is added by its package name, below. A plugin is code that runs on your
        server: add only what you trust.
      </p>
      <form method="get" action={PATH} className="search-form">
        <p className="search-box">
          <label className="screen-reader-text" htmlFor="plugin-search">
            Search plugins
          </label>
          <input
            type="search"
            id="plugin-search"
            name="s"
            defaultValue={query}
            maxLength={MAX_QUERY}
          />
          <Button type="submit">Search Plugins</Button>
        </p>
      </form>
      {problem ? (
        <Notice type="error" title="The plugin list couldn’t be loaded.">
          <p>{problem} A plugin can still be added by its package name.</p>
        </Notice>
      ) : (
        <ListTable
          caption="Plugins on npm"
          rows={results}
          rowKey={(plugin) => plugin.name}
          empty={
            query
              ? 'No plugins found. Try other words, or add one by its name.'
              : 'No plugins found.'
          }
          rowActions={(plugin) =>
            installed.has(plugin.name)
              ? [<span key="installed">Installed</span>]
              : canInstall
                ? [
                    <FormButton
                      key="install"
                      action={installUrl}
                      fields={{ package: plugin.name }}
                      variant="link"
                      aria-label={`Install ${plugin.name} now`}
                    >
                      Install Now
                    </FormButton>,
                  ]
                : []
          }
          columns={[
            {
              key: 'name',
              label: 'Plugin',
              render: (plugin) => (
                <strong>
                  <a href={plugin.url} rel="noreferrer" target="_blank">
                    {plugin.name}
                  </a>
                </strong>
              ),
            },
            { key: 'description', label: 'Description', render: (plugin) => plugin.description },
            {
              key: 'version',
              label: 'Version',
              render: (plugin) => (
                <>
                  {plugin.version}
                  {plugin.publisher && (
                    <>
                      <br />
                      <span className="description">By {plugin.publisher}</span>
                    </>
                  )}
                </>
              ),
            },
          ]}
        />
      )}

      <h2>Add a plugin by its package name</h2>
      <p>
        For a plugin that isn’t listed, such as one from your own registry. Its newest version that
        works with this site’s CMS is added, inactive: activate it on{' '}
        <Link href="/admin/plugins">Installed Plugins</Link>.
      </p>
      <form method="post" action={installUrl}>
        <p>
          <label htmlFor="plugin-package">Package name</label>{' '}
          <input
            id="plugin-package"
            name="package"
            className="regular-text code"
            placeholder="@acme/forum"
            maxLength={214}
            required
            disabled={!canInstall}
            autoComplete="off"
          />
        </p>
        <SubmitButton disabled={!canInstall}>Install Plugin</SubmitButton>
      </form>
    </AdminScreen>
  )
}
