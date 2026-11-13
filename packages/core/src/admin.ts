import type {
  AdminActionResult,
  AdminPage,
  AdminPageProps,
  AdminTitleAction,
  ApiHandler,
  CapabilityName,
  ContentType,
  Entry,
  MediaItem,
  Taxonomy,
  Term,
  Logger,
  User,
} from '@otwdesign/sdk'
import { ActionError, ForbiddenError } from '@otwdesign/sdk'
import { apiPath } from './api'
import { isSiteOrigin, publicOrigin, type OriginPolicy } from './origins'
import { withFlash, type Flash, type FlashCodec } from './flash'
import { cookieValue, parseCookies, SESSION_COOKIE_NAMES } from './session-cookie'
import type { SettingsPageView } from './settings-pages'

export const ADMIN_PREFIX = '/admin'
export const LOGIN_PATH = '/admin/login'

/** Which of a content type's screens: its list (`edit.php`), Add New, or an entry's edit screen. */
export type ContentScreen = 'list' | 'new' | 'edit' | 'revisions'

/**
 * A plugin's own screen, a settings page that core renders from its sections, or one of a
 * content type's screens.
 */
export type AdminPageEntry =
  | { pluginId: string; page: AdminPage<unknown> }
  | { pluginId: string; settingsPage: string }
  | { pluginId: string; content: { type: string; screen: ContentScreen } }
  | { pluginId: string; taxonomy: { name: string; screen: 'terms' | 'term' } }
  | { pluginId: string; media: MediaScreen }
  | { pluginId: string; user: 'edit' }

/** Media › Library (upload.php), Add New (media-new.php), and a file's Edit Media screen. */
export type MediaScreen = 'library' | 'new' | 'edit'

export type SettingsResolution =
  | { kind: 'not-found' }
  | { kind: 'forbidden' }
  | { kind: 'settings'; key: string; title: string; view: SettingsPageView }

export type AdminResolution =
  | SettingsResolution
  | { kind: 'content-list'; type: ContentType }
  /** `entry` is `null` on Add New. An entry in the trash is shown, to be restored. */
  | { kind: 'content-edit'; type: ContentType; entry: Entry | null }
  /** An entry's revisions, to compare and restore (revision.php). */
  | { kind: 'content-revisions'; type: ContentType; entry: Entry }
  /** A taxonomy's screen (edit-tags.php), and a term's (term.php). */
  | { kind: 'taxonomy-terms'; taxonomy: Taxonomy }
  | { kind: 'taxonomy-term'; taxonomy: Taxonomy; term: Term }
  | { kind: 'media-library' }
  | { kind: 'media-new' }
  | { kind: 'media-edit'; item: MediaItem }
  /** user-edit.php: another user's details, role and fields. */
  | { kind: 'user-edit'; target: User }
  | {
      kind: 'page'
      key: string
      pluginId: string
      title: string
      titleAction: AdminTitleAction | null
      props: AdminPageProps<unknown>
      Component: AdminPage<unknown>['component']
    }

export interface ActionInput {
  /** `null` only for actions that work signed out. */
  user: User | null
  sessionToken: string | null
  /** The first of these cookies the request carries, or `null`. */
  cookie(names: readonly string[]): string | null
  form: FormData
  /** Whether cookies set by this response should be Secure. */
  secure: boolean
  /** The site's public origin, `https://example.com`, for links in emails. */
  origin: string
}

export interface ActionOutput extends AdminActionResult {
  cookies?: string[]
}

/** Core's own actions may run signed out (sign in, first-run setup); plugin actions never do. */
export interface InternalAction {
  name: string
  capability: CapabilityName | null
  /**
   * The largest form it reads, by Content-Length, for actions that take files: a bigger one is
   * refused with `message` before its body is read.
   */
  maxBody?: { bytes: number; message: string }
  handler: (input: ActionInput) => ActionOutput | void | Promise<ActionOutput | void>
}

export interface ActionDependencies {
  pluginId: string
  userForSession(token: string | null): Promise<User | null>
  can(user: User, capability: CapabilityName): boolean
  flash: FlashCodec
  logger: Logger
  origins: OriginPolicy
}

export function adminPath(pluginId: string, path: string): string {
  return `${ADMIN_PREFIX}/${pluginId}${path === '/' ? '' : path}`
}

export function actionPath(pluginId: string, name: string): string {
  return apiPath(pluginId, `/actions/${name}`)
}

/**
 * A same-site path (`/admin/x?y`) or `null`. Rejects absolute and protocol-relative URLs and
 * backslash tricks, so redirects can't be pointed at another site.
 */
export function safeRedirectPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null
  if (value.includes('\\')) return null
  try {
    const base = 'http://local'
    const url = new URL(value, base)
    return url.origin === base ? url.pathname + url.search + url.hash : null
  } catch {
    return null
  }
}

function refererPath(request: Request, origins: OriginPolicy): string | null {
  const referer = request.headers.get('referer')
  if (!referer) return null
  try {
    const url = new URL(referer)
    return isSiteOrigin(url.origin, request, origins) ? url.pathname + url.search : null
  } catch {
    return null
  }
}

function isForm(request: Request): boolean {
  const type = request.headers.get('content-type') ?? ''
  return (
    type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')
  )
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 303, headers })
}

/**
 * Wraps an admin action as an API handler. The checks run before the plugin's code: the post
 * must come from this site (an Origin header is required, unlike public API routes), the user
 * must be signed in and hold the capability, and the body must be a form. The result becomes a
 * 303 redirect with a signed flash message, so the browser never re-posts on refresh.
 */
export function createActionHandler(action: InternalAction, deps: ActionDependencies): ApiHandler {
  return async (request) => {
    const origin = request.headers.get('origin')
    if (!origin || !isSiteOrigin(origin, request, deps.origins)) {
      return Response.json({ error: 'Cross-origin request blocked' }, { status: 403 })
    }
    if (!isForm(request)) {
      return Response.json({ error: 'Expected a form submission' }, { status: 415 })
    }

    const back = refererPath(request, deps.origins) ?? ADMIN_PREFIX
    const cookies = parseCookies(request.headers.get('cookie'))
    const sessionToken = cookieValue(cookies, SESSION_COOKIE_NAMES)
    const user = await deps.userForSession(sessionToken)
    if (action.capability !== null) {
      if (!user) return redirect(`${LOGIN_PATH}?next=${encodeURIComponent(back)}`)
      if (!deps.can(user, action.capability)) {
        return Response.json({ error: 'You are not allowed to do that' }, { status: 403 })
      }
    }

    const flashTo = (path: string, flash: Flash | null) =>
      withFlash(path, flash ? deps.flash.encode(flash) : null)

    if (action.maxBody) {
      const length = Number(request.headers.get('content-length') ?? NaN)
      if (!Number.isSafeInteger(length)) {
        return Response.json({ error: 'Send the form with its length' }, { status: 411 })
      }
      if (length > action.maxBody.bytes) {
        return redirect(flashTo(back, { kind: 'error', message: action.maxBody.message }))
      }
    }

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return Response.json({ error: 'Malformed form body' }, { status: 400 })
    }

    try {
      const site = deps.origins.siteUrl() ?? publicOrigin(request, deps.origins.trustProxy)
      const secure = new URL(site).protocol === 'https:'
      const result =
        (await action.handler({
          user,
          sessionToken,
          cookie: (names) => cookieValue(cookies, names),
          form,
          secure,
          origin: new URL(site).origin,
        })) ?? {}
      const target = safeRedirectPath(result.redirect) ?? back
      const notice: Flash | null = result.notice ? { kind: 'notice', message: result.notice } : null
      return redirect(flashTo(target, notice), result.cookies)
    } catch (error) {
      if (error instanceof ActionError) {
        return redirect(flashTo(back, { kind: 'error', message: error.message }))
      }
      if (error instanceof ForbiddenError) {
        return Response.json({ error: error.message }, { status: 403 })
      }
      deps.logger.error('Admin action failed', {
        plugin: deps.pluginId,
        action: action.name,
        user: user?.id,
        error,
      })
      return redirect(
        flashTo(back, { kind: 'error', message: 'Something went wrong. Check the server log.' }),
      )
    }
  }
}
