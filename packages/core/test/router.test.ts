import { describe, expect, it } from 'vitest'
import { parsePattern, Router } from '../src/router'

describe('Router', () => {
  it('matches static paths and extracts parameters', () => {
    const router = new Router<string>()
    router.add('shop', '/shop', 'shop')
    router.add('product', '/product/:slug', 'product')
    expect(router.match('/shop')?.route.value).toBe('shop')
    expect(router.match('/product/blue-mug')).toMatchObject({
      route: { value: 'product' },
      params: { slug: 'blue-mug' },
    })
    expect(router.match('/product')).toBeNull()
    expect(router.match('/product/a/b')).toBeNull()
  })

  it('matches the root path', () => {
    const router = new Router<string>()
    router.add('home', '/', 'home')
    expect(router.match('/')?.route.value).toBe('home')
  })

  it('prefers static segments over parameters regardless of registration order', () => {
    const router = new Router<string>()
    router.add('member', '/members/:user', 'member')
    router.add('me', '/members/me', 'me')
    expect(router.match('/members/me')?.route.value).toBe('me')
    expect(router.match('/members/ana')?.route.value).toBe('member')
  })

  it('orders matches by specificity, then by when each was added, whenever routes are added', () => {
    const router = new Router<string>()
    const paths = ['/:a/:b', '/shop/:b', '/:a/new', '/shop/new', '/:x/:y/:z', '/shop']
    router.add('first', paths[0]!, 'first')
    // A match between adds must not change where later routes land.
    expect(router.matchAll('/shop/new').map((match) => match.route.key)).toEqual(['first'])
    paths.slice(1).forEach((path, index) => router.add(`r${index}`, path, path, String(index)))
    expect(router.matchAll('/shop/new').map((match) => match.route.pattern)).toEqual([
      '/shop/new',
      '/shop/:b',
      '/:a/new',
      '/:a/:b',
    ])
    // Two of the same shape, in scopes of their own: the one added first comes first.
    router.add('get', '/items/:id', 'get', 'GET')
    router.add('post', '/items/:id', 'post', 'POST')
    expect(router.matchAll('/items/7').map((match) => match.route.key)).toEqual([
      'get',
      'post',
      'first',
    ])
  })

  it('ignores trailing slashes', () => {
    const router = new Router<string>()
    router.add('shop', '/shop/', 'shop')
    expect(router.match('/shop/')?.route.value).toBe('shop')
    expect(router.match('/shop')?.route.value).toBe('shop')
  })

  it('decodes parameters and rejects malformed encoding', () => {
    const router = new Router<string>()
    router.add('tag', '/tag/:name', 'tag')
    expect(router.match('/tag/caf%C3%A9')?.params).toEqual({ name: 'café' })
    expect(router.match('/tag/%E0%A4%A')).toBeNull()
  })

  it('rejects routes that would match the same URLs', () => {
    const router = new Router<string>()
    router.add('commerce.product', '/product/:slug', 'a')
    expect(() => router.add('shop.item', '/product/:id', 'b')).toThrow(
      'Route "shop.item" (/product/:id) conflicts with "commerce.product"',
    )
    expect(() => router.add('commerce.product', '/elsewhere', 'c')).toThrow('already registered')
  })

  it('allows the same shape in different scopes', () => {
    const router = new Router<string>()
    router.add('get', '/orders/:id', 'get', 'GET')
    router.add('delete', '/orders/:id', 'delete', 'DELETE')
    expect(
      router
        .matchAll('/orders/1')
        .map((m) => m.route.value)
        .sort(),
    ).toEqual(['delete', 'get'])
  })

  it('builds URLs with encoded parameters', () => {
    const router = new Router<string>()
    router.add('product', '/product/:slug', 'p')
    expect(router.url('product', { slug: 'a b/c' })).toBe('/product/a%20b%2Fc')
    expect(() => router.url('product')).toThrow('needs parameter "slug"')
    expect(() => router.url('missing')).toThrow('Unknown route')
  })
})

describe('parsePattern', () => {
  it.each([
    ['product/:slug', 'must start with "/"'],
    ['/a//b', 'empty segment'],
    ['/a/:1bad', 'Invalid parameter'],
    ['/a/:id/:id', 'Duplicate parameter'],
  ])('rejects %s', (pattern, message) => {
    expect(() => parsePattern(pattern)).toThrow(message)
  })
})
