import { FormButton, ListTable, Notice, SubmitButton } from '@otwdesign/admin-ui'
import type {
  Kernel,
  PluginUpdate,
  ReleaseRecord,
  UpdateCheck,
  UpdateJob,
  UpdateOverview,
} from '@otwdesign/core'
import { AutoRefresh } from '../auto-refresh'
import { AdminScreen } from '../screen'
import { updateOverview } from '../update-overview'
import type { ScreenContext } from './context'

type Serve = Extract<UpdateOverview, { channel: 'serve' }>

const CORE_PACKAGE = '@otwdesign/next'

const COMPATIBILITY: Record<PluginUpdate['compatible'], string> = {
  yes: 'Yes (according to its author)',
  unknown: 'Unknown',
  no: 'No',
}

const STEP_MARKS: Record<UpdateJob['steps'][number]['status'], string> = {
  pending: '○',
  running: '…',
  done: '✓',
  failed: '✕',
  skipped: '–',
}

function when(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`
}

/** WordPress's update-core.php: core, plugins, automatic updates, and what ran. */
export async function UpdatesScreen({ kernel, user, searchParams }: ScreenContext) {
  // The same answer the menu's counts came from, asked once for the request.
  const overview: UpdateOverview = (await updateOverview(kernel, user)) ?? { channel: 'none' }
  const flash = kernel.readFlash(searchParams.flash)
  return (
    <AdminScreen title="Updates" flash={flash}>
      {overview.channel === 'serve' && <ServeUpdates kernel={kernel} overview={overview} />}
      {overview.channel === 'github' && (
        <>
          <p>
            Updates for this site run on GitHub, in <code>{overview.repository}</code>: the update
            workflow moves the packages on a branch and opens a pull request. Merging it deploys the
            update.
          </p>
          <FormButton action={kernel.actionUrl('core', 'check-updates')} variant="primary">
            Check for updates and open a pull request
          </FormButton>
          <p>
            <a href={overview.runsUrl}>See the workflow’s runs on GitHub</a>
          </p>
        </>
      )}
      {overview.channel === 'unavailable' && (
        <Notice type="error" title="The update service isn’t answering">
          <p>{overview.reason}</p>
        </Notice>
      )}
      {overview.channel === 'none' && <ManualUpdates kernel={kernel} />}
    </AdminScreen>
  )
}

function ManualUpdates({ kernel }: { kernel: Kernel }) {
  return (
    <>
      <p>
        You have {kernel.brand.name} {kernel.coreVersion}. This site can’t update itself from the
        admin. To update from here, either start it with <code>cms serve</code> on your own server,
        or, if it builds from git, set <code>CMS_GITHUB_REPO</code> and{' '}
        <code>CMS_GITHUB_TOKEN</code>.
      </p>
      <p>Until then, on the server:</p>
      <pre className="code-block">
        cms update --check{'\n'}cms update{'\n'}cms migrate{'\n'}npm run build
      </pre>
    </>
  )
}

function ServeUpdates({ kernel, overview }: { kernel: Kernel; overview: Serve }) {
  const { lastCheck, job, current } = overview
  const action = (name: string) => kernel.actionUrl('core', name)
  return (
    <>
      {job && <JobProgress job={job} />}
      <div className="para update-last-checked">
        {lastCheck
          ? `Last checked on ${when(lastCheck.at)}.`
          : 'Not checked since the last update.'}{' '}
        <FormButton action={action('check-updates')} small disabled={job?.status === 'running'}>
          Check again
        </FormButton>
      </div>
      {lastCheck?.error && (
        <Notice type="error" title="The last check failed">
          <p>{lastCheck.error}</p>
        </Notice>
      )}

      <h2>{kernel.brand.name}</h2>
      {lastCheck?.core ? (
        <>
          <p>An updated version of {kernel.brand.name} is available.</p>
          <FormButton
            action={action('update')}
            fields={{ packages: 'core' }}
            variant="primary"
            disabled={job?.status === 'running'}
          >
            Update to version {lastCheck.core.to}
          </FormButton>
        </>
      ) : (
        <p>
          You have {lastCheck ? 'the latest version of ' : ''}
          {kernel.brand.name} {current?.versions[CORE_PACKAGE] ?? kernel.coreVersion}.
        </p>
      )}

      <h2>Plugins</h2>
      {lastCheck ? (
        <PluginUpdates kernel={kernel} check={lastCheck} busy={job?.status === 'running'} />
      ) : (
        <p>Check again to see which plugins have updates.</p>
      )}

      <h2>Automatic updates</h2>
      <form method="post" action={action('auto-updates')}>
        <fieldset className="auto-updates">
          <legend className="screen-reader-text">Automatic updates</legend>
          <label>
            <input
              type="radio"
              name="mode"
              value="off"
              defaultChecked={overview.autoUpdate === 'off'}
            />{' '}
            Off: updates wait for you
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              value="patch"
              defaultChecked={overview.autoUpdate === 'patch'}
            />{' '}
            Patch releases of {kernel.brand.name} and plugins, installed twice a day as they come
            out
          </label>
        </fieldset>
        <SubmitButton>Save</SubmitButton>
      </form>

      <h2>Releases</h2>
      <p className="description">
        The site runs from a built release. Rolling back runs an earlier one; the database stays as
        it is, since updates only add to it.
        {overview.database === 'embedded' &&
          ' With the embedded database, the site answers "being updated" for a few seconds while releases switch.'}
      </p>
      <Releases kernel={kernel} overview={overview} />
    </>
  )
}

function PluginUpdates({
  kernel,
  check,
  busy,
}: {
  kernel: Kernel
  check: UpdateCheck
  busy: boolean
}) {
  const ready = check.plugins.filter((plugin) => plugin.to)
  const waiting = check.plugins.filter((plugin) => !plugin.to && plugin.latest)
  const coreTarget = check.core?.to
  return (
    <>
      {ready.length === 0 ? (
        <p>Your plugins are all up to date.</p>
      ) : (
        <form method="post" action={kernel.actionUrl('core', 'update')}>
          <p>
            The following plugins have new versions available. Check the ones you want to update and
            then click “Update Plugins”.
          </p>
          <ListTable
            caption="Plugins with updates"
            rows={ready}
            rowKey={(plugin) => plugin.name}
            select={{
              name: 'packages',
              value: (plugin) => plugin.name,
              label: (plugin) => plugin.name,
            }}
            empty="None."
            columns={[
              {
                key: 'plugin',
                label: 'Plugin',
                render: (plugin) => (
                  <>
                    <strong>{plugin.name}</strong>
                    <p>
                      You have version {plugin.from} installed. Update to {plugin.to}.
                    </p>
                    <p className="description">
                      Compatibility with {kernel.brand.name}
                      {coreTarget ? ` ${coreTarget}` : ''}: {COMPATIBILITY[plugin.compatible]}
                    </p>
                    {plugin.note && (
                      <p className="description">
                        {plugin.latest} is out, but {plugin.note}.
                      </p>
                    )}
                  </>
                ),
              },
            ]}
          />
          <SubmitButton disabled={busy}>Update Plugins</SubmitButton>
        </form>
      )}
      {waiting.length > 0 && (
        <>
          <h3>Not yet</h3>
          <ul className="update-waiting">
            {waiting.map((plugin) => (
              <li key={plugin.name}>
                <strong>{plugin.name}</strong> {plugin.latest} is out, but {plugin.note}.
              </li>
            ))}
          </ul>
        </>
      )}
      {check.blockers.map((blocker) => (
        <Notice key={blocker} type="warning">
          <p>{blocker}</p>
        </Notice>
      ))}
      {check.warnings.map((warning) => (
        <Notice key={warning} type="info">
          <p>{warning}</p>
        </Notice>
      ))}
    </>
  )
}

function Releases({ kernel, overview }: { kernel: Kernel; overview: Serve }) {
  const busy = overview.job?.status === 'running'
  const versions = (release: ReleaseRecord) =>
    Object.entries(release.versions)
      .map(([name, version]) => `${name} ${version}`)
      .join(', ')
  return (
    <ListTable
      caption="Releases"
      rows={[...overview.releases].reverse()}
      rowKey={(release) => release.id}
      empty="No releases yet."
      rowActions={(release) =>
        release.status === 'previous' && !busy
          ? [
              <FormButton
                key="rollback"
                action={kernel.actionUrl('core', 'rollback-release')}
                fields={{ release: release.id }}
                variant="link"
              >
                Roll back to this release
              </FormButton>,
            ]
          : []
      }
      columns={[
        {
          key: 'built',
          label: 'Built',
          render: (release) => <strong>{when(release.createdAt)}</strong>,
        },
        { key: 'versions', label: 'Versions', render: versions },
        {
          key: 'status',
          label: 'Status',
          render: (release) =>
            release.status === 'live'
              ? 'Live'
              : release.status === 'previous'
                ? 'Previous'
                : `Failed: ${release.reason ?? 'see the log'}`,
        },
      ]}
    />
  )
}

function JobProgress({ job }: { job: UpdateJob }) {
  const running = job.status === 'running'
  const title = running
    ? job.kind === 'rollback'
      ? 'Rolling back…'
      : job.kind === 'check'
        ? 'Checking for updates…'
        : job.kind === 'install'
          ? 'Installing a plugin…'
          : job.kind === 'remove'
            ? 'Removing a plugin…'
            : 'Updating…'
    : job.summary
  return (
    <Notice
      type={running ? 'info' : job.status === 'succeeded' ? 'success' : 'error'}
      title={title}
    >
      {running && <AutoRefresh />}
      {job.steps.length > 1 && (
        <ol className="update-steps">
          {job.steps.map((step) => (
            <li key={step.name} data-status={step.status}>
              <span aria-hidden="true">{STEP_MARKS[step.status]}</span> {step.name}
              <span className="screen-reader-text"> ({step.status})</span>
            </li>
          ))}
        </ol>
      )}
      {job.log.length > 0 && (
        <details>
          <summary>Log</summary>
          <pre className="code-block">{job.log.slice(-40).join('\n')}</pre>
        </details>
      )}
    </Notice>
  )
}
