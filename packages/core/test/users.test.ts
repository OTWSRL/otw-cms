import type { OutgoingMail } from '@otw/sdk'
import { defineAdmin } from '@otw/sdk'
import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import { bootKernel, formPost, ORIGIN, plugin, redirectOf, signIn } from './helpers'

declare module '@otw/sdk' {
  interface UserMeta {
    'lms.bio': string
    'lms.level': string
    'lms.newsletter': boolean
    'lms.grade': number
  }
}

const lms = plugin('lms', {
  setup(cms) {
    cms.users.meta('lms.bio', { label: 'Bio', type: 'string', multiline: true, onAccount: true })
    cms.users.meta('lms.level', {
      label: 'Level',
      type: 'string',
      options: ['beginner', 'expert'],
      default: 'beginner',
      roles: ['customer'],
    })
    cms.users.meta('lms.newsletter', { label: 'Newsletter', type: 'boolean', onAccount: true })
    cms.users.meta('lms.grade', {
      label: 'Grade',
      type: 'number',
      capability: 'core.manage_users',
    })
  },
})

async function site() {
  const inbox: OutgoingMail[] = []
  const mailer = plugin('mailer', {
    setup(cms) {
      cms.mail.transport({ send: async (message) => void inbox.push(message) })
    },
  })
  const kernel = await bootKernel({ plugins: [lms, mailer] })
  return { kernel, inbox }
}

const post = (
  kernel: Kernel,
  name: string,
  fields: Record<string, string | string[]>,
  cookie: string,
) =>
  kernel
    .handleApi(
      formPost(kernel.actionUrl('core', name), fields, { cookie, referer: `${ORIGIN}/admin` }),
    )
    .then((response) => redirectOf(kernel, response))

describe('user fields', () => {
  it('are typed and checked like custom fields, by role, with their defaults', async () => {
    const { kernel } = await site()
    const { user: customer } = await signIn(kernel, 'customer')
    const { user: editor } = await signIn(kernel, 'editor')
    expect(kernel.users.fields('customer').map((field) => field.key)).toEqual([
      'lms.bio',
      'lms.level',
      'lms.newsletter',
      'lms.grade',
    ])
    expect(kernel.users.fields('editor').map((field) => field.key)).not.toContain('lms.level')
    expect(await kernel.users.getMeta(customer.id)).toEqual({ 'lms.level': 'beginner' })

    expect(
      await kernel.users.updateMeta(customer.id, { 'lms.bio': '  Likes\nboats ', 'lms.grade': 7 }),
    ).toEqual({ 'lms.level': 'beginner', 'lms.bio': 'Likes\nboats', 'lms.grade': 7 })
    await expect(kernel.users.updateMeta(customer.id, { 'lms.level': 'guru' })).rejects.toThrow(
      'Level must be one of beginner, expert',
    )
    await expect(kernel.users.updateMeta(editor.id, { 'lms.level': 'expert' })).rejects.toThrow(
      'Unknown user field "lms.level" for the editor role',
    )
    await expect(
      kernel.users.updateMeta(customer.id, { 'lms.unknown': 1 } as never),
    ).rejects.toThrow('Unknown user field')
    expect(await kernel.users.updateMeta(customer.id, { 'lms.bio': null })).not.toHaveProperty(
      'lms.bio',
    )
    const many = await kernel.users.getMetaMany([customer.id, editor.id, 'nope'])
    expect([...many.keys()].sort()).toEqual([customer.id, editor.id].sort())
    expect(many.get(editor.id)).toEqual({})
  })

  it('are registered in setup(), under the plugin, with a valid definition', async () => {
    const wrongKey = plugin('lms', {
      setup(cms) {
        // A key under another plugin, as plain JavaScript could pass it.
        const register = cms.users.meta as (key: string, definition: object) => void
        register('other.bio', { label: 'Bio', type: 'string' })
      },
    })
    await expect(bootKernel({ plugins: [wrongKey] })).rejects.toThrow('start it with "lms."')
    const badRoles = plugin('lms', {
      setup(cms) {
        cms.users.meta('lms.bio', { label: 'Bio', type: 'string', roles: 'customer' as never })
      },
    })
    await expect(bootKernel({ plugins: [badRoles] })).rejects.toThrow('roles is a list')
    const inAdmin = plugin('lms')
    await expect(
      bootKernel({
        plugins: [inAdmin],
        admin: [
          defineAdmin(inAdmin, (cms) => {
            cms.users.meta('lms.bio', { label: 'Bio', type: 'string' })
          }),
        ],
      }),
    ).rejects.toThrow('in setup()')
  })
})

describe('Profile', () => {
  it('saves your name and fields, but not a field whose capability you lack', async () => {
    const { kernel } = await site()
    const { user, cookie } = await signIn(kernel, 'author')
    const saved = await post(
      kernel,
      'profile-save',
      { name: 'Ava Author', userFields: ['lms.bio', 'lms.newsletter'], 'meta.lms.bio': 'Writer' },
      cookie,
    )
    expect(saved).toMatchObject({ path: '/admin/profile' })
    expect(saved.flash?.message).toBe('Profile updated.')
    expect((await kernel.users.get(user.id))?.name).toBe('Ava Author')
    // The unticked checkbox counts as false: the form listed it.
    expect(await kernel.users.getMeta(user.id)).toEqual({
      'lms.bio': 'Writer',
      'lms.newsletter': false,
    })
    const forged = await post(
      kernel,
      'profile-save',
      { name: 'Ava', userFields: ['lms.grade'], 'meta.lms.grade': '100' },
      cookie,
    )
    expect(forged.status).toBe(403)
    expect(await kernel.resolveAdminPage('/admin/users/' + user.id, {}, user)).toEqual({
      kind: 'forbidden',
    })
  })

  it('logs you out everywhere else', async () => {
    const { kernel } = await site()
    const { user, cookie } = await signIn(kernel, 'author')
    const other = await kernel.auth.createSession(user.id)
    await post(kernel, 'profile-sessions', {}, cookie)
    expect(await kernel.auth.userForSession(other)).toBeNull()
    expect(await kernel.auth.userForSession(/=(.*)$/.exec(cookie)![1])).not.toBeNull()
  })
})

describe('Edit User', () => {
  it('changes someone’s name, address, role and fields, telling the old address', async () => {
    const { kernel, inbox } = await site()
    const admin = await signIn(kernel)
    const { user } = await signIn(kernel, 'customer')
    expect(await kernel.resolveAdminPage(`/admin/users/${user.id}`, {}, admin.user)).toEqual({
      kind: 'user-edit',
      target: user,
    })
    expect(await kernel.resolveAdminPage('/admin/users/nope', {}, admin.user)).toEqual({
      kind: 'not-found',
    })
    const saved = await post(
      kernel,
      'user-save',
      {
        user: user.id,
        name: 'Cleo',
        email: 'cleo.new@example.com',
        role: 'author',
        userFields: ['lms.grade'],
        'meta.lms.grade': '9',
      },
      admin.cookie,
    )
    expect(saved).toMatchObject({ path: `/admin/users/${user.id}` })
    expect(await kernel.users.get(user.id)).toMatchObject({
      name: 'Cleo',
      email: 'cleo.new@example.com',
      role: 'author',
    })
    expect(await kernel.users.getMeta(user.id)).toEqual({ 'lms.grade': 9 })
    expect(await kernel.users.isVerified(user.id)).toBe(false)
    expect(inbox.at(-1)).toMatchObject({
      to: [user.email],
      subject: '[My Site] Your email address was changed',
    })
  })

  it('sends a reset link and logs someone out everywhere', async () => {
    const { kernel, inbox } = await site()
    const admin = await signIn(kernel)
    const { user, cookie } = await signIn(kernel, 'customer')
    const sent = await post(kernel, 'user-send-reset', { user: user.id }, admin.cookie)
    expect(sent.flash?.message).toMatch(/^A link to set a new password is on its way/)
    expect(inbox.at(-1)?.text).toContain(`${ORIGIN}/account/reset?token=`)
    await post(kernel, 'user-sessions', { user: user.id }, admin.cookie)
    expect(await kernel.auth.userForSession(/=(.*)$/.exec(cookie)![1])).toBeNull()
    // Someone who may not manage users can't, signed in or not.
    const author = await signIn(kernel, 'author')
    expect((await post(kernel, 'user-sessions', { user: user.id }, author.cookie)).status).toBe(403)
  })
})

describe('the account page’s fields', () => {
  it('are those marked for it, and only those are saved from it', async () => {
    const { kernel } = await site()
    const { user, cookie } = await signIn(kernel, 'customer')
    const page = await kernel.resolveAccount('/account', {}, user)
    expect(page?.props.fields.map((field) => field.key)).toEqual(['lms.bio', 'lms.newsletter'])
    expect(page?.props.meta).toEqual({ 'lms.level': 'beginner' })
    const saved = await kernel
      .handleApi(
        formPost(
          kernel.actionUrl('core', 'account-name'),
          {
            name: 'Cleo',
            userFields: ['lms.bio', 'lms.newsletter', 'lms.grade'],
            'meta.lms.bio': 'Hi',
            'meta.lms.newsletter': 'on',
            'meta.lms.grade': '100',
          },
          { cookie, referer: `${ORIGIN}/account` },
        ),
      )
      .then((response) => redirectOf(kernel, response))
    expect(saved.flash?.message).toBe('Your details were saved.')
    // The grade isn't on the account page, so the form can't set it, whatever it sends.
    expect(await kernel.users.getMeta(user.id)).toEqual({
      'lms.level': 'beginner',
      'lms.bio': 'Hi',
      'lms.newsletter': true,
    })
  })
})
