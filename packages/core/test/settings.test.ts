import type { SettingDefinition } from '@otwdesign/sdk'
import { describe, expect, it } from 'vitest'
import {
  conditionGroups,
  parseEnvValue,
  parseFormValue,
  resolveSettings,
  validateSettingDefinitions,
  type DeclaredSetting,
} from '../src/settings'

/** A posted form: a list of values is the field repeated, as checkboxes and rows post. */
function form(fields: Record<string, string | readonly string[]>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) {
    for (const item of typeof value === 'string' ? [value] : value) data.append(name, item)
  }
  return data
}

const currency: SettingDefinition = {
  type: 'text',
  label: 'Currency',
  default: 'USD',
  env: 'SHOP_CURRENCY',
  validate: (value) => (/^[A-Z]{3}$/.test(value) ? null : 'Use a code such as USD'),
}
const guestCheckout: SettingDefinition = { type: 'boolean', label: 'Guests', default: true }
const apiKey: SettingDefinition = { type: 'secret', label: 'API key', env: 'SHOP_API_KEY' }
const layout: SettingDefinition = {
  type: 'select',
  label: 'Layout',
  options: [
    { value: 'grid', label: 'Grid' },
    { value: 'list', label: 'List' },
  ],
}

const declared = (entries: Record<string, SettingDefinition>): DeclaredSetting[] =>
  Object.entries(entries).map(([key, definition]) => ({ key, pluginId: 'shop', definition }))

describe('resolveSettings', () => {
  it('prefers overrides, then env, then the database, then the default', () => {
    const settings = declared({ 'shop.currency': currency })
    const resolve = (input: Partial<Parameters<typeof resolveSettings>[0]>) =>
      resolveSettings({ declared: settings, env: {}, stored: new Map(), overrides: {}, ...input })
        .settings[0]

    expect(resolve({})).toMatchObject({ value: 'USD', source: 'default' })
    expect(resolve({ stored: new Map([['shop.currency', 'EUR']]) })).toMatchObject({
      value: 'EUR',
      source: 'database',
    })
    expect(
      resolve({ stored: new Map([['shop.currency', 'EUR']]), env: { SHOP_CURRENCY: ' GBP ' } }),
    ).toMatchObject({ value: 'GBP', source: 'env' })
    expect(
      resolve({ env: { SHOP_CURRENCY: 'GBP' }, overrides: { 'shop.currency': 'JPY' } }),
    ).toMatchObject({ value: 'JPY', source: 'override' })
  })

  it('skips invalid env and stored values with a warning instead of failing boot', () => {
    const result = resolveSettings({
      declared: declared({ 'shop.currency': currency, 'shop.guests': guestCheckout }),
      env: { SHOP_CURRENCY: 'dollars' },
      stored: new Map<string, unknown>([
        ['shop.currency', 'EUR'],
        ['shop.guests', 'yes please'],
      ]),
      overrides: {},
    })
    expect(result.values).toEqual({ 'shop.currency': 'EUR', 'shop.guests': true })
    expect(result.warnings).toEqual([
      'Ignoring SHOP_CURRENCY for "shop.currency": Use a code such as USD',
      'Ignoring the stored value of "shop.guests": Must be on or off',
    ])
  })

  it('reads secrets from the environment only', () => {
    const result = resolveSettings({
      declared: declared({ 'shop.apiKey': apiKey }),
      env: {},
      stored: new Map([['shop.apiKey', 'sk_from_db']]),
      overrides: {},
    })
    expect(result.settings[0]).toMatchObject({ value: undefined, source: 'unset' })
    expect(
      resolveSettings({
        declared: declared({ 'shop.apiKey': apiKey }),
        env: { SHOP_API_KEY: 'sk_env' },
        stored: new Map(),
        overrides: {},
      }).values,
    ).toEqual({ 'shop.apiKey': 'sk_env' })
  })
})

describe('parsing', () => {
  it.each([
    ['true', true],
    ['ON', true],
    ['1', true],
    ['no', false],
    ['0', false],
  ])('reads boolean env value %s', (raw, value) => {
    expect(parseEnvValue(guestCheckout, raw)).toEqual({ ok: true, value })
  })

  it('rejects an unclear boolean env value', () => {
    expect(parseEnvValue(guestCheckout, 'maybe')).toEqual({ ok: false, error: 'Use true or false' })
  })

  it('reads form fields: absent checkboxes are off, blank text falls back to the default', () => {
    const read = (definition: SettingDefinition, value: string | null) =>
      parseFormValue(definition, form(value === null ? {} : { field: value }), 'field')
    expect(read(guestCheckout, null)).toEqual({ ok: true, value: false })
    expect(read(guestCheckout, 'on')).toEqual({ ok: true, value: true })
    expect(read(currency, '  ')).toEqual({ ok: true, value: undefined })
    expect(read(currency, ' EUR ')).toEqual({ ok: true, value: 'EUR' })
    expect(read(currency, 'eur')).toEqual({ ok: false, error: 'Use a code such as USD' })
    expect(read(layout, 'carousel')).toEqual({ ok: false, error: 'Choose one of the options' })
    expect(read({ type: 'text', label: 'Short', maxLength: 3 }, 'abcd')).toEqual({
      ok: false,
      error: 'Use at most 3 characters',
    })
  })

  it('keeps a text setting to one line unless it is multiline', () => {
    const read = (definition: SettingDefinition, value: string) =>
      parseFormValue(definition, form({ field: value }), 'field')
    expect(read({ type: 'text', label: 'Name' }, 'one\ntwo')).toEqual({
      ok: false,
      error: 'Must be one line',
    })
    // A browser posts a textarea's line breaks as CRLF.
    expect(read({ type: 'text', label: 'Body', multiline: true }, ' {\r\n  "to": 1\r\n} ')).toEqual(
      {
        ok: true,
        value: '{\n  "to": 1\n}',
      },
    )
  })
})

describe('a roles setting', () => {
  const roles: SettingDefinition = { type: 'roles', label: 'Who' }

  it('reads the ticked roles from a form, and none ticked as none', () => {
    expect(parseFormValue(roles, form({ who: ['editor', 'administrator'] }), 'who')).toEqual({
      ok: true,
      value: ['editor', 'administrator'],
    })
    expect(parseFormValue(roles, form({}), 'who')).toEqual({ ok: true, value: [] })
    expect(parseFormValue(roles, form({ who: ['Editor', 'editor', ' '] }), 'who')).toEqual({
      ok: true,
      value: ['editor'],
    })
    expect(parseFormValue(roles, form({ who: ['not a role!'] }), 'who')).toEqual({
      ok: false,
      error: 'Choose from the roles',
    })
  })

  it('reads ids separated by commas from the environment, and from a value stored as text', () => {
    expect(parseEnvValue(roles, 'administrator, editor')).toEqual({
      ok: true,
      value: ['administrator', 'editor'],
    })
    const resolved = resolveSettings({
      declared: [{ key: 'shop.who', pluginId: 'shop', definition: roles }],
      env: {},
      // What a text setting that became a roles setting had saved.
      stored: new Map([['shop.who', 'administrator editor']]),
      overrides: {},
    })
    expect(resolved.values['shop.who']).toEqual(['administrator', 'editor'])
    expect(resolved.warnings).toEqual([])
  })
})

describe('a pairs setting', () => {
  const headers: SettingDefinition = {
    type: 'pairs',
    label: 'Headers',
    maxRows: 2,
    validate: (pairs) =>
      pairs.some((pair) => pair.name === 'Host') ? 'Host is set for you' : null,
  }
  const read = (rows: [string, string][]) =>
    parseFormValue(
      headers,
      form({ 'h.name': rows.map(([name]) => name), 'h.value': rows.map(([, value]) => value) }),
      'h',
    )

  it('reads its rows from a form, trimmed, without the ones left empty', () => {
    expect(
      read([
        [' X-Key ', ' abc '],
        ['', ''],
      ]),
    ).toEqual({
      ok: true,
      value: [{ name: 'X-Key', value: 'abc' }],
    })
    expect(read([])).toEqual({ ok: true, value: [] })
    // A name alone is a row: a header may be empty.
    expect(read([['X-Empty', '']])).toEqual({ ok: true, value: [{ name: 'X-Empty', value: '' }] })
  })

  it('refuses a value with no name, too many rows, and what its own check refuses', () => {
    expect(read([['', 'abc']])).toEqual({
      ok: false,
      error: 'Give "abc" a name, or remove its row',
    })
    expect(
      read([
        ['A', '1'],
        ['B', '2'],
        ['C', '3'],
      ]),
    ).toEqual({
      ok: false,
      error: 'Use at most 2 rows',
    })
    expect(read([['Host', 'example.com']])).toEqual({ ok: false, error: 'Host is set for you' })
    expect(read([['A', 'x'.repeat(2001)]])).toEqual({ ok: false, error: 'A row is too long' })
  })

  it('can’t come from the environment', () => {
    expect(
      validateSettingDefinitions('shop.', {
        'shop.headers': { type: 'pairs', label: 'Headers', env: 'SHOP_HEADERS' },
      } as never),
    ).toEqual([
      'setting "shop.headers" is rows of pairs, which an environment variable can\'t hold',
    ])
  })
})

describe('showing a setting only when another has a value', () => {
  const declared = (showWhen: SettingDefinition['showWhen']) => [
    { key: 'shop.gateway', pluginId: 'shop', definition: layout },
    { key: 'shop.live', pluginId: 'shop', definition: guestCheckout },
    {
      key: 'shop.key',
      pluginId: 'shop',
      definition: { type: 'text', label: 'Key', showWhen } as SettingDefinition,
    },
  ]
  const warnings = (showWhen: SettingDefinition['showWhen']) =>
    resolveSettings({ declared: declared(showWhen), env: {}, stored: new Map(), overrides: {} })
      .warnings

  it('reads one condition, several that must all hold, or any of several groups', () => {
    const one = { setting: 'shop.gateway', is: 'grid' } as const
    const two = { setting: 'shop.live', is: true } as const
    expect(conditionGroups(undefined)).toEqual([])
    expect(conditionGroups(one as never)).toEqual([[one]])
    expect(conditionGroups([one, two] as never)).toEqual([[one, two]])
    expect(conditionGroups({ any: [one, [one, two]] } as never)).toEqual([[one], [one, two]])
  })

  it('warns about a condition on a setting that isn’t a choice, or isn’t there', () => {
    expect(warnings({ setting: 'shop.gateway', is: 'grid' } as never)).toEqual([])
    expect(warnings({ setting: 'shop.live', is: true } as never)).toEqual([])
    expect(warnings({ setting: 'shop.gone', is: 'x' } as never)).toEqual([
      'Setting "shop.key" shows when "shop.gone" has a value, but that isn\'t a select or a checkbox setting of an active plugin',
    ])
  })
})

describe('validateSettingDefinitions', () => {
  it('requires the plugin prefix, valid env names and coherent select defaults', () => {
    expect(
      validateSettingDefinitions('shop.', {
        'other.currency': { type: 'text', label: 'X' },
        'shop.key': { type: 'secret', label: 'Key', env: 'lower-case' },
        'shop.layout': { ...layout, default: 'carousel' },
      } as never),
    ).toEqual([
      'setting "other.currency" must start with "shop."',
      'setting "shop.key" has an invalid env name "lower-case"',
      'setting "shop.layout" default is not one of its options',
    ])
  })
})
