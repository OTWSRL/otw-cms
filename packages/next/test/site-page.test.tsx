import { ForbiddenError, PageRedirect } from '@otwdesign/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Next's interrupts throw, as they do in a real render; the test reads which was thrown.
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((location: string) => {
    throw new Error(`redirect ${location}`)
  }),
  forbidden: vi.fn(() => {
    throw new Error('forbidden')
  }),
  notFound: vi.fn(() => {
    throw new Error('not found')
  }),
}))
const runtime = vi.hoisted(() => ({
  getCurrentUser: vi.fn(async () => null),
  resolvePage: vi.fn(),
}))
vi.mock('next/navigation', () => navigation)
vi.mock('../src/runtime/session', () => ({
  getCurrentUser: runtime.getCurrentUser,
  signInCookies: async () => ({ signIn: null, device: null }),
}))
vi.mock('../src/runtime/kernel', () => ({
  getKernel: async () => ({
    resolvePage: runtime.resolvePage,
    resolveAccount: async () => null,
    resolveContent: async () => null,
  }),
}))
vi.mock('../src/site-registry', () => ({ currentSite: () => ({ plugins: [] }) }))

const { SitePage, generateSiteMetadata } = await import('../src/site/page')

const props = (slug: string[], query: Record<string, string> = {}) => ({
  params: Promise.resolve({ slug }),
  searchParams: Promise.resolve(query),
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('a plugin page on the site', () => {
  it('looks up who’s asking through the request’s session, when the page asks', async () => {
    runtime.resolvePage.mockResolvedValue(null)
    await expect(SitePage(props(['members']))).rejects.toThrow('not found')
    expect(runtime.resolvePage).toHaveBeenCalledWith(
      '/members',
      {},
      { user: runtime.getCurrentUser },
    )
  })

  it('sends a signed-out visitor where the page says, as a redirect', async () => {
    runtime.resolvePage.mockRejectedValue(new PageRedirect('/account?next=%2Fmembers'))
    await expect(SitePage(props(['members']))).rejects.toThrow('redirect /account?next=%2Fmembers')
    await expect(generateSiteMetadata(props(['members']))).rejects.toThrow('redirect')
  })

  it('answers a refusal with a 403, and lets other errors through', async () => {
    runtime.resolvePage.mockRejectedValue(new ForbiddenError())
    await expect(SitePage(props(['drafts']))).rejects.toThrow('forbidden')
    runtime.resolvePage.mockRejectedValue(new Error('the database is down'))
    await expect(SitePage(props(['drafts']))).rejects.toThrow('the database is down')
    expect(navigation.forbidden).toHaveBeenCalledTimes(1)
  })
})
