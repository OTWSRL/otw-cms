/** Raised when one plugin breaks during boot, so the kernel can boot again without it. */
export class PluginBootError extends Error {
  readonly pluginId: string
  readonly phase: 'migrate' | 'setup' | 'admin setup'

  constructor(pluginId: string, phase: 'migrate' | 'setup' | 'admin setup', cause: unknown) {
    super(`Plugin "${pluginId}" failed during ${phase}: ${describe(cause)}`, { cause })
    this.name = 'PluginBootError'
    this.pluginId = pluginId
    this.phase = phase
  }
}

export class HookError extends Error {
  readonly hook: string
  readonly pluginId: string

  constructor(hook: string, pluginId: string, cause: unknown) {
    super(`Filter "${hook}" failed in plugin "${pluginId}": ${describe(cause)}`, { cause })
    this.name = 'HookError'
    this.hook = hook
    this.pluginId = pluginId
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
