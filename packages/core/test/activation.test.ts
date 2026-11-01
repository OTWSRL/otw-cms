import type { PluginDefinition } from '@otw/sdk'
import { describe, expect, it } from 'vitest'
import { createKernel, type KernelOptions } from '../src/kernel'
import { createDb, formPost, memoryLogger, plugin, redirectOf, signIn } from './helpers'

const base = plugin('commerce', { name: 'Commerce' })
const addon = plugin('stripe', { name: 'Stripe', requires: { commerce: '^1.0.0' } })
const broken = plugin('broken', {
  name: 'Broken',
  setup() {
    throw new Error('boom')
  },
})

/** Several boots on one database, like several requests or instances of the app. */
function site(plugins: PluginDefinition[], extra: Partial<KernelOptions> = {}) {
  const db = createDb()
  const changes: number[] = []
  const boot = (overrides: Partial<KernelOptions> = {}) =>
    createKernel({
      db,
      plugins,
      logger: memoryLogger(),
      passwordHashing: 'fast',
      onChange: () => void changes.push(Date.now()),
      ...extra,
      ...overrides,
    })
  return { boot, changes }
}

const post = (name: string, plugin: string, cookie: string) =>
  formPost(`/api/p/core/actions/${name}`, { plugin }, { cookie })

describe('plugin activation', () => {
  it('starts with every installed plugin active and keeps the choice in the database', async () => {
    const { boot } = site([base, addon])
    const kernel = await boot()
    expect(kernel.activation).toBe('database')
    expect(kernel.active).toEqual(['commerce', 'stripe'])
    expect(kernel.plugins().map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'commerce', status: 'active' },
      { id: 'stripe', status: 'active' },
    ])
  })

  it('starts plugins installed after the first boot inactive, as WordPress does', async () => {
    const db = createDb()
    const boot = (plugins: PluginDefinition[]) =>
      createKernel({ db, plugins, logger: memoryLogger(), strict: true })
    await boot([base])
    expect((await boot([base, addon])).active).toEqual(['commerce'])
  })

  it('deactivates and reactivates in dependency order, invalidating running kernels', async () => {
    const { boot, changes } = site([base, addon])
    const kernel = await boot()
    const { cookie } = await signIn(kernel)

    const blocked = await kernel.handleApi(post('deactivate-plugin', 'commerce', cookie))
    expect(redirectOf(kernel, blocked).flash).toEqual({
      kind: 'error',
      message: 'Stripe requires it. Deactivate that first.',
    })
    expect(await kernel.isCurrent()).toBe(true)

    for (const id of ['stripe', 'commerce']) {
      const response = await kernel.handleApi(post('deactivate-plugin', id, cookie))
      expect(redirectOf(kernel, response).flash?.kind).toBe('notice')
    }
    expect(changes).toHaveLength(2)
    expect(await kernel.isCurrent()).toBe(false)
    expect((await boot()).active).toEqual([])

    const early = await kernel.handleApi(post('activate-plugin', 'stripe', cookie))
    expect(redirectOf(kernel, early).flash).toEqual({
      kind: 'error',
      message: 'Activate Commerce first.',
    })

    for (const id of ['commerce', 'stripe']) {
      const response = await kernel.handleApi(post('activate-plugin', id, cookie))
      expect(redirectOf(kernel, response).flash).toEqual({
        kind: 'notice',
        message: `${id === 'commerce' ? 'Commerce' : 'Stripe'} activated.`,
      })
    }
    expect((await boot()).active).toEqual(['commerce', 'stripe'])
  })

  it('keeps a plugin off when it fails to boot during activation', async () => {
    const { boot, changes } = site([base, broken], { active: undefined })
    const first = await boot({ strict: false })
    const { cookie } = await signIn(first)
    // Recovery mode kept the site up; switch the broken plugin off, then try to turn it on.
    expect(first.plugins().find((p) => p.id === 'broken')).toMatchObject({
      status: 'failed',
      reason: 'Plugin "broken" failed during setup: boom',
    })
    await first.handleApi(post('deactivate-plugin', 'broken', cookie))

    const kernel = await boot({ strict: false })
    const response = await kernel.handleApi(post('activate-plugin', 'broken', cookie))
    expect(redirectOf(kernel, response).flash).toEqual({
      kind: 'error',
      message: 'Broken could not be activated. Plugin "broken" failed during setup: boom',
    })
    expect(changes).toHaveLength(1)
    expect((await boot({ strict: false })).plugins().find((p) => p.id === 'broken')?.status).toBe(
      'inactive',
    )
  })

  it('explains blockers on the plugins screen', async () => {
    const { boot } = site([base, addon])
    await boot()
    // Installed after the first boot, so it starts inactive.
    const future = plugin('future', { requires: { core: '^9.0.0' } })
    const kernel = await boot({ plugins: [base, addon, future] })
    const blockers = Object.fromEntries(kernel.plugins().map((p) => [p.id, p.blockers]))
    expect(blockers).toEqual({
      commerce: ['Stripe requires it. Deactivate that first.'],
      stripe: [],
      future: ['Requires core ^9.0.0; this site runs 0.1.0.'],
    })
  })

  it('refuses changes when activation is pinned by configuration', async () => {
    const { boot } = site([base, addon], { active: ['commerce'] })
    const kernel = await boot()
    expect(kernel.activation).toBe('pinned')
    const { cookie } = await signIn(kernel)
    const response = await kernel.handleApi(post('activate-plugin', 'stripe', cookie))
    expect(redirectOf(kernel, response).flash?.message).toMatch(/site configuration/)
  })

  it('is limited to users who may manage plugins', async () => {
    const { boot } = site([base])
    const kernel = await boot()
    const { cookie } = await signIn(kernel, 'customer')
    expect((await kernel.handleApi(post('deactivate-plugin', 'commerce', cookie))).status).toBe(403)
  })
})
