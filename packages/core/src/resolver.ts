import type { PluginDefinition } from '@cms/sdk'
import semver from 'semver'
import { validateSettingDefinitions } from './settings'

export interface SkippedPlugin {
  id: string
  reason: string
}

export interface Resolution {
  /** Plugins to load, dependencies first. */
  order: PluginDefinition[]
  skipped: SkippedPlugin[]
  warnings: string[]
  /** For each loaded plugin: the dependencies guaranteed to be loaded before it. */
  available: Map<string, Set<string>>
}

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const CORE = 'core'
// Plugin admin pages live at /admin/{pluginId}, next to the core screens.
const RESERVED_IDS = new Set([
  CORE,
  'admin',
  'api',
  'login',
  'logout',
  'setup',
  'plugins',
  'settings',
  'users',
])

interface Edge {
  from: string
  to: string
  optional: boolean
}

export function validatePlugin(plugin: PluginDefinition): string[] {
  const errors: string[] = []
  if (!PLUGIN_ID.test(plugin.id)) errors.push(`id "${plugin.id}" must be lowercase kebab-case`)
  if (RESERVED_IDS.has(plugin.id)) errors.push(`id "${plugin.id}" is reserved`)
  if (!semver.valid(plugin.version)) errors.push(`version "${plugin.version}" is not valid semver`)

  const requires = plugin.requires ?? {}
  const optional = plugin.optional ?? {}
  for (const [dep, range] of [...Object.entries(requires), ...Object.entries(optional)]) {
    if (!semver.validRange(range)) errors.push(`range "${range}" for "${dep}" is not valid`)
    if (dep === plugin.id) errors.push('a plugin cannot depend on itself')
  }
  for (const dep of Object.keys(optional)) {
    if (dep === CORE) errors.push('core cannot be an optional dependency')
    if (dep in requires) errors.push(`"${dep}" is listed in both requires and optional`)
  }

  const migrationIds = new Set<string>()
  for (const migration of plugin.migrations ?? []) {
    if (!migration.id) errors.push('migration ids must be non-empty')
    if (migrationIds.has(migration.id)) errors.push(`duplicate migration id "${migration.id}"`)
    migrationIds.add(migration.id)
  }
  errors.push(...validateSettingDefinitions(`${plugin.id}.`, plugin.settings))
  return errors
}

/**
 * Decides which of the requested plugins can run and in what order. Never throws for a bad
 * plugin: it is skipped with a reason so the rest of the site still boots.
 */
export function resolvePlugins(
  installed: readonly PluginDefinition[],
  activeIds: readonly string[],
  coreVersion: string,
): Resolution {
  const byId = new Map<string, PluginDefinition>()
  for (const plugin of installed) {
    if (byId.has(plugin.id)) throw new Error(`Plugin id "${plugin.id}" is installed twice`)
    byId.set(plugin.id, plugin)
  }

  const skipped = new Map<string, string>()
  const alive = new Set<string>()
  for (const id of new Set(activeIds)) {
    const plugin = byId.get(id)
    if (!plugin) {
      skipped.set(id, 'not installed')
      continue
    }
    const errors = validatePlugin(plugin)
    if (errors.length > 0) skipped.set(id, `invalid definition: ${errors.join('; ')}`)
    else alive.add(id)
  }

  const warnings: string[] = []
  const brokenOptionalEdges = new Set<string>()

  for (;;) {
    pruneUnmetRequirements(alive, byId, coreVersion, skipped)
    const edges = buildEdges(alive, byId, brokenOptionalEdges)
    const { order, blocked } = topologicalSort(alive, edges)

    if (blocked.length === 0) {
      return {
        order: order.map((id) => byId.get(id)!),
        skipped: [...skipped].map(([id, reason]) => ({ id, reason })),
        warnings: [...optionalVersionWarnings(alive, byId), ...warnings],
        available: availableDependencies(order, edges),
      }
    }

    const cycle = findCycle(blocked, edges)
    const optionalEdge = cycle.edges.find((edge) => edge.optional)
    if (optionalEdge) {
      // An optional integration only changes load order, so drop it rather than a plugin.
      brokenOptionalEdges.add(edgeKey(optionalEdge))
      warnings.push(
        `"${optionalEdge.to}" will not integrate with "${optionalEdge.from}": dependency cycle ${cycle.path.join(' -> ')}`,
      )
      continue
    }
    for (const id of cycle.nodes) {
      alive.delete(id)
      skipped.set(id, `dependency cycle: ${cycle.path.join(' -> ')}`)
    }
  }
}

function pruneUnmetRequirements(
  alive: Set<string>,
  byId: Map<string, PluginDefinition>,
  coreVersion: string,
  skipped: Map<string, string>,
): void {
  let changed = true
  while (changed) {
    changed = false
    for (const id of [...alive].sort()) {
      const reason = unmetRequirement(byId.get(id)!, alive, byId, coreVersion)
      if (reason) {
        alive.delete(id)
        skipped.set(id, reason)
        changed = true
      }
    }
  }
}

function unmetRequirement(
  plugin: PluginDefinition,
  alive: Set<string>,
  byId: Map<string, PluginDefinition>,
  coreVersion: string,
): string | null {
  for (const [dep, range] of Object.entries(plugin.requires ?? {})) {
    if (dep === CORE) {
      if (!semver.satisfies(coreVersion, range, { includePrerelease: true })) {
        return `requires core ${range}, running ${coreVersion}`
      }
      continue
    }
    const target = byId.get(dep)
    if (!target) return `requires "${dep}" ${range}, which is not installed`
    if (!semver.satisfies(target.version, range, { includePrerelease: true })) {
      return `requires "${dep}" ${range}, found ${target.version}`
    }
    if (!alive.has(dep)) return `requires "${dep}", which is inactive or failed to load`
  }
  return null
}

function optionalSatisfied(
  dep: string,
  range: string,
  alive: Set<string>,
  byId: Map<string, PluginDefinition>,
): boolean {
  const target = byId.get(dep)
  return (
    alive.has(dep) &&
    target !== undefined &&
    semver.satisfies(target.version, range, { includePrerelease: true })
  )
}

function optionalVersionWarnings(
  alive: Set<string>,
  byId: Map<string, PluginDefinition>,
): string[] {
  const warnings: string[] = []
  for (const id of [...alive].sort()) {
    for (const [dep, range] of Object.entries(byId.get(id)!.optional ?? {})) {
      const target = byId.get(dep)
      if (alive.has(dep) && target && !optionalSatisfied(dep, range, alive, byId)) {
        warnings.push(
          `"${id}" supports "${dep}" ${range} but found ${target.version}; integration disabled`,
        )
      }
    }
  }
  return warnings
}

function edgeKey(edge: Edge): string {
  return `${edge.from}->${edge.to}`
}

function buildEdges(
  alive: Set<string>,
  byId: Map<string, PluginDefinition>,
  brokenOptionalEdges: Set<string>,
): Edge[] {
  const edges: Edge[] = []
  for (const id of alive) {
    const plugin = byId.get(id)!
    for (const dep of Object.keys(plugin.requires ?? {})) {
      if (dep !== CORE) edges.push({ from: dep, to: id, optional: false })
    }
    for (const [dep, range] of Object.entries(plugin.optional ?? {})) {
      const edge = { from: dep, to: id, optional: true }
      if (optionalSatisfied(dep, range, alive, byId) && !brokenOptionalEdges.has(edgeKey(edge))) {
        edges.push(edge)
      }
    }
  }
  return edges
}

/** Kahn's algorithm with alphabetical tie-breaking so load order is deterministic. */
function topologicalSort(
  alive: Set<string>,
  edges: Edge[],
): { order: string[]; blocked: string[] } {
  const inDegree = new Map([...alive].map((id) => [id, 0]))
  for (const edge of edges) inDegree.set(edge.to, inDegree.get(edge.to)! + 1)

  const ready = [...alive].filter((id) => inDegree.get(id) === 0).sort()
  const order: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(id)
    for (const edge of edges.filter((e) => e.from === id)) {
      const remaining = inDegree.get(edge.to)! - 1
      inDegree.set(edge.to, remaining)
      if (remaining === 0) {
        ready.push(edge.to)
        ready.sort()
      }
    }
  }
  const blocked = [...alive].filter((id) => !order.includes(id)).sort()
  return { order, blocked }
}

function findCycle(
  blocked: string[],
  edges: Edge[],
): { nodes: string[]; path: string[]; edges: Edge[] } {
  const candidates = new Set(blocked)
  const outgoing = (id: string) => edges.filter((e) => e.from === id && candidates.has(e.to))
  const stack: string[] = []
  const onStack = new Set<string>()
  const visited = new Set<string>()

  const visit = (id: string): string[] | null => {
    stack.push(id)
    onStack.add(id)
    visited.add(id)
    for (const edge of outgoing(id)) {
      if (onStack.has(edge.to)) return stack.slice(stack.indexOf(edge.to))
      if (!visited.has(edge.to)) {
        const found = visit(edge.to)
        if (found) return found
      }
    }
    stack.pop()
    onStack.delete(id)
    return null
  }

  for (const start of blocked) {
    if (visited.has(start)) continue
    const nodes = visit(start)
    if (nodes) {
      const cycleEdges = nodes.map((from, i) => {
        const to = nodes[(i + 1) % nodes.length]!
        return edges.find((e) => e.from === from && e.to === to)!
      })
      return { nodes, path: [...nodes, nodes[0]!], edges: cycleEdges }
    }
  }
  // Every blocked node sits on or behind a cycle, so the loop above always finds one.
  throw new Error(`Unresolvable plugin order: ${blocked.join(', ')}`)
}

function availableDependencies(order: string[], edges: Edge[]): Map<string, Set<string>> {
  const available = new Map(order.map((id) => [id, new Set<string>()]))
  for (const edge of edges) available.get(edge.to)?.add(edge.from)
  return available
}
