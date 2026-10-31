import type { PluginDefinition, User } from '@cms/sdk'
import { describe, expect, it } from 'vitest'
import { createKernel, type Kernel, type KernelOptions } from '../src/kernel'
import { createDb, formPost, memoryLogger, plugin, redirectOf, signIn } from './helpers'

declare module '@cms/sdk' {
  interface Settings {
    'shop.currency': string
    'shop.guests': boolean
    'shop.apiKey': string
    'gateway.enabled': boolean
    'gateway.label': string
    'seo.separator': string
    'badges.enabled': boolean
    'badges.title': string
  }
  interface Capabilities {
    'shop.manage_settings': true
  }
  interface Services {
    'ledger.books': { currency(): string | undefined }
  }
}

const shopSettings = {
  'shop.currency': {
    type: 'text',
    label: 'Currency',
    default: 'USD',
    env: 'SHOP_CURRENCY',
    validate: (value: string) => (/^[A-Z]{3}$/.test(value) ? null : 'Use a code such as USD'),
  },
  'shop.guests': { type: 'boolean', label: 'Guest checkout', default: true },
  'shop.apiKey': { type: 'secret', label: 'API key', env: 'SHOP_API_KEY' },
} as const

/** Declares settings and nothing else: core gives it a page. */
const plainShop = plugin('shop', { name: 'Shop', settings: shopSettings })

/** A WooCommerce-style plugin with its own settings page that others extend. */
const shop = plugin('shop', {
  name: 'Shop',
  settings: shopSettings,
  setup(cms) {
    // A value that only fails once the plugin uses it, which field validation can't see.
    if (cms.settings.get('shop.currency') === 'XXX') throw new Error('XXX is not a real currency')
    cms.auth.capability('shop.manage_settings', { label: 'Shop settings', roles: ['shop_manager'] })
    cms.auth.role('shop_manager', { label: 'Shop manager', capabilities: ['core.access_admin'] })
    cms.admin.settingsPage({
      name: 'store',
      path: '/settings',
      title: 'Store',
      capability: 'shop.manage_settings',
    })
    cms.admin.settingsSection({
      name: 'checkout',
      page: 'shop.store',
      title: 'Checkout',
      fields: ['shop.currency', 'shop.guests'],
    })
  },
})

/** Adds a section to the shop's page, like a payment gateway on WooCommerce's Payments tab. */
const gateway = plugin('gateway', {
  name: 'Gateway',
  requires: { shop: '^1.0.0' },
  settings: {
    'gateway.enabled': { type: 'boolean', label: 'Accept payments', default: true },
    'gateway.label': { type: 'text', label: 'Label at checkout', default: 'Card' },
  },
  setup(cms) {
    cms.admin.settingsSection({
      name: 'gateway',
      page: 'shop.store',
      title: 'Gateway',
      order: 5,
      fields: ['gateway.enabled', 'gateway.label'],
    })
  },
})

/** Adds one field to core's General › Site, like add_settings_field() on 'general'. */
const seo = plugin('seo', {
  name: 'SEO',
  settings: { 'seo.separator': { type: 'text', label: 'Title separator', default: '·' } },
  setup(cms) {
    cms.admin.settingsFields({ section: 'core.site', fields: ['seo.separator'] })
  },
})

function site(extra: Partial<KernelOptions> = {}) {
  const db = createDb()
  return () =>
    createKernel({
      db,
      plugins: [shop, gateway, seo],
      logger: memoryLogger(),
      strict: true,
      passwordHashing: 'fast',
      ...extra,
    })
}

const save = (page: string, fields: Record<string, string>, cookie: string) =>
  formPost('/api/p/core/actions/save-settings', { page, ...fields }, { cookie })

function view(kernel: Kernel, key: string, user: User) {
  const resolution = kernel.settingsPage(key, user)
  if (resolution.kind !== 'settings') throw new Error(`Expected a page, got ${resolution.kind}`)
  return resolution.view
}

const layout = (kernel: Kernel, key: string, user: User) =>
  view(kernel, key, user).sections.map((section) => ({
    title: section.title,
    fields: section.fields.map((field) => field.key),
  }))

describe('settings pages', () => {
  it('gives a plugin that only declares settings its own page under Settings', async () => {
    const kernel = await site({ plugins: [plainShop], env: { SHOP_API_KEY: 'sk_live_secret' } })()
    const { user } = await signIn(kernel)

    const page = view(kernel, 'shop.settings', user)
    expect(page.title).toBe('Shop')
    expect(page.sections).toHaveLength(1)
    expect(page.sections[0]!.fields).toEqual([
      expect.objectContaining({ key: 'shop.currency', value: 'USD', source: 'default' }),
      expect.objectContaining({ key: 'shop.guests', value: true, locked: false }),
      expect.objectContaining({ key: 'shop.apiKey', configured: true, locked: true }),
    ])
    expect(JSON.stringify(page)).not.toContain('sk_live_secret')
    expect(await kernel.resolveAdminPage('/admin/shop/settings', {}, user)).toMatchObject({
      kind: 'settings',
      key: 'shop.settings',
    })
    expect(kernel.adminMenu(user).find((section) => section.id === 'settings')?.items).toEqual([
      { key: 'core.general', label: 'General', url: '/admin/settings' },
      { key: 'shop.settings', label: 'Shop', url: '/admin/shop/settings' },
    ])
  })

  it('places sections and fields on other plugins’ pages, and leftovers on the owner’s', async () => {
    const kernel = await site()()
    const { user } = await signIn(kernel)

    expect(layout(kernel, 'core.general', user)).toEqual([
      { title: 'Site', fields: ['site.title', 'site.url', 'site.locale', 'seo.separator'] },
    ])
    expect(layout(kernel, 'shop.store', user)).toEqual([
      { title: 'Gateway', fields: ['gateway.enabled', 'gateway.label'] },
      { title: 'Checkout', fields: ['shop.currency', 'shop.guests'] },
      // Declared but not placed: shown last on the shop's own page rather than hidden.
      { title: 'Shop', fields: ['shop.apiKey'] },
    ])
    expect(kernel.warnings).toEqual([])
  })

  it('drops a deactivated plugin’s fields from every page', async () => {
    const kernel = await site({ active: ['shop', 'seo'] })()
    const { user } = await signIn(kernel)
    expect(layout(kernel, 'shop.store', user).map((section) => section.title)).toEqual([
      'Checkout',
      'Shop',
    ])
  })

  it('moves sections aimed at an inactive plugin’s page to the owner’s page', async () => {
    const badges = plugin('badges', {
      name: 'Badges',
      optional: { forum: '^1.0.0' },
      settings: {
        'badges.enabled': { type: 'boolean', label: 'Award badges' },
        'badges.title': { type: 'text', label: 'Badge title' },
      },
      setup(cms) {
        cms.admin.settingsSection({
          name: 'forum',
          page: 'forum.settings',
          title: 'Forum badges',
          fields: ['badges.enabled'],
        })
        cms.admin.settingsSection({
          name: 'typo',
          page: 'shop.stor',
          title: 'Shop badges',
          fields: ['badges.title'],
        })
      },
    })
    const kernel = await site({ plugins: [shop, badges] })()
    const { user } = await signIn(kernel)

    expect(layout(kernel, 'badges.settings', user)).toEqual([
      { title: 'Forum badges', fields: ['badges.enabled'] },
      { title: 'Shop badges', fields: ['badges.title'] },
    ])
    // The forum isn't installed here, so only the typo on an active plugin is reported.
    expect(kernel.warnings).toEqual([
      'Settings section "badges.typo" names unknown page "shop.stor"',
    ])
  })

  it('lets a plugin place only its own settings, once', async () => {
    const thief = plugin('thief', {
      requires: { shop: '^1.0.0' },
      setup(cms) {
        cms.admin.settingsFields({ section: 'shop.checkout', fields: ['shop.apiKey'] })
      },
    })
    await expect(site({ plugins: [shop, thief] })()).rejects.toThrow(
      'Plugin "thief" can only place its own settings, not "shop.apiKey"',
    )

    const twice = plugin('shop', {
      settings: shopSettings,
      setup(cms) {
        cms.admin.settingsSection({
          name: 'a',
          page: 'core.general',
          title: 'A',
          fields: ['shop.currency'],
        })
        cms.admin.settingsFields({ section: 'core.site', fields: ['shop.currency'] })
      },
    })
    await expect(site({ plugins: [twice] })()).rejects.toThrow(
      'Setting "shop.currency" is already placed in "shop.a"',
    )
  })

  it('opens each page to users with that page’s capability only', async () => {
    const kernel = await site()()
    const { user } = await signIn(kernel, 'shop_manager')

    expect(kernel.settingsPage('shop.store', user).kind).toBe('settings')
    expect(kernel.settingsPage('core.general', user).kind).toBe('forbidden')
    expect(kernel.settingsPage('nope.page', user).kind).toBe('not-found')
    expect(kernel.adminMenu(user).find((section) => section.id === 'settings')?.items).toEqual([
      { key: 'shop.store', label: 'Store', url: '/admin/shop/settings' },
    ])
  })
})

describe('saving settings pages', () => {
  it('saves the page and applies it on the next boot', async () => {
    const boot = site()
    const kernel = await boot()
    const { cookie } = await signIn(kernel)

    // The unchecked checkbox is simply absent from the form.
    const response = await kernel.handleApi(
      save('shop.store', { 'shop.currency': ' EUR ', 'gateway.label': 'Visa' }, cookie),
    )
    expect(redirectOf(kernel, response).flash).toEqual({
      kind: 'notice',
      message: 'Settings saved.',
    })
    expect(await kernel.isCurrent()).toBe(false)

    const next = await boot()
    expect(next.setting('shop.currency')).toBe('EUR')
    expect(next.setting('shop.guests')).toBe(false)
    expect(next.setting('gateway.label')).toBe('Visa')
    expect(next.setting('gateway.enabled')).toBe(false)

    // A blank field goes back to the default.
    await next.handleApi(
      save('shop.store', { 'shop.currency': '', 'shop.guests': 'on', 'gateway.label': '' }, cookie),
    )
    const third = await boot()
    expect(third.setting('shop.currency')).toBe('USD')
    expect(third.setting('shop.guests')).toBe(true)
    expect(third.setting('gateway.label')).toBe('Card')
  })

  it('saves only fields placed on that page, whatever the form sends', async () => {
    const boot = site()
    const kernel = await boot()
    const { cookie } = await signIn(kernel, 'shop_manager')
    const response = await kernel.handleApi(
      save('shop.store', { 'shop.currency': 'EUR', 'site.title': 'Hijacked' }, cookie),
    )
    expect(response.status).toBe(303)
    const next = await boot()
    expect(next.setting('shop.currency')).toBe('EUR')
    expect(next.setting('site.title')).toBe('Next CMS')
  })

  it('refuses pages the user may not change', async () => {
    const kernel = await site()()
    const manager = await signIn(kernel, 'shop_manager')
    const forbidden = await kernel.handleApi(
      save('core.general', { 'site.title': 'Hijacked' }, manager.cookie),
    )
    expect(forbidden.status).toBe(403)
    expect(await kernel.isCurrent()).toBe(true)

    const customer = await signIn(kernel, 'customer')
    expect((await kernel.handleApi(save('shop.store', {}, customer.cookie))).status).toBe(403)
  })

  it('saves nothing when one field is invalid', async () => {
    const boot = site()
    const kernel = await boot()
    const { cookie } = await signIn(kernel)
    const response = await kernel.handleApi(
      save('shop.store', { 'gateway.label': 'Visa', 'shop.currency': 'euros' }, cookie),
    )
    expect(redirectOf(kernel, response).flash).toEqual({
      kind: 'error',
      message: 'Currency: Use a code such as USD.',
    })
    expect(await kernel.isCurrent()).toBe(true)
    expect((await boot()).setting('gateway.label')).toBe('Card')
  })

  it('saves nothing when a plugin cannot start with the new values', async () => {
    const boot = site()
    const kernel = await boot()
    const { cookie } = await signIn(kernel)
    const response = await kernel.handleApi(
      save('shop.store', { 'shop.currency': 'XXX', 'shop.guests': 'on' }, cookie),
    )
    expect(redirectOf(kernel, response).flash).toEqual({
      kind: 'error',
      message:
        'Settings not saved: Shop could not start with them. Plugin "shop" failed during setup: XXX is not a real currency',
    })
    expect(await kernel.isCurrent()).toBe(true)
    expect((await boot()).setting('shop.currency')).toBe('USD')
  })

  it('trial-boots only the plugins that read a changed setting at startup', async () => {
    const setups = { shop: 0, watcher: 0, extra: 0, bystander: 0 }
    const counted = (id: keyof typeof setups, definition: Partial<PluginDefinition> = {}) =>
      plugin(id, {
        ...definition,
        async setup(cms) {
          setups[id] += 1
          await definition.setup?.(cms)
        },
      })
    // Reads the shop's currency at startup, with an optional dependency that is active.
    const watcher = counted('watcher', {
      optional: { extra: '^1.0.0' },
      setup(cms) {
        cms.settings.get('shop.currency')
      },
    })
    const boot = site({
      plugins: [counted('shop', shop), watcher, counted('extra'), counted('bystander')],
    })
    const kernel = await boot()
    const { cookie } = await signIn(kernel)
    expect(setups).toEqual({ shop: 1, watcher: 1, extra: 1, bystander: 1 })

    await kernel.handleApi(save('shop.store', { 'shop.currency': 'EUR' }, cookie))
    expect(setups).toEqual({ shop: 2, watcher: 2, extra: 2, bystander: 1 })
    expect((await boot()).setting('shop.currency')).toBe('EUR')
  })

  it('saves without a trial boot when no plugin reads the changed settings at startup', async () => {
    let setups = 0
    const kernel = await site({
      plugins: [{ ...shop, setup: (cms) => ((setups += 1), shop.setup!(cms)) }],
    })()
    const { cookie } = await signIn(kernel)

    // Guest checkout is read per request, so no startup can fail on it; the currency is unchanged.
    const response = await kernel.handleApi(
      save('shop.store', { 'shop.currency': 'USD', 'shop.guests': 'on' }, cookie),
    )
    expect(response.status).toBe(303)
    expect(setups).toBe(1)
  })

  it('counts reads through another plugin’s service as the reader’s', async () => {
    const reporter = plugin('reporter', {
      name: 'Reporter',
      requires: { ledger: '^1.0.0' },
      setup(cms) {
        if (cms.services.get('ledger.books').currency() === 'JPY') {
          throw new Error('Reports need a currency with cents')
        }
      },
    })
    const ledger = plugin('ledger', {
      setup(cms) {
        cms.services.provide('ledger.books', { currency: () => cms.settings.get('shop.currency') })
      },
    })
    const kernel = await site({ plugins: [shop, ledger, reporter] })()
    const { cookie } = await signIn(kernel)
    const response = await kernel.handleApi(save('shop.store', { 'shop.currency': 'JPY' }, cookie))
    expect(redirectOf(kernel, response).flash).toEqual({
      kind: 'error',
      message:
        'Settings not saved: Reporter could not start with them. Plugin "reporter" failed during setup: Reports need a currency with cents',
    })
  })

  it('keeps trial boots out of the log unless something fails', async () => {
    const logger = memoryLogger()
    const noisy = plugin('noisy', {
      setup: (cms) => cms.logger.warn('Not configured yet'),
    })
    const kernel = await site({ plugins: [shop, noisy], logger })()
    const { cookie } = await signIn(kernel)
    const warnings = () => logger.entries.filter((entry) => entry.level === 'warn').length
    expect(warnings()).toBe(1)

    await kernel.handleApi(save('shop.store', { 'shop.currency': 'EUR' }, cookie))
    expect(warnings()).toBe(1)
    await kernel.handleApi(save('shop.store', { 'shop.currency': 'XXX' }, cookie))
    expect(logger.entries.filter((entry) => entry.level === 'error')).toEqual([
      expect.objectContaining({ message: 'Booting without plugin "shop"' }),
    ])
  })

  it('leaves values set by the environment alone', async () => {
    const boot = site({ env: { SHOP_CURRENCY: 'GBP' } })
    const kernel = await boot()
    const { cookie } = await signIn(kernel)
    await kernel.handleApi(
      save('shop.store', { 'shop.currency': 'EUR', 'shop.apiKey': 'sk_x' }, cookie),
    )
    const next = await boot()
    expect(next.setting('shop.currency')).toBe('GBP')
    expect(next.setting('shop.apiKey')).toBeUndefined()
  })

  it('explains a page with nothing to save, and an unknown page', async () => {
    const lockedOnly = plugin('shop', {
      settings: { 'shop.apiKey': shopSettings['shop.apiKey'] },
    }) satisfies PluginDefinition
    const kernel = await site({ plugins: [lockedOnly] })()
    const { cookie } = await signIn(kernel)
    const flash = async (page: string) =>
      redirectOf(kernel, await kernel.handleApi(save(page, {}, cookie))).flash
    expect(await flash('shop.settings')).toEqual({
      kind: 'error',
      message: 'There is nothing to save on this page.',
    })
    expect(await flash('nope.page')).toEqual({
      kind: 'error',
      message: 'That settings page does not exist.',
    })
  })
})
