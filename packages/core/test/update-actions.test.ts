import { describe, expect, it } from 'vitest'
import type { UpdateRequest, UpdateService } from '../src/updates'
import { bootKernel, formPost, plugin, redirectOf, signIn } from './helpers'

/** Records what the admin asked for, as a supervisor or a GitHub workflow would receive it. */
function recordingService() {
  const calls: unknown[][] = []
  const service: UpdateService = {
    overview: async () => ({ channel: 'none' }),
    check: async () => {
      calls.push(['check'])
      return 'Checked for updates.'
    },
    update: async (request: UpdateRequest) => {
      calls.push(['update', request])
      return 'Updating.'
    },
    rollback: async (id: string) => {
      calls.push(['rollback', id])
      return 'Rolling back.'
    },
    setAutoUpdate: async (mode) => {
      calls.push(['auto', mode])
      return 'Saved.'
    },
  }
  return { calls, service }
}

const post = (name: string, fields: Record<string, string | string[]>, cookie: string) =>
  formPost(`/api/p/core/actions/${name}`, fields, { cookie })

describe('update actions', () => {
  it('pass what an administrator asks for to the site’s update service', async () => {
    const { calls, service } = recordingService()
    const kernel = await bootKernel({ plugins: [], updates: service })
    const { cookie } = await signIn(kernel)
    const flash = async (name: string, fields: Record<string, string | string[]> = {}) =>
      redirectOf(kernel, await kernel.handleApi(post(name, fields, cookie))).flash?.message

    expect(await flash('check-updates')).toBe('Checked for updates.')
    expect(await flash('update', { packages: ['@acme/forum', '@acme/lms'] })).toBe('Updating.')
    expect(await flash('update', { scope: 'plugins' })).toBe('Updating.')
    expect(await flash('update')).toBe('Updating.')
    expect(await flash('rollback-release', { release: 'r-1' })).toBe('Rolling back.')
    expect(await flash('auto-updates', { mode: 'patch' })).toBe('Saved.')
    expect(calls).toEqual([
      ['check'],
      ['update', { packages: ['@acme/forum', '@acme/lms'] }],
      ['update', { pluginsOnly: true }],
      ['update', {}],
      ['rollback', 'r-1'],
      ['auto', 'patch'],
    ])
    expect(kernel.updates).toBe(service)
  })

  it('refuse a bad automatic update mode before reaching the service', async () => {
    const { calls, service } = recordingService()
    const kernel = await bootKernel({ plugins: [], updates: service })
    const { cookie } = await signIn(kernel)
    const response = await kernel.handleApi(post('auto-updates', { mode: 'everything' }, cookie))
    expect(redirectOf(kernel, response).flash).toEqual({
      kind: 'error',
      message: 'Choose off or patch releases.',
    })
    expect(calls).toEqual([])
  })

  it('belong to administrators unless a plugin grants core.manage_updates', async () => {
    const { calls, service } = recordingService()
    const staff = plugin('staff', {
      setup(cms) {
        cms.auth.role('editor', { label: 'Editor', capabilities: ['core.access_admin'] })
        cms.auth.role('maintainer', {
          label: 'Maintainer',
          capabilities: ['core.access_admin', 'core.manage_updates'],
        })
      },
    })
    const kernel = await bootKernel({ plugins: [staff], updates: service })
    const editor = await signIn(kernel, 'editor')
    expect((await kernel.handleApi(post('update', {}, editor.cookie))).status).toBe(403)
    const maintainer = await signIn(kernel, 'maintainer')
    expect((await kernel.handleApi(post('update', {}, maintainer.cookie))).status).toBe(303)
    expect(calls).toEqual([['update', {}]])
  })

  it('explain how to update when the site has no update service', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { cookie } = await signIn(kernel)
    expect(kernel.updates).toBeNull()
    expect(redirectOf(kernel, await kernel.handleApi(post('update', {}, cookie))).flash).toEqual({
      kind: 'error',
      message:
        'Updates from the admin need the site to run under `cms serve`, or a GitHub repository. Run `cms update` on the server instead.',
    })
  })
})
