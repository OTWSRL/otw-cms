import { createHmac } from 'node:crypto'
import { defineAdmin, type PluginContext } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Kernel, KernelOptions } from '../src/kernel'
import { DELIVERY_ATTEMPTS, MAX_FAILURES, signDelivery } from '../src/webhooks'
import { bootKernel, formPost, memoryLogger, plugin, redirectOf, signIn } from './helpers'

declare module '@otwdesign/sdk' {
  interface Events {
    'shop.order.paid': { order: string; total: number }
    'shop.order.refunded': { order: string }
    'other.thing': Record<string, never>
  }
}

interface Sent {
  url: string
  headers: Record<string, string>
  body: string
  redirect: RequestRedirect | undefined
}

/** A shop with two events, and an endpoint that answers as told. */
function shop() {
  const sent: Sent[] = []
  const state = { answer: 200 as number | Error, cms: undefined as PluginContext | undefined }
  const definition = plugin('shop', {
    setup(cms) {
      state.cms = cms
      cms.events.define('shop.order.paid', { label: 'Order paid' })
      cms.events.define('shop.order.refunded', { label: 'Order refunded', description: 'In full.' })
    },
  })
  const fetch: KernelOptions['fetch'] = async (url, init) => {
    sent.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: String(init?.body),
      redirect: init?.redirect,
    })
    if (state.answer instanceof Error) throw state.answer
    // A 204 has no body, and a Response refuses one.
    return new Response(state.answer === 204 ? null : 'ok', { status: state.answer })
  }
  const boot = (extra: Partial<KernelOptions> = {}) =>
    bootKernel({ plugins: [definition], fetch, ...extra })
  return { boot, sent, state, cms: () => state.cms! }
}

const endpoint = (extra: object = {}) => ({
  name: 'Warehouse',
  url: 'https://warehouse.example.com/hooks',
  topics: ['shop.order.paid'],
  status: 'active' as const,
  ...extra,
})

/** Moves waiting jobs' times into the past, as if that long had gone by. */
const pass = (kernel: Kernel, seconds: number) =>
  kernel.db.execute(sql`
    UPDATE cms_jobs SET run_at = run_at - make_interval(secs => ${seconds}::int)
     WHERE status = 'pending' AND name = 'core.deliver_webhook'
  `)

const deliveries = async (kernel: Kernel) =>
  (await kernel.jobs.list({ search: 'core.deliver_webhook', perPage: 100 })).jobs

describe('defining events', () => {
  const handlerless = (setup: (cms: PluginContext) => void) =>
    bootKernel({ plugins: [plugin('shop', { setup })] })

  it('takes an event named after its plugin, with a label, once, in setup()', async () => {
    await expect(
      handlerless((cms) => cms.events.define('other.thing', { label: 'Thing' })),
    ).rejects.toThrow('must start with "shop."')
    await expect(
      handlerless((cms) => cms.events.define('shop.order.paid', { label: ' ' })),
    ).rejects.toThrow('needs a label')
    await expect(
      handlerless((cms) => {
        cms.events.define('shop.order.paid', { label: 'Order paid' })
        cms.events.define('shop.order.paid', { label: 'Order paid' })
      }),
    ).rejects.toThrow('is already defined by "shop"')
    const definition = plugin('shop')
    await expect(
      bootKernel({
        plugins: [definition],
        admin: [
          defineAdmin(definition, (cms) => cms.events.define('shop.order.paid', { label: 'Paid' })),
        ],
      }),
    ).rejects.toThrow('Define the event "shop.order.paid" in setup()')
  })

  it('lists every event a webhook can subscribe to, core’s first', async () => {
    const { boot } = shop()
    const kernel = await boot()
    expect(kernel.webhooks.events().map((event) => [event.name, event.label])).toEqual([
      ['content.saved', 'Entry saved'],
      ['content.deleted', 'Entry deleted'],
      ['media.uploaded', 'File uploaded'],
      ['media.deleted', 'File deleted'],
      ['shop.order.paid', 'Order paid'],
      ['shop.order.refunded', 'Order refunded'],
    ])
  })
})

describe('webhooks', () => {
  it('are saved with a name, an http address and events that exist, and get a secret', async () => {
    const { boot } = shop()
    const kernel = await boot()
    const refused = (extra: object, message: string) =>
      expect(kernel.webhooks.create(endpoint(extra))).rejects.toThrow(message)
    await refused({ name: ' ' }, 'Give the webhook a name')
    await refused({ url: 'ftp://example.com/hooks' }, 'Use a delivery address')
    await refused({ url: 'not an address' }, 'Use a delivery address')
    await refused({ url: 'https://ada:pw@example.com/hooks' }, 'user name and password')
    await refused({ topics: [] }, 'Choose at least one event')
    await refused({ topics: ['shop.order.lost'] }, 'There is no event "shop.order.lost"')

    const hook = await kernel.webhooks.create(endpoint())
    expect(hook).toMatchObject({ name: 'Warehouse', status: 'active', failures: 0 })
    expect(hook.secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/)
    expect(await kernel.webhooks.list()).toHaveLength(1)

    const changed = await kernel.webhooks.update(hook.id, endpoint({ newSecret: true }))
    expect(changed.secret).not.toBe(hook.secret)
    expect(await kernel.webhooks.delete(hook.id)).toBe(true)
    expect(await kernel.webhooks.delete(hook.id)).toBe(false)
    expect(await kernel.webhooks.get('not-an-id')).toBeNull()
  })

  it('tell every running kernel when they change', async () => {
    const { boot } = shop()
    const kernel = await boot()
    expect(await kernel.isCurrent()).toBe(true)
    await kernel.webhooks.create(endpoint())
    expect(await kernel.isCurrent()).toBe(false)
  })
})

describe('emitting', () => {
  it('queues nothing when no webhook is subscribed', async () => {
    const { boot, cms, sent } = shop()
    const kernel = await boot()
    await kernel.webhooks.create(endpoint({ topics: ['shop.order.refunded'] }))
    await kernel.webhooks.create(endpoint({ status: 'paused' }))

    expect(await cms().events.hasSubscribers('shop.order.paid')).toBe(false)
    await cms().events.emit('shop.order.paid', { order: 'A-1', total: 40 })
    expect(await deliveries(kernel)).toEqual([])
    await kernel.jobs.runDue()
    expect(sent).toEqual([])
    await expect(cms().events.emit('other.thing', {})).rejects.toThrow(
      'No active plugin defines the event "other.thing"',
    )
  })

  it('sends the event to each subscribed webhook, signed as Standard Webhooks has it', async () => {
    const { boot, cms, sent } = shop()
    const kernel = await boot()
    const warehouse = await kernel.webhooks.create(endpoint())
    const books = await kernel.webhooks.create(
      endpoint({ name: 'Books', url: 'https://books.example.com/in', topics: ['shop.order.paid'] }),
    )

    await cms().events.emit('shop.order.paid', { order: 'A-1', total: 40 })
    expect(sent).toEqual([])
    expect((await kernel.jobs.runDue()).ran).toBe(2)

    expect(sent.map((request) => request.url).sort()).toEqual([
      'https://books.example.com/in',
      'https://warehouse.example.com/hooks',
    ])
    const request = sent.find((one) => one.url === warehouse.url)!
    const body = JSON.parse(request.body)
    expect(body).toEqual({
      type: 'shop.order.paid',
      timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      data: { order: 'A-1', total: 40 },
    })
    expect(request.redirect).toBe('manual')
    expect(request.headers).toMatchObject({
      'content-type': 'application/json',
      'user-agent': expect.stringMatching(/^cms-webhooks\/\d/),
      'webhook-id': expect.stringMatching(/^msg_[0-9a-f]{32}$/),
      'webhook-timestamp': expect.stringMatching(/^\d{10}$/),
    })
    // As a receiver checks it: HMAC-SHA256 of "id.timestamp.body" with the secret's bytes.
    const key = Buffer.from(warehouse.secret.slice('whsec_'.length), 'base64')
    const signed = `${request.headers['webhook-id']}.${request.headers['webhook-timestamp']}.${request.body}`
    expect(request.headers['webhook-signature']).toBe(
      `v1,${createHmac('sha256', key).update(signed).digest('base64')}`,
    )
    // Both endpoints get the same event, each signed with its own secret.
    const other = sent.find((one) => one.url === books.url)!
    expect(other.headers['webhook-id']).not.toBe(request.headers['webhook-id'])
    expect(other.headers['webhook-signature']).toBe(
      signDelivery(
        books.secret,
        other.headers['webhook-id']!,
        Number(other.headers['webhook-timestamp']),
        other.body,
      ),
    )

    const [saved] = await kernel.webhooks.list()
    expect(saved).toMatchObject({ lastResult: '200', failures: 0 })
    expect(saved!.lastDeliveryAt).toBeInstanceOf(Date)
  })

  it('sends only what was kept: an event emitted in a transaction that rolls back is never sent', async () => {
    const { boot, cms, sent } = shop()
    const kernel = await boot()
    await kernel.webhooks.create(endpoint())
    await expect(
      kernel.transaction(async () => {
        await cms().events.emit('shop.order.paid', { order: 'lost', total: 1 })
        throw new Error('The order could not be saved')
      }),
    ).rejects.toThrow('could not be saved')
    await kernel.transaction(() =>
      cms().events.emit('shop.order.paid', { order: 'kept', total: 2 }),
    )

    await kernel.jobs.runDue()
    expect(sent.map((request) => JSON.parse(request.body).data.order)).toEqual(['kept'])
  })

  it('refuses data that isn’t plain, or is too much to queue', async () => {
    const { boot, cms } = shop()
    const kernel = await boot()
    await kernel.webhooks.create(endpoint())
    const emit = (data: unknown) => cms().events.emit('shop.order.paid', data as never)
    await expect(emit({ order: 10n })).rejects.toThrow('plain data')
    await expect(emit({ order: 'x'.repeat(50_000) })).rejects.toThrow('48 KB')
  })
})

describe('a kernel booted later', () => {
  it('knows who is subscribed from its first query, and tells them', async () => {
    const first = shop()
    const kernel = await first.boot()
    await kernel.webhooks.create(endpoint())
    await kernel.webhooks.create(endpoint({ name: 'Paused', status: 'paused' }))

    const second = shop()
    const later = await second.boot({ db: kernel.db })
    expect(second.cms().events.hasSubscribers('shop.order.paid')).toBe(true)
    expect(second.cms().events.hasSubscribers('shop.order.refunded')).toBe(false)
    await second.cms().events.emit('shop.order.paid', { order: 'A-9', total: 5 })
    await later.jobs.runDue()
    expect(second.sent.map((request) => request.url)).toEqual([
      'https://warehouse.example.com/hooks',
    ])

    // Deleted: the next kernel is told nobody listens.
    await later.webhooks.delete((await later.webhooks.list())[0]!.id)
    const third = shop()
    await third.boot({ db: kernel.db })
    expect(third.cms().events.hasSubscribers('shop.order.paid')).toBe(false)
  })
})

describe('delivering', () => {
  it('tries again when the endpoint fails, with the same id, and records each answer', async () => {
    const { boot, cms, sent, state } = shop()
    const kernel = await boot()
    await kernel.webhooks.create(endpoint())
    await cms().events.emit('shop.order.paid', { order: 'A-1', total: 40 })

    state.answer = 503
    await kernel.jobs.runDue()
    expect((await kernel.webhooks.list())[0]).toMatchObject({ lastResult: '503', failures: 0 })
    expect((await deliveries(kernel))[0]).toMatchObject({ status: 'pending', attempts: 1 })

    state.answer = new Error('connect ECONNREFUSED')
    await pass(kernel, 61)
    await kernel.jobs.runDue()
    expect((await kernel.webhooks.list())[0]!.lastResult).toBe('No answer: connect ECONNREFUSED')

    // A redirect is an answer that isn't a success: it's never followed.
    state.answer = 302
    await pass(kernel, 241)
    await kernel.jobs.runDue()
    expect((await kernel.webhooks.list())[0]!.lastResult).toBe('302')

    state.answer = 204
    await pass(kernel, 961)
    await kernel.jobs.runDue()
    expect((await deliveries(kernel))[0]).toMatchObject({ status: 'done', attempts: 4 })
    expect(new Set(sent.map((request) => request.headers['webhook-id'])).size).toBe(1)
    expect((await kernel.webhooks.list())[0]).toMatchObject({ lastResult: '204', failures: 0 })
  })

  it('disables a webhook after five deliveries in a row failed every try', async () => {
    const { boot, cms, sent, state } = shop()
    const logger = memoryLogger()
    const kernel = await boot({ logger })
    const hook = await kernel.webhooks.create(endpoint())
    state.answer = 500

    for (let delivery = 1; delivery <= MAX_FAILURES; delivery++) {
      await cms().events.emit('shop.order.paid', { order: `A-${delivery}`, total: 1 })
      for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt++) {
        await kernel.jobs.runDue()
        await pass(kernel, 4000)
      }
      const saved = await kernel.webhooks.get(hook.id)
      expect(saved!.failures).toBe(delivery)
      expect(saved!.status).toBe(delivery < MAX_FAILURES ? 'active' : 'disabled')
    }
    expect(sent).toHaveLength(MAX_FAILURES * DELIVERY_ATTEMPTS)
    expect(logger.entries.some((entry) => entry.message.includes('webhook was disabled'))).toBe(
      true,
    )

    // Disabled: no more is queued for it. Switched back on by hand, it starts over.
    await cms().events.emit('shop.order.paid', { order: 'unsent', total: 1 })
    expect((await deliveries(kernel)).filter((job) => job.status === 'pending')).toEqual([])
    const again = await kernel.webhooks.update(hook.id, endpoint())
    expect(again).toMatchObject({ status: 'active', failures: 0 })
  })

  it('drops a delivery whose webhook was paused or deleted since', async () => {
    const { boot, cms, sent } = shop()
    const kernel = await boot()
    const paused = await kernel.webhooks.create(endpoint())
    const deleted = await kernel.webhooks.create(endpoint({ name: 'Gone' }))
    await cms().events.emit('shop.order.paid', { order: 'A-1', total: 40 })
    await kernel.webhooks.update(paused.id, endpoint({ status: 'paused' }))
    await kernel.webhooks.delete(deleted.id)

    expect((await kernel.jobs.runDue()).ran).toBe(2)
    expect(sent).toEqual([])
    expect((await deliveries(kernel)).map((job) => job.status)).toEqual(['done', 'done'])
  })

  it('sends a test whatever the webhook’s status', async () => {
    const { boot, sent } = shop()
    const kernel = await boot()
    const hook = await kernel.webhooks.create(endpoint({ status: 'paused' }))
    expect(await kernel.webhooks.test(hook.id)).toBe(true)
    expect(await kernel.webhooks.test('00000000-0000-4000-8000-000000000000')).toBe(false)
    await kernel.jobs.runDue()
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      type: 'webhook.test',
      data: { message: 'A test of the webhook “Warehouse”.' },
    })
  })
})

describe('core’s events', () => {
  it('tell of saved and deleted entries, with the address of a published one', async () => {
    const { boot, sent } = shop()
    const kernel = await boot()
    await kernel.webhooks.create(endpoint({ topics: ['content.saved', 'content.deleted'] }))
    const { user } = await signIn(kernel)

    const post = await kernel.content.create('core.post', {
      title: 'Opening hours',
      authorId: user.id,
    })
    await kernel.content.update(post.id, { status: 'published' })
    await kernel.content.delete(post.id)
    await kernel.jobs.runDue()

    const events = sent.map((request) => JSON.parse(request.body))
    expect(events.map((event) => [event.type, event.data.status, event.data.url])).toEqual([
      ['content.saved', 'draft', null],
      ['content.saved', 'published', expect.stringContaining('opening-hours')],
      ['content.deleted', 'published', null],
    ])
    expect(events[1].data).toEqual({
      id: post.id,
      type: 'core.post',
      status: 'published',
      slug: 'opening-hours',
      title: 'Opening hours',
      excerpt: '',
      authorId: user.id,
      parentId: null,
      url: expect.any(String),
      publishedAt: expect.stringMatching(/^\d{4}-/),
      updatedAt: expect.stringMatching(/^\d{4}-/),
    })
  })

  it('queue nothing for a site without webhooks', async () => {
    const { boot } = shop()
    const kernel = await boot()
    const post = await kernel.content.create('core.post', { title: 'Quiet' })
    await kernel.content.delete(post.id)
    expect(await deliveries(kernel)).toEqual([])
  })
})

describe('Settings › Webhooks’ forms', () => {
  const post = (name: string, fields: Record<string, string | string[]>, cookie: string) =>
    formPost(`/api/p/core/actions/${name}`, fields, { cookie })

  it('add, change, test and delete a webhook, for those who may manage them', async () => {
    const { boot, sent } = shop()
    const kernel = await boot()
    const { cookie } = await signIn(kernel)
    const fields = {
      name: 'Warehouse',
      url: 'https://warehouse.example.com/hooks',
      topics: ['shop.order.paid', 'content.saved'],
      status: 'active',
    }

    const added = redirectOf(kernel, await kernel.handleApi(post('save-webhook', fields, cookie)))
    expect(added.flash).toEqual({ kind: 'notice', message: 'Webhook added.' })
    const [hook] = await kernel.webhooks.list()
    expect(added.path).toBe(`/admin/settings/webhooks?edit=${hook!.id}`)
    expect(hook).toMatchObject({ topics: ['shop.order.paid', 'content.saved'], status: 'active' })

    const bad = await kernel.handleApi(
      post('save-webhook', { ...fields, id: hook!.id, url: 'nope' }, cookie),
    )
    expect(redirectOf(kernel, bad).flash).toEqual({
      kind: 'error',
      message: 'Use a delivery address such as https://example.com/webhooks.',
    })

    const saved = await kernel.handleApi(
      post('save-webhook', { ...fields, id: hook!.id, status: 'paused', new_secret: '1' }, cookie),
    )
    expect(redirectOf(kernel, saved).flash?.message).toBe('Webhook updated.')
    const changed = await kernel.webhooks.get(hook!.id)
    expect(changed).toMatchObject({ status: 'paused' })
    expect(changed!.secret).not.toBe(hook!.secret)

    const tested = await kernel.handleApi(post('test-webhook', { id: hook!.id }, cookie))
    expect(redirectOf(kernel, tested).flash?.message).toMatch(/^A test delivery is on its way/)
    await kernel.jobs.runDue()
    expect(sent).toHaveLength(1)

    const deleted = redirectOf(
      kernel,
      await kernel.handleApi(post('delete-webhook', { id: hook!.id }, cookie)),
    )
    expect(deleted).toMatchObject({
      path: '/admin/settings/webhooks',
      flash: { kind: 'notice', message: 'Webhook deleted.' },
    })
    expect(await kernel.webhooks.list()).toEqual([])
  })

  it('are refused to an editor', async () => {
    const { boot } = shop()
    const kernel = await boot()
    const { cookie } = await signIn(kernel, 'editor')
    const response = await kernel.handleApi(
      post(
        'save-webhook',
        { name: 'Mine', url: 'https://example.com', topics: 'content.saved' },
        cookie,
      ),
    )
    expect(response.status).toBe(403)
    expect(await kernel.webhooks.list()).toEqual([])
  })
})
