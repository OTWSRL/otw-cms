import { describe, expect, it } from 'vitest'
import { githubUpdates, supervisorUpdates, updateServiceFromEnv } from '../src/runtime/updates'

type Call = { url: string; init: RequestInit }

function fake(answers: Record<string, [number, unknown]>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const key = `${init.method} ${url}`
    const [status, body] = answers[key] ?? [404, { error: 'not found' }]
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('supervisorUpdates', () => {
  const URL = 'http://127.0.0.1:5000'

  it('calls cms serve with its token and returns its notices', async () => {
    const { calls, fetchImpl } = fake({
      [`POST ${URL}/update`]: [200, { notice: 'Updating.' }],
      [`PUT ${URL}/auto-update`]: [200, { notice: 'Saved.' }],
      [`GET ${URL}/status`]: [200, { channel: 'serve', releases: [] }],
    })
    const service = supervisorUpdates(URL, 'secret', fetchImpl, { statuses: new Map() })
    expect(await service.update({ packages: ['@acme/forum'] })).toBe('Updating.')
    expect(await service.setAutoUpdate('patch')).toBe('Saved.')
    expect(await service.overview()).toEqual({ channel: 'serve', releases: [] })
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer secret')
    expect(calls[0]!.init.body).toBe('{"packages":["@acme/forum"]}')
  })

  it('shows its refusals as form errors, and is unavailable when it doesn’t answer', async () => {
    const { fetchImpl } = fake({
      [`POST ${URL}/rollback`]: [409, { error: 'An update is already running.' }],
    })
    const service = supervisorUpdates(URL, 'secret', fetchImpl)
    await expect(service.rollback('r1')).rejects.toThrow('An update is already running.')

    const down = supervisorUpdates(
      URL,
      'secret',
      (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
      { statuses: new Map() },
    )
    expect(await down.overview()).toEqual({
      channel: 'unavailable',
      reason: "Couldn't reach cms serve: fetch failed",
    })
    await expect(down.check()).rejects.toThrow("Couldn't reach cms serve: fetch failed")
  })
})

describe('the supervisor’s status', () => {
  const URL = 'http://127.0.0.1:5000'
  const status = (job: string | null) => ({
    channel: 'serve',
    releases: [],
    job: job ? { id: 'j', kind: 'update', status: job } : null,
  })

  it('is reused for a few seconds, shared while in flight, and asked again after', async () => {
    let clock = 0
    const { calls, fetchImpl } = fake({ [`GET ${URL}/status`]: [200, status(null)] })
    const service = supervisorUpdates(URL, 'secret', fetchImpl, {
      now: () => clock,
      statuses: new Map(),
    })
    await Promise.all([service.overview(), service.overview(), service.overview()])
    expect(calls).toHaveLength(1)
    clock = 4_999
    await service.overview()
    expect(calls).toHaveLength(1)
    clock = 5_000
    await service.overview()
    expect(calls).toHaveLength(2)
  })

  it('is asked afresh while an update runs, and after an update action', async () => {
    const { calls, fetchImpl } = fake({
      [`GET ${URL}/status`]: [200, status('running')],
      [`POST ${URL}/check`]: [200, { notice: 'Checking.' }],
    })
    const service = supervisorUpdates(URL, 'secret', fetchImpl, {
      now: () => 0,
      statuses: new Map(),
    })
    await service.overview()
    await service.overview()
    expect(calls.filter((call) => call.url.endsWith('/status'))).toHaveLength(2)

    const idle = fake({
      [`GET ${URL}/status`]: [200, status(null)],
      [`POST ${URL}/check`]: [200, { notice: 'Checking.' }],
    })
    const quiet = supervisorUpdates(URL, 'secret', idle.fetchImpl, {
      now: () => 0,
      statuses: new Map(),
    })
    await quiet.overview()
    await quiet.check()
    await quiet.overview()
    expect(idle.calls.filter((call) => call.url.endsWith('/status'))).toHaveLength(2)
  })

  it('is one for the whole server, so an action in a route handler reaches the admin’s screens', async () => {
    // Next bundles route handlers and server components apart, each with its own kernel and
    // update service: here, two services for one supervisor.
    const SHARED = 'http://127.0.0.1:5001'
    const { calls, fetchImpl } = fake({
      [`GET ${SHARED}/status`]: [200, status(null)],
      [`POST ${SHARED}/check`]: [200, { notice: 'Checking.' }],
    })
    const screens = supervisorUpdates(SHARED, 'secret', fetchImpl, { now: () => 0 })
    const actions = supervisorUpdates(SHARED, 'secret', fetchImpl, { now: () => 0 })
    await screens.overview()
    await actions.overview()
    expect(calls).toHaveLength(1)
    await actions.check()
    await screens.overview()
    expect(calls.filter((call) => call.url.endsWith('/status'))).toHaveLength(2)
  })
})

describe('githubUpdates', () => {
  const DISPATCH =
    'POST https://api.github.com/repos/acme/shop/actions/workflows/cms-update.yml/dispatches'

  it('starts the workflow with the plugins asked for', async () => {
    const { calls, fetchImpl } = fake({ [DISPATCH]: [204, null] })
    const service = githubUpdates({ repository: 'acme/shop', token: 'ghp_x' }, fetchImpl)
    expect(await service.update({ packages: ['@acme/forum', 'core'] })).toBe(
      'Started the update on GitHub. It opens a pull request if there is anything to update: https://github.com/acme/shop/actions/workflows/cms-update.yml',
    )
    await service.update({ pluginsOnly: true })
    expect(calls.map((call) => JSON.parse(String(call.init.body)))).toEqual([
      { ref: 'main', inputs: { packages: '@acme/forum core', plugins_only: 'false' } },
      { ref: 'main', inputs: { packages: '', plugins_only: 'true' } },
    ])
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer ghp_x')
    expect(await service.overview()).toEqual({
      channel: 'github',
      repository: 'acme/shop',
      runsUrl: 'https://github.com/acme/shop/actions/workflows/cms-update.yml',
    })
  })

  it('explains what GitHub refused, and what it can’t do', async () => {
    const { fetchImpl } = fake({
      [DISPATCH]: [403, { message: 'Resource not accessible by integration' }],
    })
    const service = githubUpdates({ repository: 'acme/shop', token: 'ghp_x' }, fetchImpl)
    await expect(service.check()).rejects.toThrow(
      "GitHub didn't start the update workflow (403: Resource not accessible by integration).",
    )
    await expect(service.rollback('x')).rejects.toThrow('revert the update’s pull request')
    await expect(service.setAutoUpdate('patch')).rejects.toThrow("The workflow's schedule decides")
  })

  it('refuses a repository or workflow that could change the URL', () => {
    expect(() => githubUpdates({ repository: 'acme/shop/../x', token: 't' })).toThrow('owner/name')
    expect(() =>
      githubUpdates({ repository: 'acme/shop', token: 't', workflow: '../x.yml' }),
    ).toThrow('workflow file name')
  })
})

describe('updateServiceFromEnv', () => {
  it('prefers the supervisor that started the release, then GitHub, then none', () => {
    expect(updateServiceFromEnv({})).toBeUndefined()
    expect(updateServiceFromEnv({ CMS_GITHUB_REPO: 'acme/shop' })).toBeUndefined()
    expect(
      updateServiceFromEnv({ CMS_GITHUB_REPO: 'acme/shop', CMS_GITHUB_TOKEN: 't' }),
    ).toBeDefined()
    expect(
      updateServiceFromEnv({ CMS_SUPERVISOR_URL: 'http://127.0.0.1:1', CMS_SUPERVISOR_TOKEN: 't' }),
    ).toBeDefined()
  })
})
