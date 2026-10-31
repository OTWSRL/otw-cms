import { describe, expect, it } from 'vitest'
import { createKernel, type KernelOptions } from '../src/kernel'
import { createDb, formPost, memoryLogger, plugin, redirectOf, signIn } from './helpers'

declare module '@cms/sdk' {
  interface Settings {
    'shop.currency': string
    'shop.guests': boolean
    'shop.apiKey': string
  }
}

const shop = plugin('shop', {
  name: 'Shop',
  settings: {
    'shop.currency': {
      type: 'text',
      label: 'Currency',
      default: 'USD',
      env: 'SHOP_CURRENCY',
      validate: (value) => (/^[A-Z]{3}$/.test(value) ? null : 'Use a code such as USD'),
    },
    'shop.guests': { type: 'boolean', label: 'Guest checkout', default: true },
    'shop.apiKey': { type: 'secret', label: 'API key', env: 'SHOP_API_KEY' },
  },
})

function site(extra: Partial<KernelOptions> = {}) {
  const db = createDb()
  return () =>
    createKernel({
      db,
      plugins: [shop],
      logger: memoryLogger(),
      strict: true,
      passwordHashing: 'fast',
      ...extra,
    })
}

const save = (section: string, fields: Record<string, string>, cookie: string) =>
  formPost('/api/p/core/actions/save-settings', { section, ...fields }, { cookie })

describe('settings in the admin', () => {
  it('lists core and plugin settings with their sources, never revealing secrets', async () => {
    const kernel = await site({ env: { SHOP_API_KEY: 'sk_live_secret' } })()
    const sections = kernel.settingsSections()
    expect(sections.map((section) => section.label)).toEqual(['General', 'Shop'])
    expect(sections[1]!.fields).toEqual([
      expect.objectContaining({
        key: 'shop.currency',
        value: 'USD',
        source: 'default',
        locked: false,
      }),
      expect.objectContaining({
        key: 'shop.guests',
        value: true,
        source: 'default',
        locked: false,
      }),
      expect.objectContaining({
        key: 'shop.apiKey',
        configured: true,
        source: 'env',
        locked: true,
      }),
    ])
    expect(JSON.stringify(sections)).not.toContain('sk_live_secret')
  })

  it('saves a section and applies it on the next boot', async () => {
    const boot = site()
    const kernel = await boot()
    const { cookie } = await signIn(kernel)

    // The unchecked checkbox is simply absent from the form.
    const response = await kernel.handleApi(save('shop', { 'shop.currency': ' EUR ' }, cookie))
    expect(redirectOf(kernel, response).flash).toEqual({
      kind: 'notice',
      message: 'Settings saved.',
    })
    expect(await kernel.isCurrent()).toBe(false)

    const next = await boot()
    expect(next.setting('shop.currency')).toBe('EUR')
    expect(next.setting('shop.guests')).toBe(false)

    // A blank field goes back to the default.
    await next.handleApi(save('shop', { 'shop.currency': '', 'shop.guests': 'on' }, cookie))
    const third = await boot()
    expect(third.setting('shop.currency')).toBe('USD')
    expect(third.setting('shop.guests')).toBe(true)
  })

  it('saves nothing when one field is invalid', async () => {
    const boot = site()
    const kernel = await boot()
    const { cookie } = await signIn(kernel)
    const response = await kernel.handleApi(save('shop', { 'shop.currency': 'euros' }, cookie))
    expect(redirectOf(kernel, response).flash).toEqual({
      kind: 'error',
      message: 'Currency: Use a code such as USD.',
    })
    expect(await kernel.isCurrent()).toBe(true)
    expect((await boot()).setting('shop.guests')).toBe(true)
  })

  it('leaves values set by the environment alone', async () => {
    const boot = site({ env: { SHOP_CURRENCY: 'GBP' } })
    const kernel = await boot()
    const { cookie } = await signIn(kernel)
    await kernel.handleApi(save('shop', { 'shop.currency': 'EUR', 'shop.apiKey': 'sk_x' }, cookie))
    const next = await boot()
    expect(next.setting('shop.currency')).toBe('GBP')
    expect(next.setting('shop.apiKey')).toBeUndefined()
  })

  it('is limited to users who may change settings', async () => {
    const kernel = await site()()
    const { cookie } = await signIn(kernel, 'customer')
    expect((await kernel.handleApi(save('shop', {}, cookie))).status).toBe(403)
  })
})
