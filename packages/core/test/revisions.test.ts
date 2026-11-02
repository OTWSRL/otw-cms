import { ContentError } from '@otw/sdk'
import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import { bootKernel, formPost, plugin, redirectOf, signIn } from './helpers'

declare module '@otw/sdk' {
  interface ContentTypes {
    'notes.note': true
    'notes.memo': true
  }
  interface EntryMeta {
    'notes.mood': string
  }
}

const notes = plugin('notes', {
  setup(cms) {
    cms.content.type('note', {
      labels: { singular: 'Note', plural: 'Notes' },
      public: true,
      supports: ['title', 'body', 'revisions'],
      revisions: 3,
    })
    cms.content.type('memo', { labels: { singular: 'Memo', plural: 'Memos' }, public: true })
    cms.content.meta('notes.mood', { types: ['notes.note'], label: 'Mood', type: 'string' })
  },
})

const titles = async (kernel: Kernel, id: string) =>
  (await kernel.content.revisions(id)).revisions.map((revision) => revision.title)

const paragraph = (text: string) => [{ type: 'paragraph', content: [{ type: 'text', text }] }]

describe('revisions', () => {
  it('keep what each save wrote, newest first, and who saved it', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { user } = await signIn(kernel, 'editor')
    const post = await kernel.content.create('core.post', { title: 'One' }, { by: user.id })
    await kernel.content.update(post.id, { title: 'Two', body: paragraph('Hi') })
    expect(await titles(kernel, post.id)).toEqual(['Two', 'One'])
    const [latest, first] = (await kernel.content.revisions(post.id)).revisions
    expect(first?.authorId).toBe(user.id)
    expect(latest).toMatchObject({ authorId: null, body: paragraph('Hi') })
    expect(await kernel.content.getRevision(first!.id)).toEqual(first)
  })

  it("aren't kept for a save that changed nothing written, or only the status", async () => {
    const kernel = await bootKernel({ plugins: [] })
    const post = await kernel.content.create('core.post', { title: 'Same' })
    await kernel.content.update(post.id, { title: 'Same' })
    await kernel.content.update(post.id, { status: 'published' })
    await kernel.content.trash(post.id)
    expect(await titles(kernel, post.id)).toEqual(['Same'])
  })

  it("are pruned to the type's number, and kept only for types with the feature", async () => {
    const kernel = await bootKernel({ plugins: [notes] })
    const note = await kernel.content.create('notes.note', { title: 'v1' })
    for (const title of ['v2', 'v3', 'v4', 'v5']) {
      await kernel.content.update(note.id, { title })
    }
    expect(await titles(kernel, note.id)).toEqual(['v5', 'v4', 'v3'])
    const memo = await kernel.content.create('notes.memo', { title: 'm1' })
    await kernel.content.update(memo.id, { title: 'm2' })
    expect(await titles(kernel, memo.id)).toEqual([])
    expect(kernel.content.getType('core.post')?.revisions).toBe(25)
  })

  it('restore an entry, custom fields included, as a save of its own', async () => {
    const kernel = await bootKernel({ plugins: [notes] })
    const note = await kernel.content.create('notes.note', {
      title: 'Calm',
      meta: { 'notes.mood': 'calm' },
    })
    const [calm] = (await kernel.content.revisions(note.id)).revisions
    await kernel.content.update(note.id, { title: 'Busy', meta: { 'notes.mood': null } })
    const restored = await kernel.content.restoreRevision(calm!.id)
    expect(restored).toMatchObject({ title: 'Calm', meta: { 'notes.mood': 'calm' } })
    expect(await titles(kernel, note.id)).toEqual(['Calm', 'Busy', 'Calm'])
  })

  it('go with their entry, and refuse a restore into the trash', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const post = await kernel.content.create('core.post', { title: 'Old' })
    await kernel.content.update(post.id, { title: 'New' })
    const [, old] = (await kernel.content.revisions(post.id)).revisions
    await kernel.content.trash(post.id)
    await expect(kernel.content.restoreRevision(old!.id)).rejects.toThrow(ContentError)
    await kernel.content.delete(post.id)
    expect(await kernel.content.getRevision(old!.id)).toBeNull()
    await expect(kernel.content.restoreRevision(old!.id)).rejects.toThrow('no longer exists')
  })
})

describe('the revisions screen and Restore', () => {
  it('are for those who may edit the entry', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const editor = await signIn(kernel, 'editor')
    const author = await signIn(kernel, 'author')
    const post = await kernel.content.create('core.post', { title: 'Old' }, { by: editor.user.id })
    await kernel.content.update(post.id, { title: 'New' }, { by: editor.user.id })
    const resolve = (user = editor.user) =>
      kernel.resolveAdminPage(`/admin/posts/${post.id}/revisions`, {}, user)
    expect(await resolve()).toMatchObject({ kind: 'content-revisions', entry: { id: post.id } })
    expect(await resolve(author.user)).toEqual({ kind: 'forbidden' })

    const [, old] = (await kernel.content.revisions(post.id)).revisions
    const restore = (cookie: string) =>
      kernel.handleApi(
        formPost(kernel.actionUrl('core', 'restore-revision'), { id: old!.id }, { cookie }),
      )
    expect((await restore(author.cookie)).status).toBe(403)
    const done = redirectOf(kernel, await restore(editor.cookie))
    expect(done.path).toBe(`/admin/posts/${post.id}`)
    expect(done.flash?.message).toMatch(
      /^Post restored to the revision from \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/,
    )
    expect((await kernel.content.get(post.id))?.title).toBe('Old')
    const [newest] = (await kernel.content.revisions(post.id)).revisions
    expect(newest?.authorId).toBe(editor.user.id)
  })

  it('records who saved from the edit screen', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { user, cookie } = await signIn(kernel, 'author')
    await kernel.handleApi(
      formPost(
        kernel.actionUrl('core', 'save-entry'),
        { type: 'core.post', title: 'Mine', slug: '' },
        { cookie },
      ),
    )
    const [post] = (await kernel.content.list({ type: 'core.post' })).entries
    expect((await kernel.content.revisions(post!.id)).revisions[0]?.authorId).toBe(user.id)
  })
})
