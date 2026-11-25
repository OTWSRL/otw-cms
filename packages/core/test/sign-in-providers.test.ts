import {
  ActionError,
  defineAdmin,
  type PluginContext,
  type SignInIdentity,
  type SignInProvider,
  type SignInProviderRequest,
} from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Kernel } from '../src/kernel'
import type { MemoryLogger } from '../src/logger'
import { createPendingCodec } from '../src/sign-in-providers'
import {
  bootKernel,
  formPost,
  memoryLogger,
  ORIGIN,
  PASSWORD,
  plugin,
  redirectOf,
  signIn,
} from './helpers'

const IMAGE = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`

/** Who the pretend service says each code belongs to. */
const PEOPLE: Record<string, SignInIdentity> = {
  ada: {
    subject: 'sub-ada',
    email: 'Ada@Gmail.test',
    emailVerified: true,
    emailOwned: true,
    name: 'Ada Lovelace',
  },
  // Verified once by the service, which doesn't host the mailbox.
  linus: { subject: 'sub-linus', email: 'linus@other.test', emailVerified: true, name: 'Linus' },
  unverified: { subject: 'sub-u', email: 'u@other.test', emailVerified: false, emailOwned: true },
}

/** A sign-in provider in miniature: `code` names one of the people above. */
function service(extra: Partial<SignInProvider> = {}, people = PEOPLE) {
  const started: SignInProviderRequest[] = []
  const finished: (SignInProviderRequest & { code: string | null })[] = []
  let cms: PluginContext | undefined
  const provider: SignInProvider = {
    id: 'pretend',
    label: 'Continue with Pretend',
    name: 'Pretend',
    image: IMAGE,
    start(request) {
      started.push(request)
      return `https://accounts.pretend.test/auth?state=${request.state}&redirect_uri=${encodeURIComponent(request.redirectUri)}`
    },
    finish({ params, ...request }) {
      const code = params.get('code')
      finished.push({ ...request, code })
      if (params.get('error')) throw new ActionError('You didn’t allow it at Pretend.')
      const person = code ? people[code] : undefined
      if (!person) throw new Error('unknown code')
      return person
    },
    newAccountRole: () => 'customer',
    ...extra,
  }
  const definition = plugin('pretend', {
    setup(context) {
      cms = context
      context.auth.signInProvider(provider)
    },
  })
  return { definition, started, finished, cms: () => cms! }
}

async function site(
  extra: Partial<SignInProvider> = {},
  options: Parameters<typeof bootKernel>[0] = { plugins: [] },
) {
  const pretend = service(extra)
  const logger = memoryLogger()
  const kernel = await bootKernel({
    ...options,
    logger,
    plugins: [...options.plugins, pretend.definition],
  })
  return { kernel, logger: logger as MemoryLogger, ...pretend }
}

const get = (kernel: Kernel, path: string, cookie = '', origin = ORIGIN) =>
  kernel.handleApi(new Request(new URL(path, origin), { headers: cookie ? { cookie } : {} }))

const setCookie = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1) ?? null

/** Leaves for the service: where the browser is sent, and the cookie it keeps meanwhile. */
async function leave(kernel: Kernel, query = 'screen=admin', origin = ORIGIN) {
  const response = await get(kernel, `/api/p/core/sign-in/pretend?${query}`, '', origin)
  const location = response.headers.get('location') ?? ''
  const cookie =
    setCookie(response, '__Host-cms_sign_in_with') ?? setCookie(response, 'cms_sign_in_with')
  const state = location.startsWith('https://accounts.pretend.test/')
    ? new URL(location).searchParams.get('state')
    : null
  return { response, location, cookie, state }
}

/** Comes back from the service with a code. */
async function back(
  kernel: Kernel,
  input: { cookie: string | null; state: string | null; code?: string; query?: string },
  origin = ORIGIN,
) {
  const query = new URLSearchParams(input.query ?? '')
  if (input.state !== null) query.set('state', input.state)
  if (input.code) query.set('code', input.code)
  const response = await get(
    kernel,
    `/api/p/core/sign-in/pretend/callback?${query}`,
    input.cookie ?? '',
    origin,
  )
  return {
    response,
    session: setCookie(response, 'cms_session')?.split('=')[1] ?? null,
    hold: setCookie(response, 'cms_sign_in')?.split('=')[1] ?? null,
    ...redirectOf(kernel, response),
  }
}

/** The whole trip for one person. */
async function arrive(kernel: Kernel, code: string, query = 'screen=admin') {
  const left = await leave(kernel, query)
  return back(kernel, { cookie: left.cookie, state: left.state, code })
}

const rows = async <T>(kernel: Kernel, text: string) =>
  ((await kernel.db.execute(sql.raw(text))) as unknown as { rows: T[] }).rows

const identities = (kernel: Kernel) =>
  rows<{ provider: string; subject: string; email: string; plugin: string }>(
    kernel,
    `SELECT i.provider, i.subject, i.plugin, u.email FROM cms_identities i
     JOIN cms_users u ON u.id = i.user_id ORDER BY i.subject`,
  )

describe('without a provider', () => {
  it('shows no button, answers neither address and runs no query for them', async () => {
    const kernel = await bootKernel({ plugins: [] })
    expect(kernel.signInProviders('admin', '/admin')).toEqual([])
    const page = await kernel.resolveAccount('/account', {}, null)
    expect(page!.props.providers).toEqual([])
    expect((await get(kernel, '/api/p/core/sign-in/pretend')).status).toBe(404)
    expect((await get(kernel, '/api/p/core/sign-in/pretend/callback?state=x')).status).toBe(404)
  })
})

describe('the sign-in pages', () => {
  it('get a link per provider, headed where the person was going', async () => {
    const { kernel } = await site()
    expect(kernel.signInProviders('admin', '/admin/posts?x=1')).toEqual([
      {
        id: 'pretend',
        label: 'Continue with Pretend',
        image: IMAGE,
        url: '/api/p/core/sign-in/pretend?screen=admin&next=%2Fadmin%2Fposts%3Fx%3D1',
      },
    ])
    const page = await kernel.resolveAccount('/account', { next: '/orders' }, null)
    expect(page!.props.providers.map((link) => link.url)).toEqual([
      '/api/p/core/sign-in/pretend?screen=account&next=%2Forders',
    ])
    // Another site's address is never carried.
    expect(kernel.signInProviders('admin', 'https://evil.test/')[0]!.url).toBe(
      '/api/p/core/sign-in/pretend?screen=admin',
    )
    // Only the sign-in view lists them.
    const { user } = await signIn(kernel, 'customer')
    expect((await kernel.resolveAccount('/account', {}, user))!.props.providers).toEqual([])
  })
})

describe('leaving for the provider', () => {
  it('sends the person on with a state and a verifier only their browser holds', async () => {
    const { kernel, started } = await site()
    const left = await leave(kernel)
    expect(left.response.status).toBe(303)
    expect(left.location.startsWith('https://accounts.pretend.test/auth?')).toBe(true)
    expect(started).toHaveLength(1)
    expect(started[0]!.redirectUri).toBe(`${ORIGIN}/api/p/core/sign-in/pretend/callback`)
    expect(started[0]!.state).toMatch(/^[\w-]{43}$/)
    expect(started[0]!.verifier).toMatch(/^[\w-]{43}$/)
    expect(started[0]!.verifier).not.toBe(started[0]!.state)
    expect(left.state).toBe(started[0]!.state)
    const header = left.response.headers.getSetCookie()[0]!
    expect(header).toMatch(
      /^cms_sign_in_with=[\w.-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/,
    )
    // Each sign-in gets its own.
    const again = await leave(kernel)
    expect(again.state).not.toBe(left.state)
    expect(left.response.headers.get('cache-control')).toBe('no-store')
  })

  it('uses the configured site address, and the `__Host-` cookie on https', async () => {
    const { kernel, started } = await site(
      {},
      { plugins: [], settings: { 'site.url': 'https://shop.test' } },
    )
    const left = await leave(kernel)
    expect(started[0]!.redirectUri).toBe('https://shop.test/api/p/core/sign-in/pretend/callback')
    expect(left.response.headers.getSetCookie()[0]).toMatch(
      /^__Host-cms_sign_in_with=[\w.-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/,
    )
  })

  it('refuses an address that isn’t https, and says so on the page it came from', async () => {
    for (const address of [
      'http://accounts.pretend.test/auth',
      'javascript:alert(1)',
      '/auth',
      '',
    ]) {
      const { kernel } = await site({ start: () => address })
      const left = await leave(kernel, 'screen=account')
      const { path, flash } = redirectOf(kernel, left.response)
      expect({ address, path, flash }).toEqual({
        address,
        path: '/account',
        flash: { kind: 'error', message: 'Signing in with Pretend isn’t working. Try again.' },
      })
      expect(left.cookie).toBeNull()
    }
    // This machine's own http is allowed, for a test service.
    const local = await site({ start: () => 'http://localhost:3511/auth?x=1' })
    expect((await leave(local.kernel)).location).toBe('http://localhost:3511/auth?x=1')
  })

  it('says what the provider says when it can’t start, and logs anything else', async () => {
    const told = await site({
      start: () => {
        throw new ActionError('Pretend isn’t set up yet.')
      },
    })
    expect(redirectOf(told.kernel, (await leave(told.kernel)).response)).toMatchObject({
      path: '/admin/login',
      flash: { kind: 'error', message: 'Pretend isn’t set up yet.' },
    })
    const broke = await site({
      start: () => {
        throw new Error('secret detail')
      },
    })
    const { flash } = redirectOf(broke.kernel, (await leave(broke.kernel)).response)
    expect(flash!.message).toBe('Signing in with Pretend isn’t working. Try again.')
    expect(broke.logger.entries.some((entry) => entry.level === 'error')).toBe(true)
  })
})

describe('coming back', () => {
  it('signs in someone the provider owns the address of, making their account', async () => {
    const { kernel, finished } = await site()
    const left = await leave(kernel, 'screen=account&next=%2Forders')
    const done = await back(kernel, { cookie: left.cookie, state: left.state, code: 'ada' })
    expect(done).toMatchObject({ status: 303, path: '/orders', flash: null })
    const user = await kernel.auth.userForSession(done.session)
    expect(user).toMatchObject({ email: 'ada@gmail.test', name: 'Ada Lovelace', role: 'customer' })
    // The provider got back what it was given when the person left.
    expect(finished[0]).toMatchObject({
      code: 'ada',
      state: left.state,
      redirectUri: `${ORIGIN}/api/p/core/sign-in/pretend/callback`,
    })
    expect(finished[0]!.verifier).toMatch(/^[\w-]{43}$/)
    expect(await identities(kernel)).toEqual([
      { provider: 'pretend', subject: 'sub-ada', plugin: 'pretend', email: 'ada@gmail.test' },
    ])
    const [row] = await rows<{ password_hash: string; verified: boolean }>(
      kernel,
      `SELECT password_hash, email_verified_at IS NOT NULL AS verified FROM cms_users WHERE email = 'ada@gmail.test'`,
    )
    expect(row).toEqual({ password_hash: '', verified: true })
    // The cookie is used up.
    expect(done.response.headers.getSetCookie().join('\n')).toMatch(
      /cms_sign_in_with=; .*Max-Age=0/,
    )
  })

  it('finds the person by the provider’s id from then on, whatever their address became', async () => {
    const people = { ...PEOPLE }
    const pretend = service({}, people)
    const kernel = await bootKernel({ plugins: [pretend.definition] })
    const first = await arrive(kernel, 'ada')
    const before = await kernel.auth.userForSession(first.session)
    people.ada = { ...PEOPLE.ada!, email: 'renamed@other.test', emailVerified: false }
    const second = await arrive(kernel, 'ada')
    expect(await kernel.auth.userForSession(second.session)).toEqual(before)
    expect(await rows(kernel, 'SELECT 1 FROM cms_users')).toHaveLength(1)
  })

  it('joins the account that has the address only when the provider owns the address', async () => {
    const { kernel } = await site()
    const ada = await kernel.auth.createUser({
      email: 'ada@gmail.test',
      role: 'administrator',
      password: PASSWORD,
    })
    const done = await arrive(kernel, 'ada')
    expect(done.path).toBe('/admin')
    expect(await kernel.auth.userForSession(done.session)).toEqual(ada)
    expect(await kernel.accounts.isVerified(ada.id)).toBe(true)

    // Verified once, by a service that doesn't host the mailbox: not the owner's word.
    await kernel.auth.createUser({ email: 'linus@other.test', role: 'editor', password: PASSWORD })
    const refused = await arrive(kernel, 'linus')
    expect(refused).toMatchObject({
      path: '/admin/login',
      session: null,
      flash: {
        kind: 'error',
        message: 'An account here already uses linus@other.test. Sign in with its password.',
      },
    })
    expect((await identities(kernel)).map((row) => row.subject)).toEqual(['sub-ada'])
  })

  it('gives someone new an account on a verified address, owned or not', async () => {
    const { kernel } = await site()
    const done = await arrive(kernel, 'linus')
    expect(await kernel.auth.userForSession(done.session)).toMatchObject({
      email: 'linus@other.test',
      role: 'customer',
    })
    // A customer at the admin's sign-in lands on their account.
    expect(done.path).toBe('/account')
  })

  it('turns away an address nobody verified: no account, no link, no session', async () => {
    const { kernel } = await site()
    await kernel.auth.createUser({ email: 'u@other.test', role: 'editor', password: PASSWORD })
    const done = await arrive(kernel, 'unverified')
    expect(done).toMatchObject({
      path: '/admin/login',
      session: null,
      flash: {
        kind: 'error',
        message:
          'Pretend hasn’t confirmed that email address, so it can’t be used to sign in here.',
      },
    })
    expect(await identities(kernel)).toEqual([])
  })

  it('turns away someone without an account when the provider gives new people no role', async () => {
    for (const newAccountRole of [undefined, () => null, () => 'no-such-role']) {
      const { kernel } = await site({ newAccountRole })
      const done = await arrive(kernel, 'ada')
      expect(done).toMatchObject({
        session: null,
        flash: { kind: 'error', message: 'There’s no account for ada@gmail.test on this site.' },
      })
      expect(await rows(kernel, 'SELECT 1 FROM cms_users')).toHaveLength(0)
    }
  })

  it('needs the state the browser left with: another, none, or no cookie ends it', async () => {
    const { kernel, finished } = await site()
    const left = await leave(kernel)
    const other = await leave(kernel)
    const ran = {
      path: '/admin/login',
      session: null,
      flash: { kind: 'error', message: 'That sign-in has run out. Try again.' },
    }
    // Someone else's state with this browser's cookie, and the reverse.
    expect(
      await back(kernel, { cookie: left.cookie, state: other.state, code: 'ada' }),
    ).toMatchObject(ran)
    expect(await back(kernel, { cookie: left.cookie, state: null, code: 'ada' })).toMatchObject(ran)
    expect(await back(kernel, { cookie: left.cookie, state: '', code: 'ada' })).toMatchObject(ran)
    expect(await back(kernel, { cookie: null, state: left.state, code: 'ada' })).toMatchObject(ran)
    // A cookie this site didn't sign: the same payload with its last character changed.
    const forged = left.cookie!.slice(0, -1) + (left.cookie!.endsWith('A') ? 'B' : 'A')
    expect(await back(kernel, { cookie: forged, state: left.state, code: 'ada' })).toMatchObject(
      ran,
    )
    expect(finished).toEqual([])
    expect(await rows(kernel, 'SELECT 1 FROM cms_users')).toHaveLength(0)
    // The untouched pair still works.
    expect(
      (await back(kernel, { cookie: left.cookie, state: left.state, code: 'ada' })).session,
    ).not.toBeNull()
  })

  it('takes a cookie only at the provider it was made for', async () => {
    const first = service()
    const second = service({ id: 'second' })
    const kernel = await bootKernel({
      plugins: [first.definition, { ...second.definition, id: 'second' }],
    })
    const left = await leave(kernel)
    const query = new URLSearchParams({ state: left.state!, code: 'ada' })
    const response = await get(kernel, `/api/p/core/sign-in/second/callback?${query}`, left.cookie!)
    expect(redirectOf(kernel, response).flash!.message).toBe('That sign-in has run out. Try again.')
    expect(second.finished).toEqual([])
    expect(setCookie(response, 'cms_session')).toBeNull()
  })

  it('takes only the `__Host-` cookie on https: a plain one could be planted', async () => {
    const { kernel } = await site(
      {},
      { plugins: [], settings: { 'site.url': 'https://shop.test' } },
    )
    const left = await leave(kernel)
    expect(left.cookie!.startsWith('__Host-cms_sign_in_with=')).toBe(true)
    const planted = left.cookie!.replace('__Host-', '')
    const refused = await back(kernel, { cookie: planted, state: left.state, code: 'ada' })
    expect(refused).toMatchObject({
      session: null,
      flash: { message: 'That sign-in has run out. Try again.' },
    })
    const done = await back(kernel, { cookie: left.cookie, state: left.state, code: 'ada' })
    expect(done.response.headers.getSetCookie().join('\n')).toMatch(/__Host-cms_session=[\w-]{43};/)
  })

  it('says what the provider says when it throws an ActionError, and little otherwise', async () => {
    const { kernel, logger } = await site()
    const left = await leave(kernel, 'screen=account')
    const denied = await back(kernel, {
      cookie: left.cookie,
      state: left.state,
      query: 'error=access_denied',
    })
    expect(denied).toMatchObject({
      path: '/account',
      session: null,
      flash: { kind: 'error', message: 'You didn’t allow it at Pretend.' },
    })
    const again = await leave(kernel)
    const broken = await back(kernel, { cookie: again.cookie, state: again.state, code: 'nobody' })
    expect(broken.flash).toEqual({
      kind: 'error',
      message: 'Signing in with Pretend didn’t work. Try again.',
    })
    expect(logger.entries.filter((entry) => entry.level === 'error')).toHaveLength(1)
  })

  it('checks what the provider returns: an id or address that can’t be one signs nobody in', async () => {
    const bad: SignInIdentity[] = [
      { subject: '', email: 'a@b.test', emailVerified: true },
      { subject: 'has space', email: 'a@b.test', emailVerified: true },
      { subject: 'x'.repeat(256), email: 'a@b.test', emailVerified: true },
      { subject: 'ok', email: 'not-an-address', emailVerified: true },
      { subject: 'ok', email: `${'a'.repeat(250)}@b.test`, emailVerified: true },
      { subject: 7 as unknown as string, email: 'a@b.test', emailVerified: true },
      null as unknown as SignInIdentity,
    ]
    for (const identity of bad) {
      const { kernel } = await site({ finish: () => identity })
      const done = await arrive(kernel, 'x')
      expect(done.session).toBeNull()
      expect(done.flash!.message).toBe('Signing in with Pretend didn’t work. Try again.')
      expect(await rows(kernel, 'SELECT 1 FROM cms_users')).toHaveLength(0)
    }
    // "true" as text isn't verified, and an owned address must be verified too.
    const sloppy = await site({
      finish: () => ({
        subject: 's',
        email: 'a@b.test',
        emailVerified: 'true' as unknown as boolean,
        emailOwned: true,
      }),
    })
    expect((await arrive(sloppy.kernel, 'x')).session).toBeNull()
    // A name's control characters are dropped, and it's cut to the length names have.
    const named = await site({
      finish: () => ({
        subject: 's',
        email: 'a@b.test',
        emailVerified: true,
        name: `Ada\u0000\n${'x'.repeat(200)}`,
      }),
    })
    const done = await arrive(named.kernel, 'x')
    const user = await named.kernel.auth.userForSession(done.session)
    expect(user!.name).toBe(`Ada${'x'.repeat(97)}`)
  })

  it('goes only to a path on this site afterwards', async () => {
    const { kernel } = await site()
    await kernel.auth.createUser({
      email: 'ada@gmail.test',
      role: 'administrator',
      password: PASSWORD,
    })
    for (const next of [
      'https://evil.test/',
      '//evil.test',
      '/\\evil.test',
      `/${'a'.repeat(3000)}`,
    ]) {
      const done = await arrive(kernel, 'ada', `screen=admin&next=${encodeURIComponent(next)}`)
      expect({ next, path: done.path }).toEqual({ next, path: '/admin' })
    }
    const kept = await arrive(kernel, 'ada', 'screen=admin&next=%2Fadmin%2Fposts')
    expect(kept.path).toBe('/admin/posts')
  })
})

describe('with a sign-in step', () => {
  it('still asks for the code: the provider proves who, not the second step', async () => {
    const pretend = service()
    const contexts: string[] = []
    const codes = plugin('codes', {
      setup: (cms) =>
        cms.auth.signInStep({
          methods(_user, context) {
            contexts.push(context.via)
            return [{ id: 'app', label: 'App', prompt: 'Enter the code.' }]
          },
          verify: (_user, _method, code) => code === '111111',
        }),
    })
    const kernel = await bootKernel({ plugins: [pretend.definition, codes] })
    const held = await arrive(kernel, 'ada', 'screen=account&next=%2Forders')
    expect(held).toMatchObject({ path: '/account/verify', session: null })
    expect(held.hold).toMatch(/^[\w-]{43}$/)
    expect(contexts).toEqual(['provider'])
    const response = await kernel.handleApi(
      formPost(
        kernel.actionUrl('core', 'sign-in-verify'),
        { method: 'app', code: '111111' },
        { cookie: `cms_sign_in=${held.hold}`, referer: `${ORIGIN}/account/verify` },
      ),
    )
    expect(redirectOf(kernel, response).path).toBe('/orders')
  })
})

describe('adding a provider', () => {
  const boot = (provider: Partial<SignInProvider>) =>
    bootKernel({ plugins: [service(provider).definition] })

  it('needs an id, a label, a name, both functions and a data: image', async () => {
    await expect(boot({ id: 'Bad Id' })).rejects.toThrow(/lowercase letters, digits and hyphens/)
    await expect(boot({ id: '../x' })).rejects.toThrow(/lowercase letters/)
    await expect(boot({ label: '' })).rejects.toThrow(/needs a label/)
    await expect(boot({ name: 'x'.repeat(61) })).rejects.toThrow(/needs a name/)
    await expect(boot({ finish: undefined })).rejects.toThrow(/needs start\(\) and finish\(\)/)
    for (const image of [
      'https://cdn.test/g.svg',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/svg+xml,<svg onload="x"/>',
      `data:image/png;base64,${'A'.repeat(9000)}`,
    ]) {
      await expect(boot({ image })).rejects.toThrow(/data: address of an SVG or PNG/)
    }
  })

  it('is once per id, and in setup()', async () => {
    const bare = (id: string): SignInProvider => ({
      id,
      label: 'x',
      name: 'x',
      start: () => '',
      finish: () => PEOPLE.ada!,
    })
    const twice = plugin('zebra', { setup: (cms) => cms.auth.signInProvider(bare('pretend')) })
    await expect(bootKernel({ plugins: [service().definition, twice] })).rejects.toThrow(
      'Plugin "zebra" adds the sign-in provider "pretend", but "pretend" already does',
    )
    const late = plugin('late')
    await expect(
      bootKernel({
        plugins: [late],
        admin: [defineAdmin(late, (cms) => cms.auth.signInProvider(bare('late')))],
      }),
    ).rejects.toThrow('Add the sign-in provider in setup()')
  })
})

describe('linking an identity by hand', () => {
  it('lets a signed-in person’s id sign in as them, and refuses one that is someone else’s', async () => {
    const { kernel, cms } = await site({ newAccountRole: undefined })
    const { user: editor } = await signIn(kernel, 'editor')
    const { user: other } = await signIn(kernel, 'editor')
    await cms().auth.linkIdentity('pretend', editor, 'sub-linus')
    // Again is fine.
    await cms().auth.linkIdentity('pretend', editor, 'sub-linus')
    const done = await arrive(kernel, 'linus')
    expect(await kernel.auth.userForSession(done.session)).toEqual(editor)

    await expect(cms().auth.linkIdentity('pretend', other, 'sub-linus')).rejects.toThrow(
      'That Pretend account already signs in someone else here.',
    )
    await expect(cms().auth.linkIdentity('pretend', other, 'has space')).rejects.toThrow(TypeError)
    await expect(cms().auth.linkIdentity('nope', other, 'x')).rejects.toThrow(
      /no sign-in provider "nope"/,
    )

    await cms().auth.unlinkIdentity('pretend', other)
    expect(await identities(kernel)).toHaveLength(1)
    await cms().auth.unlinkIdentity('pretend', editor, 'another-subject')
    expect(await identities(kernel)).toHaveLength(1)
    await cms().auth.unlinkIdentity('pretend', editor)
    expect(await identities(kernel)).toEqual([])
    expect((await arrive(kernel, 'linus')).session).toBeNull()
  })

  it('is for a plugin’s own providers', async () => {
    let outsider: PluginContext | undefined
    const other = plugin('outsider', { setup: (cms) => void (outsider = cms) })
    const kernel = await bootKernel({ plugins: [service().definition, other] })
    const { user } = await signIn(kernel, 'editor')
    await expect(outsider!.auth.linkIdentity('pretend', user, 'sub-x')).rejects.toThrow(
      /"outsider" has no sign-in provider "pretend"/,
    )
    await expect(outsider!.auth.unlinkIdentity('pretend', user)).rejects.toThrow(
      /no sign-in provider/,
    )
  })
})

describe('the cookie', () => {
  const pending = {
    provider: 'pretend',
    state: 's'.repeat(43),
    verifier: 'v'.repeat(43),
    next: '/admin',
    screen: 'admin' as const,
    expires: 2_000,
  }

  it('opens what this site sealed, until it runs out', () => {
    let now = 1_000
    const codec = createPendingCodec('secret', () => now)
    const sealed = codec.seal(pending)
    expect(codec.open(sealed)).toEqual(pending)
    now = 2_000
    expect(codec.open(sealed)).toBeNull()
  })

  it('opens nothing signed with another secret, changed, or signed for another purpose', async () => {
    const codec = createPendingCodec('secret', () => 1_000)
    const sealed = codec.seal(pending)
    expect(createPendingCodec('other', () => 1_000).open(sealed)).toBeNull()
    const [payload, signature] = sealed.split('.') as [string, string]
    const changed = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        n: '/elsewhere',
      }),
    ).toString('base64url')
    expect(codec.open(`${changed}.${signature}`)).toBeNull()
    for (const value of [
      null,
      '',
      'x',
      `${payload}.`,
      `.${signature}`,
      `${sealed}.x`,
      'a'.repeat(5000),
    ]) {
      expect(codec.open(value)).toBeNull()
    }
    // A flash message is signed with the same secret: its signature must not pass here.
    const { createHmac } = await import('node:crypto')
    const asFlash = createHmac('sha256', 'secret').update(payload).digest('base64url')
    expect(codec.open(`${payload}.${asFlash}`)).toBeNull()
  })
})
