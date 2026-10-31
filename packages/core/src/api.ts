import type { ApiHandler, HttpMethod, Logger } from '@cms/sdk'
import { HttpError } from '@cms/sdk'
import type { Router } from './router'

export const API_PREFIX = '/api/p'

export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

export interface ApiEntry {
  pluginId: string
  method: HttpMethod
  handler: ApiHandler
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function apiPath(pluginId: string, path: string): string {
  return `${API_PREFIX}/${pluginId}${path === '/' ? '' : path}`
}

export async function dispatchApi(
  router: Router<ApiEntry>,
  request: Request,
  logger: Logger,
  allowedOrigins: readonly string[],
): Promise<Response> {
  const url = new URL(request.url)
  const method = request.method.toUpperCase()
  const matches = router.matchAll(url.pathname)
  if (matches.length === 0) return errorResponse(404, 'Not found')

  const match = matches.find((m) => m.route.value.method === method)
  if (!match) {
    const allow = [...new Set(matches.map((m) => m.route.value.method))].join(', ')
    return errorResponse(405, 'Method not allowed', { Allow: allow })
  }

  // Browsers send Origin on cross-site form posts and fetches; server-to-server calls
  // (payment webhooks) send none.
  if (!SAFE_METHODS.has(method)) {
    const origin = request.headers.get('origin')
    if (origin && origin !== url.origin && !allowedOrigins.includes(origin)) {
      return errorResponse(403, 'Cross-origin request blocked')
    }
  }

  const { pluginId } = match.route.value
  try {
    const response = await match.route.value.handler(request, { params: match.params })
    if (!(response instanceof Response)) throw new TypeError('API handlers must return a Response')
    return response
  } catch (error) {
    if (error instanceof HttpError && error.status >= 400 && error.status < 600) {
      const body =
        error.details === undefined
          ? { error: error.message }
          : { error: error.message, details: error.details }
      return Response.json(body, { status: error.status })
    }
    logger.error('API handler failed', { plugin: pluginId, route: match.route.key, error })
    return errorResponse(500, 'Internal server error')
  }
}

function errorResponse(
  status: number,
  message: string,
  headers?: Record<string, string>,
): Response {
  return Response.json({ error: message }, { status, headers })
}
