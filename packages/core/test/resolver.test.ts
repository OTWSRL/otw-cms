import { describe, expect, it } from 'vitest'
import { resolvePlugins, validatePlugin } from '../src/resolver'
import { plugin } from './helpers'

const ids = (resolution: ReturnType<typeof resolvePlugins>) => resolution.order.map((p) => p.id)
const reason = (resolution: ReturnType<typeof resolvePlugins>, id: string) =>
  resolution.skipped.find((s) => s.id === id)?.reason

describe('resolvePlugins', () => {
  it('loads dependencies before dependents, alphabetically among equals', () => {
    const installed = [
      plugin('stripe', { requires: { commerce: '^1.0.0' } }),
      plugin('commerce'),
      plugin('blog'),
      plugin('subscriptions', { requires: { commerce: '^1.0.0', stripe: '^1.0.0' } }),
    ]
    const result = resolvePlugins(
      installed,
      installed.map((p) => p.id),
      '1.0.0',
    )
    expect(ids(result)).toEqual(['blog', 'commerce', 'stripe', 'subscriptions'])
    expect(result.skipped).toEqual([])
  })

  it('only loads requested plugins', () => {
    const result = resolvePlugins([plugin('a'), plugin('b')], ['b'], '1.0.0')
    expect(ids(result)).toEqual(['b'])
  })

  it('skips ids that are not installed', () => {
    const result = resolvePlugins([plugin('a')], ['a', 'ghost'], '1.0.0')
    expect(ids(result)).toEqual(['a'])
    expect(reason(result, 'ghost')).toBe('not installed')
  })

  it('throws when the same id is installed twice', () => {
    expect(() => resolvePlugins([plugin('a'), plugin('a')], ['a'], '1.0.0')).toThrow(
      'installed twice',
    )
  })

  it('skips a plugin whose required dependency is missing, inactive or the wrong version', () => {
    const installed = [
      plugin('needs-missing', { requires: { nope: '^1.0.0' } }),
      plugin('needs-inactive', { requires: { commerce: '^1.0.0' } }),
      plugin('needs-v2', { requires: { blog: '^2.0.0' } }),
      plugin('commerce'),
      plugin('blog'),
    ]
    const result = resolvePlugins(
      installed,
      ['needs-missing', 'needs-inactive', 'needs-v2', 'blog'],
      '1.0.0',
    )
    expect(ids(result)).toEqual(['blog'])
    expect(reason(result, 'needs-missing')).toContain('not installed')
    expect(reason(result, 'needs-inactive')).toContain('inactive')
    expect(reason(result, 'needs-v2')).toBe('requires "blog" ^2.0.0, found 1.0.0')
  })

  it('cascades skips down the dependency chain', () => {
    const installed = [
      plugin('a', { requires: { missing: '*' } }),
      plugin('b', { requires: { a: '*' } }),
      plugin('c', { requires: { b: '*' } }),
    ]
    const result = resolvePlugins(installed, ['a', 'b', 'c'], '1.0.0')
    expect(ids(result)).toEqual([])
    expect(result.skipped.map((s) => s.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('checks the core version range', () => {
    const installed = [
      plugin('modern', { requires: { core: '^2.0.0' } }),
      plugin('ok', { requires: { core: '^1.0.0' } }),
    ]
    const result = resolvePlugins(installed, ['modern', 'ok'], '1.4.0')
    expect(ids(result)).toEqual(['ok'])
    expect(reason(result, 'modern')).toBe('requires core ^2.0.0, running 1.4.0')
  })

  it('orders optional dependencies first and exposes them as available', () => {
    const installed = [plugin('lms', { optional: { commerce: '^1.0.0' } }), plugin('commerce')]
    const result = resolvePlugins(installed, ['lms', 'commerce'], '1.0.0')
    expect(ids(result)).toEqual(['commerce', 'lms'])
    expect([...result.available.get('lms')!]).toEqual(['commerce'])
  })

  it('loads a plugin without its optional dependency when that is absent', () => {
    const result = resolvePlugins(
      [plugin('lms', { optional: { commerce: '^1.0.0' } })],
      ['lms'],
      '1.0.0',
    )
    expect(ids(result)).toEqual(['lms'])
    expect(result.available.get('lms')!.size).toBe(0)
    expect(result.warnings).toEqual([])
  })

  it('disables an optional integration with an unsupported version and warns', () => {
    const installed = [plugin('lms', { optional: { commerce: '^2.0.0' } }), plugin('commerce')]
    const result = resolvePlugins(installed, ['lms', 'commerce'], '1.0.0')
    expect(ids(result)).toEqual(['commerce', 'lms'])
    expect(result.available.get('lms')!.size).toBe(0)
    expect(result.warnings).toEqual([
      '"lms" supports "commerce" ^2.0.0 but found 1.0.0; integration disabled',
    ])
  })

  it('breaks a cycle through an optional edge instead of dropping plugins', () => {
    const installed = [plugin('a', { requires: { b: '*' } }), plugin('b', { optional: { a: '*' } })]
    const result = resolvePlugins(installed, ['a', 'b'], '1.0.0')
    expect(ids(result)).toEqual(['b', 'a'])
    expect(result.available.get('b')!.size).toBe(0)
    expect(result.warnings[0]).toContain('"b" will not integrate with "a"')
  })

  it('skips plugins in a hard cycle and keeps the rest', () => {
    const installed = [
      plugin('a', { requires: { b: '*' } }),
      plugin('b', { requires: { a: '*' } }),
      plugin('c', { requires: { a: '*' } }),
      plugin('d'),
    ]
    const result = resolvePlugins(installed, ['a', 'b', 'c', 'd'], '1.0.0')
    expect(ids(result)).toEqual(['d'])
    expect(reason(result, 'a')).toMatch(/^dependency cycle: (a -> b -> a|b -> a -> b)$/)
    expect(reason(result, 'c')).toContain('requires "a"')
  })

  it('skips invalid definitions with every problem listed', () => {
    const result = resolvePlugins(
      [{ id: 'Bad_Id', version: 'one', requires: { x: 'not a range' } }],
      ['Bad_Id'],
      '1.0.0',
    )
    expect(ids(result)).toEqual([])
    const why = reason(result, 'Bad_Id')!
    expect(why).toContain('kebab-case')
    expect(why).toContain('not valid semver')
    expect(why).toContain('range "not a range"')
  })
})

describe('validatePlugin', () => {
  it('accepts a well-formed plugin', () => {
    expect(
      validatePlugin(
        plugin('commerce-stripe', { requires: { core: '^0.1.0', commerce: '>=1 <3' } }),
      ),
    ).toEqual([])
  })

  it.each([
    [plugin('core'), 'reserved'],
    [plugin('self', { requires: { self: '*' } }), 'itself'],
    [plugin('x', { optional: { core: '*' } }), 'core cannot be an optional'],
    [plugin('x', { requires: { y: '*' }, optional: { y: '*' } }), 'both requires and optional'],
    [
      plugin('x', {
        migrations: [
          { id: '001', up: async () => undefined },
          { id: '001', up: async () => undefined },
        ],
      }),
      'duplicate migration id',
    ],
  ])('rejects %#', (definition, message) => {
    expect(validatePlugin(definition).join('; ')).toContain(message)
  })
})
