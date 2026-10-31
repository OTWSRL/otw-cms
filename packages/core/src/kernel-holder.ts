import type { Kernel } from './kernel'

export interface KernelHolderOptions {
  boot: () => Promise<Kernel>
  /** How long to trust a kernel before asking the database whether it is stale. */
  recheckMs?: number
  /**
   * A counter bumped by changes made in this process. A new value forces a check right away, so
   * the page an admin is redirected to after a change never shows the old state.
   */
  localChanges?: () => number
  now?: () => number
}

export interface KernelHolder {
  get(): Promise<Kernel>
}

interface Entry {
  kernel: Promise<Kernel>
  checkedAt: number
  changes: number
}

/**
 * Keeps one booted kernel and replaces it after activation or settings change, whether the
 * change came from this process or another instance sharing the database.
 */
export function createKernelHolder(options: KernelHolderOptions): KernelHolder {
  const recheckMs = options.recheckMs ?? 2000
  const localChanges = options.localChanges ?? (() => 0)
  const now = options.now ?? Date.now
  let current: Entry | undefined
  let checking: Promise<Kernel> | undefined

  const start = (): Promise<Kernel> => {
    const entry: Entry = { kernel: options.boot(), checkedAt: now(), changes: localChanges() }
    current = entry
    entry.kernel.catch(() => {
      // A failed boot must not be cached; the next request tries again.
      if (current === entry) current = undefined
    })
    return entry.kernel
  }

  const revalidate = async (entry: Entry): Promise<Kernel> => {
    const changes = localChanges()
    const kernel = await entry.kernel
    if (await kernel.isCurrent()) {
      entry.checkedAt = now()
      entry.changes = changes
      return kernel
    }
    return current && current !== entry ? current.kernel : start()
  }

  return {
    get() {
      const entry = current
      if (!entry) return start()
      if (entry.changes === localChanges() && now() - entry.checkedAt < recheckMs) {
        return entry.kernel
      }
      checking ??= revalidate(entry).finally(() => {
        checking = undefined
      })
      return checking
    },
  }
}
