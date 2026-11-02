import { describe, expect, it } from 'vitest'
import { bootKernel } from './helpers'

describe('the users list', () => {
  it('pages users by email, by role and search, with how many match', async () => {
    const kernel = await bootKernel({ plugins: [] })
    for (let i = 0; i < 25; i++) {
      await kernel.auth.createUser({
        email: `customer${String(i).padStart(2, '0')}@example.com`,
        name: i === 7 ? 'Cleo Patra' : '',
        role: 'customer',
        password: 'a long enough password',
      })
    }
    await kernel.auth.createUser({
      email: 'ed@example.com',
      name: 'Ed Itor',
      role: 'editor',
      password: 'a long enough password',
    })

    const first = await kernel.auth.findUsers({ role: 'customer' })
    expect(first.total).toBe(25)
    expect(first.users).toHaveLength(20)
    expect(first.users[0]?.email).toBe('customer00@example.com')
    const second = await kernel.auth.findUsers({ role: 'customer', offset: 20 })
    expect(second.users.map((user) => user.email)).toEqual([
      'customer20@example.com',
      'customer21@example.com',
      'customer22@example.com',
      'customer23@example.com',
      'customer24@example.com',
    ])
    // Past the last page: no rows, and still the count.
    expect(await kernel.auth.findUsers({ role: 'customer', offset: 40 })).toEqual({
      users: [],
      total: 25,
    })
    expect((await kernel.auth.findUsers({ search: 'cleo PATRA' })).users).toMatchObject([
      { email: 'customer07@example.com' },
    ])
    expect((await kernel.auth.findUsers({ search: 'ed@' })).users).toMatchObject([
      { email: 'ed@example.com' },
    ])
    // % and _ are text to find, not wildcards.
    expect((await kernel.auth.findUsers({ search: '%' })).total).toBe(0)
    await expect(kernel.auth.findUsers({ limit: 500 })).rejects.toThrow('1 to 100')
  })

  it('counts each role’s users in one query', async () => {
    const kernel = await bootKernel({ plugins: [] })
    await kernel.auth.createFirstAdministrator({
      email: 'ada@example.com',
      password: 'a long enough password',
    })
    for (const role of ['customer', 'customer', 'author']) {
      await kernel.auth.createUser({
        email: `${role}-${Math.random()}@example.com`,
        role,
        password: 'a long enough password',
      })
    }
    expect(await kernel.auth.countUsersByRole()).toEqual({
      administrator: 1,
      customer: 2,
      author: 1,
    })
  })
})
