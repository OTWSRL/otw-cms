import { definePlugin, HttpError } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestKernel, type TestKernel } from '../src'

let harness: TestKernel | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const echo = definePlugin({
  id: 'echo',
  version: '1.0.0',
  migrations: [{ id: 'create', up: (db) => db.execute(sql`CREATE TABLE echo_log (body text)`) }],
  setup(cms) {
    cms.routes.api({
      method: 'POST',
      path: '/echo',
      handler: async (request) => {
        const type = request.headers.get('content-type') ?? ''
        if (type.includes('json')) return Response.json({ json: await request.json() })
        if (type.includes('form'))
          return Response.json({ form: Object.fromEntries(await request.formData()) })
        throw new HttpError(415, 'Unsupported content type')
      },
    })
  },
})

describe('createTestKernel', () => {
  it('boots plugins on a migrated in-memory database', async () => {
    harness = await createTestKernel({ plugins: [echo] })
    expect(harness.kernel.active).toEqual(['echo'])
    await expect(harness.db.execute(sql`SELECT * FROM echo_log`)).resolves.toBeDefined()
  })

  it('sends JSON and form requests through the kernel', async () => {
    harness = await createTestKernel({ plugins: [echo] })
    const json = await harness.request('POST', '/api/p/echo/echo', { json: { a: 1 } })
    expect(await json.json()).toEqual({ json: { a: 1 } })
    const form = await harness.request('POST', '/api/p/echo/echo', { form: { email: 'a@b.co' } })
    expect(await form.json()).toEqual({ form: { email: 'a@b.co' } })
    expect((await harness.request('POST', '/api/p/echo/echo', { body: 'x' })).status).toBe(415)
  })

  it("sends this site's Origin on unsafe requests unless told otherwise", async () => {
    const seen: (string | null)[] = []
    const probe = definePlugin({
      id: 'probe',
      version: '1.0.0',
      setup(cms) {
        cms.routes.api({
          method: 'POST',
          path: '/origin',
          handler: (request) => {
            seen.push(request.headers.get('origin'))
            return new Response(null, { status: 204 })
          },
        })
      },
    })
    harness = await createTestKernel({ plugins: [probe] })
    await harness.request('POST', '/api/p/probe/origin')
    await harness.request('POST', '/api/p/probe/origin', { headers: { origin: '' } })
    expect(seen).toEqual(['http://cms.test', null])
  })

  it('signs users in for admin requests', async () => {
    harness = await createTestKernel({ plugins: [] })
    const { user, cookie } = await harness.signIn('customer')
    expect(user.role).toBe('customer')
    const response = await harness.request('POST', '/api/p/core/actions/logout', {
      cookie,
      form: {},
    })
    expect(response.status).toBe(303)
    expect(await harness.kernel.auth.userForSession(cookie.split('=')[1])).toBeNull()
  })

  it('reboots on the same database to pick up admin changes', async () => {
    harness = await createTestKernel({ plugins: [echo] })
    const { cookie } = await harness.signIn()
    await harness.request('POST', '/api/p/core/actions/deactivate-plugin', {
      cookie,
      form: { plugin: 'echo' },
    })
    expect(harness.kernel.active).toEqual(['echo'])
    expect((await harness.reboot()).active).toEqual([])
    expect(harness.kernel.active).toEqual([])
  })

  it('is strict, so a broken plugin fails the test', async () => {
    const broken = definePlugin({
      id: 'broken',
      version: '1.0.0',
      setup() {
        throw new Error('nope')
      },
    })
    await expect(createTestKernel({ plugins: [broken] })).rejects.toThrow(
      'Plugin "broken" failed during setup',
    )
  })
})
