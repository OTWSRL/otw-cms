import type { SlotComponent } from '@otwdesign/sdk'
import { DEFAULT_PRIORITY } from './hooks'

const SLOT_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/

interface Fill {
  component: SlotComponent
  pluginId: string
  priority: number
  sequence: number
}

export class SlotStore {
  readonly #slots = new Map<string, Fill[]>()
  readonly #assertOpen: (what: string) => void
  #sequence = 0

  constructor(assertOpen: (what: string) => void) {
    this.#assertOpen = assertOpen
  }

  fill(
    pluginId: string,
    name: string,
    component: SlotComponent,
    priority = DEFAULT_PRIORITY,
  ): void {
    this.#assertOpen(`slot fill for "${name}"`)
    if (!SLOT_NAME.test(name)) throw new Error(`Invalid slot name "${name}"`)
    if (typeof component !== 'function') throw new TypeError(`Slot "${name}" needs a component`)
    if (!Number.isFinite(priority)) {
      throw new TypeError(`Priority for slot "${name}" must be finite`)
    }
    const fills = this.#slots.get(name) ?? []
    fills.push({ component, pluginId, priority, sequence: this.#sequence++ })
    fills.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)
    this.#slots.set(name, fills)
  }

  get(name: string): { component: SlotComponent; pluginId: string }[] {
    return (this.#slots.get(name) ?? []).map(({ component, pluginId }) => ({ component, pluginId }))
  }
}
