import { describe, expect, it } from 'vitest'
import { bootKernel } from './helpers'

describe('a type’s outline', () => {
  it('lists entries as a tree, leaving out the trash and an entry’s own branch', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const page = (title: string, parentId: string | null = null, position = 0) =>
      kernel.content.create('core.page', { title, parentId, position })
    const about = await page('About', null, 1)
    const team = await page('Team', about.id)
    const ada = await page('Ada', team.id)
    const contact = await page('Contact', null, 2)
    const home = await page('Home', null, 0)
    const gone = await page('Gone', contact.id)
    await kernel.content.trash(gone.id)

    const outline = (exclude?: string) =>
      kernel.content
        .outline('core.page', { exclude })
        .then((rows) => rows.map((row) => `${'-'.repeat(row.depth)}${row.title}`))
    expect(await outline()).toEqual(['Home', 'About', '-Team', '--Ada', 'Contact'])
    // A page can't go under itself or its descendants.
    expect(await outline(team.id)).toEqual(['Home', 'About', 'Contact'])
    expect(await outline(ada.id)).toEqual(['Home', 'About', '-Team', 'Contact'])
    expect(await outline('not an id')).toHaveLength(5)
    expect(await kernel.content.outline('core.page', { limit: 2 })).toMatchObject([
      { id: home.id, depth: 0 },
      { id: about.id, depth: 0 },
    ])
    await expect(kernel.content.outline('core.page', { limit: 10_000 })).rejects.toThrow(
      '1 to 5000',
    )
  })
})
