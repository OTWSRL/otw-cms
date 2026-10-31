export class ServiceStore {
  readonly #services = new Map<string, { service: unknown; pluginId: string }>()
  readonly #assertOpen: (what: string) => void

  constructor(assertOpen: (what: string) => void) {
    this.#assertOpen = assertOpen
  }

  provide(pluginId: string, name: string, service: unknown): void {
    this.#assertOpen(`service "${name}"`)
    const existing = this.#services.get(name)
    if (existing) {
      throw new Error(`Service "${name}" is already provided by plugin "${existing.pluginId}"`)
    }
    this.#services.set(name, { service, pluginId })
  }

  get(name: string): unknown {
    const entry = this.#services.get(name)
    if (!entry) {
      throw new Error(
        `Service "${name}" is not available. Add the plugin that provides it to "requires" (or use when()).`,
      )
    }
    return entry.service
  }
}
