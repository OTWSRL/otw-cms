import type { Kernel } from '@cms/core'
import type { CapabilityName, SearchParams, User } from '@cms/sdk'
import type { Metadata } from 'next'
import { forbidden, notFound } from 'next/navigation'
import { cache, type ReactNode } from 'react'
import { getKernel } from '../runtime/kernel'
import {
  parseSearchParams,
  pathnameFromSegments,
  serializeSearchParams,
} from '../runtime/search-params'
import { requireAdmin } from '../runtime/session'
import { LoginShell } from './login-shell'
import { AdminScreen, adminTitle } from './screen'
import type { ScreenContext } from './screens/context'
import { DashboardScreen } from './screens/dashboard'
import { LoginScreen } from './screens/login'
import { PluginsScreen } from './screens/plugins'
import { RolesScreen } from './screens/roles'
import { SetupScreen } from './screens/setup'
import { UpdatesScreen } from './screens/updates'
import { NewUserScreen } from './screens/user-new'
import { UsersScreen } from './screens/users'
import { SettingsForm } from './settings-form'
import { AdminShell } from './shell'

export interface AdminRouteProps {
  params: Promise<{ segments?: string[] }>
  searchParams: Promise<SearchParams>
}

interface CoreScreen {
  title: string
  /** On top of `core.access_admin`, which every framed screen needs. */
  capability?: CapabilityName
  Screen: (context: ScreenContext) => Promise<ReactNode>
}

/**
 * Core's screens. Everything else under /admin is a plugin page or a settings page, which the
 * kernel resolves. One catch-all route serves them all, so a new screen ships with the package and
 * needs no new file in the site.
 */
const SCREENS: Readonly<Record<string, CoreScreen>> = {
  '/admin': { title: 'Dashboard', Screen: DashboardScreen },
  '/admin/plugins': { title: 'Plugins', capability: 'core.manage_plugins', Screen: PluginsScreen },
  '/admin/users': { title: 'Users', capability: 'core.manage_users', Screen: UsersScreen },
  '/admin/users/new': {
    title: 'Add User',
    capability: 'core.manage_users',
    Screen: NewUserScreen,
  },
  '/admin/users/roles': { title: 'Roles', capability: 'core.manage_users', Screen: RolesScreen },
  '/admin/updates': { title: 'Updates', capability: 'core.manage_updates', Screen: UpdatesScreen },
}

/** Signed-out screens, in wp-login.php's frame rather than the admin's. */
const LOGIN_SCREENS: Readonly<
  Record<string, { title: string; Screen: typeof LoginScreen | typeof SetupScreen }>
> = {
  '/admin/login': { title: 'Log In', Screen: LoginScreen },
  '/admin/setup': { title: 'Set up your site', Screen: SetupScreen },
}

// Core's settings page lives at /admin/settings; plugins' at /admin/{pluginId}/....
const GENERAL_SETTINGS = '/admin/settings'

interface Resolved {
  kernel: Kernel
  user: User
  title: string
  body: ReactNode
}

async function location({ params, searchParams }: AdminRouteProps) {
  const { segments = [] } = await params
  return {
    path: pathnameFromSegments(['admin', ...segments]),
    query: serializeSearchParams(await searchParams),
  }
}

/**
 * Checks access and loads the screen. Cached per request: metadata and the page both call it, and
 * a plugin page's loader must run once.
 */
const resolveScreen = cache(async (path: string, query: string): Promise<Resolved> => {
  const core = Object.hasOwn(SCREENS, path) ? SCREENS[path] : undefined
  const { kernel, user } = await requireAdmin(path, core?.capability)
  const searchParams = parseSearchParams(query)
  if (core) {
    const body = <core.Screen kernel={kernel} user={user} path={path} searchParams={searchParams} />
    return { kernel, user, title: core.title, body }
  }

  const resolution =
    path === GENERAL_SETTINGS
      ? kernel.settingsPage('core.general', user)
      : await kernel.resolveAdminPage(path, searchParams, user)
  if (resolution.kind === 'not-found') notFound()
  if (resolution.kind === 'forbidden') forbidden()
  const flash = kernel.readFlash(searchParams.flash)
  if (resolution.kind === 'settings') {
    const body = (
      <AdminScreen title={resolution.title} flash={flash}>
        <SettingsForm view={resolution.view} saveUrl={kernel.actionUrl('core', 'save-settings')} />
      </AdminScreen>
    )
    return { kernel, user, title: resolution.title, body }
  }
  const { Component } = resolution
  const body = (
    <AdminScreen title={resolution.title} titleAction={resolution.titleAction} flash={flash}>
      <Component {...resolution.props} />
    </AdminScreen>
  )
  return { kernel, user, title: resolution.title, body }
})

/** Every page under /admin: core screens, plugin screens, settings pages, sign-in and setup. */
export async function AdminPage(props: AdminRouteProps) {
  const { path, query } = await location(props)
  const login = Object.hasOwn(LOGIN_SCREENS, path) ? LOGIN_SCREENS[path] : undefined
  if (login) {
    return (
      <LoginShell>
        <login.Screen searchParams={parseSearchParams(query)} />
      </LoginShell>
    )
  }
  const { kernel, user, body } = await resolveScreen(path, query)
  return (
    <AdminShell kernel={kernel} user={user}>
      {body}
    </AdminShell>
  )
}

/** `Plugins · Admin · My Site`, or `Log In · My Site`; never indexed. */
export async function generateAdminMetadata(props: AdminRouteProps): Promise<Metadata> {
  const { path, query } = await location(props)
  const site = (await getKernel()).setting('site.title') ?? 'Next CMS'
  const login = Object.hasOwn(LOGIN_SCREENS, path) ? LOGIN_SCREENS[path] : undefined
  const title = login
    ? `${login.title} · ${site}`
    : adminTitle(site, (await resolveScreen(path, query)).title)
  return { title: { absolute: title }, robots: { index: false, follow: false } }
}
