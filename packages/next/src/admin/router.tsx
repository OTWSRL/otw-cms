import type { Kernel, SettingsPageView } from '@otwdesign/core'
import type { CapabilityName, ContentTypeName, SearchParams, User } from '@otwdesign/sdk'
import type { Metadata } from 'next'
import { forbidden, notFound, redirect } from 'next/navigation'
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
import { ContentEditScreen } from './screens/content-edit'
import { ContentListScreen } from './screens/content-list'
import { ContentRevisionsScreen } from './screens/content-revisions'
import { MediaEditScreen } from './screens/media-edit'
import { MediaLibraryScreen } from './screens/media-library'
import { MediaNewScreen } from './screens/media-new'
import { ContentTermScreen } from './screens/content-term'
import { ContentTermsScreen } from './screens/content-terms'
import type { ScreenContext } from './screens/context'
import { DashboardScreen } from './screens/dashboard'
import { LoginScreen } from './screens/login'
import { PluginsScreen } from './screens/plugins'
import { RolesScreen } from './screens/roles'
import { SetupScreen } from './screens/setup'
import { UpdatesScreen } from './screens/updates'
import { NewUserScreen } from './screens/user-new'
import { ScheduledActionsScreen } from './screens/scheduled-actions'
import { UsersScreen } from './screens/users'
import { ProfileScreen } from './screens/profile'
import { UserEditScreen } from './screens/user-edit'
import { SettingsForm } from './settings-form'
import { AdminShell } from './shell'

/** What Next.js passes the admin's catch-all route. */
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
  '/admin/profile': { title: 'Profile', Screen: ProfileScreen },
  '/admin/updates': { title: 'Updates', capability: 'core.manage_updates', Screen: UpdatesScreen },
  '/admin/tools/scheduled-actions': {
    title: 'Scheduled Actions',
    capability: 'core.manage_jobs',
    Screen: ScheduledActionsScreen,
  },
}

/** Signed-out screens, in wp-login.php's frame rather than the admin's. */
const LOGIN_SCREENS: Readonly<
  Record<string, { title: string; Screen: typeof LoginScreen | typeof SetupScreen }>
> = {
  '/admin/login': { title: 'Log In', Screen: LoginScreen },
  '/admin/setup': { title: 'Set up your site', Screen: SetupScreen },
}

// Core's settings pages live under /admin/settings; plugins' at /admin/{pluginId}/....
const CORE_SETTINGS: Readonly<Record<string, string>> = {
  '/admin/settings': 'core.general',
  '/admin/settings/reading': 'core.reading',
  '/admin/settings/media': 'core.media',
}

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

/** For a settings page's `entry` fields: each content type's published entries, as a tree. */
async function entryOptions(kernel: Kernel, view: SettingsPageView) {
  const types = new Set(
    view.sections.flatMap((section) =>
      section.fields.flatMap((field) => (field.contentType ? [field.contentType] : [])),
    ),
  )
  const options: Record<string, { value: string; label: string }[]> = {}
  for (const type of types) {
    if (!kernel.content.getType(type)) continue
    const { entries, depths = [] } = await kernel.content.list({
      type: type as ContentTypeName,
      status: 'published',
      orderBy: kernel.content.getType(type)?.hierarchical ? 'tree' : 'title',
      limit: 100,
    })
    options[type] = entries.map((entry, i) => ({
      value: entry.id,
      label: `${'\u00a0\u00a0\u00a0'.repeat(depths[i] ?? 0)}${entry.title || '(no title)'}`,
    }))
  }
  return options
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

  const coreSettings = Object.hasOwn(CORE_SETTINGS, path) ? CORE_SETTINGS[path] : undefined
  const resolution = coreSettings
    ? kernel.settingsPage(coreSettings, user)
    : await kernel.resolveAdminPage(path, searchParams, user)
  if (resolution.kind === 'not-found') notFound()
  if (resolution.kind === 'forbidden') forbidden()
  const flash = kernel.readFlash(searchParams.flash)
  if (resolution.kind === 'settings') {
    const body = (
      <AdminScreen title={resolution.title} flash={flash}>
        <SettingsForm
          view={resolution.view}
          saveUrl={kernel.actionUrl('core', 'save-settings')}
          entryOptions={await entryOptions(kernel, resolution.view)}
        />
      </AdminScreen>
    )
    return { kernel, user, title: resolution.title, body }
  }
  if (resolution.kind === 'content-list') {
    const { type } = resolution
    const body = (
      <ContentListScreen kernel={kernel} user={user} type={type} searchParams={searchParams} />
    )
    return { kernel, user, title: type.labels.plural, body }
  }
  if (resolution.kind === 'content-edit') {
    const { type, entry } = resolution
    const body = (
      <ContentEditScreen
        kernel={kernel}
        user={user}
        type={type}
        entry={entry}
        searchParams={searchParams}
      />
    )
    const title = `${entry ? 'Edit' : 'Add New'} ${type.labels.singular}`
    return { kernel, user, title, body }
  }
  if (resolution.kind === 'user-edit') {
    // As user-edit.php sends you to profile.php for yourself.
    if (resolution.target.id === user.id) redirect('/admin/profile')
    const body = (
      <UserEditScreen
        kernel={kernel}
        user={user}
        target={resolution.target}
        searchParams={searchParams}
      />
    )
    return { kernel, user, title: 'Edit User', body }
  }
  if (resolution.kind === 'media-library') {
    const body = <MediaLibraryScreen kernel={kernel} user={user} searchParams={searchParams} />
    return { kernel, user, title: 'Media Library', body }
  }
  if (resolution.kind === 'media-new') {
    return {
      kernel,
      user,
      title: 'Upload New Media',
      body: <MediaNewScreen kernel={kernel} searchParams={searchParams} />,
    }
  }
  if (resolution.kind === 'media-edit') {
    const body = (
      <MediaEditScreen
        kernel={kernel}
        user={user}
        item={resolution.item}
        searchParams={searchParams}
      />
    )
    return { kernel, user, title: 'Edit Media', body }
  }
  if (resolution.kind === 'content-revisions') {
    const { type, entry } = resolution
    const body = (
      <ContentRevisionsScreen
        kernel={kernel}
        type={type}
        entry={entry}
        searchParams={searchParams}
      />
    )
    return { kernel, user, title: `Revisions · ${entry.title || '(no title)'}`, body }
  }
  if (resolution.kind === 'taxonomy-terms') {
    const { taxonomy } = resolution
    const body = (
      <ContentTermsScreen
        kernel={kernel}
        user={user}
        taxonomy={taxonomy}
        searchParams={searchParams}
      />
    )
    return { kernel, user, title: taxonomy.labels.plural, body }
  }
  if (resolution.kind === 'taxonomy-term') {
    const { taxonomy, term } = resolution
    const body = (
      <ContentTermScreen
        kernel={kernel}
        user={user}
        taxonomy={taxonomy}
        term={term}
        searchParams={searchParams}
      />
    )
    return { kernel, user, title: `Edit ${taxonomy.labels.singular}`, body }
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
  const site = (await getKernel()).setting('site.title') ?? 'My Site'
  const login = Object.hasOwn(LOGIN_SCREENS, path) ? LOGIN_SCREENS[path] : undefined
  const title = login
    ? `${login.title} · ${site}`
    : adminTitle(site, (await resolveScreen(path, query)).title)
  return { title: { absolute: title }, robots: { index: false, follow: false } }
}
