import type { Logger } from '@otwdesign/sdk'
import { HookError } from './errors'
import { traced } from './tracing'

type Handler = (...args: never[]) => unknown

interface Entry {
  handler: Handler
  pluginId: string
  priority: number
  sequence: number
  /** For an action handler that only sometimes has work: skipped, savepoint and all, while false. */
  when?: () => boolean
}

export interface HookBusOptions {
  logger: Logger
  /** Wraps each action handler so its failure can't poison a surrounding transaction. */
  isolate: <T>(fn: () => Promise<T>) => Promise<T>
  assertOpen: (what: string) => void
}

export const DEFAULT_PRIORITY = 10

export class HookBus {
  readonly #filters = new Map<string, Entry[]>()
  readonly #actions = new Map<string, Entry[]>()
  readonly #options: HookBusOptions
  #sequence = 0

  constructor(options: HookBusOptions) {
    this.#options = options
  }

  addFilter(pluginId: string, name: string, handler: Handler, priority?: number): void {
    this.#options.assertOpen(`filter "${name}"`)
    this.#add(this.#filters, pluginId, name, handler, priority)
  }

  /**
   * `when` is for a handler that only sometimes has work: while it answers false the handler
   * isn't run, and doesn't cost the savepoint every run takes inside a transaction.
   */
  addAction(
    pluginId: string,
    name: string,
    handler: Handler,
    priority?: number,
    when?: () => boolean,
  ): void {
    this.#options.assertOpen(`action "${name}"`)
    this.#add(this.#actions, pluginId, name, handler, priority, when)
  }

  /** A failing filter aborts the operation: continuing would use a half-filtered value. */
  async applyFilters<V, C>(name: string, value: V, context: C): Promise<V> {
    let current = value
    for (const entry of this.#filters.get(name) ?? []) {
      try {
        const value = current
        current = (await traced(
          `filter ${name}`,
          {
            'otw.kind': 'hook',
            'otw.hook': name,
            'otw.hook.type': 'filter',
            'otw.plugin': entry.pluginId,
          },
          () => (entry.handler as (v: V, c: C) => V | Promise<V>)(value, context),
        )) as V
      } catch (error) {
        throw new HookError(name, entry.pluginId, error)
      }
    }
    return current
  }

  async doAction<P>(name: string, payload: P): Promise<void> {
    for (const entry of this.#actions.get(name) ?? []) {
      if (entry.when && !entry.when()) continue
      try {
        await traced(
          `action ${name}`,
          {
            'otw.kind': 'hook',
            'otw.hook': name,
            'otw.hook.type': 'action',
            'otw.plugin': entry.pluginId,
          },
          () =>
            this.#options.isolate(async () => {
              await (entry.handler as (p: P) => unknown)(payload)
            }),
        )
      } catch (error) {
        this.#options.logger.error(`Action "${name}" failed in plugin "${entry.pluginId}"`, {
          hook: name,
          plugin: entry.pluginId,
          error,
        })
      }
    }
  }

  #add(
    store: Map<string, Entry[]>,
    pluginId: string,
    name: string,
    handler: Handler,
    priority = DEFAULT_PRIORITY,
    when?: () => boolean,
  ): void {
    if (typeof handler !== 'function') {
      throw new TypeError(`Handler for "${name}" must be a function`)
    }
    if (!Number.isFinite(priority)) {
      throw new TypeError(`Priority for "${name}" must be a finite number`)
    }
    const entries = store.get(name) ?? []
    entries.push({ handler, pluginId, priority, sequence: this.#sequence++, when })
    entries.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)
    store.set(name, entries)
  }
}
