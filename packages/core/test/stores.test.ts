import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RegistryStore } from '../src/registries'
import { ServiceStore } from '../src/services'
import { SlotStore } from '../src/slots'
import { CORE_VERSION } from '../src/version'

const open = () => undefined

describe('RegistryStore', () => {
  it('lets other plugins add to a defined registry, in order', () => {
    const store = new RegistryStore(open)
    store.define('commerce', 'commerce.gateways')
    store.view('commerce', 'commerce.gateways').add({ id: 'manual' })
    store.view('stripe', 'commerce.gateways').add({ id: 'stripe' })
    const registry = store.view('app', 'commerce.gateways')
    expect(registry.list().map((g) => g.id)).toEqual(['manual', 'stripe'])
    expect(registry.has('stripe')).toBe(true)
    expect(registry.get('paypal')).toBeUndefined()
  })

  it('names the plugin that owns a duplicate definition or item', () => {
    const store = new RegistryStore(open)
    store.define('commerce', 'commerce.gateways')
    expect(() => store.define('rogue', 'commerce.gateways')).toThrow(
      'already defined by plugin "commerce"',
    )
    store.view('stripe', 'commerce.gateways').add({ id: 'card' })
    expect(() => store.view('other', 'commerce.gateways').add({ id: 'card' })).toThrow(
      'added by plugin "stripe"',
    )
  })

  it('explains how to fix access to an undefined registry', () => {
    const store = new RegistryStore(open)
    expect(() => store.view('stripe', 'commerce.gateways')).toThrow('Add the plugin that owns it')
  })

  it('rejects items without an id', () => {
    const store = new RegistryStore(open)
    store.define('a', 'a.things')
    expect(() => store.view('a', 'a.things').add({ id: '' })).toThrow('non-empty string id')
  })
})

describe('ServiceStore', () => {
  it('provides and returns services', () => {
    const store = new ServiceStore(open)
    const commerce = { checkout: () => 'ok' }
    store.provide('commerce', 'commerce', commerce)
    expect(store.get('commerce')).toBe(commerce)
  })

  it('rejects duplicates and explains missing services', () => {
    const store = new ServiceStore(open)
    store.provide('commerce', 'commerce', {})
    expect(() => store.provide('fork', 'commerce', {})).toThrow(
      'already provided by plugin "commerce"',
    )
    expect(() => store.get('lms')).toThrow('Service "lms" is not available')
  })
})

describe('SlotStore', () => {
  it('orders fills by priority, then registration order', () => {
    const store = new SlotStore(open)
    const a = () => 'a'
    const b = () => 'b'
    const c = () => 'c'
    store.fill('commerce', 'header.nav', a)
    store.fill('social', 'header.nav', b, 5)
    store.fill('lms', 'header.nav', c)
    expect(store.get('header.nav').map((f) => f.component)).toEqual([b, a, c])
    expect(store.get('footer')).toEqual([])
  })

  it('validates slot names and components', () => {
    const store = new SlotStore(open)
    expect(() => store.fill('a', 'Header Nav', () => null)).toThrow('Invalid slot name')
    expect(() => store.fill('a', 'header', 'x' as never)).toThrow('needs a component')
  })
})

describe('CORE_VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(CORE_VERSION).toBe(pkg.version)
  })
})
