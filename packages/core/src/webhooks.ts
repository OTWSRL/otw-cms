import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { EventDefinition, JobRun, Jobs, Logger } from '@otwdesign/sdk'
import { asc, eq, sql } from 'drizzle-orm'
import { webhooks, type WebhookStatus } from './core-schema'
import type { DatabaseContext } from './database'
import type { JobService } from './jobs'

/** The job that sends one event to one webhook. */
export const DELIVER_JOB = 'core.deliver_webhook'
/** How many times a delivery is tried: at once, then after 1, 4, 16 and 64 minutes. */
export const DELIVERY_ATTEMPTS = 5
/** Failed deliveries in a row that disable a webhook, as WooCommerce does after its fifth. */
export const MAX_FAILURES = 5
/** What Settings › Webhooks sends with "Send a test". */
export const TEST_EVENT = 'webhook.test'
/** How long an endpoint has to answer. */
const TIMEOUT_MS = 10_000
/** An event's data, as JSON: under the 64 KB a job's arguments may be, with room for the rest. */
const MAX_DATA_BYTES = 48 * 1024
const MAX_NAME = 100
const MAX_URL = 2000
const EVENT_NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_.-]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CORE = 'core'
/** Core's own events are named after its actions, which have no `core.` in front. */
const CORE_PREFIXES = ['content.', 'media.']

interface DefinedEvent extends EventDefinition {
  pluginId: string
  name: string
}

/** A row of `cms_webhooks`. */
export type StoredWebhook = typeof webhooks.$inferSelect

/** What Settings › Webhooks saves. */
export interface WebhookInput {
  name: string
  url: string
  topics: readonly string[]
  status: WebhookStatus
  /** Replaces the secret with a new one. */
  newSecret?: boolean
}

/** A webhook couldn't be saved as asked: the message is for the person saving it. */
export class WebhookError extends Error {
  override name = 'WebhookError'
}

/** The events plugins define in `setup()`: the topics a webhook can subscribe to. */
export class EventStore {
  readonly #events = new Map<string, DefinedEvent>()
  readonly #assertOpen: (what: string) => void

  constructor(assertOpen: (what: string) => void) {
    this.#assertOpen = assertOpen
  }

  define(pluginId: string, name: string, definition: EventDefinition): void {
    this.#assertOpen(`event "${name}"`)
    const fail = (problem: string): never => {
      throw new Error(`Event "${name}" from "${pluginId}" ${problem}`)
    }
    if (typeof name !== 'string' || !EVENT_NAME.test(name) || name.length > MAX_NAME) {
      fail('needs a name such as "shop.order.paid"')
    }
    const own =
      pluginId === CORE
        ? CORE_PREFIXES.some((prefix) => name.startsWith(prefix))
        : name.startsWith(`${pluginId}.`)
    if (!own) fail(`must start with "${pluginId}."`)
    const existing = this.#events.get(name)
    if (existing) fail(`is already defined by "${existing.pluginId}"`)
    if (!definition || typeof definition.label !== 'string' || definition.label.trim() === '') {
      fail('needs a label')
    }
    this.#events.set(name, { pluginId, name, ...definition })
  }

  get(name: string): DefinedEvent | undefined {
    return this.#events.get(name)
  }

  all(): DefinedEvent[] {
    return [...this.#events.values()]
  }
}

export interface WebhookService {
  /** Queues a delivery to every active webhook subscribed to the event, in the caller's transaction. */
  emit(name: string, data: unknown): Promise<void>
  hasSubscribers(name: string): Promise<boolean>
  /** The events a webhook can subscribe to, in the order plugins defined them. */
  events(): { name: string; label: string; description?: string; pluginId: string }[]
  list(): Promise<StoredWebhook[]>
  get(id: string): Promise<StoredWebhook | null>
  create(input: WebhookInput): Promise<StoredWebhook>
  update(id: string, input: WebhookInput): Promise<StoredWebhook>
  delete(id: string): Promise<boolean>
  /** Queues a `webhook.test` delivery, whatever the webhook's status. */
  test(id: string): Promise<boolean>
  /** The `core.deliver_webhook` job's handler. */
  deliver(args: Jobs['core.deliver_webhook'], run: JobRun): Promise<void>
}

export interface WebhookServiceOptions {
  db: DatabaseContext
  logger: Logger
  store: EventStore
  jobs: Pick<JobService, 'enqueue'>
  /** Sends deliveries. Tests give their own. */
  fetch?: typeof fetch
  /** The `User-Agent` deliveries carry. */
  userAgent: string
  /** Tells every running kernel that the webhooks changed, so each reads its subscriptions again. */
  changed(): Promise<void>
}

/**
 * The signature the Standard Webhooks specification asks for: an HMAC-SHA256 of
 * `id.timestamp.body`, keyed with the secret's bytes, in base64 after `v1,`.
 */
export function signDelivery(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}

const newSecret = (): string => `whsec_${randomBytes(24).toString('base64')}`

/** An event's data as it's sent: plain, and small enough to queue. */
function plainData(name: string, data: unknown): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(data)
  } catch {
    json = undefined
  }
  if (json === undefined) throw new TypeError(`Event "${name}" needs data that is plain data`)
  if (Buffer.byteLength(json) > MAX_DATA_BYTES) {
    throw new TypeError(`Event "${name}" carries more than 48 KB: send an id, not the whole thing`)
  }
  return JSON.parse(json)
}

/** `cms.events` and Settings › Webhooks: who is told what happened, and the telling. */
export function createWebhookService(options: WebhookServiceOptions): WebhookService {
  const { db, logger, store, jobs } = options
  const send = options.fetch ?? fetch

  let subscribed: Promise<Map<string, string[]>> | undefined
  // Every query here goes through `db.current`: an event is emitted inside the transaction of
  // what happened, and the embedded database has one connection, which that transaction holds.
  /**
   * The active webhooks by event, read once per kernel: a changed webhook boots a new kernel. So
   * an event nobody subscribes to costs a lookup in memory.
   */
  const subscriptions = (): Promise<Map<string, string[]>> => {
    subscribed ??= db.current
      .select({ id: webhooks.id, topics: webhooks.topics })
      .from(webhooks)
      .where(eq(webhooks.status, 'active'))
      .then((rows) => {
        const byTopic = new Map<string, string[]>()
        for (const { id, topics } of rows) {
          for (const topic of topics) byTopic.set(topic, [...(byTopic.get(topic) ?? []), id])
        }
        return byTopic
      })
      .catch((error: unknown) => {
        subscribed = undefined
        throw error
      })
    return subscribed
  }

  const afterChange = async (): Promise<void> => {
    subscribed = undefined
    await options.changed()
  }

  /** The fields as they're stored, or a `WebhookError` saying what to change. */
  const clean = (input: WebhookInput, previous: StoredWebhook | null) => {
    const name = String(input.name ?? '').trim()
    if (name === '' || name.length > MAX_NAME) {
      throw new WebhookError(`Give the webhook a name of up to ${MAX_NAME} characters.`)
    }
    const text = String(input.url ?? '').trim()
    let url: URL | undefined
    try {
      url = new URL(text)
    } catch {
      url = undefined
    }
    if (!url || !['https:', 'http:'].includes(url.protocol) || text.length > MAX_URL) {
      throw new WebhookError('Use a delivery address such as https://example.com/webhooks.')
    }
    if (url.username || url.password) {
      throw new WebhookError('Leave the user name and password out of the delivery address.')
    }
    const topics = [...new Set(input.topics)]
    // A topic whose plugin is inactive stays on a webhook that already had it.
    const unknown = topics.filter((topic) => !store.get(topic) && !previous?.topics.includes(topic))
    if (unknown.length > 0) throw new WebhookError(`There is no event "${unknown[0]}".`)
    if (topics.length === 0) throw new WebhookError('Choose at least one event to send.')
    if (!['active', 'paused', 'disabled'].includes(input.status)) {
      throw new WebhookError('Choose a status.')
    }
    return { name, url: url.toString(), topics, status: input.status }
  }

  const find = async (id: string): Promise<StoredWebhook | null> => {
    if (!UUID.test(id)) return null
    const [row] = await db.current.select().from(webhooks).where(eq(webhooks.id, id)).limit(1)
    return row ?? null
  }

  const queue = (webhook: string, type: string, data: unknown) =>
    jobs.enqueue(DELIVER_JOB, {
      webhook,
      event: `msg_${randomUUID().replaceAll('-', '')}`,
      type,
      timestamp: Math.floor(Date.now() / 1000),
      data,
    })

  /** Records how a delivery went; the fifth in a row to fail every try disables the webhook. */
  const record = async (
    hook: StoredWebhook,
    result: string,
    outcome: 'ok' | 'retry' | 'failed',
  ) => {
    const failures = outcome === 'ok' ? 0 : hook.failures + (outcome === 'failed' ? 1 : 0)
    const disable = outcome === 'failed' && failures >= MAX_FAILURES && hook.status === 'active'
    await db.current
      .update(webhooks)
      .set({
        failures,
        lastDeliveryAt: sql`now()`,
        lastResult: result.slice(0, 500),
        ...(disable ? { status: 'disabled' as const } : {}),
      })
      .where(eq(webhooks.id, hook.id))
    if (disable) {
      logger.error('A webhook was disabled after failed deliveries', {
        webhook: hook.id,
        name: hook.name,
        failures,
      })
      await afterChange()
    }
  }

  return {
    async emit(name, data) {
      if (!store.get(name)) throw new TypeError(`No active plugin defines the event "${name}"`)
      const ids = (await subscriptions()).get(name)
      if (!ids || ids.length === 0) return
      const plain = plainData(name, data)
      for (const id of ids) await queue(id, name, plain)
    },

    hasSubscribers: async (name) => (await subscriptions()).has(name),

    events: () =>
      store.all().map(({ name, label, description, pluginId }) => ({
        name,
        label,
        description,
        pluginId,
      })),

    list: () =>
      db.current.select().from(webhooks).orderBy(asc(webhooks.createdAt), asc(webhooks.id)),

    get: find,

    async create(input) {
      const [row] = await db.current
        .insert(webhooks)
        .values({ ...clean(input, null), secret: newSecret() })
        .returning()
      await afterChange()
      return row!
    },

    async update(id, input) {
      const previous = await find(id)
      if (!previous) throw new WebhookError('That webhook no longer exists.')
      const fields = clean(input, previous)
      const [row] = await db.current
        .update(webhooks)
        .set({
          ...fields,
          updatedAt: sql`now()`,
          ...(input.newSecret ? { secret: newSecret() } : {}),
          // Switched back on by hand: its failures start over.
          ...(fields.status === 'active' && previous.status !== 'active' ? { failures: 0 } : {}),
        })
        .where(eq(webhooks.id, id))
        .returning()
      await afterChange()
      return row!
    },

    async delete(id) {
      if (!UUID.test(id)) return false
      const deleted = await db.current
        .delete(webhooks)
        .where(eq(webhooks.id, id))
        .returning({ id: webhooks.id })
      if (deleted.length === 0) return false
      await afterChange()
      return true
    },

    async test(id) {
      const hook = await find(id)
      if (!hook) return false
      await queue(hook.id, TEST_EVENT, { message: `A test of the webhook “${hook.name}”.` })
      return true
    },

    async deliver(args, run) {
      const hook = await find(args.webhook)
      // Deleted, paused or disabled since the event: there is nobody to tell.
      if (!hook || (hook.status !== 'active' && args.type !== TEST_EVENT)) return
      const body = JSON.stringify({
        type: args.type,
        timestamp: new Date(args.timestamp * 1000).toISOString(),
        data: args.data,
      })
      // The time of this try, which a receiver checks is recent; the event's own is in the body.
      const sentAt = Math.floor(Date.now() / 1000)
      const last = run.attempt >= DELIVERY_ATTEMPTS
      let response: Response
      try {
        response = await send(hook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': options.userAgent,
            'webhook-id': args.event,
            'webhook-timestamp': String(sentAt),
            'webhook-signature': signDelivery(hook.secret, args.event, sentAt, body),
          },
          body,
          // A redirect could lead anywhere, the site's own network included: it isn't followed.
          redirect: 'manual',
          signal: AbortSignal.any([run.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await record(hook, `No answer: ${reason}`, last ? 'failed' : 'retry')
        throw new Error(`${hook.url} gave no answer: ${reason}`, { cause: error })
      }
      // The answer's body isn't needed; an unread one would hold the connection.
      await response.body?.cancel().catch(() => {})
      if (response.status >= 200 && response.status < 300) {
        await record(hook, String(response.status), 'ok')
        return
      }
      await record(hook, String(response.status), last ? 'failed' : 'retry')
      throw new Error(`${hook.url} answered ${response.status}`)
    },
  }
}
