import type { Registry, RegistryItem } from '@cms/sdk'

interface Stored {
  ownerId: string
  items: Map<string, { item: RegistryItem; pluginId: string }>
}

export class RegistryStore {
  readonly #registries = new Map<string, Stored>()
  readonly #assertOpen: (what: string) => void

  constructor(assertOpen: (what: string) => void) {
    this.#assertOpen = assertOpen
  }

  define(ownerId: string, name: string): void {
    this.#assertOpen(`registry "${name}"`)
    const existing = this.#registries.get(name)
    if (existing) {
      throw new Error(`Registry "${name}" is already defined by plugin "${existing.ownerId}"`)
    }
    this.#registries.set(name, { ownerId, items: new Map() })
  }

  /** A view of the registry that attributes additions to `pluginId`. */
  view<T extends RegistryItem>(pluginId: string, name: string): Registry<T> {
    const stored = this.#registries.get(name)
    if (!stored) {
      throw new Error(
        `Registry "${name}" is not defined. Add the plugin that owns it to "requires" (or use when()).`,
      )
    }
    return {
      add: (item) => {
        this.#assertOpen(`registry item in "${name}"`)
        if (!item || typeof item.id !== 'string' || item.id === '') {
          throw new TypeError(`Items in registry "${name}" need a non-empty string id`)
        }
        const existing = stored.items.get(item.id)
        if (existing) {
          throw new Error(
            `Registry "${name}" already has "${item.id}" (added by plugin "${existing.pluginId}")`,
          )
        }
        stored.items.set(item.id, { item, pluginId })
      },
      get: (id) => stored.items.get(id)?.item as T | undefined,
      has: (id) => stored.items.has(id),
      list: () => [...stored.items.values()].map((entry) => entry.item as T),
    }
  }
}
