import { describe, expect, it } from 'vitest'
import { searchPlugins } from '../src/runtime/plugin-search'

const found = (name: string, keywords: string[], extra: object = {}) => ({
  package: { name, version: '1.2.0', description: `About ${name}`, keywords, ...extra },
})

function npm(answer: unknown, status = 200) {
  const asked: string[] = []
  const fetchImpl = (async (url: string) => {
    asked.push(url)
    return Response.json(answer, { status })
  }) as unknown as typeof fetch
  return { asked, fetchImpl }
}

describe('searchPlugins', () => {
  it('asks npm for packages tagged as plugins, narrowed by the words typed', async () => {
    const { asked, fetchImpl } = npm({
      objects: [
        found('@acme/forum', ['otw-cms-plugin', 'forum'], {
          date: '2026-11-01T10:00:00.000Z',
          publisher: { username: 'acme' },
        }),
        // Matched on its text, but it doesn't say it's a plugin: left out.
        found('forum-toolkit', ['forum']),
        { package: { keywords: ['otw-cms-plugin'] } },
      ],
    })
    expect(await searchPlugins('  forum  ', fetchImpl)).toEqual([
      {
        name: '@acme/forum',
        version: '1.2.0',
        description: 'About @acme/forum',
        publisher: 'acme',
        date: '2026-11-01T10:00:00.000Z',
        url: 'https://www.npmjs.com/package/@acme/forum',
      },
    ])
    const url = new URL(asked[0]!)
    expect(url.origin + url.pathname).toBe('https://registry.npmjs.org/-/v1/search')
    expect(url.searchParams.get('text')).toBe('keywords:otw-cms-plugin forum')
    expect(url.searchParams.get('size')).toBe('24')

    await searchPlugins('', fetchImpl)
    expect(new URL(asked[1]!).searchParams.get('text')).toBe('keywords:otw-cms-plugin')
  })

  it('says so when npm doesn’t answer, or answers with an error', async () => {
    await expect(searchPlugins('x', npm({}, 503).fetchImpl)).rejects.toThrow(
      'npm’s search answered 503.',
    )
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
    }) as unknown as typeof fetch
    await expect(searchPlugins('x', offline)).rejects.toThrow(
      'npm couldn’t be reached: getaddrinfo ENOTFOUND registry.npmjs.org',
    )
    expect(await searchPlugins('x', npm({}).fetchImpl)).toEqual([])
  })
})
