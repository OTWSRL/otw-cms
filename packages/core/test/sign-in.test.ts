import {
  ActionError,
  defineAdmin,
  type SignInContext,
  type SignInStep,
  type User,
} from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import { bootKernel, formPost, ORIGIN, PASSWORD, plugin, redirectOf } from './helpers'

const APP_CODE = '111111'
const EMAIL_CODE = '222222'

/**
 * A two-factor plugin in miniature: everyone but `plain…` addresses has an app, and an email
 * code unless they came by an emailed link, which proves the same inbox. `emailer…` addresses
 * have email first.
 */
function codes(extra: Partial<SignInStep> = {}) {
  const sent: { email: string; method: string; via: string }[] = []
  const calls: { user: string; context: SignInContext }[] = []
  const remembered = new Map<string, string>()
  const step: SignInStep = {
    methods(user, context) {
      calls.push({ user: user.email, context })
      if (user.email.startsWith('plain')) return []
      if (context.device && remembered.get(context.device) === user.id) return []
      const app = {
        id: 'app',
        label: 'Authenticator app',
        prompt: 'Enter the code from your app.',
        numeric: true,
      }
      const email = {
        id: 'email',
        label: 'Email',
        prompt: 'Enter the code we emailed.',
        sends: true,
      }
      if (context.via === 'link') return [app]
      return user.email.startsWith('emailer') ? [email, app] : [app, email]
    },
    send(user, method, context) {
      if (user.email.includes('bounce')) throw new ActionError('We couldn’t email your code.')
      sent.push({ email: user.email, method, via: context.via })
    },
    verify: (_user, method, code) => code === (method === 'app' ? APP_CODE : EMAIL_CODE),
    rememberDays: () => 30,
    remember(user, device) {
      remembered.set(device, user.id)
    },
    ...extra,
  }
  const definition = plugin('codes', { setup: (cms) => cms.auth.signInStep(step) })
  return { definition, sent, calls, remembered }
}

async function site(extra: Partial<SignInStep> = {}) {
  const step = codes(extra)
  const kernel = await bootKernel({ plugins: [step.definition] })
  return { kernel, ...step }
}

const user = (kernel: Kernel, email: string, role = 'administrator') =>
  kernel.auth.createUser({ email, role, password: PASSWORD })

const cookieOf = (response: Response, name: string) =>
  new RegExp(`(?:^|, |\\b)${name}=([^;]*)`).exec(response.headers.get('set-cookie') ?? '')?.[1] ??
  null

const post = (
  kernel: Kernel,
  name: string,
  fields: Record<string, string>,
  options: { cookie?: string; referer?: string } = {},
) =>
  kernel
    .handleApi(
      formPost(kernel.actionUrl('core', name), fields, {
        referer: `${ORIGIN}${options.referer ?? '/admin/login/verify'}`,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      }),
    )
    .then((response) => ({
      response,
      session: cookieOf(response, 'cms_session'),
      hold: cookieOf(response, 'cms_sign_in'),
      device: cookieOf(response, 'cms_device'),
      ...redirectOf(kernel, response),
    }))

/** The password step of the admin's sign-in. */
const logIn = (kernel: Kernel, email: string, fields: Record<string, string> = {}, cookie = '') =>
  post(
    kernel,
    'login',
    { email, password: PASSWORD, ...fields },
    { cookie, referer: '/admin/login' },
  )

const verify = (kernel: Kernel, hold: string | null, fields: Record<string, string>, cookie = '') =>
  post(
    kernel,
    'sign-in-verify',
    { method: 'app', ...fields },
    {
      cookie: `cms_sign_in=${hold ?? ''}${cookie ? `; ${cookie}` : ''}`,
    },
  )

const rows = async (kernel: Kernel, where = 'true') => {
  const result = (await kernel.db.execute(
    sql.raw(`SELECT count(*)::int AS n FROM cms_sign_ins WHERE ${where}`),
  )) as unknown as { rows: { n: number }[] }
  return result.rows[0]!.n
}

describe('without a step', () => {
  it('signs in with the password alone, as before', async () => {
    const kernel = await bootKernel({ plugins: [] })
    await user(kernel, 'ada@cms.test')
    const done = await logIn(kernel, 'ada@cms.test')
    expect(done).toMatchObject({ path: '/admin', hold: null })
    expect(done.session).toMatch(/^[\w-]{43}$/)
    expect(await rows(kernel)).toBe(0)
  })
})

describe('a sign-in step', () => {
  it('lets in at once someone it has no way to ask', async () => {
    const { kernel } = await site()
    await user(kernel, 'plain@cms.test')
    const done = await logIn(kernel, 'plain@cms.test')
    expect(done).toMatchObject({ path: '/admin', hold: null })
    expect(done.session).not.toBeNull()
  })

  it('holds the sign-in after a correct password: no session until a code passes', async () => {
    const { kernel, sent } = await site()
    const ada = await user(kernel, 'ada@cms.test')
    const held = await logIn(kernel, 'ada@cms.test', { next: '/admin/plugins?tab=all' })
    expect(held).toMatchObject({ path: '/admin/login/verify', session: null, flash: null })
    expect(held.hold).toMatch(/^[\w-]{43}$/)
    expect(held.response.headers.get('set-cookie')).toMatch(/cms_sign_in=.*HttpOnly.*Max-Age=600/)
    // The default way is the app, which sends nothing.
    expect(sent).toEqual([])
    expect(await kernel.auth.userForSession(held.hold)).toBeNull()

    const screen = await kernel.signIns.held(held.hold, null)
    expect(screen).toMatchObject({ user: ada, via: 'password', rememberDays: 30 })
    expect(screen!.methods.map((method) => method.id)).toEqual(['app', 'email'])

    const done = await verify(kernel, held.hold, { code: ' 111 111 ' })
    expect(done).toMatchObject({ path: '/admin/plugins?tab=all', device: null })
    expect(await kernel.auth.userForSession(done.session)).toEqual(ada)
    // The held sign-in's cookie is cleared, and the sign-in can't be finished twice.
    expect(done.response.headers.getSetCookie().join('\n')).toMatch(/cms_sign_in=; .*Max-Age=0/)
    expect(await rows(kernel)).toBe(0)
    const again = await verify(kernel, held.hold, { code: APP_CODE })
    expect(again).toMatchObject({ session: null, path: '/admin/login/verify' })
    expect(again.flash).toEqual({
      kind: 'error',
      message: 'That sign-in has run out. Sign in again.',
    })
  })

  it('never reaches the step with a wrong password', async () => {
    const { kernel, calls } = await site()
    await user(kernel, 'ada@cms.test')
    const done = await post(
      kernel,
      'login',
      { email: 'ada@cms.test', password: 'not it' },
      { referer: '/admin/login' },
    )
    expect(done.flash?.message).toBe('Incorrect email or password.')
    expect(done.hold).toBeNull()
    expect(calls).toEqual([])
  })

  it('sends a customer at the admin’s sign-in to their account, after the code', async () => {
    const { kernel } = await site()
    await user(kernel, 'cleo@cms.test', 'customer')
    const held = await logIn(kernel, 'cleo@cms.test', { next: '/admin/plugins' })
    expect((await verify(kernel, held.hold, { code: APP_CODE })).path).toBe('/account')
  })

  it('counts wrong codes, and after five refuses even the right one for the account', async () => {
    const { kernel, sent } = await site()
    await user(kernel, 'ada@cms.test')
    const held = await logIn(kernel, 'ada@cms.test')
    for (const code of ['000000', '', 'x'.repeat(65), '123456']) {
      const wrong = await verify(kernel, held.hold, { code })
      expect(wrong).toMatchObject({ session: null, path: '/admin/login/verify' })
      expect(wrong.flash).toEqual({ kind: 'error', message: 'That code isn’t right.' })
    }
    // A way the person doesn't have counts as a wrong code too.
    expect(
      (await verify(kernel, held.hold, { method: 'sms', code: APP_CODE })).flash?.message,
    ).toBe('That code isn’t right.')
    expect(await rows(kernel, 'failures = 5')).toBe(1)

    const throttled = 'Too many wrong codes. Try again in 15 minutes.'
    expect((await verify(kernel, held.hold, { code: APP_CODE })).flash?.message).toBe(throttled)
    // A new sign-in, with the right password, gets no further, and no code is sent for it.
    const retry = await logIn(kernel, 'ada@cms.test')
    expect(retry).toMatchObject({ hold: null, session: null, path: '/admin/login' })
    expect(retry.flash?.message).toBe(throttled)
    expect(sent).toEqual([])

    // Fifteen minutes on, the wrong codes no longer count.
    await kernel.db.execute(sql`UPDATE cms_sign_ins SET created_at = now() - interval '16 minutes'`)
    const later = await logIn(kernel, 'ada@cms.test')
    expect((await verify(kernel, later.hold, { code: APP_CODE })).session).not.toBeNull()
  })

  it('counts wrong codes over all an account’s sign-ins, and forgives them once one passes', async () => {
    const { kernel } = await site()
    await user(kernel, 'ada@cms.test')
    for (let attempt = 0; attempt < 4; attempt++) {
      const held = await logIn(kernel, 'ada@cms.test')
      await verify(kernel, held.hold, { code: '000000' })
    }
    const held = await logIn(kernel, 'ada@cms.test')
    expect((await verify(kernel, held.hold, { code: APP_CODE })).session).not.toBeNull()
    expect(await rows(kernel)).toBe(0)
    // Another account's wrong codes are its own.
    await user(kernel, 'bob@cms.test')
    const bob = await logIn(kernel, 'bob@cms.test')
    expect((await verify(kernel, bob.hold, { code: APP_CODE })).session).not.toBeNull()
  })

  it('lets a held sign-in run out after ten minutes', async () => {
    const { kernel } = await site()
    await user(kernel, 'ada@cms.test')
    const held = await logIn(kernel, 'ada@cms.test')
    await kernel.db.execute(sql`UPDATE cms_sign_ins SET expires_at = now() - interval '1 second'`)
    expect(await kernel.signIns.held(held.hold, null)).toBeNull()
    const late = await verify(kernel, held.hold, { code: APP_CODE })
    expect(late.session).toBeNull()
    expect(late.flash?.message).toBe('That sign-in has run out. Sign in again.')
    // Without the cookie, or with a made-up one, there is nothing to finish.
    expect((await verify(kernel, null, { code: APP_CODE })).session).toBeNull()
    expect((await verify(kernel, 'x'.repeat(43), { code: APP_CODE })).session).toBeNull()
  })

  it('sends the default way’s code when it is one that sends, and again when asked', async () => {
    const { kernel, sent } = await site()
    await user(kernel, 'emailer@cms.test')
    const held = await logIn(kernel, 'emailer@cms.test')
    expect(sent).toEqual([{ email: 'emailer@cms.test', method: 'email', via: 'password' }])

    const cookie = `cms_sign_in=${held.hold}`
    const again = await post(kernel, 'sign-in-send', { method: 'email' }, { cookie })
    expect(again.path).toBe('/admin/login/verify?method=email')
    expect(again.flash).toEqual({ kind: 'notice', message: 'A new code is on its way.' })
    expect(sent).toHaveLength(2)

    // From the account's screen, back to the account's screen.
    const account = await post(
      kernel,
      'sign-in-send',
      { method: 'email', screen: 'account' },
      { cookie },
    )
    expect(account.path).toBe('/account/verify?method=email')

    // A way that sends nothing, or that the person doesn't have, isn't sent.
    for (const method of ['app', 'sms', '']) {
      const refused = await post(kernel, 'sign-in-send', { method }, { cookie })
      expect(refused.flash).toEqual({ kind: 'error', message: 'Choose one of the ways shown.' })
    }
    expect(sent).toHaveLength(3)
    const none = await post(kernel, 'sign-in-send', { method: 'email' })
    expect(none.flash?.message).toBe('That sign-in has run out. Sign in again.')

    expect(
      (await verify(kernel, held.hold, { method: 'email', code: EMAIL_CODE })).session,
    ).toMatch(/^[\w-]{43}$/)
  })

  it('still holds the sign-in when the code couldn’t be sent, and says why', async () => {
    const { kernel } = await site()
    await user(kernel, 'emailer-bounce@cms.test')
    const held = await logIn(kernel, 'emailer-bounce@cms.test')
    expect(held).toMatchObject({ path: '/admin/login/verify', session: null })
    expect(held.flash?.message).toBe('We couldn’t email your code.')
    // The app still works.
    expect((await verify(kernel, held.hold, { code: APP_CODE })).session).not.toBeNull()
    const second = await logIn(kernel, 'emailer-bounce@cms.test')
    const resend = await post(
      kernel,
      'sign-in-send',
      { method: 'email' },
      {
        cookie: `cms_sign_in=${second.hold}`,
      },
    )
    expect(resend.flash).toEqual({ kind: 'error', message: 'We couldn’t email your code.' })
  })

  it('remembers a browser when asked, and lets it in without a code from then on', async () => {
    const { kernel, remembered, calls } = await site()
    const ada = await user(kernel, 'ada@cms.test')
    const first = await logIn(kernel, 'ada@cms.test')
    const done = await verify(kernel, first.hold, { code: APP_CODE, remember: 'on' })
    expect(done.device).toMatch(/^[\w-]{43}$/)
    expect(done.response.headers.getSetCookie().join('\n')).toMatch(
      /cms_device=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/,
    )
    expect(remembered.get(done.device!)).toBe(ada.id)

    const next = await logIn(kernel, 'ada@cms.test', {}, `cms_device=${done.device}`)
    expect(next).toMatchObject({ path: '/admin', hold: null })
    expect(next.session).not.toBeNull()
    expect(calls.at(-1)!.context).toEqual({ via: 'password', device: done.device })

    // Another browser, or a cookie that isn't an id, is asked as ever.
    expect((await logIn(kernel, 'ada@cms.test')).hold).not.toBeNull()
    await logIn(kernel, 'ada@cms.test', {}, 'cms_device=<script>')
    expect(calls.at(-1)!.context.device).toBeNull()
  })

  it('doesn’t remember a browser that didn’t ask, or for a step that can’t', async () => {
    const { kernel, remembered } = await site()
    await user(kernel, 'ada@cms.test')
    const held = await logIn(kernel, 'ada@cms.test')
    expect((await verify(kernel, held.hold, { code: APP_CODE })).device).toBeNull()
    expect(remembered.size).toBe(0)

    const forgetful = await site({ rememberDays: () => 0 })
    await user(forgetful.kernel, 'ada@cms.test')
    const second = await logIn(forgetful.kernel, 'ada@cms.test')
    expect((await forgetful.kernel.signIns.held(second.hold, null))!.rememberDays).toBe(0)
    const done = await verify(forgetful.kernel, second.hold, { code: APP_CODE, remember: 'on' })
    expect(done.session).not.toBeNull()
    expect(done.device).toBeNull()
  })

  it('fails closed when the step breaks: no session, and the error is logged', async () => {
    const { kernel } = await site({
      methods: () => {
        throw new Error('the codes table is gone')
      },
    })
    await user(kernel, 'ada@cms.test')
    const done = await logIn(kernel, 'ada@cms.test')
    expect(done).toMatchObject({ session: null, hold: null })
    expect(done.flash?.message).toBe('Something went wrong. Check the server log.')
  })
})

describe('the account pages', () => {
  const signIn = (kernel: Kernel, email: string, next?: string) =>
    post(
      kernel,
      'account-sign-in',
      { email, password: PASSWORD, ...(next ? { next } : {}) },
      { referer: '/account' },
    )

  it('ask for the code on the site, and go on to where the person was headed', async () => {
    const { kernel } = await site()
    const cleo = await user(kernel, 'cleo@cms.test', 'customer')
    const held = await signIn(kernel, 'cleo@cms.test', '/orders')
    expect(held).toMatchObject({ path: '/account/verify', session: null })

    const cookies = { signIn: held.hold, device: null }
    const page = await kernel.resolveAccount('/account/verify', {}, null, cookies)
    expect(page!.metadata.title).toBe('Verify it’s you')
    expect(page!.props).toMatchObject({
      view: 'verify',
      signIn: { method: { id: 'app', numeric: true }, rememberDays: 30 },
      actions: {
        verify: kernel.actionUrl('core', 'sign-in-verify'),
        sendCode: kernel.actionUrl('core', 'sign-in-send'),
      },
      paths: { verify: '/account/verify' },
    })
    expect(page!.props.signIn!.methods.map((method) => method.id)).toEqual(['app', 'email'])
    // `?method=` switches; one the person doesn't have falls back to their default.
    const email = await kernel.resolveAccount('/account/verify', { method: 'email' }, null, cookies)
    expect(email!.props.signIn!.method.id).toBe('email')
    const other = await kernel.resolveAccount('/account/verify', { method: 'sms' }, null, cookies)
    expect(other!.props.signIn!.method.id).toBe('app')

    const done = await verify(kernel, held.hold, { code: APP_CODE })
    expect(done.path).toBe('/orders')
    expect(await kernel.auth.userForSession(done.session)).toEqual(cleo)
  })

  it('show that a sign-in has run out when nothing is held', async () => {
    const { kernel } = await site()
    const none = await kernel.resolveAccount('/account/verify', {}, null)
    expect(none!.props).toMatchObject({ view: 'verify', signIn: null })
    const stale = { signIn: 'x'.repeat(43), device: null }
    expect(
      (await kernel.resolveAccount('/account/verify', {}, null, stale))!.props.signIn,
    ).toBeNull()
    // Other views carry no sign-in, whatever the cookie.
    expect((await kernel.resolveAccount('/account', {}, null, stale))!.props.signIn).toBeNull()
  })

  it('ask for a code after a reset link too: an inbox alone doesn’t open the account', async () => {
    const inbox: string[] = []
    const step = codes()
    const mailer = plugin('mailer', {
      setup: (cms) =>
        cms.mail.transport({ send: async (message) => void inbox.push(message.text) }),
    })
    const kernel = await bootKernel({ plugins: [step.definition, mailer] })
    const ada = await user(kernel, 'ada@cms.test')
    await post(kernel, 'account-lost-password', { email: 'ada@cms.test' }, { referer: '/account' })
    const token = /token=([\w-]+)/.exec(inbox.at(-1)!)![1]!

    const reset = await post(
      kernel,
      'account-reset',
      { token, password: 'a brand new passphrase' },
      { referer: '/account/reset' },
    )
    expect(reset).toMatchObject({ path: '/account/verify', session: null })
    expect(reset.flash?.message).toBe('Your password is set. Enter a code to finish signing in.')
    // The step is told how they came, and offers the app alone.
    const held = await kernel.signIns.held(reset.hold, null)
    expect(held).toMatchObject({ via: 'link' })
    expect(held!.methods.map((method) => method.id)).toEqual(['app'])
    expect(
      (await verify(kernel, reset.hold, { method: 'email', code: EMAIL_CODE })).session,
    ).toBeNull()
    const done = await verify(kernel, reset.hold, { code: APP_CODE })
    expect(done.path).toBe('/account')
    expect(await kernel.auth.userForSession(done.session)).toMatchObject({ id: ada.id })
  })

  it('end a held sign-in when the password changes under it', async () => {
    const { kernel } = await site()
    const ada = await user(kernel, 'ada@cms.test')
    const held = await logIn(kernel, 'ada@cms.test')
    await kernel.auth.signOutEverywhere(ada.id)
    expect(await kernel.signIns.held(held.hold, null)).toBeNull()
    expect((await verify(kernel, held.hold, { code: APP_CODE })).session).toBeNull()
  })
})

describe('adding a step', () => {
  const step: SignInStep = { methods: () => [], verify: () => false }

  it('is for one plugin, in setup()', async () => {
    const first = plugin('first', { setup: (cms) => cms.auth.signInStep(step) })
    const second = plugin('second', { setup: (cms) => cms.auth.signInStep(step) })
    await expect(bootKernel({ plugins: [first, second] })).rejects.toThrow(
      'Plugin "second" adds a sign-in step, but "first" already does; only one can',
    )
    const broken = plugin('broken', {
      setup: (cms) => cms.auth.signInStep({ methods: () => [] } as never),
    })
    await expect(bootKernel({ plugins: [broken] })).rejects.toThrow(
      'The sign-in step from "broken" needs methods() and verify()',
    )
    const late = plugin('late')
    await expect(
      bootKernel({
        plugins: [late],
        admin: [defineAdmin(late, (cms) => cms.auth.signInStep(step))],
      }),
    ).rejects.toThrow('Add the sign-in step in setup()')
  })

  it('goes with its plugin: deactivated, sign-ins need no code', async () => {
    const { definition } = codes()
    const kernel = await bootKernel({ plugins: [definition], active: [] })
    await user(kernel, 'ada@cms.test')
    expect((await logIn(kernel, 'ada@cms.test')).session).not.toBeNull()
  })
})

describe('cms.auth.checkPassword', () => {
  it('says whether a password is the user’s, and throttles as signing in does', async () => {
    let check!: (user: User, password: string) => Promise<boolean>
    const asker = plugin('asker', {
      setup: (cms) => {
        check = cms.auth.checkPassword
      },
    })
    const kernel = await bootKernel({ plugins: [asker] })
    const ada = await user(kernel, 'ada@cms.test')
    expect(await check(ada, PASSWORD)).toBe(true)
    for (let attempt = 0; attempt < 5; attempt++) expect(await check(ada, 'not it')).toBe(false)
    await expect(check(ada, PASSWORD)).rejects.toThrow(ActionError)
    await expect(check(ada, PASSWORD)).rejects.toThrow('Too many failed attempts')
  })
})
