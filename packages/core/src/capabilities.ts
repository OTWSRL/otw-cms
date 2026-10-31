import type { CapabilityDefinition, RoleDefinition, User } from '@cms/sdk'

export const ADMINISTRATOR = 'administrator'

const ROLE_ID = /^[a-z][a-z0-9_]*$/

interface Role {
  id: string
  label: string
  pluginId: string
  capabilities: Set<string>
}

export interface RoleInfo {
  id: string
  label: string
}

/** Roles and capabilities, WordPress style: a user has one role; a role grants capabilities. */
export class CapabilityStore {
  readonly #roles = new Map<string, Role>()
  readonly #capabilities = new Map<string, { label: string; pluginId: string }>()
  readonly #grants: { capability: string; role: string }[] = []
  readonly #assertOpen: (what: string) => void

  constructor(assertOpen: (what: string) => void) {
    this.#assertOpen = assertOpen
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
      capabilities: new Set(definition.capabilities ?? []),
    })
  }

  capability(pluginId: string, name: string, definition: CapabilityDefinition): void {
    this.#assertOpen(`capability "${name}"`)
    if (!name.startsWith(`${pluginId}.`)) {
      throw new Error(`Capability "${name}" must start with "${pluginId}."`)
    }
    const existing = this.#capabilities.get(name)
    if (existing) {
      throw new Error(`Capability "${name}" is already defined by plugin "${existing.pluginId}"`)
    }
    this.#capabilities.set(name, { label: definition.label, pluginId })
    for (const role of definition.roles ?? []) this.#grants.push({ capability: name, role })
  }

  /**
   * Applies grants once every plugin has registered its roles. A grant to a role that no active
   * plugin defines is dropped: it comes back when that plugin is activated.
   */
  seal(): void {
    for (const { capability, role } of this.#grants) {
      this.#roles.get(role)?.capabilities.add(capability)
    }
  }

  can(user: User | null, capability: string): boolean {
    if (!user) return false
    if (user.role === ADMINISTRATOR) return true
    return this.#roles.get(user.role)?.capabilities.has(capability) ?? false
  }

  hasRole(id: string): boolean {
    return this.#roles.has(id)
  }

  isDefined(capability: string): boolean {
    return this.#capabilities.has(capability)
  }

  roles(): RoleInfo[] {
    return [...this.#roles.values()].map(({ id, label }) => ({ id, label }))
  }
}
