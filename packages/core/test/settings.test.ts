import type { SettingDefinition } from '@otw/sdk'
import { describe, expect, it } from 'vitest'
import {
  parseEnvValue,
  parseFormValue,
  resolveSettings,
  validateSettingDefinitions,
  type DeclaredSetting,
} from '../src/settings'

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
    expect(parseFormValue(guestCheckout, null)).toEqual({ ok: true, value: false })
    expect(parseFormValue(guestCheckout, 'on')).toEqual({ ok: true, value: true })
    expect(parseFormValue(currency, '  ')).toEqual({ ok: true, value: undefined })
    expect(parseFormValue(currency, ' EUR ')).toEqual({ ok: true, value: 'EUR' })
    expect(parseFormValue(currency, 'eur')).toEqual({ ok: false, error: 'Use a code such as USD' })
    expect(parseFormValue(layout, 'carousel')).toEqual({
      ok: false,
      error: 'Choose one of the options',
    })
    expect(parseFormValue({ type: 'text', label: 'Short', maxLength: 3 }, 'abcd')).toEqual({
      ok: false,
      error: 'Use at most 3 characters',
    })
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
