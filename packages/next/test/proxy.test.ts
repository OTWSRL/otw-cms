import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { createProxy } from '../src/proxy'

const request = (path = '/') => new NextRequest(`http://cms.test${path}`)

describe('createProxy', () => {
  it('lets a request on to the site when no plugin answers it', async () => {
    const seen: string[] = []
    const proxy = createProxy([
      (each) => void seen.push(`first ${new URL(each.url).pathname}`),
      async () => (seen.push('second'), null),
    ])
    const response = await proxy(request('/about'))
    // What NextResponse.next() says: carry on.
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(seen).toEqual(['first /about', 'second'])
  })

  it('ends with the first plugin that answers', async () => {
    const seen: string[] = []
    const proxy = createProxy([
      () => new Response('from the cache', { headers: { 'x-cache': 'HIT' } }),
      () => void seen.push('never asked'),
    ])
    const response = await proxy(request())
    expect(await response.text()).toBe('from the cache')
    expect(response.headers.get('x-cache')).toBe('HIT')
    expect(seen).toEqual([])
  })

  it('is a pass-through with no plugins', async () => {
    expect((await createProxy([])(request())).headers.get('x-middleware-next')).toBe('1')
  })
})
