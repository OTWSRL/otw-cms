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
    const service = supervisorUpdates(URL, 'secret', fetchImpl)
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

    const down = supervisorUpdates(URL, 'secret', (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    expect(await down.overview()).toEqual({
      channel: 'unavailable',
      reason: "Couldn't reach cms serve: fetch failed",
    })
    await expect(down.check()).rejects.toThrow("Couldn't reach cms serve: fetch failed")
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
