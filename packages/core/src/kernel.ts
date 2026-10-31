import type {
  ActionName,
  Actions,
  AdminPage,
  ApiRoute,
  CapabilityName,
  Database,
  FilterContext,
  FilterName,
  FilterValue,
  HooksApi,
  Logger,
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
  SettingDefinition,
  SettingName,
  Settings,
  SettingsValues,
  SlotComponent,
  User,
} from '@cms/sdk'
import { ActionError } from '@cms/sdk'
import {
  actionPath,
  adminPath,
  createActionHandler,
  type AdminMenuGroup,
  type AdminPageEntry,
  type AdminResolution,
  type InternalAction,
} from './admin'
import { apiPath, dispatchApi, HTTP_METHODS, type ApiEntry } from './api'
import { createAuthService, type AuthService } from './auth'
import { CapabilityStore, type RoleInfo } from './capabilities'
import { CORE, coreActions, coreDefinition, registerCoreCapabilities } from './core-plugin'
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
  isLocked,
  loadStoredSettings,
  parseFormValue,
  resolveSettings,
  saveSettings,
  type Env,
  type ResolvedSetting,
  type SettingSource,
  type SettingValue,
} from './settings'
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

export interface SettingField {
  key: string
  type: SettingDefinition['type']
  label: string
  description?: string
  options?: readonly { value: string; label: string }[]
  /** Never set for secrets. */
  value?: SettingValue
  /** Secrets only: whether the environment variable is set. */
  configured?: boolean
  source: SettingSource
  locked: boolean
  env?: string
}

export interface SettingsSection {
  id: string
  label: string
  fields: SettingField[]
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
  slot(name: string): SlotComponent[]
  handleApi(request: Request): Promise<Response>

  readonly auth: AuthService
  can(user: User | null, capability: CapabilityName): boolean
  roles(): RoleInfo[]
  plugins(): PluginStatus[]
  settingsSections(): SettingsSection[]
  resolveAdminPage(
    pathname: string,
    searchParams: SearchParams,
    user: User,
  ): Promise<AdminResolution>
  adminMenu(user: User): AdminMenuGroup[]
  adminUrl(name: string, params?: Record<string, string>): string
  actionUrl(pluginId: string, name: string): string
  readFlash(value: string | string[] | undefined): Flash | null
}

interface PageEntry {
  pluginId: string
  route: PageRoute<unknown>
}

interface MenuEntry {
  pluginId: string
  key: string
  label: string
  order: number
  capability: CapabilityName
  sequence: number
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

const ROUTE_NAME = /^[a-z][a-z0-9-]*$/
const RESERVED_PATHS = ['/api', '/_next', '/admin']
const APP = 'app'
const PINNED = 'Plugins are switched on in the site configuration, so they cannot be changed here.'

/**
 * Boots the plugins. If one fails to migrate or set up, the kernel boots again without it (and
 * without anything that requires it), like WordPress recovery mode, unless `strict` is set.
 */
export async function createKernel(options: KernelOptions): Promise<Kernel> {
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
    stored: await loadStoredSettings(db.root),
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

  let sealed = false
  const assertOpen = (what: string) => {
    if (sealed) throw new Error(`Cannot register ${what} after boot; register it in setup()`)
  }
  const stores = {
    hooks: new HookBus({ logger, isolate: (fn) => db.isolate(fn), assertOpen }),
    registries: new RegistryStore(assertOpen),
    services: new ServiceStore(assertOpen),
    slots: new SlotStore(assertOpen),
    capabilities: new CapabilityStore(assertOpen),
    pages: new Router<PageEntry>(),
    apis: new Router<ApiEntry>(),
    adminPages: new Router<AdminPageEntry>(),
    menu: [] as MenuEntry[],
  }
  const installed = new Map(options.plugins.map((plugin) => [plugin.id, plugin]))
  const activeSet = new Set(resolution.order.map((plugin) => plugin.id))
  const overridesUsed = new Set<string>()
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
      stores.menu.push({
        pluginId,
        key,
        label: page.menu.label,
        order: page.menu.order ?? 10,
        capability: page.capability,
        sequence: stores.menu.length,
      })
    }
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
      const trial = await createKernel({
        ...options,
        active: [...current, id],
        strict: false,
        onChange: undefined,
      })
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
    async saveSettings(section, form) {
      const editable = settings.settings.filter(
        (setting) => setting.pluginId === section && !isLocked(setting),
      )
      if (editable.length === 0) throw new ActionError('There is nothing to save in that section.')
      const updates = new Map<string, SettingValue | undefined>()
      for (const setting of editable) {
        const parsed = parseFormValue(setting.definition, form.get(setting.key))
        if (!parsed.ok) throw new ActionError(`${setting.definition.label}: ${parsed.error}.`)
        updates.set(setting.key, parsed.value)
      }
      await saveSettings(db.root, updates)
      await changed()
    },
  })
  for (const action of actions) registerAction(CORE, action)

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
        fill: (name, fill) => stores.slots.fill(plugin.id, name, fill.component, fill.priority),
      },
      settings: { get: (key) => values[key] },
      auth: {
        role: (id, definition) => stores.capabilities.role(plugin.id, id, definition),
        capability: (name, definition) =>
          stores.capabilities.capability(plugin.id, name, definition),
        can: (user, capability) => stores.capabilities.can(user, capability),
      },
      admin: {
        page: (page) => registerAdminPage(plugin.id, page as AdminPage<unknown>),
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
    try {
      await plugin.setup?.(contextFor(plugin))
    } catch (error) {
      throw new PluginBootError(plugin.id, 'setup', error)
    }
  }
  sealed = true
  stores.capabilities.seal()

  const registrationWarnings = [
    ...unusedOverrideWarnings(options.routes, overridesUsed),
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
    settings: settings.settings,
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
    menu: MenuEntry[]
  }
  values: SettingsValues
  settings: ResolvedSetting[]
  installed: ReadonlyMap<string, PluginDefinition>
  auth: AuthService
}): Kernel {
  const { prepared, stores, values, installed } = input
  const { options, logger, db } = prepared
  const active = input.resolution.order.map((plugin) => plugin.id)
  const activeSet = new Set(active)
  const configured = new Set(prepared.configured)
  const loadOrder = new Map(active.map((id, index) => [id, index]))
  const capabilities = stores.capabilities

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
    slot: (name) => stores.slots.get(name).map((fill) => fill.component),
    handleApi: (request) => dispatchApi(stores.apis, request, logger, options.allowedOrigins ?? []),

    auth: input.auth,
    can: (user, capability) => capabilities.can(user, capability),
    roles: () => capabilities.roles(),

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

    settingsSections: () => {
      const sections = new Map<string, SettingsSection>()
      for (const setting of input.settings) {
        const label =
          setting.pluginId === CORE
            ? (coreDefinition.name ?? CORE)
            : displayName(installed.get(setting.pluginId), setting.pluginId)
        const section = sections.get(setting.pluginId) ?? {
          id: setting.pluginId,
          label,
          fields: [],
        }
        sections.set(setting.pluginId, section)
        section.fields.push(toField(setting))
      }
      return [...sections.values()]
    },

    async resolveAdminPage(pathname, searchParams, user) {
      const match = stores.adminPages.match(pathname)
      if (!match) return { kind: 'not-found' }
      const { pluginId, page } = match.route.value
      if (
        !capabilities.can(user, 'core.access_admin') ||
        !capabilities.can(user, page.capability)
      ) {
        return { kind: 'forbidden' }
      }
      const context = { params: match.params, searchParams, user }
      const data = page.load ? await page.load(context) : undefined
      if (data === null) return { kind: 'not-found' }
      const props = { ...context, data }
      return {
        kind: 'page',
        key: match.route.key,
        pluginId,
        title: typeof page.title === 'function' ? page.title(props) : page.title,
        props,
        Component: page.component,
      }
    },

    adminMenu(user) {
      if (!capabilities.can(user, 'core.access_admin')) return []
      const entries = stores.menu
        .filter((entry) => capabilities.can(user, entry.capability))
        .sort(
          (a, b) =>
            loadOrder.get(a.pluginId)! - loadOrder.get(b.pluginId)! ||
            a.order - b.order ||
            a.sequence - b.sequence,
        )
      const groups = new Map<string, AdminMenuGroup>()
      for (const entry of entries) {
        const group = groups.get(entry.pluginId) ?? {
          pluginId: entry.pluginId,
          label: displayName(installed.get(entry.pluginId), entry.pluginId),
          items: [],
        }
        groups.set(entry.pluginId, group)
        group.items.push({
          key: entry.key,
          label: entry.label,
          url: stores.adminPages.url(entry.key),
        })
      }
      return [...groups.values()]
    },

    adminUrl: (name, params) => stores.adminPages.url(name, params),
    actionUrl: (pluginId, name) => actionPath(pluginId, name),
    readFlash: (value) => prepared.flash.decode(value),
  }
}

function toField(setting: ResolvedSetting): SettingField {
  const { key, definition, value, source } = setting
  const base = {
    key,
    type: definition.type,
    label: definition.label,
    description: definition.description,
    source,
    locked: isLocked(setting),
    env: definition.env,
  }
  if (definition.type === 'secret') return { ...base, configured: value !== undefined }
  return {
    ...base,
    value,
    options: definition.type === 'select' ? definition.options : undefined,
  }
}
