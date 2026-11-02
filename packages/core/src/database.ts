import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database } from '@otw/sdk'

type AfterCommit = () => Promise<void>

interface Scope {
  db: Database
  /** What runs once the outermost transaction commits; dropped if this level rolls back. */
  after: AfterCommit[]
}

/**
 * Tracks the active transaction per async call chain, so a filter running inside checkout
 * writes through the checkout transaction without anyone passing `tx` around.
 */
export class DatabaseContext {
  readonly root: Database
  readonly #scope = new AsyncLocalStorage<Scope>()

  constructor(root: Database) {
    this.root = root
  }

  get current(): Database {
    return this.#scope.getStore()?.db ?? this.root
  }

  get inTransaction(): boolean {
    return this.#scope.getStore() !== undefined
  }

  /** Nested calls become savepoints. */
  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const parent = this.#scope.getStore()
    const after: AfterCommit[] = []
    const result = await this.current.transaction((tx) =>
      this.#scope.run({ db: tx, after }, () => fn(tx)),
    )
    if (parent) parent.after.push(...after)
    else for (const callback of after) await callback()
    return result
  }

  /** Inside a transaction, runs `fn` in a savepoint so its failure leaves the outer one usable. */
  isolate<T>(fn: () => Promise<T>): Promise<T> {
    return this.inTransaction ? this.transaction(() => fn()) : fn()
  }

  /**
   * Runs `callback` once the outermost transaction commits, or now outside one; never if it rolls
   * back. For what the database can't undo, such as deleting files. It must handle its own errors:
   * the data is already committed.
   */
  async afterCommit(callback: AfterCommit): Promise<void> {
    const scope = this.#scope.getStore()
    if (scope) scope.after.push(callback)
    else await callback()
  }
}
