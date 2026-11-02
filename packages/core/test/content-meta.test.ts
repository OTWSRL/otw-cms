import { ContentError, type MetaDefinition, type MetaField } from '@otw/sdk'
import { describe, expect, it } from 'vitest'
import { cleanMetaValue, MetaStore } from '../src/content-meta'

const field = (definition: MetaDefinition): MetaField => ({
  key: 'lms.x' as never,
  pluginId: 'lms',
  definition,
})
// lms.course stands for any plugin's type; it isn't declared in these tests.
const base = { types: ['lms.course'] as never, label: 'Level' } as const

function store() {
  const meta = new MetaStore(() => {})
  meta.register('lms', 'lms.level', {
    ...base,
    type: 'string',
    options: ['beginner', { value: 'advanced', label: 'Advanced' }],
    default: 'beginner',
  })
  meta.register('lms', 'lms.hours', {
    ...base,
    label: 'Hours',
    type: 'number',
    integer: true,
    min: 1,
  })
  meta.register('lms', 'lms.notes', { types: '*', label: 'Notes', type: 'string', multiline: true })
  return meta
}

describe('custom field values', () => {
  it.each([
    [{ type: 'string' }, '  Hello\u0007 world ', 'Hello  world'],
    [{ type: 'string', multiline: true }, ' a\nb\u0007 ', 'a\nb'],
    [{ type: 'number' }, 1.5, 1.5],
    [{ type: 'boolean' }, false, false],
    [{ type: 'strings' }, [' a ', '', 'b'], ['a', 'b']],
    [{ type: 'json', validate: () => null }, { a: [1, undefined] }, { a: [1, null] }],
  ])('%j tidies %j to %j', (definition, value, expected) => {
    expect(cleanMetaValue(field({ ...base, ...definition } as MetaDefinition), value)).toEqual(
      expected,
    )
  })

  it.each([
    [{ type: 'string' }, 3, 'Level must be text'],
    [{ type: 'string', maxLength: 3 }, 'abcd', 'Level is limited to 3 characters'],
    [{ type: 'string', options: ['a', { value: 'b', label: 'Bee' }] }, 'c', 'one of a, Bee'],
    [
      { type: 'string', validate: (v: string) => (v.includes('@') ? null : 'needs an @') },
      'x',
      'Level: needs an @',
    ],
    [{ type: 'number' }, Number.NaN, 'Level must be a number'],
    [{ type: 'number' }, '3', 'Level must be a number'],
    [{ type: 'number', integer: true }, 1.5, 'whole number'],
    [{ type: 'number', min: 1 }, 0, 'at least 1'],
    [{ type: 'number', max: 9 }, 10, 'at most 9'],
    [{ type: 'boolean' }, 'yes', 'true or false'],
    [{ type: 'strings', maxItems: 1 }, ['a', 'b'], 'at most 1 items'],
    [{ type: 'strings' }, ['a', 2], 'list of texts'],
    [{ type: 'json', validate: () => 'no' }, {}, 'Level: no'],
    [{ type: 'json', validate: () => null }, () => 1, 'plain data'],
  ])('%j refuses %j', (definition, value, message) => {
    const check = () => cleanMetaValue(field({ ...base, ...definition } as MetaDefinition), value)
    expect(check).toThrow(ContentError)
    expect(check).toThrow(message)
  })
})

describe('MetaStore', () => {
  it('knows which types have which fields, and their defaults', () => {
    const meta = store()
    expect(meta.list('lms.course').map((f) => f.key)).toEqual([
      'lms.level',
      'lms.hours',
      'lms.notes',
    ])
    expect(meta.list('core.post').map((f) => f.key)).toEqual(['lms.notes'])
    expect(meta.has('lms.level', 'core.post')).toBe(false)
    expect(meta.withDefaults('lms.course', { 'lms.hours': 3 } as never)).toEqual({
      'lms.level': 'beginner',
      'lms.hours': 3,
    })
  })

  it('merges changes key by key: values set, null removes, others stay', () => {
    const meta = store()
    const stored = { 'lms.level': 'advanced', 'old.plugin': 'kept' } as never
    expect(meta.merge('lms.course', stored, { 'lms.hours': 2, 'lms.level': null })).toEqual({
      'old.plugin': 'kept',
      'lms.hours': 2,
    })
    expect(() => meta.merge('lms.course', stored, { 'old.plugin': 'x' })).toThrow(
      'Unknown custom field "old.plugin" for lms.course',
    )
    expect(() => meta.merge('core.post', {} as never, { 'lms.hours': 2 })).toThrow(
      'Unknown custom field',
    )
    expect(() => meta.merge('lms.course', {} as never, ['x'])).toThrow('as an object')
  })

  it('checks only what a filter changed, and the size of the whole', () => {
    const meta = store()
    const stored = { 'old.plugin': 'kept' } as never
    expect(meta.check('lms.course', { 'old.plugin': 'kept', 'lms.hours': 4 }, stored)).toEqual({
      'old.plugin': 'kept',
      'lms.hours': 4,
    })
    expect(() => meta.check('lms.course', { 'old.plugin': 'changed' }, stored)).toThrow('Unknown')
    // Text drops control characters, NUL with them; JSON keeps them, so the whole is checked.
    expect(meta.check('lms.course', { 'lms.notes': 'nul\u0000' }, {} as never)).toEqual({
      'lms.notes': 'nul',
    })
    meta.register('lms', 'lms.data', {
      types: '*',
      label: 'Data',
      type: 'json',
      validate: () => null,
    })
    expect(() => meta.check('lms.course', { 'lms.data': ['nul\u0000'] }, {} as never)).toThrow(
      'cannot contain NUL',
    )
    expect(() =>
      meta.check('lms.course', { 'lms.data': ['x'.repeat(1_100_000)] }, {} as never),
    ).toThrow('too large')
  })

  it.each([
    ['lms.level', {}, 'already registered by plugin "lms"'],
    ['shop.price', {}, 'start it with "lms."'],
    ['lms.Price', {}, 'Invalid custom field key'],
    ['lms.price', { type: 'money' }, 'unknown type "money"'],
    ['lms.price', { label: '' }, 'needs a label'],
    ['lms.price', { type: 'json' }, 'needs a validate function'],
    [
      'lms.price',
      { type: 'number', min: 1, default: 0 },
      'invalid default: Price must be at least 1',
    ],
    ['lms.price', { types: [] }, 'needs content type names'],
  ])('refuses registering %s with %j', (key, extra, message) => {
    const meta = store()
    const definition = { types: ['lms.course'], label: 'Price', type: 'number', ...extra }
    expect(() => meta.register('lms', key, definition as MetaDefinition)).toThrow(message)
  })
})
