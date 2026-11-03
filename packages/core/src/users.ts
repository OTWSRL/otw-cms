import type {
  User,
  UserMetaChanges,
  UserMetaDefinition,
  UserMetaField,
  UserMetaValues,
  UsersApi,
} from '@otwdesign/sdk'
import { ContentError } from '@otwdesign/sdk'
import { eq, inArray } from 'drizzle-orm'
import type { AccountService } from './accounts'
import type { MetaDefinition } from '@otwdesign/sdk'
import { MetaStore } from './content-meta'
import { users } from './core-schema'
import type { DatabaseContext } from './database'

/** What the kernel serves: everything but registering fields. */
export type UsersService = Omit<UsersApi, 'meta'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The custom field store's "type" every user field is registered for. */
const USERS = 'users'

const userColumns = { id: users.id, email: users.email, name: users.name, role: users.role }

/**
 * Users' fields, like WordPress's user meta: 7c's custom fields, checked the same way, in a
 * registry of their own, with the roles whose users have each.
 */
export class UserMetaStore {
  readonly #store: MetaStore
  readonly #fields = new Map<string, UserMetaField>()

  constructor(assertOpen: (what: string) => void) {
    this.#store = new MetaStore(assertOpen)
  }

  register(pluginId: string, key: string, definition: UserMetaDefinition): void {
    if (typeof definition !== 'object' || definition === null) {
      throw new Error(`User field "${key}" needs a definition`)
    }
    const { roles, onAccount } = definition
    if (
      roles !== undefined &&
      (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string'))
    ) {
      throw new Error(`User field "${key}": roles is a list of role ids`)
    }
    if (onAccount !== undefined && typeof onAccount !== 'boolean') {
      throw new Error(`User field "${key}": onAccount is true or false`)
    }
    this.#store.register(pluginId, key, { ...definition, types: '*' } as MetaDefinition)
    this.#fields.set(key, { key, pluginId, definition })
  }

  /** Every field, or those a role's users have. */
  list(role?: string): UserMetaField[] {
    return [...this.#fields.values()].filter(
      ({ definition }) =>
        role === undefined || !definition.roles || definition.roles.includes(role),
    )
  }

  withDefaults(role: string, stored: UserMetaValues): UserMetaValues {
    const defaults: Record<string, unknown> = {}
    for (const field of this.list(role)) {
      if (field.definition.default !== undefined) defaults[field.key] = field.definition.default
    }
    return { ...defaults, ...stored } as UserMetaValues
  }

  /** `stored` with `changes`, each a field the role's users have, checked; `null` removes one. */
  merge(role: string, stored: UserMetaValues, changes: unknown): UserMetaValues {
    if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
      throw new ContentError('invalid_input', 'Pass user fields as an object')
    }
    for (const key of Object.keys(changes)) {
      if (!this.list(role).some((field) => field.key === key)) {
        throw new ContentError('invalid_input', `Unknown user field "${key}" for the ${role} role`)
      }
    }
    const merged = this.#store.merge(USERS, stored as never, changes)
    return this.#store.check(USERS, merged, stored as never) as UserMetaValues
  }
}

export interface UsersServiceOptions {
  db: DatabaseContext
  fields: UserMetaStore
  accounts: AccountService
}

export function createUsersService({ db, fields, accounts }: UsersServiceOptions): UsersService {
  const row = async (id: string) => {
    if (typeof id !== 'string' || !UUID.test(id)) return null
    const [found] = await db.current
      .select({ ...userColumns, meta: users.meta })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
    return found ?? null
  }

  return {
    fields: (role) => fields.list(role),

    async get(id): Promise<User | null> {
      if (typeof id !== 'string' || !UUID.test(id)) return null
      const [found] = await db.current
        .select(userColumns)
        .from(users)
        .where(eq(users.id, id))
        .limit(1)
      return found ?? null
    },

    async getMeta(userId) {
      const found = await row(userId)
      return found ? fields.withDefaults(found.role, found.meta) : {}
    },

    async getMetaMany(userIds) {
      const ids = [...new Set(userIds)].filter((id) => typeof id === 'string' && UUID.test(id))
      if (ids.length === 0) return new Map()
      const rows = await db.current
        .select({ id: users.id, role: users.role, meta: users.meta })
        .from(users)
        .where(inArray(users.id, ids))
      return new Map(rows.map((found) => [found.id, fields.withDefaults(found.role, found.meta)]))
    },

    updateMeta: (userId, changes: UserMetaChanges) =>
      db.transaction(async () => {
        if (typeof userId !== 'string' || !UUID.test(userId)) {
          throw new ContentError('not_found', 'That user no longer exists')
        }
        const [found] = await db.current
          .select({ role: users.role, meta: users.meta })
          .from(users)
          .where(eq(users.id, userId))
          .for('update')
          .limit(1)
        if (!found) throw new ContentError('not_found', 'That user no longer exists')
        const meta = fields.merge(found.role, found.meta, changes)
        await db.current.update(users).set({ meta }).where(eq(users.id, userId))
        return fields.withDefaults(found.role, meta)
      }),

    isVerified: (userId) => accounts.isVerified(userId),
  }
}
