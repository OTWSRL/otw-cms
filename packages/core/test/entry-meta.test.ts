import { ContentError, defineAdmin, type Entry } from '@otwdesign/sdk'
import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import { bootKernel, formPost, memoryLogger, plugin, redirectOf, signIn } from './helpers'

declare module '@otwdesign/sdk' {
  interface EntryMeta {
    'course.level': string
    'course.hours': number
    'course.featured': boolean
    'course.skills': string[]
    'course.price': number
  }
}

const course = plugin('course', {
  setup(cms) {
    const types = ['core.post'] as const
    cms.content.meta('course.level', {
      types,
      label: 'Level',
      type: 'string',
      options: ['beginner', 'advanced'],
      default: 'beginner',
    })
    cms.content.meta('course.hours', {
      types,
      label: 'Hours',
      type: 'number',
      integer: true,
      min: 1,
    })
    cms.content.meta('course.featured', { types, label: 'Featured', type: 'boolean' })
    cms.content.meta('course.skills', { types, label: 'Skills', type: 'strings' })
    cms.content.meta('course.price', {
      types,
      label: 'Price',
      type: 'number',
      capability: 'core.manage_settings',
    })
  },
})

const fieldsBox = defineAdmin(course, (cms) =>
  cms.admin.metaBox('core.post', {
    name: 'details',
    title: 'Course details',
    fields: ['course.level', 'course.hours', 'course.featured', 'course.skills', 'course.price'],
  }),
)

async function refused(promise: Promise<unknown>, message: string | RegExp) {
  const error = await promise.then(
    () => expect.fail('expected a ContentError'),
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(ContentError)
  expect((error as ContentError).message).toMatch(message)
}

describe('custom fields on entries', () => {
  it('are validated on save, merged key by key, and removed with null', async () => {
    const kernel = await bootKernel({ plugins: [course] })
    const { content } = kernel
    const entry = await content.create('core.post', {
      meta: { 'course.hours': 3, 'course.skills': [' a ', 'b'] },
    })
    expect(entry.meta).toEqual({
      'course.level': 'beginner',
      'course.hours': 3,
      'course.skills': ['a', 'b'],
    })
    const updated = await content.update(entry.id, { meta: { 'course.level': 'advanced' } })
    expect(updated.meta).toEqual({
      'course.level': 'advanced',
      'course.hours': 3,
      'course.skills': ['a', 'b'],
    })
    const removed = await content.update(entry.id, {
      meta: { 'course.level': null, 'course.hours': null },
    })
    // The default shows again once the value is gone.
    expect(removed.meta).toEqual({ 'course.level': 'beginner', 'course.skills': ['a', 'b'] })
    expect((await content.get(entry.id))?.meta).toEqual(removed.meta)

    await refused(
      content.update(entry.id, { meta: { 'course.hours': 0 } }),
      'Hours must be at least 1',
    )
    await refused(
      content.update(entry.id, { meta: { 'course.level': 'expert' } }),
      'one of beginner, advanced',
    )
    await refused(
      content.update(entry.id, { meta: { 'nope.key': 1 } as never }),
      'Unknown custom field "nope.key"',
    )
    const page = await content.create('core.page')
    await refused(content.update(page.id, { meta: { 'course.hours': 2 } }), 'for core.page')
  })

  it('pass through the content.entry filter, whose changes are checked too', async () => {
    let value: unknown = 5
    const bumper = plugin('bumper', {
      setup: (cms) =>
        cms.hooks.addFilter('content.entry', (fields) => ({
          ...fields,
          meta: { ...fields.meta, 'course.hours': value as number },
        })),
    })
    const kernel = await bootKernel({ plugins: [course, bumper] })
    const entry = await kernel.content.create('core.post')
    expect(entry.meta['course.hours']).toBe(5)
    value = -1
    await refused(kernel.content.update(entry.id, { title: 'x' }), 'Hours must be at least 1')
  })

  it('filter lists by value, using the stored values only', async () => {
    const kernel = await bootKernel({ plugins: [course] })
    const { content } = kernel
    const advanced = await content.create('core.post', {
      title: 'A',
      meta: { 'course.level': 'advanced', 'course.featured': true },
    })
    await content.create('core.post', { title: 'B', meta: { 'course.featured': true } })
    await content.create('core.post', { title: 'C' })
    const titles = async (meta: object) =>
      (await content.list({ type: 'core.post', meta, orderBy: 'title' })).entries.map(
        (e) => e.title,
      )
    expect(await titles({ 'course.featured': true })).toEqual(['A', 'B'])
    expect(await titles({ 'course.level': 'advanced', 'course.featured': true })).toEqual(['A'])
    // C shows "beginner" by default but stores nothing, so it doesn't match.
    expect(await titles({ 'course.level': 'beginner' })).toEqual([])
    expect(advanced.meta['course.featured']).toBe(true)
  })

  it("are kept when their plugin is off, shown but not writable until it's back", async () => {
    const kernel = await bootKernel({ plugins: [course] })
    const entry = await kernel.content.create('core.post', { meta: { 'course.hours': 4 } })
    const off = await bootKernel({ plugins: [course], active: [], db: kernel.db })
    const kept = await off.content.get(entry.id)
    expect(kept?.meta).toEqual({ 'course.hours': 4 })
    const titled = await off.content.update(entry.id, { title: 'Still here' })
    expect(titled.meta).toEqual({ 'course.hours': 4 })
    await refused(
      off.content.update(entry.id, { meta: { 'course.hours': 5 } }),
      'Unknown custom field',
    )
  })
})

describe('field boxes', () => {
  async function site() {
    const kernel = await bootKernel({ plugins: [course], admin: [fieldsBox] })
    const editor = await signIn(kernel, 'editor')
    return { kernel, editor }
  }

  async function save(
    kernel: Kernel,
    cookie: string,
    fields: Record<string, string | string[]>,
    entry?: Entry,
  ) {
    const hidden: Record<string, string> = entry
      ? { id: entry.id, updatedAt: entry.updatedAt.toISOString() }
      : {}
    const response = await kernel.handleApi(
      formPost(
        kernel.actionUrl('core', 'save-entry'),
        { type: 'core.post', title: 'T', slug: '', ...hidden, ...fields },
        { cookie },
      ),
    )
    if (response.status === 403) return { status: 403, message: undefined, entry: undefined }
    const { path, flash } = redirectOf(kernel, response)
    const id = /([0-9a-f-]{36})$/.exec(path)?.[1]
    return {
      status: response.status,
      message: flash?.message,
      entry: id ? await kernel.content.get(id) : null,
    }
  }

  const shown = ['course.level', 'course.hours', 'course.featured', 'course.skills']

  it('save their fields with the entry: empty removes, an unticked box is false', async () => {
    const { kernel, editor } = await site()
    const first = await save(kernel, editor.cookie, {
      metaFields: shown,
      'meta.course.level': 'advanced',
      'meta.course.hours': '12',
      'meta.course.featured': 'on',
      'meta.course.skills': 'Listening\n\n  Speaking \r\n',
    })
    expect(first.entry?.meta).toEqual({
      'course.level': 'advanced',
      'course.hours': 12,
      'course.featured': true,
      'course.skills': ['Listening', 'Speaking'],
    })
    const second = await save(
      kernel,
      editor.cookie,
      { metaFields: shown, 'meta.course.level': '', 'meta.course.hours': '12' },
      first.entry!,
    )
    expect(second.entry?.meta).toEqual({
      'course.level': 'beginner',
      'course.hours': 12,
      'course.featured': false,
    })
  })

  it("leave fields the form didn't show alone, and explain bad input", async () => {
    const { kernel, editor } = await site()
    const entry = await kernel.content.create('core.post', { meta: { 'course.hours': 2 } })
    const untouched = await save(kernel, editor.cookie, { title: 'Renamed' }, entry)
    expect(untouched.entry?.meta['course.hours']).toBe(2)
    const latest = (await kernel.content.get(entry.id))!
    const words = await save(
      kernel,
      editor.cookie,
      { metaFields: 'course.hours', 'meta.course.hours': 'ten' },
      latest,
    )
    expect(words.message).toBe('Hours must be a number.')
    const zero = await save(
      kernel,
      editor.cookie,
      { metaFields: 'course.hours', 'meta.course.hours': '0' },
      latest,
    )
    expect(zero.message).toBe('Hours must be at least 1')
  })

  it("need a field's own capability to change it", async () => {
    const { kernel, editor } = await site()
    const admin = await signIn(kernel)
    const fields = { metaFields: 'course.price', 'meta.course.price': '30' }
    expect((await save(kernel, editor.cookie, fields)).status).toBe(403)
    expect((await save(kernel, admin.cookie, fields)).entry?.meta['course.price']).toBe(30)
  })

  it('warn about fields no active plugin registers', async () => {
    const logger = memoryLogger()
    const typo = defineAdmin(course, (cms) =>
      cms.admin.metaBox('core.post', {
        name: 'typo',
        title: 'Typo',
        fields: ['course.levle' as never],
      }),
    )
    const kernel = await bootKernel({ plugins: [course], admin: [typo], logger })
    expect(kernel.warnings).toContain(
      'Meta box "course.typo" shows custom field "course.levle", which no active plugin registers',
    )
  })
})
