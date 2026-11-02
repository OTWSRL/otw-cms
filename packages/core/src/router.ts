type Segment = { kind: 'static'; value: string } | { kind: 'param'; name: string }

export interface CompiledRoute<T> {
  key: string
  pattern: string
  segments: Segment[]
  value: T
}

export interface RouteMatch<T> {
  route: CompiledRoute<T>
  params: Record<string, string>
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parsePattern(pattern: string): Segment[] {
  if (!pattern.startsWith('/')) throw new Error(`Route path "${pattern}" must start with "/"`)
  if (pattern === '/') return []

  const seen = new Set<string>()
  return pattern
    .replace(/\/$/, '')
    .slice(1)
    .split('/')
    .map((part): Segment => {
      if (part === '') throw new Error(`Route path "${pattern}" has an empty segment`)
      if (!part.startsWith(':')) return { kind: 'static', value: part }
      const name = part.slice(1)
      if (!PARAM_NAME.test(name)) throw new Error(`Invalid parameter "${part}" in "${pattern}"`)
      if (seen.has(name)) throw new Error(`Duplicate parameter "${part}" in "${pattern}"`)
      seen.add(name)
      return { kind: 'param', name }
    })
}

/** A pattern's path with its parameters filled in. `what` names the route in errors. */
export function fillPattern(
  segments: readonly Segment[],
  params: Record<string, string>,
  what: string,
): string {
  const parts = segments.map((segment) => {
    if (segment.kind === 'static') return segment.value
    const value = params[segment.name]
    if (value === undefined || value === '') {
      throw new Error(`${what} needs parameter "${segment.name}"`)
    }
    return encodeURIComponent(value)
  })
  return '/' + parts.join('/')
}

export function paramNames(segments: Segment[]): string[] {
  return segments.flatMap((s) => (s.kind === 'param' ? [s.name] : []))
}

/** Routes that differ only in parameter names would match the same URLs. */
function shape(segments: Segment[]): string {
  return '/' + segments.map((s) => (s.kind === 'static' ? s.value : ':')).join('/')
}

/** Static segments beat parameters, compared left to right. */
function compareSpecificity(a: Segment[], b: Segment[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const rank = (s: Segment) => (s.kind === 'static' ? 0 : 1)
    const diff = rank(a[i]!) - rank(b[i]!)
    if (diff !== 0) return diff
  }
  return a.length - b.length
}

function splitPath(pathname: string): string[] | null {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (trimmed === '/' || trimmed === '') return []
  try {
    return trimmed.slice(1).split('/').map(decodeURIComponent)
  } catch {
    return null
  }
}

export class Router<T> {
  readonly #routes: CompiledRoute<T>[] = []
  readonly #byKey = new Map<string, CompiledRoute<T>>()
  readonly #byShape = new Map<string, string>()

  /** `scope` separates routes that may share a shape, such as API routes with different methods. */
  add(key: string, pattern: string, value: T, scope = ''): CompiledRoute<T> {
    if (this.#byKey.has(key)) throw new Error(`Route "${key}" is already registered`)
    const segments = parsePattern(pattern)
    const shapeKey = `${scope} ${shape(segments)}`
    const clash = this.#byShape.get(shapeKey)
    if (clash) throw new Error(`Route "${key}" (${pattern}) conflicts with "${clash}"`)

    const route = { key, pattern, segments, value }
    this.#routes.push(route)
    this.#routes.sort((a, b) => compareSpecificity(a.segments, b.segments))
    this.#byKey.set(key, route)
    this.#byShape.set(shapeKey, key)
    return route
  }

  get(key: string): CompiledRoute<T> | undefined {
    return this.#byKey.get(key)
  }

  /** Every route matching the path, most specific first. */
  matchAll(pathname: string): RouteMatch<T>[] {
    const parts = splitPath(pathname)
    if (!parts) return []
    const matches: RouteMatch<T>[] = []
    for (const route of this.#routes) {
      const params = matchSegments(route.segments, parts)
      if (params) matches.push({ route, params })
    }
    return matches
  }

  match(pathname: string): RouteMatch<T> | null {
    return this.matchAll(pathname)[0] ?? null
  }

  url(key: string, params: Record<string, string> = {}): string {
    const route = this.#byKey.get(key)
    if (!route) throw new Error(`Unknown route "${key}"`)
    return fillPattern(route.segments, params, `Route "${key}"`)
  }
}

function matchSegments(segments: Segment[], parts: string[]): Record<string, string> | null {
  if (segments.length !== parts.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    const part = parts[i]!
    if (segment.kind === 'static') {
      if (segment.value !== part) return null
    } else {
      if (part === '') return null
      params[segment.name] = part
    }
  }
  return params
}
