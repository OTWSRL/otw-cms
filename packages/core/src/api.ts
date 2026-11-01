import { isSiteOrigin, type OriginPolicy } from './origins'
import type { ApiContext, ApiHandler, HttpMethod, Logger, User } from '@otw/sdk'
import { ForbiddenError, HttpError } from '@otw/sdk'
import type { Router } from './router'
import { sessionTokenFromHeader } from './session-cookie'

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

export interface ApiDependencies {
  logger: Logger
  origins: OriginPolicy
  userForSession(token: string | null): Promise<User | null>
}

export async function dispatchApi(
  router: Router<ApiEntry>,
  request: Request,
  { logger, origins, userForSession }: ApiDependencies,
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
  const safe = SAFE_METHODS.has(method)
  const origin = request.headers.get('origin')
  if (!safe && origin && !isSiteOrigin(origin, request, origins)) {
    return errorResponse(403, 'Cross-origin request blocked')
  }

  // Unsafe requests act as the user only with this site's Origin, as admin actions do: a cookie
  // on a request no browser vouched for stays anonymous. Looked up only if the handler asks.
  let user: Promise<User | null> | undefined
  const context: ApiContext = {
    params: match.params,
    user: () =>
      (user ??=
        safe || origin
          ? userForSession(sessionTokenFromHeader(request.headers.get('cookie')))
          : Promise.resolve(null)),
  }

  const { pluginId } = match.route.value
  try {
    const response = await match.route.value.handler(request, context)
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
    if (error instanceof ForbiddenError) return errorResponse(403, error.message)
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
