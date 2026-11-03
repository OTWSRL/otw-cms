import type {
  CapabilityDefinition,
  RequiredCapabilities,
  RoleDefinition,
  User,
} from '@otwdesign/sdk'

export const ADMINISTRATOR = 'administrator'

/** WordPress's `read`: every role starts with it, so a role reads published entries and its own. */
export const READ = 'core.read'

const ROLE_ID = /^[a-z][a-z0-9_]*$/

type Mapper = (user: User, ...args: unknown[]) => RequiredCapabilities
type Extension = (
  required: RequiredCapabilities,
  user: User,
  ...args: unknown[]
) => RequiredCapabilities

interface Role {
  id: string
  label: string
  pluginId: string
  capabilities: Set<string>
}

interface MetaCapability {
  label: string
  pluginId: string
  map: Mapper
  extensions: { pluginId: string; extend: Extension }[]
}

interface Change {
  pluginId: string
  role: string
  capabilities: readonly string[]
}

export interface RoleInfo {
  id: string
  label: string
  /** Every declared capability for administrators. */
  capabilities: string[]
}

export interface CapabilityInfo {
  name: string
  label: string
  pluginId: string
}

/** Reports a failing `map` or extension; the check then denies. */
export type CapabilityErrorHandler = (capability: string, pluginId: string, error: unknown) => void

/**
 * Roles and capabilities, WordPress style: a user has one role; a role grants capabilities;
 * meta capabilities map an object to the capabilities it requires. Rebuilt on every boot from
 * what the active plugins register, so nothing outlives the plugin that added it.
 */
export class CapabilityStore {
  readonly #roles = new Map<string, Role>()
  readonly #capabilities = new Map<string, CapabilityInfo>()
  readonly #meta = new Map<string, MetaCapability>()
  readonly #grants: Change[] = []
  readonly #revokes: Change[] = []
  readonly #extensions: { pluginId: string; name: string; extend: Extension }[] = []
  readonly #assertOpen: (what: string) => void
  readonly #onError: CapabilityErrorHandler

  constructor(assertOpen: (what: string) => void, onError: CapabilityErrorHandler) {
    this.#assertOpen = assertOpen
    this.#onError = onError
  }

  role(pluginId: string, id: string, definition: RoleDefinition): void {
    this.#assertOpen(`role "${id}"`)
    if (!ROLE_ID.test(id)) throw new Error(`Invalid role id "${id}"`)
    const existing = this.#roles.get(id)
    if (existing) {
      throw new Error(`Role "${id}" is already defined by plugin "${existing.pluginId}"`)
    }
    this.#roles.set(id, {
      id,
      label: definition.label,
      pluginId,
      capabilities: new Set([READ, ...(definition.capabilities ?? [])]),
    })
  }

  capability(pluginId: string, name: string, definition: CapabilityDefinition): void {
    this.#assertOpen(`capability "${name}"`)
    this.#assertUnclaimed(pluginId, name)
    this.#capabilities.set(name, { name, label: definition.label, pluginId })
    for (const role of definition.roles ?? []) {
      this.#grants.push({ pluginId, role, capabilities: [name] })
    }
  }

  grant(pluginId: string, role: string, capabilities: readonly string[]): void {
    this.#assertOpen(`grant to role "${role}"`)
    this.#assertChangeable(role)
    this.#grants.push({ pluginId, role, capabilities })
  }

  revoke(pluginId: string, role: string, capabilities: readonly string[]): void {
    this.#assertOpen(`revoke from role "${role}"`)
    this.#assertChangeable(role)
    this.#revokes.push({ pluginId, role, capabilities })
  }

  metaCapability(pluginId: string, name: string, definition: { label: string; map: Mapper }): void {
    this.#assertOpen(`meta capability "${name}"`)
    this.#assertUnclaimed(pluginId, name)
    if (typeof definition.map !== 'function') {
      throw new TypeError(`Meta capability "${name}" needs a map function`)
    }
    this.#meta.set(name, { label: definition.label, pluginId, map: definition.map, extensions: [] })
  }

  extendCapability(pluginId: string, name: string, extend: Extension): void {
    this.#assertOpen(`extension of capability "${name}"`)
    if (typeof extend !== 'function') {
      throw new TypeError(`Extension of capability "${name}" must be a function`)
    }
    this.#extensions.push({ pluginId, name, extend })
  }

  /**
   * Applies grants, then revokes, in registration (load) order, once every plugin has set up.
   * Changes to roles and meta capabilities that no active plugin defines are dropped: they come
   * back when that plugin is activated.
   */
  seal(): void {
    for (const { role, capabilities } of this.#grants) {
      const target = this.#roles.get(role)
      for (const capability of capabilities) target?.capabilities.add(capability)
    }
    for (const { role, capabilities } of this.#revokes) {
      const target = this.#roles.get(role)
      for (const capability of capabilities) target?.capabilities.delete(capability)
    }
    for (const { pluginId, name, extend } of this.#extensions) {
      this.#meta.get(name)?.extensions.push({ pluginId, extend })
    }
  }

  can(user: User | null, capability: string, ...args: unknown[]): boolean {
    if (!user) return false
    const meta = this.#meta.get(capability)
    if (!meta) return this.#has(user, capability)
    const required = this.#required(capability, meta, user, args)
    return required !== false && required.length > 0 && required.every((c) => this.#has(user, c))
  }

  hasRole(id: string): boolean {
    return this.#roles.has(id)
  }

  isDefined(capability: string): boolean {
    return this.#capabilities.has(capability) || this.#meta.has(capability)
  }

  roles(): RoleInfo[] {
    const all = [...this.#capabilities.keys()]
    return [...this.#roles.values()].map(({ id, label, capabilities }) => ({
      id,
      label,
      capabilities: id === ADMINISTRATOR ? all : all.filter((name) => capabilities.has(name)),
    }))
  }

  capabilities(): CapabilityInfo[] {
    return [...this.#capabilities.values()]
  }

  #has(user: User, capability: string): boolean {
    if (user.role === ADMINISTRATOR) return true
    return this.#roles.get(user.role)?.capabilities.has(capability) ?? false
  }

  /** A throwing `map` or extension denies rather than failing the page, and is reported. */
  #required(
    capability: string,
    meta: MetaCapability,
    user: User,
    args: unknown[],
  ): RequiredCapabilities {
    let pluginId = meta.pluginId
    try {
      let required = meta.map(user, ...args)
      for (const extension of meta.extensions) {
        pluginId = extension.pluginId
        required = extension.extend(required, user, ...args)
      }
      return required
    } catch (error) {
      this.#onError(capability, pluginId, error)
      return false
    }
  }

  #assertUnclaimed(pluginId: string, name: string): void {
    if (!name.startsWith(`${pluginId}.`)) {
      throw new Error(`Capability "${name}" must start with "${pluginId}."`)
    }
    const owner = this.#capabilities.get(name)?.pluginId ?? this.#meta.get(name)?.pluginId
    if (owner) throw new Error(`Capability "${name}" is already defined by plugin "${owner}"`)
  }

  #assertChangeable(role: string): void {
    if (role === ADMINISTRATOR) {
      throw new Error('Administrators always have every capability; their role cannot be changed')
    }
  }
}
