import { describe, expect, it } from 'vitest'
import { ControlError } from '../src/serve/control.ts'
import { Supervisor, type ServeState, type SupervisorDeps } from '../src/serve/supervisor.ts'
import type { UpdatePlan } from '../src/update.ts'

const FORUM = '@acme/forum'

const plan = (changes: UpdatePlan['changes'], extra: Partial<UpdatePlan> = {}): UpdatePlan => ({
  core: null,
  changes,
  plugins: changes.map(({ name, from, to }) => ({
    name,
    from,
    to,
    latest: to,
    compatible: 'yes' as const,
  })),
  blockers: [],
  warnings: [],
  linked: [],
  ...extra,
})

const UPDATE = plan([{ name: FORUM, from: '1.0.0', to: '1.1.0' }])

/** Fake side effects that record, in order, what happened to which release. */
function harness(
  options: {
    fail?: Partial<Record<string, string>>
    plans?: UpdatePlan[]
    /** What adding or removing a plugin would change, by its package name. */
    plugins?: Record<string, UpdatePlan>
  } = {},
) {
  const events: string[] = []
  const saved: ServeState[] = []
  const plans = [...(options.plans ?? [UPDATE])]
  let clock = Date.parse('2026-11-01T10:00:00Z')
  let nextPort = 4000
  const fail = (step: string, id: string) => {
    const reason = options.fail?.[`${step} ${id}`] ?? options.fail?.[step]
    if (reason) throw new Error(reason)
  }
  const deps: SupervisorDeps = {
    async plan(release, scope) {
      events.push(`plan ${release.id} ${JSON.stringify(scope)}`)
      return plans.length > 1 ? plans.shift()! : plans[0]!
    },
    async planInstall(release, name) {
      events.push(`plan install ${release.id} ${name}`)
      return options.plugins?.[name] ?? plan([])
    },
    async planRemove(release, name) {
      events.push(`plan remove ${release.id} ${name}`)
      return options.plugins?.[name] ?? plan([])
    },
    async build(id, changes) {
      events.push(`build ${id} ${changes.map((c) => `${c.name}@${c.to}`).join(' ')}`)
      fail('build', id)
      // What the release runs: the forum, and whatever was added and not removed.
      const versions: Record<string, string> = { [FORUM]: '1.0.0' }
      for (const change of changes) {
        if (change.to === '') delete versions[change.name]
        else versions[change.name] = change.to
      }
      return {
        id,
        dir: `/site/.cms/releases/${id}`,
        createdAt: new Date(clock).toISOString(),
        versions,
      }
    },
    async migrate(release) {
      events.push(`migrate ${release.id}`)
      fail('migrate', release.id)
    },
    async backup() {
      events.push('backup')
      return '/site/.cms/backups/1'
    },
    async restore(backup) {
      events.push(`restore ${backup}`)
    },
    async start(release) {
      events.push(`start ${release.id}`)
      fail('start', release.id)
      const port = nextPort++
      return {
        port,
        stop: async () => {
          events.push(`stop ${release.id}`)
        },
      }
    },
    async writeBack(release, changes) {
      events.push(`write back ${release.id} ${changes.map((c) => `${c.name}@${c.to}`).join(' ')}`)
    },
    async remove(release) {
      events.push(`remove ${release.id}`)
    },
    async save(state) {
      saved.push(structuredClone(state))
    },
    now: () => new Date((clock += 60_000)),
  }
  return { deps, events, saved }
}

const live = (id: string, version = '1.0.0'): ServeState['releases'][number] => ({
  id,
  dir: `/site/.cms/releases/${id}`,
  createdAt: '2026-10-31T09:00:00.000Z',
  versions: { [FORUM]: version },
  status: 'live',
})

const state = (extra: Partial<ServeState> = {}): ServeState => ({
  current: 'r1',
  releases: [live('r1')],
  autoUpdate: 'off',
  lastCheck: null,
  ...extra,
})

async function started(
  database: 'embedded' | 'postgres',
  options: Parameters<typeof harness>[0] = {},
  initial = state(),
) {
  const h = harness(options)
  const supervisor = new Supervisor(initial, h.deps, { database })
  await supervisor.start(() => {})
  h.events.length = 0
  return { ...h, supervisor }
}

describe('Supervisor', () => {
  it('builds the site into its first release when it has none', async () => {
    const h = harness()
    const supervisor = new Supervisor(state({ current: null, releases: [] }), h.deps, {
      database: 'embedded',
    })
    await supervisor.start(() => {})
    expect(h.events).toEqual(['build 20261101-100100 ', 'start 20261101-100100'])
    expect(supervisor.target()).toBe(4000)
    expect(supervisor.overview().current).toMatchObject({ id: '20261101-100100', status: 'live' })
  })

  it('updates with Postgres without a gap: the old release serves until the new one answers', async () => {
    const { supervisor, events, saved } = await started('postgres')
    expect(supervisor.update({ packages: [FORUM] })).toBe('Updating. This page shows the progress.')
    // While it builds, the old release still serves.
    expect(supervisor.target()).toBe(4000)
    await supervisor.idle()

    expect(events).toEqual([
      `plan r1 {"only":["${FORUM}"]}`,
      `build 20261101-100200 ${FORUM}@1.1.0`,
      'migrate 20261101-100200',
      'start 20261101-100200',
      'stop r1',
      `write back 20261101-100200 ${FORUM}@1.1.0`,
    ])
    expect(supervisor.target()).toBe(4001)
    const overview = supervisor.overview()
    expect(overview.job).toMatchObject({
      kind: 'update',
      status: 'succeeded',
      summary: `Updated: ${FORUM} 1.0.0 → 1.1.0.`,
    })
    expect(overview.job!.steps.every((step) => step.status === 'done')).toBe(true)
    expect(overview.releases.map(({ id, status }) => `${id} ${status}`)).toEqual([
      'r1 previous',
      '20261101-100200 live',
    ])
    expect(saved.at(-1)!.current).toBe('20261101-100200')
  })

  it('stops the old release before migrating the embedded database, and the proxy waits', async () => {
    const { supervisor, events } = await started('embedded')
    supervisor.update({})
    await supervisor.idle()
    expect(events).toEqual([
      'plan r1 {}',
      `build 20261101-100200 ${FORUM}@1.1.0`,
      'stop r1',
      'backup',
      'migrate 20261101-100200',
      'start 20261101-100200',
      `write back 20261101-100200 ${FORUM}@1.1.0`,
    ])
    expect(supervisor.target()).toBe(4001)
  })

  it('answers 503 between releases on the embedded database', async () => {
    const h = harness()
    let duringMigrate: number | null | undefined
    const supervisor = new Supervisor(
      state(),
      {
        ...h.deps,
        async migrate() {
          duringMigrate = supervisor.target()
        },
      },
      { database: 'embedded' },
    )
    await supervisor.start(() => {})
    supervisor.update({})
    await supervisor.idle()
    expect(duringMigrate).toBeNull()
  })

  it('changes nothing when the new release doesn’t build', async () => {
    const { supervisor, events } = await started('embedded', {
      fail: { build: 'next build failed' },
    })
    supervisor.update({})
    await supervisor.idle()
    expect(events).toEqual(['plan r1 {}', `build 20261101-100200 ${FORUM}@1.1.0`])
    expect(supervisor.target()).toBe(4000)
    expect(supervisor.overview().job).toMatchObject({
      status: 'failed',
      summary: "The new release didn't build, so nothing changed: next build failed",
    })
    expect(supervisor.overview().job!.steps.map((step) => step.status)).toEqual([
      'done',
      'failed',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ])
  })

  it('puts the embedded database back and restarts the old release when the new one won’t start', async () => {
    const { supervisor, events } = await started('embedded', {
      fail: { 'start 20261101-100200': 'It did not answer within 60 seconds' },
    })
    supervisor.update({})
    await supervisor.idle()
    expect(events.slice(2)).toEqual([
      'stop r1',
      'backup',
      'migrate 20261101-100200',
      'start 20261101-100200',
      'restore /site/.cms/backups/1',
      'start r1',
      'remove 20261101-100200',
    ])
    expect(supervisor.target()).toBe(4001)
    const overview = supervisor.overview()
    expect(overview.current?.id).toBe('r1')
    expect(overview.job?.summary).toBe(
      'It did not answer within 60 seconds The site is back on the release it was running.',
    )
    expect(overview.releases.at(-1)).toMatchObject({
      status: 'failed',
      reason: 'It did not answer within 60 seconds',
    })
  })

  it('keeps the old release serving with Postgres when the new one fails', async () => {
    const { supervisor, events } = await started('postgres', {
      fail: { migrate: 'relation "x" already exists' },
    })
    supervisor.update({})
    await supervisor.idle()
    expect(events).not.toContain('stop r1')
    expect(supervisor.target()).toBe(4000)
    expect(supervisor.overview().job?.status).toBe('failed')
  })

  it('refuses a second job while one runs, and an update with blockers', async () => {
    const { supervisor } = await started('postgres')
    supervisor.update({})
    expect(() => supervisor.update({})).toThrow(ControlError)
    await expect(supervisor.check()).rejects.toThrow('An update is already running')
    await supervisor.idle()

    const blocked = await started('postgres', {
      plans: [plan(UPDATE.changes, { blockers: ['@acme/lms 1.0.0 would be switched off.'] })],
    })
    blocked.supervisor.update({})
    await blocked.supervisor.idle()
    expect(blocked.supervisor.overview().job?.summary).toBe(
      'Not updated: @acme/lms 1.0.0 would be switched off.',
    )
    expect(blocked.events).toEqual(['plan r1 {}'])
  })

  it('rolls back to the previous release and writes its versions back to the site', async () => {
    const { supervisor, events } = await started('postgres')
    supervisor.update({})
    await supervisor.idle()
    events.length = 0

    expect(supervisor.rollback('r1')).toBe('Going back to the release from 2026-10-31 09:00.')
    await supervisor.idle()
    expect(events).toEqual(['start r1', 'stop 20261101-100200', `write back r1 ${FORUM}@1.0.0`])
    expect(supervisor.overview().current?.id).toBe('r1')
    expect(() => supervisor.rollback('nope')).toThrow('There is no earlier release')
  })

  it('installs a plugin in a new release, and says to activate it', async () => {
    const WIKI = '@acme/wiki'
    const { supervisor, events } = await started('postgres', {
      plugins: { [WIKI]: plan([{ name: WIKI, from: '', to: '2.1.0' }]) },
    })
    expect(supervisor.install(WIKI)).toBe(
      `Installing ${WIKI}. Dashboard › Updates shows the progress.`,
    )
    await supervisor.idle()
    const [, id] = /^build (\S+)/.exec(events[1]!)!
    expect(events).toEqual([
      `plan install r1 ${WIKI}`,
      `build ${id} ${WIKI}@2.1.0`,
      `migrate ${id}`,
      `start ${id}`,
      'stop r1',
      `write back ${id} ${WIKI}@2.1.0`,
    ])
    const overview = supervisor.overview()
    expect(overview.job).toMatchObject({
      kind: 'install',
      status: 'succeeded',
      summary: `Installed ${WIKI} 2.1.0. Activate it on the Plugins screen.`,
    })
    expect(overview.current?.versions).toEqual({ [FORUM]: '1.0.0', [WIKI]: '2.1.0' })

    // Rolling back takes it off the site's own files again.
    events.length = 0
    supervisor.rollback('r1')
    await supervisor.idle()
    expect(events.at(-1)).toBe(`write back r1 ${WIKI}@`)
  })

  it('removes a plugin in a new release, and installs or removes nothing that is refused', async () => {
    const { supervisor, events } = await started('postgres', {
      plugins: {
        [FORUM]: plan([{ name: FORUM, from: '1.0.0', to: '' }]),
        'left-pad': plan([], { blockers: ['left-pad isn’t a plugin for this CMS.'] }),
      },
    })
    supervisor.install('left-pad')
    await supervisor.idle()
    expect(supervisor.overview().job).toMatchObject({
      kind: 'install',
      status: 'failed',
      summary: 'Not installed: left-pad isn’t a plugin for this CMS.',
    })
    expect(events).toEqual(['plan install r1 left-pad'])

    events.length = 0
    expect(supervisor.remove(FORUM)).toBe(
      `Removing ${FORUM}. Dashboard › Updates shows the progress.`,
    )
    await supervisor.idle()
    expect(events[0]).toBe(`plan remove r1 ${FORUM}`)
    expect(events[1]).toMatch(new RegExp(`^build \\S+ ${FORUM}@$`))
    expect(supervisor.overview().job).toMatchObject({
      kind: 'remove',
      status: 'succeeded',
      summary: `Removed ${FORUM}.`,
    })
    expect(supervisor.overview().current?.versions).toEqual({})
  })

  it('records a check, including one that fails', async () => {
    const { supervisor } = await started('postgres')
    expect(await supervisor.check()).toBe('1 update(s) available.')
    expect(supervisor.overview().lastCheck).toMatchObject({
      core: null,
      plugins: [{ name: FORUM, to: '1.1.0' }],
    })

    const offline = await started('postgres')
    const failing = new Supervisor(
      state(),
      {
        ...offline.deps,
        plan: async () => {
          throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
        },
      },
      { database: 'postgres' },
    )
    expect(await failing.check()).toBe(
      "Couldn't check for updates: getaddrinfo ENOTFOUND registry.npmjs.org",
    )
    expect(failing.overview().lastCheck?.error).toBe('getaddrinfo ENOTFOUND registry.npmjs.org')
  })

  it('applies patch releases on its own when automatic updates are on', async () => {
    const quiet = await started('postgres')
    await quiet.supervisor.tick()
    expect(quiet.events).toEqual(['plan r1 {}'])

    const auto = await started('postgres', {}, state({ autoUpdate: 'patch' }))
    await auto.supervisor.tick()
    expect(auto.events.slice(0, 3)).toEqual([
      'plan r1 {}',
      'plan r1 {"patchOnly":true}',
      'plan r1 {"patchOnly":true}',
    ])
    expect(auto.supervisor.overview().current?.versions[FORUM]).toBe('1.1.0')
    expect(await auto.supervisor.setAutoUpdate('off')).toBe('Automatic updates are off.')
  })

  it('keeps three working releases, and never removes the live one', async () => {
    const releases = [live('r1'), live('r2'), live('r3')].map((release, index) => ({
      ...release,
      status: index === 2 ? ('live' as const) : ('previous' as const),
    }))
    const { supervisor, events } = await started('postgres', {}, state({ current: 'r3', releases }))
    supervisor.update({})
    await supervisor.idle()
    expect(events).toContain('remove r1')
    expect(supervisor.overview().releases.map((release) => release.id)).toEqual([
      'r2',
      'r3',
      '20261101-100200',
    ])
  })
})
