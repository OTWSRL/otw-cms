import type { SearchParams } from '@cms/sdk'

/** Stable string form, so React's per-request cache can key on it. */
export function serializeSearchParams(params: SearchParams): string {
  const query = new URLSearchParams()
  for (const key of Object.keys(params).sort()) {
    for (const value of [params[key]].flat()) if (value !== undefined) query.append(key, value)
  }
  return query.toString()
}

export function parseSearchParams(query: string): SearchParams {
  const params: Record<string, string | string[]> = {}
  for (const [key, value] of new URLSearchParams(query)) {
    const existing = params[key]
    params[key] = existing === undefined ? value : [existing, value].flat()
  }
  return params
}

/** Next hands catch-all segments over decoded; the router expects an encoded pathname. */
export function pathnameFromSegments(segments: readonly string[] | undefined): string {
  return '/' + (segments ?? []).map(encodeURIComponent).join('/')
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
