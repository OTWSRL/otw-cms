import type { OutgoingMail } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import { bootKernel, formPost, ORIGIN, plugin, redirectOf, signIn } from './helpers'

/** A site whose email is kept for the test to read, and whose sign-ups are open unless said. */
async function site(options: { open?: boolean; mail?: boolean } = {}) {
  const inbox: OutgoingMail[] = []
  const mailer = plugin('mailer', {
    setup(cms) {
      cms.mail.transport({ send: async (message) => void inbox.push(message) })
    },
  })
  const kernel = await bootKernel({
    plugins: options.mail === false ? [] : [mailer],
    settings: { 'users.can_register': options.open ?? true, 'site.title': 'Shop' },
  })
  return { kernel, inbox }
}

/** The token in the last email's link to `path`. */
function tokenFrom(inbox: OutgoingMail[], path: '/reset' | '/email'): string {
  const text = inbox.at(-1)?.text ?? ''
  const match = new RegExp(`${ORIGIN}/account${path}\\?token=([A-Za-z0-9_-]+)`).exec(text)
  if (!match) throw new Error(`No ${path} link in: ${text}`)
  return match[1]!
}

const post = (kernel: Kernel, name: string, fields: Record<string, string>, cookie?: string) =>
  kernel
    .handleApi(
      formPost(kernel.actionUrl('core', name), fields, {
        referer: `${ORIGIN}/account`,
        ...(cookie ? { cookie } : {}),
      }),
    )
    .then((response) => ({ response, ...redirectOf(kernel, response) }))

const sessionOf = (response: Response) =>
  /cms_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? null

describe('signing up', () => {
  it('makes a Customer with no password, and emails a link that sets one and signs them in', async () => {
    const { kernel, inbox } = await site()
    const done = await post(kernel, 'account-register', { email: 'Cleo@Example.com', name: 'Cleo' })
    expect(done).toMatchObject({ path: '/account' })
    expect(done.flash?.message).toBe('Check your email for a link to set your password.')
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      to: ['cleo@example.com'],
      subject: '[Shop] Set your password',
    })

    // No password yet: signing in fails as a wrong password does.
    await expect(kernel.auth.signIn('cleo@example.com', '')).rejects.toThrow(
      'Incorrect email or password.',
    )
    const token = tokenFrom(inbox, '/reset')
    const page = await kernel.resolveAccount('/account/reset', { token }, null)
    expect(page?.props).toMatchObject({ view: 'reset', valid: true })
    expect(page?.metadata.referrer).toBe('same-origin')

    const reset = await post(kernel, 'account-reset', { token, password: 'a new long password' })
    expect(reset.flash?.message).toBe('Your password is set, and you’re signed in.')
    const user = await kernel.auth.userForSession(sessionOf(reset.response))
    expect(user).toMatchObject({ email: 'cleo@example.com', name: 'Cleo', role: 'customer' })
    expect(await kernel.accounts.isVerified(user!.id)).toBe(true)
    // The link works once.
    const again = await post(kernel, 'account-reset', { token, password: 'another password!' })
    expect(again.flash).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('expired'),
    })
  })

  it('tells an address that has an account so, without telling the form', async () => {
    const { kernel, inbox } = await site()
    await signIn(kernel, 'customer')
    const [existing] = await kernel.auth.listUsers({ roles: ['customer'] })
    const done = await post(kernel, 'account-register', { email: existing!.email })
    expect(done.flash?.message).toBe('Check your email for a link to set your password.')
    expect(inbox[0]?.subject).toBe('[Shop] You already have an account')
    expect(tokenFrom(inbox, '/reset')).toBeTruthy()
    expect(await kernel.auth.listUsers({ roles: ['customer'] })).toHaveLength(1)
  })

  it('is closed until Settings › General opens it, and needs a mail plugin', async () => {
    const closed = await site({ open: false })
    expect(closed.kernel.accounts.canRegister()).toBe(false)
    const refused = await post(closed.kernel, 'account-register', { email: 'a@example.com' })
    expect(refused.flash).toMatchObject({
      kind: 'error',
      message: 'This site isn’t taking sign-ups.',
    })
    expect(closed.inbox).toEqual([])
    const noMail = await site({ mail: false })
    expect(noMail.kernel.accounts.canRegister()).toBe(false)
    const page = await noMail.kernel.resolveAccount('/account', {}, null)
    expect(page?.props).toMatchObject({ view: 'sign-in', canRegister: false })
  })
})

describe('a lost password', () => {
  it('gets a link when an account uses the address, and the same answer when none does', async () => {
    const { kernel, inbox } = await site()
    const { user, cookie } = await signIn(kernel, 'customer')
    const unknown = await post(kernel, 'account-lost-password', { email: 'nobody@example.com' })
    const known = await post(kernel, 'account-lost-password', { email: user.email })
    expect(unknown.flash?.message).toBe(known.flash?.message)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]?.subject).toBe('[Shop] Password reset')

    await post(kernel, 'account-reset', {
      token: tokenFrom(inbox, '/reset'),
      password: 'a brand new password',
    })
    // A reset ends every session, as WordPress's does.
    expect(await kernel.auth.userForSession(/=(.*)$/.exec(cookie)![1])).toBeNull()
    await expect(kernel.auth.signIn(user.email, 'a brand new password')).resolves.toBeTruthy()
  })

  it('sends an address three emails an hour at most, and links stop after a day', async () => {
    const { kernel, inbox } = await site()
    const { user } = await signIn(kernel, 'customer')
    for (let i = 0; i < 5; i++) await kernel.accounts.requestPasswordReset(user.email, ORIGIN)
    expect(inbox).toHaveLength(3)
    const token = tokenFrom(inbox, '/reset')
    await kernel.db.execute(
      sql`UPDATE cms_user_tokens SET expires_at = now() - interval '1 second'`,
    )
    expect(await kernel.accounts.tokenInfo(token, 'password')).toBeNull()
    await expect(kernel.accounts.setPassword(token, 'too late password')).rejects.toThrow('expired')
  })
})

describe('a signed-in account', () => {
  it('changes its name, and its password with the current one, keeping only this session', async () => {
    const { kernel, inbox } = await site()
    const { user, cookie } = await signIn(kernel, 'customer')
    const other = await kernel.auth.createSession(user.id)
    expect((await post(kernel, 'account-name', { name: 'Cleo P.' }, cookie)).flash?.message).toBe(
      'Your details were saved.',
    )
    const wrong = await post(
      kernel,
      'account-password',
      { current: 'nope', password: 'a different password' },
      cookie,
    )
    expect(wrong.flash).toMatchObject({
      kind: 'error',
      message: 'Your current password is incorrect.',
    })
    const changed = await post(
      kernel,
      'account-password',
      { current: 'correct horse battery staple', password: 'a different password' },
      cookie,
    )
    expect(changed.flash?.message).toMatch(/^Your password was changed/)
    expect(await kernel.auth.userForSession(/=(.*)$/.exec(cookie)![1])).toMatchObject({
      name: 'Cleo P.',
    })
    expect(await kernel.auth.userForSession(other)).toBeNull()
    expect(inbox.at(-1)).toMatchObject({
      to: [user.email],
      subject: '[Shop] Your password was changed',
    })
  })

  it('changes its address only once the new one confirms, and tells the old one', async () => {
    const { kernel, inbox } = await site()
    const { user, cookie } = await signIn(kernel, 'customer')
    const taken = (await signIn(kernel, 'customer')).user.email
    const ask = (email: string, password = 'correct horse battery staple') =>
      post(kernel, 'account-email', { email, password }, cookie)
    expect((await ask('new@example.com', 'wrong')).flash?.message).toBe(
      'Your current password is incorrect.',
    )
    expect((await ask(taken)).flash?.message).toBe('A user with that email address already exists.')
    expect((await ask('New@Example.com')).flash?.message).toMatch(/^We’ve emailed New@Example.com/)
    expect(inbox.at(-1)?.to).toEqual(['new@example.com'])
    expect((await kernel.auth.getUsers([user.id]))[0]?.email).toBe(user.email)

    const token = tokenFrom(inbox, '/email')
    const page = await kernel.resolveAccount('/account/email', { token }, null)
    expect(page?.props).toMatchObject({
      view: 'confirm-email',
      valid: true,
      newEmail: 'new@example.com',
    })
    const confirmed = await post(kernel, 'account-confirm-email', { token })
    expect(confirmed.flash?.message).toBe('Your email address is now new@example.com.')
    expect((await kernel.auth.getUsers([user.id]))[0]?.email).toBe('new@example.com')
    expect(await kernel.accounts.isVerified(user.id)).toBe(true)
    expect(inbox.at(-1)).toMatchObject({
      to: [user.email],
      subject: '[Shop] Your email address was changed',
    })
  })

  it('signs out', async () => {
    const { kernel } = await site()
    const { cookie } = await signIn(kernel, 'customer')
    const done = await post(kernel, 'account-sign-out', {}, cookie)
    expect(done).toMatchObject({ path: '/account' })
    expect(await kernel.auth.userForSession(/=(.*)$/.exec(cookie)![1])).toBeNull()
  })
})

describe('the account pages', () => {
  it('show sign-in signed out and the account signed in, at their paths only', async () => {
    const { kernel } = await site()
    const customer = await signIn(kernel, 'customer')
    const admin = await signIn(kernel)
    expect(
      (await kernel.resolveAccount('/account', { next: '//evil.example' }, null))?.props,
    ).toMatchObject({ view: 'sign-in', canRegister: true, next: null })
    expect((await kernel.resolveAccount('/account', { next: '/shop' }, null))?.props.next).toBe(
      '/shop',
    )
    expect((await kernel.resolveAccount('/account', {}, customer.user))?.props).toMatchObject({
      view: 'account',
      canUseAdmin: false,
      verified: false,
    })
    expect((await kernel.resolveAccount('/account', {}, admin.user))?.props.canUseAdmin).toBe(true)
    expect(
      (await kernel.resolveAccount('/account/reset', { token: 'nope' }, null))?.props,
    ).toMatchObject({ view: 'reset', valid: false })
    expect(await kernel.resolveAccount('/accounts', {}, null)).toBeNull()
    expect(await kernel.resolveAccount('/account/other', {}, null)).toBeNull()
  })

  it('send a customer who signs in at the admin to their account', async () => {
    const { kernel } = await site()
    const { user } = await signIn(kernel, 'customer')
    const done = await kernel
      .handleApi(
        formPost(kernel.actionUrl('core', 'login'), {
          email: user.email,
          password: 'correct horse battery staple',
          next: '/admin',
        }),
      )
      .then((response) => redirectOf(kernel, response))
    expect(done.path).toBe('/account')
  })
})
