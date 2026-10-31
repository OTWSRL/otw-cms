import type {
  ActionName,
  Actions,
  AdminPage,
  ApiRoute,
  CapabilityArgs,
  CapabilityName,
  Database,
  FilterContext,
  FilterName,
  FilterValue,
  HooksApi,
  Logger,
  MetaCapabilityName,
  PageMetadata,
  PageProps,
  PageRoute,
  PluginContext,
  PluginDefinition,
  RegistryName,
  RegistryOf,
  SearchParams,
  ServiceName,
  Services,
  SettingName,
  Settings,
  SettingsPage,
  SettingsValues,
  SlotComponent,
  SlotName,
  User,
} from '@cms/sdk'
import { ActionError, ForbiddenError } from '@cms/sdk'
import {
  actionPath,
  adminPath,
  createActionHandler,
  type AdminPageEntry,
  type AdminResolution,
  type InternalAction,
  type SettingsResolution,
} from './admin'
import { AdminMenu, type AdminMenuSection } from './admin-menu'
import { apiPath, dispatchApi, HTTP_METHODS, type ApiEntry } from './api'
import { createAuthService, type AuthService } from './auth'
import { CapabilityStore, type CapabilityInfo, type RoleInfo } from './capabilities'
import {
  CORE,
  coreActions,
  coreDefinition,
  registerCoreCapabilities,
  registerCoreSettings,
} from './core-plugin'
import { DatabaseContext } from './database'
import { PluginBootError } from './errors'
import { createFlashCodec, type Flash, type FlashCodec } from './flash'
import { HookBus } from './hooks'
import { consoleLogger, withContext } from './logger'
import { runMigrations } from './migrations'
import { bumpGeneration, ensureSecret, readGeneration } from './options'
import type { HashCost } from './passwords'
import {
  activationBlockers,
  deactivationBlockers,
  displayName,
  loadActiveIds,
  saveActive,
} from './plugin-state'
import { RegistryStore } from './registries'
import { resolvePlugins, type Resolution, type SkippedPlugin } from './resolver'
import { paramNames, parsePattern, Router } from './router'
import { ServiceStore } from './services'
import {
  declaredSettings,
  loadStoredSettings,
  resolveSettings,
  saveSettings,
  type Env,
  type ResolvedSetting,
  type SettingValue,
} from './settings'
import {
  pageUpdates,
  pageView,
  SettingsLayoutStore,
  type ResolvedSettingsPage,
} from './settings-pages'
import { SlotStore } from './slots'
import { CORE_VERSION } from './version'

export interface KernelOptions {
  /** Every installed plugin (from the generated import map). */
  plugins: readonly PluginDefinition[]
  /**
   * Pins the active plugins and turns off activation in the admin (tests, or sites that manage
   * plugins in configuration). Without it, activation lives in the database; on first boot every
   * installed plugin is active.
   */
  active?: readonly string[]
  db: Database
  /** Environment variables, for settings that declare an `env` override. */
  env?: Env
  /** Fixed values that win over the environment and the database (tests, embedding). */
  settings?: SettingsValues
  /** Page route path overrides, e.g. `{ 'commerce.product': '/p/:slug' }`. */
  routes?: Readonly<Record<string, string>>
  /** Extra origins allowed to send unsafe API requests. */
  allowedOrigins?: readonly string[]
  logger?: Logger
  /** Throw when a plugin fails to boot instead of booting without it. Use in tests and CI. */
  strict?: boolean
  coreVersion?: string
  /** Signs flash messages. Defaults to a random secret stored in the database. */
  secret?: string
  /** Runs after the admin changes activation or settings, so the app can reboot its kernel. */
  onChange?: () => void
  /** `fast` lowers the password hashing cost. Only for test suites. */
  passwordHashing?: HashCost
}

export interface ResolvedPage {
  key: string
  pluginId: string
  props: PageProps<unknown>
  Component: PageRoute<unknown>['component']
  metadata(): Promise<PageMetadata>
}

export interface PluginStatus {
  id: string
  name: string
  version: string
  description?: string
  requires: Readonly<Record<string, string>>
  /** `failed`: switched on, but it (or something it needs) didn't load. */
  status: 'active' | 'inactive' | 'failed'
  reason?: string
  /** Why it can't be activated (when inactive) or deactivated (when on) right now. */
  blockers: string[]
}

export interface Kernel {
  readonly coreVersion: string
  /** Loaded plugin ids, in load order. */
  readonly active: readonly string[]
  readonly skipped: readonly SkippedPlugin[]
  readonly warnings: readonly string[]
  readonly db: Database
  /** Changes when the admin changes activation or settings. */
  readonly generation: number
  /** `pinned` when the active set comes from configuration rather than the admin. */
  readonly activation: 'database' | 'pinned'
  /** False once activation or settings changed after this kernel booted. */
  isCurrent(): Promise<boolean>
  isActive(pluginId: string): boolean
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>
  applyFilters<K extends FilterName>(
    name: K,
    value: FilterValue<K>,
    context: FilterContext<K>,
  ): Promise<FilterValue<K>>
  doAction<K extends ActionName>(name: K, payload: Actions[K]): Promise<void>
  service<K extends ServiceName>(name: K): Services[K]
  registry<K extends RegistryName>(name: K): RegistryOf<K>
  setting<K extends SettingName>(key: K): Settings[K] | undefined
  url(name: string, params?: Record<string, string>): string
  /** Matches a page route and runs its loader. `null` means 404. */
  resolvePage(pathname: string, searchParams?: SearchParams): Promise<ResolvedPage | null>
  slot<K extends SlotName>(name: K): SlotComponent<K>[]
  handleApi(request: Request): Promise<Response>

  readonly auth: AuthService
  can<C extends CapabilityName | MetaCapabilityName>(
    user: User | null,
    capability: C,
    ...args: CapabilityArgs<C>
  ): boolean
  roles(): RoleInfo[]
  capabilities(): CapabilityInfo[]
  plugins(): PluginStatus[]
  /** A settings page by qualified name, such as `core.general`, for this user. */
  settingsPage(key: string, user: User): SettingsResolution
  resolveAdminPage(
    pathname: string,
    searchParams: SearchParams,
    user: User,
  ): Promise<AdminResolution>
  adminMenu(user: User): AdminMenuSection[]
  adminUrl(name: string, params?: Record<string, string>): string
  actionUrl(pluginId: string, name: string): string
  readFlash(value: string | string[] | undefined): Flash | null
}

interface PageEntry {
  pluginId: string
  route: PageRoute<unknown>
}

/** State read once per `createKernel()`, shared by the recovery-mode reboots. */
interface Prepared {
  options: KernelOptions
  logger: Logger
  db: DatabaseContext
  generation: number
  flash: FlashCodec
  configured: readonly string[]
  stored: ReadonlyMap<string, unknown>
}

/** Used by trial boots, which test values before they are stored. */
interface StartOptions {
  stored?: ReadonlyMap<string, unknown>
}

const ROUTE_NAME = /^[a-z][a-z0-9-]*$/
const RESERVED_PATHS = ['/api', '/_next', '/admin']
const APP = 'app'
const PINNED = 'Plugins are switched on in the site configuration, so they cannot be changed here.'

/**
 * Boots the plugins. If one fails to migrate or set up, the kernel boots again without it (and
 * without anything that requires it), like WordPress recovery mode, unless `strict` is set.
 */
export function createKernel(options: KernelOptions): Promise<Kernel> {
  return startKernel(options, {})
}

async function startKernel(options: KernelOptions, start: StartOptions): Promise<Kernel> {
  const logger = options.logger ?? consoleLogger
  const db = new DatabaseContext(options.db)
  await runMigrations(db, [coreDefinition], logger)
  // Read the generation before the state it guards, so a change in between triggers a reboot.
  const generation = await readGeneration(db.root)
  const prepared: Prepared = {
    options,
    logger,
    db,
    generation,
    flash: createFlashCodec(options.secret ?? (await ensureSecret(db.root))),
    configured: options.active ?? (await loadActiveIds(db.root, options.plugins)),
    stored: start.stored ?? (await loadStoredSettings(db.root)),
  }
  const failed = new Map<string, string>()

  for (;;) {
    try {
      return await boot(
        prepared,
        prepared.configured.filter((id) => !failed.has(id)),
        failed,
      )
    } catch (error) {
      if (!(error instanceof PluginBootError) || options.strict) throw error
      logger.error(`Booting without plugin "${error.pluginId}"`, { plugin: error.pluginId, error })
      failed.set(error.pluginId, error.message)
    }
  }
}

async function boot(
  prepared: Prepared,
  activeIds: readonly string[],
  failed: ReadonlyMap<string, string>,
): Promise<Kernel> {
  const { options, logger, db } = prepared
  const coreVersion = options.coreVersion ?? CORE_VERSION
  const resolution = resolvePlugins(options.plugins, activeIds, coreVersion)
  const skipped = [...[...failed].map(([id, reason]) => ({ id, reason })), ...resolution.skipped]
  for (const { id, reason } of resolution.skipped) {
    logger.warn(`Plugin "${id}" not loaded: ${reason}`)
  }
  for (const warning of resolution.warnings) logger.warn(warning)

  await runMigrations(db, resolution.order, logger)

  const settings = resolveSettings({
    declared: [coreDefinition, ...resolution.order].flatMap((plugin) =>
      declaredSettings(plugin.id, plugin.settings),
    ),
    env: options.env ?? {},
    stored: prepared.stored,
    overrides: options.settings ?? {},
  })
  for (const warning of settings.warnings) logger.warn(warning)
  const values = settings.values as SettingsValues
  const settingsByKey = new Map(settings.settings.map((setting) => [setting.key, setting]))

  let sealed = false
  const assertOpen = (what: string) => {
    if (sealed) throw new Error(`Cannot register ${what} after boot; register it in setup()`)
  }
  const stores = {
    hooks: new HookBus({ logger, isolate: (fn) => db.isolate(fn), assertOpen }),
    registries: new RegistryStore(assertOpen),
    services: new ServiceStore(assertOpen),
    slots: new SlotStore(assertOpen),
    capabilities: new CapabilityStore(assertOpen, (capability, pluginId, error) =>
      logger.error('Capability check failed; denying', { capability, plugin: pluginId, error }),
    ),
    pages: new Router<PageEntry>(),
    apis: new Router<ApiEntry>(),
    adminPages: new Router<AdminPageEntry>(),
    menu: new AdminMenu(),
    settingsLayout: new SettingsLayoutStore(
      assertOpen,
      new Map(settings.settings.map((setting) => [setting.key, setting.pluginId])),
    ),
  }
  // Placed once every plugin has set up; actions read it only after boot.
  let settingsPages = new Map<string, ResolvedSettingsPage>()
  const installed = new Map(options.plugins.map((plugin) => [plugin.id, plugin]))
  const activeSet = new Set(resolution.order.map((plugin) => plugin.id))
  const overridesUsed = new Set<string>()
  // Who read each setting while setting up: only they can fail to start on a new value.
  const startupReaders = new Map<string, Set<string>>()
  let settingUp: string | undefined
  const requiredCapabilities: { what: string; capability: string }[] = []
  const auth = createAuthService(db, {
    roleExists: (role) => stores.capabilities.hasRole(role),
    hashCost: options.passwordHashing,
  })

  const registerPage = (pluginId: string, route: PageRoute<unknown>) => {
    assertOpen(`page route "${route.name}"`)
    if (!ROUTE_NAME.test(route.name)) throw new Error(`Invalid page route name "${route.name}"`)
    if (typeof route.component !== 'function') {
      throw new TypeError(`Page "${route.name}" needs a component`)
    }
    const key = `${pluginId}.${route.name}`
    const override = options.routes?.[key]
    if (override !== undefined) {
      const expected = paramNames(parsePattern(route.path)).sort().join(',')
      const actual = paramNames(parsePattern(override)).sort().join(',')
      if (expected !== actual) {
        throw new Error(`Override for "${key}" must use parameters [${expected}], got [${actual}]`)
      }
      overridesUsed.add(key)
    }
    const path = override ?? route.path
    if (RESERVED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      throw new Error(`Page "${key}" cannot use reserved path "${path}"`)
    }
    stores.pages.add(key, path, { pluginId, route })
  }

  const registerApi = (pluginId: string, route: ApiRoute) => {
    assertOpen(`API route ${route.method} ${route.path}`)
    if (!HTTP_METHODS.includes(route.method)) {
      throw new Error(`Unsupported method "${route.method}"`)
    }
    if (typeof route.handler !== 'function') {
      throw new TypeError(`API route ${route.path} needs a handler`)
    }
    stores.apis.add(
      `${pluginId} ${route.method} ${route.path}`,
      apiPath(pluginId, route.path),
      { pluginId, method: route.method, handler: route.handler },
      route.method,
    )
  }

  const registerAdminPage = (pluginId: string, page: AdminPage<unknown>) => {
    assertOpen(`admin page "${page.name}"`)
    if (!ROUTE_NAME.test(page.name)) throw new Error(`Invalid admin page name "${page.name}"`)
    if (typeof page.component !== 'function') {
      throw new TypeError(`Admin page "${page.name}" needs a component`)
    }
    const key = `${pluginId}.${page.name}`
    const path = adminPath(pluginId, page.path)
    if (page.menu && paramNames(parsePattern(path)).length > 0) {
      throw new Error(`Admin page "${key}" has parameters, so it cannot be in the menu`)
    }
    stores.adminPages.add(key, path, { pluginId, page })
    requiredCapabilities.push({ what: `Admin page "${key}"`, capability: page.capability })
    if (page.menu) {
      stores.menu.add({ ...page.menu, key, pluginId, url: path, capability: page.capability })
    }
  }

  const registerSettingsPage = (pluginId: string, page: SettingsPage) => {
    const path = adminPath(pluginId, page.path)
    if (paramNames(parsePattern(path)).length > 0) {
      throw new Error(`Settings page "${pluginId}.${page.name}" cannot have parameters`)
    }
    const entry = stores.settingsLayout.page(pluginId, page, path)
    stores.adminPages.add(entry.key, path, { pluginId, settingsPage: entry.key })
    requiredCapabilities.push({
      what: `Settings page "${entry.key}"`,
      capability: entry.capability,
    })
  }

  const registerAction = (pluginId: string, action: InternalAction) => {
    assertOpen(`admin action "${action.name}"`)
    if (!ROUTE_NAME.test(action.name)) throw new Error(`Invalid admin action name "${action.name}"`)
    if (typeof action.handler !== 'function') {
      throw new TypeError(`Admin action "${action.name}" needs a handler`)
    }
    const path = `/actions/${action.name}`
    stores.apis.add(
      `${pluginId} POST ${path}`,
      apiPath(pluginId, path),
      {
        pluginId,
        method: 'POST',
        handler: createActionHandler(action, {
          pluginId,
          userForSession: (token) => auth.userForSession(token),
          can: (user, capability) => stores.capabilities.can(user, capability),
          flash: prepared.flash,
          logger: withContext(logger, { plugin: pluginId }),
          allowedOrigins: options.allowedOrigins ?? [],
          siteUrl: () => values['site.url'],
        }),
      },
      'POST',
    )
  }

  // A trial boot's warnings repeat the running kernel's; its errors are the point of the trial.
  const trialOptions: KernelOptions = {
    ...options,
    strict: false,
    onChange: undefined,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message, context) => logger.error(message, context),
    },
  }

  const changed = async () => {
    await bumpGeneration(db.root)
    options.onChange?.()
  }

  registerCoreCapabilities(stores.capabilities)
  const actions = coreActions({
    auth,
    async activate(id) {
      if (options.active) throw new ActionError(PINNED)
      const plugin = installed.get(id)
      if (!plugin) throw new ActionError('That plugin is not installed.')
      const name = displayName(plugin, id)
      const current = await loadActiveIds(db.root, options.plugins)
      if (current.includes(id)) return `${name} is already active.`
      const blockers = activationBlockers(plugin, installed, new Set(current), coreVersion)
      if (blockers.length > 0) throw new ActionError(blockers.join(' '))

      // Boot once with it switched on, as WordPress does, so a fatal error never reaches visitors.
      const trial = await createKernel({ ...trialOptions, active: [...current, id] })
      if (!trial.isActive(id)) {
        const reason = trial.skipped.find((entry) => entry.id === id)?.reason ?? 'it did not load'
        throw new ActionError(`${name} could not be activated. ${reason}`)
      }
      await saveActive(db.root, id, true)
      await changed()
      return `${name} activated.`
    },
    async deactivate(id) {
      if (options.active) throw new ActionError(PINNED)
      const name = displayName(installed.get(id), id)
      const current = new Set(await loadActiveIds(db.root, options.plugins))
      if (!current.has(id)) return `${name} is already inactive.`
      const blockers = deactivationBlockers(id, options.plugins, current)
      if (blockers.length > 0) throw new ActionError(blockers.join(' '))
      await saveActive(db.root, id, false)
      await changed()
      return `${name} deactivated.`
    },
    async saveSettings(key, user, form) {
      const page = settingsPages.get(key)
      if (!page) throw new ActionError('That settings page does not exist.')
      if (!stores.capabilities.can(user, page.capability)) throw new ForbiddenError()
      const updates = pageUpdates(page, settingsByKey, form)
      await trialSettings(updates)
      await saveSettings(db.root, updates)
      await changed()
    },
  })
  for (const action of actions) registerAction(CORE, action)

  /** These plugins and, transitively, the active plugins they require or optionally use. */
  const withDependencies = (ids: Iterable<string>): string[] => {
    const needed = new Set<string>()
    const visit = (id: string) => {
      if (needed.has(id) || !activeSet.has(id)) return
      needed.add(id)
      const { requires, optional } = installed.get(id)!
      for (const dependency of Object.keys({ ...requires, ...optional })) visit(dependency)
    }
    for (const id of ids) visit(id)
    return resolution.order.map((plugin) => plugin.id).filter((id) => needed.has(id))
  }

  /**
   * Boots the plugins that read a changed setting while starting, with the new values, so a value
   * a plugin rejects at startup never reaches visitors. Field validation can't catch these: they
   * depend on other values or on what the plugin does with them. Plugins that didn't read the
   * setting can't fail on it, so they stay out and a save costs what it touches, not every plugin.
   */
  const trialSettings = async (updates: ReadonlyMap<string, SettingValue | undefined>) => {
    const read = [...updates.keys()].filter((key) => {
      const setting = settingsByKey.get(key)!
      const fallback = setting.definition.type === 'secret' ? undefined : setting.definition.default
      return startupReaders.has(key) && (updates.get(key) ?? fallback) !== setting.value
    })
    if (read.length === 0) return
    const readers = read.flatMap((key) => [...startupReaders.get(key)!])
    // The owners declare the settings, so their values resolve in the trial.
    const owners = read.map((key) => settingsByKey.get(key)!.pluginId)
    const stored = new Map(await loadStoredSettings(db.root))
    for (const [key, value] of updates) {
      if (value === undefined) stored.delete(key)
      else stored.set(key, value)
    }
    const trial = await startKernel(
      { ...trialOptions, active: withDependencies([...readers, ...owners]) },
      { stored },
    )
    const broken = trial.skipped.filter((plugin) => activeSet.has(plugin.id))
    if (broken.length > 0) {
      const names = broken.map((plugin) => displayName(installed.get(plugin.id), plugin.id))
      throw new ActionError(
        `Settings not saved: ${names.join(', ')} could not start with them. ${broken[0]!.reason}`,
      )
    }
  }
  registerCoreSettings(stores.settingsLayout)

  const hooksFor = (pluginId: string): HooksApi => ({
    addFilter: (name, handler, opts) =>
      stores.hooks.addFilter(pluginId, name, handler, opts?.priority),
    applyFilters: (name, value, context) => stores.hooks.applyFilters(name, value, context),
    addAction: (name, handler, opts) =>
      stores.hooks.addAction(pluginId, name, handler, opts?.priority),
    doAction: (name, payload) => stores.hooks.doAction(name, payload),
  })

  const contextFor = (plugin: PluginDefinition): PluginContext => {
    const declared = new Set([
      ...Object.keys(plugin.requires ?? {}),
      ...Object.keys(plugin.optional ?? {}),
    ])
    const available = resolution.available.get(plugin.id) ?? new Set<string>()
    return {
      plugin: { id: plugin.id, version: plugin.version },
      hooks: hooksFor(plugin.id),
      registries: {
        define: (name) => {
          stores.registries.define(plugin.id, name)
          return stores.registries.view(plugin.id, name)
        },
        get: (name) => stores.registries.view(plugin.id, name),
      },
      services: {
        provide: (name, service) => stores.services.provide(plugin.id, name, service),
        get: (name) => stores.services.get(name) as never,
      },
      routes: {
        page: (route) => registerPage(plugin.id, route as PageRoute<unknown>),
        api: (route) => registerApi(plugin.id, route),
        url: (name, params) => stores.pages.url(name, params),
        apiUrl: (path) => apiPath(plugin.id, path),
      },
      slots: {
        fill: (name, fill) =>
          stores.slots.fill(plugin.id, name, fill.component as SlotComponent, fill.priority),
        get: (name) => stores.slots.get(name).map((fill) => fill.component) as never,
      },
      settings: {
        get: (key) => {
          if (settingUp !== undefined) {
            const readers = startupReaders.get(key) ?? new Set()
            startupReaders.set(key, readers.add(settingUp))
          }
          return values[key]
        },
      },
      auth: {
        role: (id, definition) => stores.capabilities.role(plugin.id, id, definition),
        capability: (name, definition) =>
          stores.capabilities.capability(plugin.id, name, definition),
        grant: (role, capabilities) => stores.capabilities.grant(plugin.id, role, capabilities),
        revoke: (role, capabilities) => stores.capabilities.revoke(plugin.id, role, capabilities),
        metaCapability: (name, definition) =>
          stores.capabilities.metaCapability(plugin.id, name, definition as never),
        extendCapability: (name, extension) =>
          stores.capabilities.extendCapability(plugin.id, name, extension as never),
        can: (user, capability, ...args) => stores.capabilities.can(user, capability, ...args),
      },
      admin: {
        page: (page) => registerAdminPage(plugin.id, page as AdminPage<unknown>),
        settingsPage: (page) => registerSettingsPage(plugin.id, page),
        settingsSection: (section) => stores.settingsLayout.section(plugin.id, section),
        settingsFields: (fields) => stores.settingsLayout.fields(plugin.id, fields),
        action: (action) => {
          requiredCapabilities.push({
            what: `Admin action "${plugin.id}.${action.name}"`,
            capability: action.capability,
          })
          registerAction(plugin.id, {
            name: action.name,
            capability: action.capability,
            // A capability is always set, so the wrapper has already required a signed-in user.
            handler: ({ user, form }) => action.handler({ user: user!, form }),
          })
        },
        url: (name, params) => stores.adminPages.url(name, params),
        actionUrl: (name) => actionPath(plugin.id, name),
      },
      logger: withContext(logger, { plugin: plugin.id }),
      get db() {
        return db.current
      },
      transaction: (fn) => db.transaction(fn),
      when: async (pluginId, fn) => {
        if (!declared.has(pluginId)) {
          throw new Error(
            `Plugin "${plugin.id}" called when("${pluginId}") without declaring it in requires or optional`,
          )
        }
        if (available.has(pluginId)) await fn()
      },
      isActive: (pluginId) => activeSet.has(pluginId),
    }
  }

  for (const plugin of resolution.order) {
    // Setups run one at a time, so a read through another plugin's service counts as this one's.
    settingUp = plugin.id
    try {
      await plugin.setup?.(contextFor(plugin))
    } catch (error) {
      throw new PluginBootError(plugin.id, 'setup', error)
    }
  }
  settingUp = undefined
  sealed = true
  stores.capabilities.seal()
  const label = (pluginId: string) => displayName(installed.get(pluginId), pluginId)
  const layout = stores.settingsLayout.resolve({
    isActive: (pluginId) => activeSet.has(pluginId),
    label,
    automaticUrl: (pluginId) => adminPath(pluginId, '/settings'),
  })
  for (const page of layout.pages) {
    if (page.automatic) {
      try {
        stores.adminPages.add(page.key, page.url, {
          pluginId: page.pluginId,
          settingsPage: page.key,
        })
      } catch (error) {
        throw new PluginBootError(page.pluginId, 'setup', error)
      }
    }
    stores.menu.add({
      ...page.menu,
      key: page.key,
      pluginId: page.pluginId,
      url: page.url,
      capability: page.capability,
    })
  }
  settingsPages = new Map(layout.pages.map((page) => [page.key, page]))
  const menuWarnings = stores.menu.seal({
    active: resolution.order.map((plugin) => plugin.id),
    installed: new Set(installed.keys()),
    label,
    icon: (pluginId) => installed.get(pluginId)?.icon ?? 'admin',
  })

  const registrationWarnings = [
    ...unusedOverrideWarnings(options.routes, overridesUsed),
    ...layout.warnings,
    ...menuWarnings,
    ...requiredCapabilities
      .filter(({ capability }) => !stores.capabilities.isDefined(capability))
      .map(
        ({ what, capability }) =>
          `${what} requires undeclared capability "${capability}"; only administrators can use it`,
      ),
  ]
  for (const warning of registrationWarnings) logger.warn(warning)
  const warnings = [...resolution.warnings, ...settings.warnings, ...registrationWarnings]

  return buildKernel({
    coreVersion,
    prepared,
    resolution,
    skipped,
    warnings,
    stores,
    values,
    settingsByKey,
    settingsPages,
    installed,
    auth,
  })
}

function unusedOverrideWarnings(
  routes: KernelOptions['routes'],
  used: ReadonlySet<string>,
): string[] {
  return Object.keys(routes ?? {})
    .filter((key) => !used.has(key))
    .map((key) => `Route override "${key}" does not match any registered page route`)
}

function buildKernel(input: {
  coreVersion: string
  prepared: Prepared
  resolution: Resolution
  skipped: SkippedPlugin[]
  warnings: string[]
  stores: {
    hooks: HookBus
    registries: RegistryStore
    services: ServiceStore
    slots: SlotStore
    capabilities: CapabilityStore
    pages: Router<PageEntry>
    apis: Router<ApiEntry>
    adminPages: Router<AdminPageEntry>
    menu: AdminMenu
  }
  values: SettingsValues
  settingsByKey: ReadonlyMap<string, ResolvedSetting>
  settingsPages: ReadonlyMap<string, ResolvedSettingsPage>
  installed: ReadonlyMap<string, PluginDefinition>
  auth: AuthService
}): Kernel {
  const { prepared, stores, values, installed } = input
  const { options, logger, db } = prepared
  const active = input.resolution.order.map((plugin) => plugin.id)
  const activeSet = new Set(active)
  const configured = new Set(prepared.configured)
  const capabilities = stores.capabilities

  const settingsPage = (key: string, user: User): SettingsResolution => {
    const page = input.settingsPages.get(key)
    if (!page) return { kind: 'not-found' }
    if (!capabilities.can(user, 'core.access_admin') || !capabilities.can(user, page.capability)) {
      return { kind: 'forbidden' }
    }
    return { kind: 'settings', key, title: page.title, view: pageView(page, input.settingsByKey) }
  }

  return {
    coreVersion: input.coreVersion,
    active,
    skipped: input.skipped,
    warnings: input.warnings,
    generation: prepared.generation,
    activation: options.active ? 'pinned' : 'database',
    get db() {
      return db.current
    },
    isCurrent: async () => (await readGeneration(db.root)) === prepared.generation,
    isActive: (pluginId) => activeSet.has(pluginId),
    transaction: (fn) => db.transaction(fn),
    applyFilters: (name, value, context) => stores.hooks.applyFilters(name, value, context),
    doAction: (name, payload) => stores.hooks.doAction(name, payload),
    service: (name) => stores.services.get(name) as never,
    registry: (name) => stores.registries.view(APP, name),
    setting: (key) => values[key],
    url: (name, params) => stores.pages.url(name, params),
    async resolvePage(pathname, searchParams = {}) {
      const match = stores.pages.match(pathname)
      if (!match) return null
      const { pluginId, route } = match.route.value
      const context = { params: match.params, searchParams }
      const data = route.load ? await route.load(context) : undefined
      if (data === null) return null
      const props: PageProps<unknown> = { ...context, data }
      return {
        key: match.route.key,
        pluginId,
        props,
        Component: route.component,
        metadata: async () => (route.metadata ? route.metadata(props) : {}),
      }
    },
    slot: (name) => stores.slots.get(name).map((fill) => fill.component) as never,
    handleApi: (request) => dispatchApi(stores.apis, request, logger, options.allowedOrigins ?? []),

    auth: input.auth,
    can: (user, capability, ...args) => capabilities.can(user, capability, ...args),
    roles: () => capabilities.roles(),
    capabilities: () => capabilities.capabilities(),

    plugins: () =>
      options.plugins.map((plugin): PluginStatus => {
        const on = configured.has(plugin.id)
        const status = activeSet.has(plugin.id) ? 'active' : on ? 'failed' : 'inactive'
        return {
          id: plugin.id,
          name: displayName(plugin, plugin.id),
          version: plugin.version,
          description: plugin.description,
          requires: plugin.requires ?? {},
          status,
          reason:
            status === 'failed'
              ? input.skipped.find((entry) => entry.id === plugin.id)?.reason
              : undefined,
          blockers: on
            ? deactivationBlockers(plugin.id, options.plugins, configured)
            : activationBlockers(plugin, installed, configured, input.coreVersion),
        }
      }),

    settingsPage,

    async resolveAdminPage(pathname, searchParams, user) {
      const match = stores.adminPages.match(pathname)
      if (!match) return { kind: 'not-found' }
      const entry = match.route.value
      if ('settingsPage' in entry) return settingsPage(entry.settingsPage, user)
      const { pluginId, page } = entry
      if (
        !capabilities.can(user, 'core.access_admin') ||
        !capabilities.can(user, page.capability)
      ) {
        return { kind: 'forbidden' }
      }
      const context = { params: match.params, searchParams, user }
      let data: unknown
      try {
        data = page.load ? await page.load(context) : undefined
      } catch (error) {
        if (error instanceof ForbiddenError) return { kind: 'forbidden' }
        throw error
      }
      if (data === null) return { kind: 'not-found' }
      const props = { ...context, data }
      return {
        kind: 'page',
        key: match.route.key,
        pluginId,
        title: typeof page.title === 'function' ? page.title(props) : page.title,
        titleAction: page.titleAction?.(props) ?? null,
        props,
        Component: page.component,
      }
    },

    adminMenu: (user) =>
      stores.menu.build(user, (u, capability) => capabilities.can(u, capability)),

    adminUrl: (name, params) => stores.adminPages.url(name, params),
    actionUrl: (pluginId, name) => actionPath(pluginId, name),
    readFlash: (value) => prepared.flash.decode(value),
  }
}
