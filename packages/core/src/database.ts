import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database } from '@otw/sdk'

/**
 * Tracks the active transaction per async call chain, so a filter running inside checkout
 * writes through the checkout transaction without anyone passing `tx` around.
 */
export class DatabaseContext {
  readonly root: Database
  readonly #transaction = new AsyncLocalStorage<Database>()

  constructor(root: Database) {
    this.root = root
  }

  get current(): Database {
    return this.#transaction.getStore() ?? this.root
  }

  get inTransaction(): boolean {
    return this.#transaction.getStore() !== undefined
  }

  /** Nested calls become savepoints. */
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return this.current.transaction((tx) => this.#transaction.run(tx, () => fn(tx)))
  }

  /** Inside a transaction, runs `fn` in a savepoint so its failure leaves the outer one usable. */
  isolate<T>(fn: () => Promise<T>): Promise<T> {
    return this.inTransaction ? this.transaction(() => fn()) : fn()
  }
}
