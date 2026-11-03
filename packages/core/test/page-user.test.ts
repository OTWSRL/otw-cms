import type { PageProps, User } from '@otwdesign/sdk'
import { ForbiddenError, PageRedirect } from '@otwdesign/sdk'
import { describe, expect, it, vi } from 'vitest'
import { bootKernel, plugin, signIn } from './helpers'

/** A members' area: one page for whoever asks, one for the signed-in, one for editors only. */
const members = plugin('members', {
  setup(cms) {
    cms.routes.page({
      name: 'welcome',
      path: '/welcome',
      load: async ({ user }) => {
        const first = await user()
        const again = await user()
        return { name: first?.name ?? 'visitor', same: first === again }
      },
      component: () => null,
    })
    cms.routes.page({
      name: 'saved',
      path: '/members/:list',
      load: async ({ requireUser, params }) => ({ user: await requireUser(), list: params.list }),
      metadata: async ({ user }) => ({ title: `Saved for ${(await user())?.email}` }),
      component: () => null,
    })
    cms.routes.page({
      name: 'drafts',
      path: '/drafts',
      load: async ({ requireUser }) => {
        const user = await requireUser()
        if (!cms.auth.can(user, 'core.edit_others_posts')) throw new ForbiddenError()
        return user
      },
      component: () => null,
    })
    cms.routes.page({
      name: 'old',
      path: '/old-saved',
      load: () => {
        throw new PageRedirect('/members/saved')
      },
      component: () => null,
    })
    cms.routes.page({ name: 'static', path: '/about-members', component: () => null })
  },
})

describe('a plugin page', () => {
  it('knows who’s asking, looked up once, and only if it asks', async () => {
    const kernel = await bootKernel({ plugins: [members] })
    const { user } = await signIn(kernel, 'customer')
    const lookup = vi.fn(async (): Promise<User | null> => ({ ...user, name: 'Cleo' }))
    const page = await kernel.resolvePage('/welcome', {}, { user: lookup })
    expect(page?.props.data).toEqual({ name: 'Cleo', same: true })
    // The component and metadata share the request's lookup.
    expect(await page?.props.user()).toMatchObject({ name: 'Cleo' })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(page?.props).not.toHaveProperty('requireUser')

    const untouched = vi.fn(async () => null)
    await kernel.resolvePage('/about-members', {}, { user: untouched })
    expect(untouched).not.toHaveBeenCalled()
    // Without a lookup, nobody is signed in.
    expect((await kernel.resolvePage('/welcome'))?.props.data).toEqual({
      name: 'visitor',
      same: true,
    })
  })

  it('sends a signed-out visitor to sign in, and back to the page with its query', async () => {
    const kernel = await bootKernel({ plugins: [members] })
    const signedOut = kernel.resolvePage(
      '/members/saved',
      { sort: 'new', tag: ['a', 'b'] },
      { user: async () => null },
    )
    await expect(signedOut).rejects.toBeInstanceOf(PageRedirect)
    await expect(signedOut).rejects.toMatchObject({
      location: `/account?next=${encodeURIComponent('/members/saved?sort=new&tag=a&tag=b')}`,
    })

    const { user } = await signIn(kernel, 'customer')
    const page = await kernel.resolvePage('/members/saved', {}, { user: async () => user })
    expect(page?.props.data).toEqual({ user, list: 'saved' })
    expect(await page?.metadata()).toEqual({ title: `Saved for ${user.email}` })
  })

  it('refuses someone who may not see it, and can redirect anywhere on the site', async () => {
    const kernel = await bootKernel({ plugins: [members] })
    const { user: author } = await signIn(kernel, 'author')
    const { user: editor } = await signIn(kernel, 'editor')
    await expect(
      kernel.resolvePage('/drafts', {}, { user: async () => author }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(
      (await kernel.resolvePage('/drafts', {}, { user: async () => editor }))?.props.data,
    ).toEqual(editor)
    await expect(kernel.resolvePage('/old-saved')).rejects.toMatchObject({
      location: '/members/saved',
    })
  })

  it('builds a sign-in link that comes back, to paths on the site only', async () => {
    let signInUrl: ((returnTo?: string) => string) | undefined
    const linker = plugin('linker', {
      setup(cms) {
        signInUrl = cms.routes.signInUrl
      },
    })
    await bootKernel({ plugins: [linker] })
    expect(signInUrl!('/members/saved?sort=new')).toBe(
      '/account?next=%2Fmembers%2Fsaved%3Fsort%3Dnew',
    )
    expect(signInUrl!()).toBe('/account')
    expect(signInUrl!('https://evil.example/')).toBe('/account')
    expect(signInUrl!('//evil.example/')).toBe('/account')
  })
})

describe('PageRedirect', () => {
  it('goes only to paths on this site', () => {
    expect(new PageRedirect('/new').location).toBe('/new')
    for (const location of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'relative',
      '/a b',
    ]) {
      expect(() => new PageRedirect(location)).toThrow(TypeError)
    }
  })
})

// The component's props are typed without requireUser: who may see the page is load's to say.
const _props: PageProps<null> = {
  params: {},
  searchParams: {},
  user: async () => null,
  data: null,
}
void _props
