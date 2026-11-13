import { defineAdmin, type SettingPair, type User } from '@otwdesign/sdk'
import { describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '../src/kernel'
import { createDb, formPost, memoryLogger, plugin, redirectOf, signIn } from './helpers'

declare module '@otwdesign/sdk' {
  interface Settings {
    'relay.roles': readonly string[]
    'relay.enabled': boolean
    'relay.via': string
    'relay.url': string
    'relay.auth': string
    'relay.headers': readonly SettingPair[]
    'relay.template': string
    'relay.retries': string
  }
}

/** A plugin whose settings use every kind of field that isn't a plain input. */
const relay = plugin('relay', {
  name: 'Relay',
  settings: {
    'relay.roles': { type: 'roles', label: 'Who is told', default: ['administrator'] },
    'relay.enabled': { type: 'boolean', label: 'Send messages', default: false },
    'relay.via': {
      type: 'select',
      label: 'Send through',
      default: 'carrier',
      options: [
        { value: 'carrier', label: 'Carrier' },
        { value: 'http', label: 'An HTTP request' },
      ],
    },
    'relay.url': {
      type: 'text',
      label: 'URL',
      showWhen: { setting: 'relay.via', is: 'http' },
    },
    'relay.auth': {
      type: 'select',
      label: 'Authorization',
      default: 'none',
      options: [
        { value: 'none', label: 'None' },
        { value: 'headers', label: 'Custom headers' },
      ],
      showWhen: { setting: 'relay.via', is: 'http' },
    },
    'relay.headers': {
      type: 'pairs',
      label: 'Headers',
      nameLabel: 'Header',
      maxRows: 3,
      showWhen: [
        { setting: 'relay.via', is: 'http' },
        { setting: 'relay.auth', is: 'headers' },
      ],
    },
    'relay.template': {
      type: 'text',
      label: 'Body',
      multiline: true,
      maxLength: 2000,
      // Its page doesn't hold the setting it depends on.
      showWhen: { setting: 'relay.via', is: 'http' },
    },
    'relay.retries': {
      type: 'text',
      label: 'Retries',
      default: '3',
      showWhen: {
        any: [
          { setting: 'relay.enabled', is: true },
          { setting: 'relay.via', is: ['http'] },
        ],
      },
    },
  },
  setup(cms) {
    cms.auth.role('dispatcher', { label: 'Dispatcher', capabilities: ['core.access_admin'] })
  },
})
const relayAdmin = defineAdmin(relay, (cms) => {
  cms.admin.settingsPage({ name: 'settings', path: '/settings', title: 'Relay' })
  cms.admin.settingsSection({
    name: 'who',
    page: 'relay.settings',
    title: 'Who',
    fields: ['relay.roles', 'relay.enabled'],
  })
  cms.admin.settingsSection({
    name: 'sending',
    page: 'relay.settings',
    title: 'Sending',
    order: 20,
    fields: ['relay.via', 'relay.url', 'relay.auth', 'relay.headers', 'relay.retries'],
    showWhen: { setting: 'relay.enabled', is: true },
    link: { label: 'Send a test', url: cms.admin.url('/test') },
  })
  cms.admin.settingsPage({ name: 'advanced', path: '/advanced', title: 'Relay, advanced' })
  cms.admin.settingsSection({
    name: 'body',
    page: 'relay.advanced',
    title: 'Body',
    fields: ['relay.template'],
  })
})

function site() {
  const db = createDb()
  return () =>
    createKernel({
      db,
      plugins: [relay],
      admin: [relayAdmin],
      logger: memoryLogger(),
      strict: true,
      passwordHashing: 'fast',
    })
}

function view(kernel: Kernel, key: string, user: User) {
  const resolution = kernel.settingsPage(key, user)
  if (resolution.kind !== 'settings') throw new Error(`Expected a page, got ${resolution.kind}`)
  return resolution.view
}

const field = (kernel: Kernel, user: User, key: string, page = 'relay.settings') =>
  view(kernel, page, user)
    .sections.flatMap((section) => section.fields)
    .find((candidate) => candidate.key === key)!

const save = (page: string, fields: Record<string, string | readonly string[]>, cookie: string) =>
  formPost('/api/p/core/actions/save-settings', { page, ...fields }, { cookie })

describe('a roles field', () => {
  it('lists the site’s roles, plugins’ included, with the saved ones chosen', async () => {
    const kernel = await site()()
    const { user } = await signIn(kernel)
    const roles = field(kernel, user, 'relay.roles')
    expect(roles).toMatchObject({ type: 'roles', value: ['administrator'], source: 'default' })
    expect(roles.options).toContainEqual({ value: 'administrator', label: 'Administrator' })
    expect(roles.options).toContainEqual({ value: 'dispatcher', label: 'Dispatcher' })
  })

  it('saves the ticked roles, and none when none is ticked', async () => {
    const boot = site()
    let kernel = await boot()
    const { user, cookie } = await signIn(kernel)
    await kernel.handleApi(
      save(
        'relay.settings',
        { 'relay.roles': ['editor', 'dispatcher'], 'relay.via': 'carrier' },
        cookie,
      ),
    )
    kernel = await boot()
    expect(kernel.setting('relay.roles')).toEqual(['editor', 'dispatcher'])

    // None ticked is none, not the default again.
    await kernel.handleApi(save('relay.settings', { 'relay.via': 'carrier' }, cookie))
    kernel = await boot()
    expect(kernel.setting('relay.roles')).toEqual([])
    expect(field(kernel, user, 'relay.roles')).toMatchObject({ value: [], source: 'database' })
  })

  it('keeps a saved role that is no longer one listed, so it can be unticked', async () => {
    const boot = site()
    let kernel = await boot()
    const { user, cookie } = await signIn(kernel)
    await kernel.handleApi(
      save('relay.settings', { 'relay.roles': ['shop_manager'], 'relay.via': 'carrier' }, cookie),
    )
    kernel = await boot()
    expect(field(kernel, user, 'relay.roles').options).toContainEqual({
      value: 'shop_manager',
      label: 'shop_manager (no longer a role)',
    })
  })
})

describe('a pairs field', () => {
  it('saves its rows and gives them back as they were typed', async () => {
    const boot = site()
    let kernel = await boot()
    const { user, cookie } = await signIn(kernel)
    expect(field(kernel, user, 'relay.headers')).toMatchObject({
      type: 'pairs',
      columns: { name: 'Header', value: 'Value', maxRows: 3 },
    })
    const response = await kernel.handleApi(
      save(
        'relay.settings',
        {
          'relay.via': 'http',
          'relay.auth': 'headers',
          'relay.headers.name': ['X-Api-Key', 'X-Sender', ''],
          'relay.headers.value': ['env:RELAY_KEY', ' My Site ', ''],
        },
        cookie,
      ),
    )
    expect(redirectOf(kernel, response).flash?.message).toBe('Settings saved.')
    kernel = await boot()
    expect(kernel.setting('relay.headers')).toEqual([
      { name: 'X-Api-Key', value: 'env:RELAY_KEY' },
      { name: 'X-Sender', value: 'My Site' },
    ])
    expect(field(kernel, user, 'relay.headers').value).toEqual(kernel.setting('relay.headers'))
  })

  it('saves nothing when a row is wrong, and says which', async () => {
    const kernel = await site()()
    const { cookie } = await signIn(kernel)
    const response = await kernel.handleApi(
      save(
        'relay.settings',
        {
          'relay.via': 'http',
          'relay.headers.name': ['A', 'B', 'C', 'D'],
          'relay.headers.value': ['1', '2', '3', '4'],
        },
        cookie,
      ),
    )
    expect(redirectOf(kernel, response).flash).toEqual({
      kind: 'error',
      message: 'Headers: Use at most 3 rows.',
    })
    expect(await kernel.isCurrent()).toBe(true)
  })
})

describe('a multiline text field', () => {
  it('keeps its lines', async () => {
    const boot = site()
    let kernel = await boot()
    const { user, cookie } = await signIn(kernel)
    expect(field(kernel, user, 'relay.template', 'relay.advanced').multiline).toBe(true)
    await kernel.handleApi(
      save('relay.advanced', { 'relay.template': '{\r\n  "to": "{{to}}"\r\n}' }, cookie),
    )
    kernel = await boot()
    expect(kernel.setting('relay.template')).toBe('{\n  "to": "{{to}}"\n}')
  })
})

describe('showing a field or a section only when another setting says so', () => {
  it('gives the form the conditions it can follow, and whether they hold now', async () => {
    const kernel = await site()()
    const { user } = await signIn(kernel)
    expect(field(kernel, user, 'relay.via').visibility).toBeUndefined()
    expect(field(kernel, user, 'relay.url').visibility).toEqual({
      groups: [[{ setting: 'relay.via', is: 'http' }]],
      shown: false,
    })
    expect(field(kernel, user, 'relay.headers').visibility).toEqual({
      groups: [
        [
          { setting: 'relay.via', is: 'http' },
          { setting: 'relay.auth', is: 'headers' },
        ],
      ],
      shown: false,
    })
    // Any of two: sending is off and it isn't HTTP, so neither holds.
    expect(field(kernel, user, 'relay.retries').visibility).toMatchObject({
      groups: [[{ setting: 'relay.enabled', is: true }], [{ setting: 'relay.via', is: ['http'] }]],
      shown: false,
    })
    const sending = view(kernel, 'relay.settings', user).sections[1]!
    expect(sending).toMatchObject({
      title: 'Sending',
      visibility: { groups: [[{ setting: 'relay.enabled', is: true }]], shown: false },
      link: { label: 'Send a test', url: '/admin/relay/test' },
    })
  })

  it('settles a condition on a setting from another page with its saved value', async () => {
    const boot = site()
    let kernel = await boot()
    const { user, cookie } = await signIn(kernel)
    // Carrier is chosen, on the other page: the body never shows here, whatever this form does.
    expect(field(kernel, user, 'relay.template', 'relay.advanced').visibility).toEqual({
      groups: [],
      shown: false,
    })
    await kernel.handleApi(save('relay.settings', { 'relay.via': 'http' }, cookie))
    kernel = await boot()
    // HTTP is chosen: it always shows.
    expect(field(kernel, user, 'relay.template', 'relay.advanced').visibility).toBeUndefined()
  })

  it('keeps a hidden field’s value: what the form posts is saved, shown or not', async () => {
    const boot = site()
    let kernel = await boot()
    const { cookie } = await signIn(kernel)
    await kernel.handleApi(
      save(
        'relay.settings',
        { 'relay.via': 'carrier', 'relay.url': 'https://sms.example.com' },
        cookie,
      ),
    )
    kernel = await boot()
    expect(kernel.setting('relay.url')).toBe('https://sms.example.com')
  })
})
