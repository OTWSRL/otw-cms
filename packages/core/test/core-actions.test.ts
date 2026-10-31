import { describe, expect, it } from 'vitest'
import {
  bootKernel,
  cookiesFrom,
  formPost,
  ORIGIN,
  PASSWORD,
  plugin,
  redirectOf,
  signIn,
} from './helpers'

const action = (name: string) => `/api/p/core/actions/${name}`

describe('first-run setup', () => {
  it('creates the first administrator and signs them in', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const response = await kernel.handleApi(
      formPost(action('setup'), { name: 'Ana', email: 'Ana@Example.com', password: PASSWORD }),
    )
    expect(redirectOf(kernel, response)).toEqual({
      status: 303,
      path: '/admin',
      flash: { kind: 'notice', message: 'Your site is ready.' },
    })

    const [cookie] = response.headers.getSetCookie()
    expect(cookie).toMatch(
      /^cms_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1209600$/,
    )
    const user = await kernel.auth.userForSession(cookie!.split(';')[0]!.split('=')[1])
    expect(user).toMatchObject({ email: 'ana@example.com', name: 'Ana', role: 'administrator' })
  })

  it('refuses once the site has a user', async () => {
    const kernel = await bootKernel({ plugins: [] })
    await signIn(kernel)
    const response = await kernel.handleApi(
      formPost(
        action('setup'),
        { email: 'intruder@evil.test', password: PASSWORD },
        { referer: `${ORIGIN}/admin/setup` },
      ),
    )
    expect(redirectOf(kernel, response)).toEqual({
      status: 303,
      path: '/admin/setup',
      flash: { kind: 'error', message: 'This site already has an administrator.' },
    })
    expect(response.headers.getSetCookie()).toEqual([])
  })
})

describe('signing in and out', () => {
  it('signs in and continues to the page the user wanted', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { user } = await signIn(kernel)
    const response = await kernel.handleApi(
      formPost(action('login'), { email: user.email, password: PASSWORD, next: '/admin/users' }),
    )
    expect(redirectOf(kernel, response)).toMatchObject({ status: 303, path: '/admin/users' })
    expect(await kernel.auth.userForSession(cookiesFrom(response).split('=')[1])).toEqual(user)
  })

  it('never follows an off-site next parameter', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { user } = await signIn(kernel)
    const response = await kernel.handleApi(
      formPost(action('login'), {
        email: user.email,
        password: PASSWORD,
        next: 'https://evil.test',
      }),
    )
    expect(redirectOf(kernel, response).path).toBe('/admin')
  })

  it('sends a failed sign-in back to the form with the reason', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { user } = await signIn(kernel)
    const response = await kernel.handleApi(
      formPost(
        action('login'),
        { email: user.email, password: 'wrong password' },
        { referer: `${ORIGIN}/admin/login?next=%2Fadmin%2Fusers` },
      ),
    )
    expect(redirectOf(kernel, response)).toEqual({
      status: 303,
      path: '/admin/login?next=%2Fadmin%2Fusers',
      flash: { kind: 'error', message: 'Incorrect email or password.' },
    })
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it('uses a __Host- Secure cookie when the site is served over HTTPS', async () => {
    const kernel = await bootKernel({ plugins: [], settings: { 'site.url': 'https://cms.test' } })
    const { user } = await signIn(kernel)
    const response = await kernel.handleApi(
      formPost(action('login'), { email: user.email, password: PASSWORD }),
    )
    expect(response.headers.getSetCookie()[0]).toMatch(
      /^__Host-cms_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=\d+$/,
    )
  })

  it('signs out: the session ends and both cookie variants are cleared', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { cookie } = await signIn(kernel)
    const response = await kernel.handleApi(formPost(action('logout'), {}, { cookie }))
    expect(redirectOf(kernel, response)).toMatchObject({ status: 303, path: '/admin/login' })
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-cms_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
      'cms_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    ])
    expect(await kernel.auth.userForSession(cookie.split('=')[1])).toBeNull()
  })
})

describe('users', () => {
  it('lets administrators add users and change roles', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { cookie } = await signIn(kernel)
    const created = await kernel.handleApi(
      formPost(
        action('create-user'),
        { email: 'bo@b.co', name: 'Bo', role: 'customer', password: PASSWORD },
        { cookie },
      ),
    )
    // Back to the list, as user-new.php returns to users.php.
    expect(redirectOf(kernel, created)).toMatchObject({
      path: '/admin/users',
      flash: { kind: 'notice', message: 'Added bo@b.co.' },
    })
    const bo = (await kernel.auth.listUsers()).find((user) => user.email === 'bo@b.co')!

    const updated = await kernel.handleApi(
      formPost(action('set-role'), { users: [bo.id], role: 'administrator' }, { cookie }),
    )
    expect(redirectOf(kernel, updated).flash).toEqual({
      kind: 'notice',
      message: 'Updated bo@b.co.',
    })
    expect((await kernel.auth.userForSession(cookie.split('=')[1]))?.role).toBe('administrator')
  })

  it('changes the role of every selected user at once', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { user, cookie } = await signIn(kernel)
    const add = (email: string) =>
      kernel.handleApi(
        formPost(
          action('create-user'),
          { email, role: 'customer', password: PASSWORD },
          { cookie },
        ),
      )
    await add('a@b.co')
    await add('b@b.co')
    const ids = (await kernel.auth.listUsers())
      .filter((each) => each.id !== user.id)
      .map((each) => each.id)

    const changed = await kernel.handleApi(
      formPost(action('set-role'), { users: ids, role: 'administrator' }, { cookie }),
    )
    expect(redirectOf(kernel, changed).flash).toEqual({
      kind: 'notice',
      message: 'Changed the role of 2 users.',
    })
    expect((await kernel.auth.listUsers()).map((each) => each.role)).toEqual([
      'administrator',
      'administrator',
      'administrator',
    ])

    const none = await kernel.handleApi(
      formPost(action('set-role'), { role: 'customer' }, { cookie }),
    )
    expect(redirectOf(kernel, none).flash).toEqual({
      kind: 'error',
      message: 'Select the users to change.',
    })
    const noRole = await kernel.handleApi(formPost(action('set-role'), { users: ids }, { cookie }))
    expect(redirectOf(kernel, noRole).flash).toEqual({
      kind: 'error',
      message: 'Choose the role to change them to.',
    })
  })

  it('reports problems on the form instead of failing', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { user, cookie } = await signIn(kernel)
    const duplicate = await kernel.handleApi(
      formPost(
        action('create-user'),
        { email: user.email, role: 'customer', password: PASSWORD },
        { cookie },
      ),
    )
    expect(redirectOf(kernel, duplicate).flash).toEqual({
      kind: 'error',
      message: 'A user with that email address already exists.',
    })
    const demoteSelf = await kernel.handleApi(
      formPost(action('set-role'), { users: [user.id], role: 'customer' }, { cookie }),
    )
    expect(redirectOf(kernel, demoteSelf).flash).toEqual({
      kind: 'error',
      message: 'The site needs at least one administrator.',
    })
  })

  it('is limited to users who may manage users', async () => {
    const shop = plugin('shop', {
      setup: (cms) =>
        cms.auth.role('editor', { label: 'Editor', capabilities: ['core.access_admin'] }),
    })
    const kernel = await bootKernel({ plugins: [shop] })
    const { cookie } = await signIn(kernel, 'editor')
    const response = await kernel.handleApi(
      formPost(
        action('create-user'),
        { email: 'x@b.co', role: 'administrator', password: PASSWORD },
        { cookie },
      ),
    )
    expect(response.status).toBe(403)
  })
})
