import type { AdminIcon } from './admin-icons'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { ReactNode } from 'react'
import type {
  ActionName,
  EventName,
  Events,
  JobName,
  Jobs,
  Actions,
  CapabilityArgs,
  CapabilityName,
  ContentTypeName,
  EntryMeta,
  EntryMetaKey,
  UserMeta,
  UserMetaKey,
  TaxonomyName,
  FilterContext,
  FilterName,
  FilterValue,
  MetaCapabilityName,
  Registries,
  RegistryName,
  ServiceName,
  Services,
  SettingName,
  Settings,
  SlotName,
  Slots,
} from './index'

/** Works with any Drizzle Postgres driver (node-postgres in production, PGlite in dev and tests). */
export type Database = PgDatabase<PgQueryResultHKT, Record<string, never>>

/** The plugin's logger: each entry carries the plugin's id, and context is logged as data. */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/** How a handler is added to a hook. */
export interface HookOptions {
  /** Lower runs first. Defaults to 10, as in WordPress. */
  priority?: number
}

/** Receives the value and the filter's context, and returns the value (changed or not). */
export type FilterHandler<K extends FilterName> = (
  value: FilterValue<K>,
  context: FilterContext<K>,
) => FilterValue<K> | Promise<FilterValue<K>>

/** Receives the action's payload. Its return value is ignored. */
export type ActionHandler<K extends ActionName> = (payload: Actions[K]) => void | Promise<void>

/** `cms.hooks`: WordPress's actions and filters, typed by the `Actions` and `Filters` interfaces. */
export interface HooksApi {
  /** Adds a handler to a filter, like `add_filter()`. */
  addFilter<K extends FilterName>(name: K, handler: FilterHandler<K>, options?: HookOptions): void
  /**
   * Passes `value` through every handler in priority order, like `apply_filters()`, and returns
   * the result. A handler that throws fails the whole call.
   */
  applyFilters<K extends FilterName>(
    name: K,
    value: FilterValue<K>,
    context: FilterContext<K>,
  ): Promise<FilterValue<K>>
  /** Adds a handler to an action, like `add_action()`. */
  addAction<K extends ActionName>(name: K, handler: ActionHandler<K>, options?: HookOptions): void
  /**
   * Runs every handler. A failing handler is logged and skipped so one broken plugin can't
   * block the others; inside a transaction each handler runs in its own savepoint.
   */
  doAction<K extends ActionName>(name: K, payload: Actions[K]): Promise<void>
}

// ── Registries & services ────────────────────────────────────────────────────

/** What every registry item has: an id, unique within its registry. */
export interface RegistryItem {
  id: string
}

/** A list one plugin owns and others add to, such as Commerce's payment gateways. */
export interface Registry<T extends RegistryItem> {
  /** Adds an item during setup. An id the registry already has throws. */
  add(item: T): void
  get(id: string): T | undefined
  has(id: string): boolean
  /** Items in registration order, which follows plugin load order. */
  list(): T[]
}

/** The registry declared under a name, typed by its item. */
export type RegistryOf<K extends RegistryName> = Registry<Extract<Registries[K], RegistryItem>>

/** `cms.registries`: defines a plugin's own registries and reaches other plugins'. */
export interface RegistriesApi {
  /** Called once by the owning plugin. Other plugins can only add to defined registries. */
  define<K extends RegistryName>(name: K): RegistryOf<K>
  /** A registry another plugin defined. Throws if it isn't defined: require its owner, or use `when()`. */
  get<K extends RegistryName>(name: K): RegistryOf<K>
}

/** `cms.services`: APIs plugins offer one another, typed by the `Services` interface. */
export interface ServicesApi {
  /** Offers this plugin's service under its name. One plugin provides each; a second throws. */
  provide<K extends ServiceName>(name: K, service: Services[K]): void
  /** Another plugin's service. Throws if no active plugin provides it: require it, or use `when()`. */
  get<K extends ServiceName>(name: K): Services[K]
}

/** `cms.settings`: reads any setting, already resolved from code, environment, database and default. */
export interface SettingsApi {
  /** The setting's value, or `undefined` when it has none and no default. */
  get<K extends SettingName>(key: K): Settings[K] | undefined
}

// ── Settings fields ──────────────────────────────────────────────────────────

interface SettingFieldBase {
  label: string
  description?: string
  /**
   * Environment variable that overrides the stored value. The admin shows the field read-only
   * while it is set, as WordPress does for constants in wp-config.php.
   */
  env?: string
}

/** A line of text, trimmed when saved. */
export interface TextSetting extends SettingFieldBase {
  type: 'text'
  default?: string
  /** Defaults to 500. */
  maxLength?: number
  /** Return an error message to reject the (trimmed) value. */
  validate?: (value: string) => string | null
}

/** A checkbox. */
export interface BooleanSetting extends SettingFieldBase {
  type: 'boolean'
  default?: boolean
}

/** A choice from a fixed list. */
export interface SelectSetting extends SettingFieldBase {
  type: 'select'
  options: readonly { value: string; label: string }[]
  default?: string
}

/** Read from the environment only. Secrets are never stored in the database or shown. */
export interface SecretSetting extends SettingFieldBase {
  type: 'secret'
  env: string
}

/**
 * An entry of a content type, by id, chosen from a dropdown of its published entries: WordPress's
 * page pickers, such as Settings › Reading's homepage. Empty means none.
 */
export interface EntrySetting extends SettingFieldBase {
  type: 'entry'
  contentType: ContentTypeName
  default?: string
}

/** One field in a plugin's `settings`. */
export type SettingDefinition =
  TextSetting | BooleanSetting | SelectSetting | SecretSetting | EntrySetting

/** The fields that can hold a value of type `V`: a checkbox for booleans, the rest for strings. */
export type SettingDefinitionFor<V> = [V] extends [boolean]
  ? BooleanSetting
  : [V] extends [string]
    ? TextSetting | SelectSetting | SecretSetting | EntrySetting
    : never

/** Keys must start with the plugin's id, e.g. `commerce.currency`. */
export type SettingDefinitions = {
  readonly [K in SettingName]?: SettingDefinitionFor<Settings[K]>
}

// ── Users & capabilities ─────────────────────────────────────────────────────

/** A signed-in person, as admin pages, actions and capability checks receive them. */
export interface User {
  id: string
  email: string
  name: string
  role: string
}

/** A role's label and the capabilities it starts with, besides `core.read`, which every role has. */
export interface RoleDefinition {
  label: string
  capabilities?: readonly CapabilityName[]
}

/** How a capability shows in the admin, and which roles start with it. */
export interface CapabilityDefinition {
  label: string
  /** Existing roles that get this capability. Administrators have every capability. */
  roles?: readonly string[]
}

/**
 * The primitive capabilities a check requires: the user needs every one. `false` denies everyone,
 * administrators included, like WordPress's `do_not_allow`.
 */
export type RequiredCapabilities = readonly [CapabilityName, ...CapabilityName[]] | false

/** A meta capability's label and how it maps an object to the capabilities it needs. */
export interface MetaCapabilityDefinition<K extends MetaCapabilityName> {
  label: string
  /**
   * Like `map_meta_cap`. Receives the loaded object, not an id, so checks stay synchronous and a
   * list screen can check every row without a query each.
   */
  map: (user: User, ...args: CapabilityArgs<K>) => RequiredCapabilities
}

/** Adjusts another plugin's meta capability, like the `map_meta_cap` filter. */
export type CapabilityExtension<K extends MetaCapabilityName> = (
  required: RequiredCapabilities,
  user: User,
  ...args: CapabilityArgs<K>
) => RequiredCapabilities

/** One way to pass a sign-in step: an app's code, or one sent by email or text message. */
export interface SignInMethod {
  /** Such as `app`, `email` or `sms`: what the step's `send()` and `verify()` are given. */
  id: string
  /** What the screen's "Try another way" calls it, such as "Authenticator app". */
  label: string
  /** What the screen asks for, such as "Enter the 6-digit code from your authenticator app." */
  prompt: string
  /** Whether choosing it sends a code, so the screen offers to send another. */
  sends?: boolean
  /** Whether its codes are digits only, so a phone shows its number keys. */
  numeric?: boolean
}

/** What a sign-in step is told about the sign-in under way. */
export interface SignInContext {
  /** How they proved who they are: their `password`, or an emailed `link` to set a new one. */
  via: 'password' | 'link'
  /**
   * This browser's id, from the cookie it got when a step last remembered it; `null` for one
   * that was never remembered. Keep only a hash of it.
   */
  device: string | null
}

/**
 * A step between proving who you are and being signed in, as a two-factor plugin adds. Core
 * shows the screen, holds the sign-in for ten minutes and counts wrong codes: five in fifteen
 * minutes end it. The step says which ways a person has, sends codes and checks them.
 */
export interface SignInStep {
  /**
   * The ways this person can pass, their default first. None signs them in at once, as without
   * a step: for someone who hasn't set one up, or a browser the step remembers.
   */
  methods(user: User, context: SignInContext): SignInMethod[] | Promise<SignInMethod[]>
  /**
   * Sends the method's code: when the person arrives at the screen with a method that `sends`,
   * and when they ask for another. Throw an `ActionError` to tell them why it couldn't.
   */
  send?(user: User, method: string, context: SignInContext): void | Promise<void>
  /** Whether `code`, as typed with its spaces removed, passes for the method. */
  verify(
    user: User,
    method: string,
    code: string,
    context: SignInContext,
  ): boolean | Promise<boolean>
  /**
   * For how many days the screen offers "Don’t ask again on this device"; 0, or leaving it out,
   * doesn't offer it.
   */
  rememberDays?(user: User): number
  /**
   * The person passed and asked to be remembered: `device` is a new id that only their browser
   * holds, which `methods()` is given as `context.device` from then on.
   */
  remember?(user: User, device: string, days: number): void | Promise<void>
}

/**
 * `cms.auth`: roles, capabilities and checks, as in WordPress. Add and change roles and
 * capabilities in `setup()`, so every part of the site agrees on them; checks work anywhere.
 */
export interface AuthApi {
  /** Adds a role, like WordPress's `add_role()`. */
  role(id: string, definition: RoleDefinition): void
  /** Declares one of this plugin's capabilities. Names start with the plugin's id. */
  capability(name: CapabilityName, definition: CapabilityDefinition): void
  /**
   * Gives any role (including other plugins' roles) these capabilities, like `add_cap()`. Applied
   * once every plugin has set up; a grant to a role no active plugin defines is dropped.
   */
  grant(role: string, capabilities: readonly CapabilityName[]): void
  /** Takes capabilities away from a role, like `remove_cap()`. Applied after every grant. */
  revoke(role: string, capabilities: readonly CapabilityName[]): void
  /** Declares one of this plugin's meta capabilities. Names start with the plugin's id. */
  metaCapability<K extends MetaCapabilityName>(
    name: K,
    definition: MetaCapabilityDefinition<K>,
  ): void
  /** Runs after the owner's `map` (and earlier extensions), in load order. */
  extendCapability<K extends MetaCapabilityName>(name: K, extension: CapabilityExtension<K>): void
  /**
   * Whether `user` may do something, like `current_user_can()`. A meta capability takes the object
   * it's checked against. `null` (signed out) has no capabilities.
   */
  can<C extends CapabilityName | MetaCapabilityName>(
    user: User | null,
    capability: C,
    ...args: CapabilityArgs<C>
  ): boolean
  /**
   * Adds a step between a correct password and being signed in: two-factor's codes. In
   * `setup()` only, by one plugin at most.
   */
  signInStep(step: SignInStep): void
  /**
   * Whether `password` is the user's, like `wp_check_password()`: for a form that asks for it
   * again before a change that matters. Wrong ones count as failed sign-ins do, and past five
   * in fifteen minutes it throws an `ActionError` saying so.
   */
  checkPassword(user: User, password: string): Promise<boolean>
}

// ── Admin ────────────────────────────────────────────────────────────────────

/** A core menu section, or a plugin id to join that plugin's section (`add_submenu_page`). */
export type AdminMenuParent = 'dashboard' | 'plugins' | 'users' | 'settings' | (string & {})

/** Where an admin page shows in the menu. */
export interface AdminMenuPlacement {
  label: string
  /** Lower comes first. Defaults to 10. */
  order?: number
  /**
   * Defaults to this plugin's own section. A plugin id that isn't active falls back to it too,
   * so pages placed under an optional dependency still show.
   */
  parent?: AdminMenuParent
}

/** What an admin page's `load` receives. */
export interface AdminPageContext {
  params: Record<string, string>
  searchParams: SearchParams
  user: User
}

/** What an admin page's `component`, `title` and `titleAction` receive: the context and what `load` returned. */
export interface AdminPageProps<TData> extends AdminPageContext {
  data: TData
}

/**
 * TypeScript infers `TData` from `load`, reading the object left to right: write `load` before
 * `title` and `component`, or their `data` is typed `undefined`.
 */
export interface AdminPage<TData = undefined> {
  /** Unique within the plugin. Addressed globally as `${pluginId}.${name}`. */
  name: string
  /** Mounted under `/admin/{pluginId}`, so `/products` serves `/admin/commerce/products`. */
  path: string
  title: string | ((props: AdminPageProps<TData>) => string)
  capability: CapabilityName
  /** Adds the page to the admin menu. Leave it out for pages reached from others (edit forms). */
  menu?: AdminMenuPlacement
  /** Return `null` to render a 404. */
  load?: (context: AdminPageContext) => TData | null | Promise<TData | null>
  /** A button beside the title, such as "Add Product" on a list (`page-title-action`). */
  titleAction?: (props: AdminPageProps<TData>) => AdminTitleAction | null
  component: (props: AdminPageProps<TData>) => ReactNode | Promise<ReactNode>
}

/** The button beside an admin page's title. */
export interface AdminTitleAction {
  label: string
  url: string
}

/** What an admin action's handler receives: who posted the form, and what it sent. */
export interface AdminActionContext {
  user: User
  form: FormData
}

/** Where an admin action sends the user next, and what it tells them. */
export interface AdminActionResult {
  /** Same-site path to go to next. Defaults to the page that posted the form. */
  redirect?: string
  /** Shown once on the next page. */
  notice?: string
}

/**
 * A form post from the admin. The kernel checks the origin, the session and the capability
 * before the handler runs, and turns the result into a redirect.
 */
export interface AdminAction {
  name: string
  capability: CapabilityName
  handler: (
    context: AdminActionContext,
  ) => AdminActionResult | void | Promise<AdminActionResult | void>
}

/** A settings screen, like `add_options_page()` or a WooCommerce settings tab. */
export interface SettingsPage {
  /** Unique among this plugin's admin pages. Addressed globally as `${pluginId}.${name}`. */
  name: string
  /** Mounted under `/admin/{pluginId}`, like other admin pages. */
  path: string
  title: string
  description?: string
  /** Who may open and save it. Defaults to `core.manage_settings`. */
  capability?: CapabilityName
  /** Listed under Settings with `title` as its label unless this says otherwise. */
  menu?: Partial<AdminMenuPlacement>
}

/** A group of fields on any settings page, including other plugins' (`add_settings_section`). */
export interface SettingsSection {
  /** Unique within the plugin. Addressed globally as `${pluginId}.${name}`. */
  name: string
  /**
   * Qualified page name, such as `core.general` or `commerce.payments`. If that plugin isn't
   * active, the section moves to this plugin's own settings page.
   */
  page: string
  title: string
  description?: string
  /** Lower comes first. Defaults to 10. */
  order?: number
  /** This plugin's own settings, in display order. */
  fields: readonly SettingName[]
}

/** Adds this plugin's settings to another plugin's section (`add_settings_field`). */
export interface SettingsFields {
  /** Qualified section name, such as `core.site`. */
  section: string
  fields: readonly SettingName[]
}

/**
 * `cms.admin`: this plugin's admin pages, form actions and settings screens. Register them in the
 * plugin's admin entry (`defineAdmin`), which only the admin loads; `url()` and `actionUrl()` work
 * anywhere.
 */
export interface AdminApi {
  /** Adds an admin page, like `add_menu_page()` or `add_submenu_page()`. */
  page<TData = undefined>(page: AdminPage<TData>): void
  /** Adds a form action, posted to `actionUrl(name)`. */
  action(action: AdminAction): void
  /**
   * Settings stay declared on the plugin definition; these say where they show. Fields this
   * plugin doesn't place get a section on its first settings page, or on one made for it.
   */
  settingsPage(page: SettingsPage): void
  settingsSection(section: SettingsSection): void
  settingsFields(fields: SettingsFields): void
  /**
   * URL of an admin page. By qualified name, such as `commerce.products`, where the admin is
   * loaded: its screens, and API routes. By path, relative to this plugin's admin pages, such as
   * `/orders/:id`, anywhere, the site included, like WordPress's `admin_url()`.
   */
  url(name: string, params?: Record<string, string>): string
  /** Form `action` URL for one of this plugin's admin actions. */
  actionUrl(name: string): string
  /** Adds a column to content types' list screens. */
  column<TData>(types: ContentTypeSelector, column: ContentColumn<TData>): void
  /** Adds a box to content types' edit screens, like `add_meta_box()`. */
  metaBox(types: ContentTypeSelector, box: ContentMetaBox): void
  /** Adds a link under each entry's title on content types' list screens. */
  rowAction(types: ContentTypeSelector, action: ContentRowAction): void
  /** Adds a choice to content types' Bulk actions. */
  bulkAction(types: ContentTypeSelector, action: ContentBulkAction): void
}

// ── Routes & slots ───────────────────────────────────────────────────────────

/** A URL's query string, as Next.js passes it: repeated keys become arrays. */
export type SearchParams = Record<string, string | string[] | undefined>

/** What a page route's `load` receives: the path's parameters and the query string. */
export interface PageContext {
  params: Record<string, string>
  searchParams: SearchParams
  /**
   * The user signed in with the request's session cookie, or `null`: looked up on the first
   * call, once per request, so a page that never asks costs nothing.
   */
  user(): Promise<User | null>
  /**
   * The signed-in user. A signed-out visitor is sent to sign in, and brought back to this page,
   * query string and all, once they have: WordPress's `auth_redirect()`. Call it in `load`.
   */
  requireUser(): Promise<User>
}

/**
 * What a page route's `component` and `metadata` receive: the context and what `load` returned.
 * Who may see the page is `load`'s to decide, so they get `user()` but not `requireUser()`.
 */
export interface PageProps<TData> extends Omit<PageContext, 'requireUser'> {
  data: TData
}

/** The page's `<title>` and meta description. */
export interface PageMetadata {
  title?: string
  description?: string
}

/**
 * A page on the site, served by the site's catch-all route. TypeScript infers `TData` from `load`:
 * write `load` before `metadata` and `component`.
 */
export interface PageRoute<TData = undefined> {
  /** Unique within the plugin. Addressed globally as `${pluginId}.${name}`. */
  name: string
  /** Default path such as `/product/:slug`. Sites can override it without touching the plugin. */
  path: string
  /**
   * Return `null` to render a 404. Throw `ForbiddenError` for a 403, or `PageRedirect` to send the
   * visitor elsewhere on the site; `context.requireUser()` sends a signed-out one to sign in.
   */
  load?: (context: PageContext) => TData | null | Promise<TData | null>
  metadata?: (props: PageProps<TData>) => PageMetadata | Promise<PageMetadata>
  component: (props: PageProps<TData>) => ReactNode | Promise<ReactNode>
}

/** The methods an API route can answer. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** What an API route's handler receives besides the request. */
export interface ApiContext {
  /** The path's parameters, such as `id` for `/orders/:id`. */
  params: Record<string, string>
  /**
   * The user signed in with the request's session cookie, or `null`, looked up on the first call.
   * Unsafe requests (POST, PUT, PATCH, DELETE) count as signed in only when they carry this site's
   * `Origin`, which browsers send, so another site can't act as the user.
   */
  user(): Promise<User | null>
}

/** Answers an API request with a standard `Response`. */
export type ApiHandler = (request: Request, context: ApiContext) => Response | Promise<Response>

/** An HTTP endpoint for the site's pages, other servers, or scripts. */
export interface ApiRoute {
  method: HttpMethod
  /** Mounted under `/api/p/{pluginId}`. */
  path: string
  handler: ApiHandler
}

/** `cms.routes`: this plugin's pages on the site and its API endpoints. */
export interface RoutesApi {
  /** Adds a page to the site. */
  page<TData = undefined>(route: PageRoute<TData>): void
  /** Adds an API endpoint under `/api/p/{pluginId}`. */
  api(route: ApiRoute): void
  /** Builds the public URL of any page route by its qualified name, honouring site overrides. */
  url(name: string, params?: Record<string, string>): string
  /** Public URL of one of this plugin's API routes. */
  apiUrl(path: string): string
  /**
   * Where to sign in, and come back to `returnTo` (a path on this site) afterwards, like
   * `wp_login_url()`: for a "Sign in to save" link. Without it, the account page.
   */
  signInUrl(returnTo?: string): string
}

/** A component that fills a slot: it receives the slot's props. */
export type SlotComponent<K extends SlotName = SlotName> = (
  props: Slots[K],
) => ReactNode | Promise<ReactNode>

/** `cms.slots`: renders components in other plugins' slots, and reads the fills of this plugin's own. */
export interface SlotsApi {
  /**
   * Renders `component` wherever the slot is shown. Lower `priority` comes first; defaults to 10.
   * Fill admin slots (`admin.*`, and plugins' `*.admin.*`) in the admin entry, the site's in
   * `setup()`.
   */
  fill<K extends SlotName>(name: K, fill: { component: SlotComponent<K>; priority?: number }): void
  /**
   * The fills for a slot, in priority order, for plugins that offer a slot on their own screens.
   * Call it while rendering: fills from plugins loaded later aren't registered during setup.
   */
  get<K extends SlotName>(name: K): SlotComponent<K>[]
}

// ── Content ──────────────────────────────────────────────────────────────────

/**
 * Where an entry stands, like WordPress's post statuses. Only `published` entries are public;
 * `private` ones are published for those who may read private entries of their type. A
 * `scheduled` entry, WordPress's `future`, is published by the site when its `publishedAt` comes.
 */
export type EntryStatus = 'draft' | 'pending' | 'scheduled' | 'published' | 'private' | 'trash'

/** A piece of an entry's body, such as a paragraph. The editor's block types come with the editor. */
export interface Block {
  type: string
  [property: string]: unknown
}

/** An entry of any content type: a post, a page, a course. WordPress's `WP_Post`. */
export interface Entry {
  id: string
  /** Its content type's qualified name, such as `core.post`. */
  type: string
  status: EntryStatus
  /**
   * Its address among its type's entries. Published, private and scheduled entries own theirs:
   * no other such entry of the type (with the same parent, for hierarchical types) has it. Empty
   * on a draft until it's set or the entry is published or scheduled, when it's made from the
   * title.
   */
  slug: string
  title: string
  /** Rendered by React components, so stored content can't add markup of its own. */
  body: Block[]
  excerpt: string
  /** `null` once the author's account is gone. */
  authorId: string | null
  /** Another entry of the same type, for hierarchical types such as pages. */
  parentId: string | null
  /** Sorts entries by hand, like WordPress's `menu_order`. Lower comes first. */
  position: number
  /**
   * Its featured image, an image in the media library, for types with the `thumbnail` feature:
   * WordPress's `_thumbnail_id`. `null` once the image is deleted.
   */
  thumbnailId: string | null
  /**
   * When it was first published, or published privately; for a `scheduled` entry, when it will
   * be.
   */
  publishedAt: Date | null
  createdAt: Date
  updatedAt: Date
  /** In the trash: the status it had, which capability checks still go by. */
  trashedFrom: Exclude<EntryStatus, 'trash'> | null
  trashedAt: Date | null
  /**
   * Its custom fields, typed by the `EntryMeta` interface. A registered field it has no value for
   * shows its default. Values a deactivated plugin's fields hold are kept.
   */
  meta: EntryMetaValues
}

/** An entry's custom fields by key, as `EntryMeta` declares them. */
export type EntryMetaValues = { [K in EntryMetaKey]?: EntryMeta[K] }

/** Custom fields to change: a value sets the field, `null` removes it. */
export type EntryMetaChanges = { [K in EntryMetaKey]?: EntryMeta[K] | null }

/** What an entry is saved with. The `content.entry` filter receives and returns it. */
export interface EntryFields {
  /**
   * Entries go to the trash with `trash()`, not through a status. As in WordPress, `published`
   * with a `publishedAt` a minute or more ahead is saved as `scheduled`, and `scheduled` with a
   * date that has come as `published`.
   */
  status: Exclude<EntryStatus, 'trash'>
  slug: string
  title: string
  body: Block[]
  excerpt: string
  authorId: string | null
  parentId: string | null
  position: number
  /** An image's id, for types with the `thumbnail` feature. */
  thumbnailId: string | null
  /**
   * Set when the entry is first published. Set it to backdate one, or to a time ahead to
   * schedule it: the site publishes it then.
   */
  publishedAt: Date | null
  /** Every custom field the entry will have, defaults left out. */
  meta: EntryMetaValues
}

/**
 * A new entry's fields. All optional: an entry starts as an untitled draft with no author. Its
 * custom fields must be registered for its type.
 */
export type NewEntry = Partial<Omit<EntryFields, 'meta'>> & { meta?: EntryMetaChanges }

/** The fields to change. Those left out keep their values; `meta` changes only the keys named. */
export type EntryChanges = Partial<Omit<EntryFields, 'meta'>> & { meta?: EntryMetaChanges }

/** How a save is recorded. */
export interface SaveOptions {
  /** Who made the change: the user its revision names. */
  by?: string | null
}

/**
 * An entry as one save left it, like WordPress's revisions: what the author wrote, not its
 * status or place. The newest is the entry as it is.
 */
export interface Revision {
  id: string
  entryId: string
  /** Who saved it, when known. */
  authorId: string | null
  title: string
  body: Block[]
  excerpt: string
  meta: EntryMetaValues
  createdAt: Date
}

/** Which entries `list()` returns, and in what order. */
export interface EntryQuery {
  type: ContentTypeName | readonly ContentTypeName[]
  /** Defaults to every status but `trash`. */
  status?: EntryStatus | readonly EntryStatus[]
  authorId?: string
  /** `null` for top-level entries only. */
  parentId?: string | null
  /** Only these entries, like WordPress's `post__in`. */
  ids?: readonly string[]
  /**
   * Entries with any of these terms in each taxonomy named, like a `tax_query`. Hierarchical
   * taxonomies include the terms' descendants, as WordPress's category queries do.
   */
  terms?: Partial<Record<TaxonomyName, readonly string[]>>
  /**
   * Entries whose custom fields have these values, like a `meta_query` with `=`; the index
   * answers it. An entry without the field doesn't match, even if its default would.
   */
  meta?: EntryMetaValues
  /** Words in the title, excerpt or body, like WordPress's `s`. Letters' case doesn't matter. */
  search?: string
  /** Dated (as `orderBy: 'date'` dates them) at or after this. */
  after?: Date
  /** Dated before this. */
  before?: Date
  /**
   * `date` (the default) is when the entry was published, or created if it never was, like
   * WordPress's post date. `updated` is when it last changed. `tree`, for hierarchical types,
   * lists parents before their children, siblings by position and title, as WordPress lists
   * pages; `depths` then says how deep each entry is.
   */
  orderBy?: 'date' | 'updated' | 'title' | 'position' | 'tree'
  /** Defaults to newest first for dates, A to Z for `title`, lowest first for `position`. */
  order?: 'asc' | 'desc'
  /** 1 to 100. Defaults to 20. */
  limit?: number
  offset?: number
}

/** A page of entries, and how many match the query in all. */
export interface EntryList {
  entries: Entry[]
  total: number
  /** With `orderBy: 'tree'`: each entry's number of ancestors, in the same order. */
  depths?: number[]
}

/** A term of a taxonomy: a category, a tag, a course topic. WordPress's `WP_Term`. */
export interface Term {
  id: string
  /** Its taxonomy's qualified name, such as `core.category`. */
  taxonomy: string
  name: string
  /** Unique in its taxonomy. */
  slug: string
  description: string
  /** Another term of the same taxonomy, for hierarchical taxonomies. */
  parentId: string | null
  createdAt: Date
  updatedAt: Date
}

/** A new term: a name, and optionally the rest. The slug is made from the name if not given. */
export interface NewTerm {
  name: string
  slug?: string
  description?: string
  parentId?: string | null
}

/** Which terms `listTerms()` returns. */
export interface TermQuery {
  taxonomy: TaxonomyName
  /** `null` for top-level terms only. */
  parentId?: string | null
  ids?: readonly string[]
  /** Words in the name, slug or description. */
  search?: string
  /** Only terms with published entries. */
  hideEmpty?: boolean
  /**
   * `name` (the default), or `count` of published entries. `tree`, for hierarchical taxonomies,
   * lists parents before their children, as the Categories screen does; `depths` then says how
   * deep each term is.
   */
  orderBy?: 'name' | 'count' | 'tree'
  /** Defaults to A to Z for names, most first for counts. */
  order?: 'asc' | 'desc'
  /** 1 to 1000. Defaults to 100. */
  limit?: number
  offset?: number
}

/** A page of terms, each with its count of published entries, as WordPress counts them. */
export interface TermList {
  terms: Term[]
  /** Published entries with each term, in the same order. */
  counts: number[]
  total: number
  /** With `orderBy: 'tree'`: each term's number of ancestors. */
  depths?: number[]
}

/** A month that has entries, for a filter such as WordPress's "All dates". */
export interface EntryMonth {
  year: number
  /** 1 to 12. */
  month: number
}

/**
 * The capabilities a role gets over a content type, named after WordPress's roles:
 * - `editor`: every entry of the type, anyone's;
 * - `author`: their own entries, publishing included;
 * - `contributor`: their own drafts, which someone else publishes.
 */
export type ContentRoleLevel = 'editor' | 'author' | 'contributor'

/** What a content type's entries use, like WordPress's `supports`; the edit screen shows these. */
export type ContentFeature =
  'title' | 'body' | 'excerpt' | 'author' | 'position' | 'revisions' | 'thumbnail'

/** A content type, as `cms.content.type()` takes it: WordPress's `register_post_type()` arguments. */
export interface ContentTypeDefinition {
  labels: {
    /** Such as `Course`. */
    singular: string
    /** Such as `Courses`. */
    plural: string
  }
  /**
   * The plural in its capability names, such as `lms.edit_courses`. Defaults to the name and an
   * `s`; set it for others (`person` → `people`), with the same `plural` in `ContentTypes`.
   */
  plural?: string
  description?: string
  /** Its published entries have pages on the site. Defaults to `false`. */
  public?: boolean
  /** Entries can have a parent of the same type, as pages do. Defaults to `false`. */
  hierarchical?: boolean
  /** Defaults to `['title', 'body']`, as in WordPress. */
  supports?: readonly ContentFeature[]
  /** It has list and edit screens in the admin. Defaults to `public`, as WordPress's `show_ui`. */
  showUi?: boolean
  /**
   * Its screens are in the admin menu: Posts and Pages in their own sections, a plugin's types in
   * the plugin's section. Defaults to `showUi`.
   */
  showInMenu?: boolean
  /**
   * Its published entries are listed at an archive page, `/{plural}`, like WordPress's
   * `has_archive`. Defaults to `false`. Posts are listed on the home page or the posts page.
   */
  hasArchive?: boolean
  /**
   * With the `revisions` feature: how many revisions each entry keeps, the oldest going first.
   * Defaults to 25. WordPress keeps every one unless told otherwise.
   */
  revisions?: number
  /**
   * Which roles get its capabilities, and at what level. Defaults to WordPress's, as for posts:
   * `{ editor: 'editor', author: 'author', contributor: 'contributor' }`. Administrators have
   * every capability. Like other grants, nothing is stored: they go when the plugin does.
   */
  roles?: Readonly<Record<string, ContentRoleLevel>>
}

/**
 * The capabilities a content type declares, like WordPress's `$post_type->cap`. The primitive
 * ones belong to roles; the meta ones take an entry and say which primitives it needs.
 */
export interface ContentTypeCapabilities {
  /** Write entries, and edit and delete their own drafts. WordPress's `edit_posts`, which `create_posts` maps to. */
  edit: CapabilityName
  editOthers: CapabilityName
  editPublished: CapabilityName
  editPrivate: CapabilityName
  publish: CapabilityName
  readPrivate: CapabilityName
  delete: CapabilityName
  deleteOthers: CapabilityName
  deletePublished: CapabilityName
  deletePrivate: CapabilityName
  /** `can(user, cap.editEntry, entry)`: WordPress's `edit_post`. */
  editEntry: MetaCapabilityName
  /** WordPress's `read_post`: published entries need only `core.read`, which every role has. */
  readEntry: MetaCapabilityName
  /** WordPress's `delete_post`. */
  deleteEntry: MetaCapabilityName
  /** WordPress's `publish_post`. */
  publishEntry: MetaCapabilityName
}

/** A taxonomy, as `cms.content.taxonomy()` takes it: WordPress's `register_taxonomy()` arguments. */
export interface TaxonomyDefinition {
  labels: {
    /** Such as `Topic`. */
    singular: string
    /** Such as `Topics`. */
    plural: string
  }
  /** The plural in its capability names; as for content types. Defaults to the name and an `s`. */
  plural?: string
  /** The content types it classifies. Those no active plugin registers are left out. */
  types: readonly ContentTypeName[]
  description?: string
  /** Terms have parents, as categories do; otherwise they're flat, as tags are. */
  hierarchical?: boolean
  /** Its terms have pages on the site. Defaults to `true`, as in WordPress. */
  public?: boolean
  /** It has a screen in the admin, and boxes on its types' edit screens. Defaults to `public`. */
  showUi?: boolean
  /** A column for it on its types' list screens. Defaults to `false`, as in WordPress. */
  showAdminColumn?: boolean
  /**
   * The term an entry gets when it has none of this taxonomy's, such as "Uncategorized". It's
   * created when first needed and can't be deleted.
   */
  defaultTerm?: { name: string; slug?: string; description?: string }
  /**
   * Which roles get its capabilities: `editor` gets all four; `author` and `contributor` may
   * assign terms. Defaults to `{ editor: 'editor', author: 'author', contributor: 'contributor' }`.
   */
  roles?: Readonly<Record<string, ContentRoleLevel>>
}

/** The capabilities a taxonomy declares, like WordPress's `$taxonomy->cap`. */
export interface TaxonomyCapabilities {
  /** Open its screen. WordPress's `manage_terms`. */
  manage: CapabilityName
  /** Add and change terms. */
  edit: CapabilityName
  delete: CapabilityName
  /** Give entries its terms, and add flat taxonomies' terms by name while doing so. */
  assign: CapabilityName
  /** `can(user, caps.editTerm, term)`: WordPress's `edit_term`. */
  editTerm: MetaCapabilityName
  /** WordPress's `delete_term`; the default term can't be deleted. */
  deleteTerm: MetaCapabilityName
  /** WordPress's `assign_term`. */
  assignTerm: MetaCapabilityName
}

/** A registered taxonomy. */
export interface Taxonomy {
  /** Qualified, such as `core.category`. */
  name: TaxonomyName
  pluginId: string
  labels: TaxonomyDefinition['labels']
  description: string
  types: readonly ContentTypeName[]
  hierarchical: boolean
  public: boolean
  showUi: boolean
  showAdminColumn: boolean
  /** The default term's name and slug. */
  defaultTerm: { name: string; slug: string; description: string } | null
  /** Its screen, such as `/admin/posts/categories`, under its first type with screens. */
  adminPath: string | null
  capabilities: TaxonomyCapabilities
}

/** A registered content type. */
export interface ContentType {
  /** Qualified, such as `lms.course`. */
  name: ContentTypeName
  pluginId: string
  /** The plural in its capability names and its archive's address, such as `courses`. */
  plural: string
  labels: ContentTypeDefinition['labels']
  description: string
  public: boolean
  hierarchical: boolean
  supports: readonly ContentFeature[]
  showUi: boolean
  showInMenu: boolean
  hasArchive: boolean
  /** How many revisions each entry keeps; 0 without the `revisions` feature. */
  revisions: number
  /**
   * Its list screen, such as `/admin/posts` or `/admin/lms/courses`, when it has screens. Add New
   * is `${adminPath}/new` and an entry's edit screen `${adminPath}/${id}`.
   */
  adminPath: string | null
  capabilities: ContentTypeCapabilities
}

interface MetaDefinitionBase {
  /** The content types with this field: one, several, or `'*'` for all. */
  types: ContentTypeSelector
  label: string
  description?: string
  /**
   * Who may change it on the edit screen, besides being able to edit the entry. The content API
   * itself checks no capabilities, as for every field.
   */
  capability?: CapabilityName
}

/** Text: one line, or several with `multiline`. Control characters go; `options` limit it. */
export interface StringMetaDefinition extends MetaDefinitionBase {
  type: 'string'
  default?: string
  /** Defaults to 10 000. */
  maxLength?: number
  multiline?: boolean
  /** The values allowed, shown as a dropdown. */
  options?: readonly (string | { value: string; label: string })[]
  /** Return an error message to refuse the (tidied) value. */
  validate?: (value: string) => string | null
}

/** A number, whole with `integer`, between `min` and `max`. */
export interface NumberMetaDefinition extends MetaDefinitionBase {
  type: 'number'
  default?: number
  integer?: boolean
  min?: number
  max?: number
}

/** A checkbox. */
export interface BooleanMetaDefinition extends MetaDefinitionBase {
  type: 'boolean'
  default?: boolean
}

/** A list of short texts, WordPress's meta with `single => false`; one per line on the screen. */
export interface StringsMetaDefinition extends MetaDefinitionBase {
  type: 'strings'
  default?: readonly string[]
  /** Defaults to 100. */
  maxItems?: number
  /** Each item's; defaults to 500. */
  maxLength?: number
}

/** Any JSON, which `validate` must accept: for structured values the other types can't hold. */
export interface JsonMetaDefinition<V = unknown> extends MetaDefinitionBase {
  type: 'json'
  default?: V
  validate: (value: unknown) => string | null
}

/** A custom field, as `cms.content.meta()` takes it. */
export type MetaDefinition =
  | StringMetaDefinition
  | NumberMetaDefinition
  | BooleanMetaDefinition
  | StringsMetaDefinition
  | JsonMetaDefinition

/** The definitions that can hold a value of type `V`, as for settings. */
export type MetaDefinitionFor<V> = [V] extends [boolean]
  ? BooleanMetaDefinition
  : [V] extends [number]
    ? NumberMetaDefinition
    : [V] extends [string]
      ? StringMetaDefinition
      : [V] extends [readonly string[]]
        ? StringsMetaDefinition | JsonMetaDefinition<V>
        : JsonMetaDefinition<V>

/** What every template's page shows: the entry or entries, and where they live. */
export interface EntryTemplateProps {
  entry: Entry
  type: ContentType
  /** Its address on the site; `null` for a draft, shown by preview. */
  url: string | null
  author: { id: string; name: string } | null
  /** Its terms in every public taxonomy of its type. */
  terms: Term[]
  termUrl(term: Term): string | null
  /** A draft or other entry shown to someone who may read it, not to visitors. */
  preview: boolean
  /** Its featured image, when its type has them and it has one. */
  thumbnail: MediaItem | null
  /** The images in its body, by id, for `Blocks`; a deleted one is missing, and not shown. */
  media: ReadonlyMap<string, MediaItem>
}

/** A list of entries: a type's archive, the latest posts, or a term's entries. */
export interface ArchiveTemplateProps {
  title: string
  description: string
  /** Whose entries: the type, and for a term's archive, the taxonomy and term. */
  type: ContentType
  taxonomy: Taxonomy | null
  term: Term | null
  /** Each entry with its address and its featured image, all found in one query. */
  items: { entry: Entry; url: string | null; thumbnail: MediaItem | null }[]
  total: number
  /** From 1. */
  page: number
  pages: number
  pageUrl(page: number): string
}

/**
 * Which account page: signing in (and up), a sign-in step's code, the signed-in person's
 * account, asking for a reset link, setting a password from one, and confirming a new email
 * address.
 */
export type AccountView =
  'sign-in' | 'verify' | 'account' | 'lost-password' | 'reset' | 'confirm-email'

/** What the `verify` view shows: the sign-in a step is holding until a code passes. */
export interface AccountSignInStep {
  /** The way being asked for: the person's default, or the one they switched to. */
  method: SignInMethod
  /** Every way they have, `method` included, for "Try another way". */
  methods: SignInMethod[]
  /** For how many days "Don’t ask again on this device" lasts; 0 doesn't offer it. */
  rememberDays: number
}

/** What the account pages' template receives: WooCommerce's My Account, by view. */
export interface AccountTemplateProps {
  view: AccountView
  /** The signed-in person; `null` signed out. */
  user: User | null
  /** Whether they've proved their address, by using a link sent to it. */
  verified: boolean
  /** Whether they may use the admin, for a link to it. */
  canUseAdmin: boolean
  /** The fields plugins put on the account page for their role (`onAccount`), and their values. */
  fields: UserMetaField[]
  meta: UserMetaValues
  /** Settings › General's "Anyone can register", with a mail plugin to send the link. */
  canRegister: boolean
  /** On `reset` and `confirm-email`: the link's token, and whether it still works. */
  token: string | null
  valid: boolean
  /** On `confirm-email`: the address being confirmed. */
  newEmail: string | null
  /** The one-time message after a form. */
  notice: { kind: 'notice' | 'error'; message: string } | null
  /** Where to go after signing in, from the `next` query; a path on the site. */
  next: string | null
  /**
   * On `verify`: the sign-in waiting for a code. `null` once it has run out, after ten minutes
   * or too many wrong codes: say so, and link back to `paths.account`.
   */
  signIn: AccountSignInStep | null
  /** Where each form posts. */
  actions: {
    signIn: string
    /** The `verify` view's form: fields `method`, `code` and, ticked, `remember`. */
    verify: string
    /** Sends a code, or switches to another way: a field `method`. */
    sendCode: string
    register: string
    lostPassword: string
    reset: string
    name: string
    password: string
    email: string
    confirmEmail: string
    signOut: string
  }
  /** The pages' addresses. `verify` takes `?method=` to switch to another way. */
  paths: { account: string; lostPassword: string; verify: string }
}

/** Which page a template shows: an entry, a type's archive, or a term's. */
export type ContentView = 'single' | 'archive' | 'term'

/**
 * A plugin's template for its type's or taxonomy's pages, in place of the default, as WordPress's
 * `template_include` lets plugins choose. The highest `priority` wins; a site's own templates
 * (`src/cms/templates.tsx`) win over all.
 */
export type ContentTemplate =
  | {
      view: 'single'
      for: ContentTypeName
      component: (props: EntryTemplateProps) => ReactNode | Promise<ReactNode>
      priority?: number
    }
  | {
      view: 'archive'
      for: ContentTypeName
      component: (props: ArchiveTemplateProps) => ReactNode | Promise<ReactNode>
      priority?: number
    }
  | {
      view: 'term'
      for: TaxonomyName
      component: (props: ArchiveTemplateProps) => ReactNode | Promise<ReactNode>
      priority?: number
    }

/** A registered custom field. */
export interface MetaField {
  /** Such as `lms.level`. */
  key: string
  pluginId: string
  definition: MetaDefinition
}

/** What a content screen's extensions are added to: one type, several, or every type with screens. */
export type ContentTypeSelector = ContentTypeName | readonly ContentTypeName[] | '*'

/**
 * A column on a content type's list screen, like `manage_{$post_type}_posts_columns`. `load` runs
 * once for the page of entries shown, so a column costs one query, not one per row as WordPress's
 * `manage_posts_custom_column` invites.
 */
export interface ContentColumn<TData = unknown> {
  /** Unique within the plugin. */
  name: string
  label: string
  /**
   * The column it follows: `title`, `author`, `date` or another plugin's `pluginId.name`.
   * Defaults to before the date.
   */
  after?: string
  load?: (
    entries: readonly Entry[],
    context: { user: User; type: ContentType },
  ) => TData | Promise<TData>
  render: (entry: Entry, data: TData) => ReactNode
}

/** What a meta box's component receives. `entry` is `null` on Add New, before the first save. */
export interface ContentMetaBoxProps {
  entry: Entry | null
  type: ContentType
  user: User
}

/**
 * A box on a content type's edit screen, like `add_meta_box()`. Either its `fields`, custom fields
 * the CMS renders and saves with the entry, like a settings section; or a `component` of its own,
 * whose inputs are part of the entry's form (name them after the plugin, `seo.title`, so they
 * don't clash) and which `save` stores.
 */
export interface ContentMetaBox {
  /** Unique within the plugin. */
  name: string
  title: string
  /** Under the editor (`normal`, the default), or in the sidebar below Publish (`side`). */
  context?: 'normal' | 'side'
  /** Lower comes first. Defaults to 10. */
  order?: number
  /** Custom fields registered for the type, in the order shown; any plugin's. */
  fields?: readonly EntryMetaKey[]
  component?: (props: ContentMetaBoxProps) => ReactNode | Promise<ReactNode>
  /**
   * Saves the box's fields once the entry is written, in the same transaction, as `save_post`
   * handlers read `$_POST`. Runs only when the user may edit the entry.
   */
  save?: (context: { entry: Entry; form: FormData; user: User }) => void | Promise<void>
}

/** A link under an entry's title on the list screen, like `post_row_actions`. */
export interface ContentRowAction {
  /** Unique within the plugin. */
  name: string
  /** The link's text and address, or `null` to leave it out for this entry and user. */
  link: (entry: Entry, user: User) => { label: string; url: string } | null
}

/**
 * A choice in the list screen's Bulk actions, like `bulk_actions-edit-{$post_type}` with its
 * handler. The CMS checks `capability` first; the handler checks each entry.
 */
export interface ContentBulkAction {
  /** Unique within the plugin. */
  name: string
  label: string
  capability: CapabilityName
  /** Returns the notice to show, such as "3 courses archived." */
  handler: (context: {
    entries: Entry[]
    type: ContentType
    user: User
  }) => string | Promise<string>
}

/**
 * `cms.content`: content types and their entries, WordPress's post types and posts. Register
 * types in `setup()`, so every part of the site knows them; entries can be read and written
 * anywhere. Like `wp_insert_post()`, these don't check capabilities: the screens, actions and API
 * routes that call them do, with the type's meta capabilities.
 */
export interface ContentApi {
  /**
   * Registers a content type, like `register_post_type()`, under this plugin's id: `course` in
   * the `lms` plugin is `lms.course`. Declares its capabilities and grants them to `roles`.
   */
  type(name: string, definition: ContentTypeDefinition): void
  /** The registered types, in registration order. */
  types(): ContentType[]
  getType(name: string): ContentType | undefined
  /** Adds an entry, like `wp_insert_post()`. Throws `ContentError` for a type no active plugin registers. */
  create(type: ContentTypeName, entry?: NewEntry, options?: SaveOptions): Promise<Entry>
  /** Changes an entry, like `wp_update_post()`. An entry in the trash must be restored first. */
  update(id: string, changes: EntryChanges, options?: SaveOptions): Promise<Entry>
  get(id: string): Promise<Entry | null>
  /**
   * The published or private entry with this slug. `parentId` picks the level of a hierarchical
   * type; it defaults to the top.
   */
  getBySlug(
    type: ContentTypeName,
    slug: string,
    options?: { parentId?: string | null },
  ): Promise<Entry | null>
  list(query: EntryQuery): Promise<EntryList>
  /**
   * How many entries of the type have each status, like `wp_count_posts()`; with `authorId`, only
   * that author's.
   */
  count(
    type: ContentTypeName,
    options?: { authorId?: string },
  ): Promise<Record<EntryStatus, number>>
  /** The months with entries in these statuses (by default all but the trash), newest first. */
  months(
    type: ContentTypeName,
    options?: { status?: readonly EntryStatus[] },
  ): Promise<EntryMonth[]>
  /** Moves an entry to the trash, keeping its status for capability checks, like `wp_trash_post()`. */
  trash(id: string): Promise<Entry>
  /** Takes an entry out of the trash as a draft, as WordPress has done since 5.6. */
  restore(id: string): Promise<Entry>
  /** Deletes an entry for good. Its children move up to its parent, as in WordPress. */
  delete(id: string): Promise<void>
  /**
   * Registers a taxonomy, like `register_taxonomy()`, under this plugin's id: `topic` in the
   * `lms` plugin is `lms.topic`. Names are shared with content types.
   */
  taxonomy(name: string, definition: TaxonomyDefinition): void
  /** The registered taxonomies; with `type`, those classifying it. */
  taxonomies(type?: string): Taxonomy[]
  getTaxonomy(name: string): Taxonomy | undefined
  /**
   * Registers a custom field, like `register_meta()`: its key starts with this plugin's id, and
   * `types` says which content types have it. Declare its value's type in `EntryMeta`.
   */
  meta<K extends EntryMetaKey>(key: K, definition: MetaDefinitionFor<EntryMeta[K]>): void
  /**
   * A hierarchical type's entries (all but the trash) as a tree, for a Parent dropdown, like the
   * pages `wp_dropdown_pages()` lists: each one's id, title and depth, in one query. `exclude`
   * leaves out an entry and its descendants, which can't be its parent. At most `limit` (5,000).
   */
  outline(
    type: ContentTypeName,
    options?: { exclude?: string; limit?: number },
  ): Promise<{ id: string; title: string; depth: number }[]>
  /** The custom fields registered for a content type, or every one. */
  metaFields(type?: string): MetaField[]
  /** Replaces the default template for a type's or taxonomy's pages. Register it in `setup()`. */
  template(template: ContentTemplate): void
  /**
   * Entries' addresses on the site, like `get_permalink()`, for a page of them at once: a page's
   * path takes its ancestors' slugs. `null` for entries that aren't published (or published
   * privately), or whose type has no pages.
   */
  permalinks(entries: readonly Entry[]): Promise<Map<string, string | null>>
  /** A term's archive on the site, or `null` when its taxonomy isn't public. */
  termUrl(term: Term): string | null
  /** A type's archive on the site, or `null` when it has none. */
  archiveUrl(type: ContentTypeName): string | null
  /** Where an entry's preview shows it, saved but unpublished, to those who may read it. */
  previewUrl(entry: Entry): string
  /** An entry's revisions, newest first, like `wp_get_post_revisions()`. */
  revisions(
    entryId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ revisions: Revision[]; total: number }>
  getRevision(id: string): Promise<Revision | null>
  /**
   * Puts an entry back as a revision had it: its title, body, excerpt and custom fields, like
   * `wp_restore_post_revision()`. The restore is a save like any other, with a revision of its
   * own.
   */
  restoreRevision(id: string, options?: SaveOptions): Promise<Entry>
  /** Adds a term, like `wp_insert_term()`. Names are unique among a term's siblings. */
  createTerm(taxonomy: TaxonomyName, term: NewTerm): Promise<Term>
  /** Changes a term, like `wp_update_term()`. The default term keeps its slug. */
  updateTerm(id: string, changes: Partial<NewTerm>): Promise<Term>
  /**
   * Deletes a term, like `wp_delete_term()`: its children move up to its parent, and entries it
   * leaves without a term of the taxonomy get the default term, if there is one.
   */
  deleteTerm(id: string): Promise<void>
  getTerm(id: string): Promise<Term | null>
  getTermBySlug(taxonomy: TaxonomyName, slug: string): Promise<Term | null>
  listTerms(query: TermQuery): Promise<TermList>
  /**
   * The terms of several entries at once, by entry id, so a list shows them with one query.
   * With `taxonomy`, only its terms.
   */
  entryTerms(entryIds: readonly string[], taxonomy?: TaxonomyName): Promise<Map<string, Term[]>>
  /**
   * Replaces an entry's terms in a taxonomy, like `wp_set_object_terms()`. `names` that no term
   * has are added; with neither, the entry gets the default term, if there is one.
   */
  setEntryTerms(
    entryId: string,
    taxonomy: TaxonomyName,
    terms: { ids?: readonly string[]; names?: readonly string[] },
  ): Promise<Term[]>
}

// ── Media ────────────────────────────────────────────────────────────────────

/** What the media library sorts files into, as its type filter does. */
export type MediaKind = 'image' | 'audio' | 'video' | 'document' | 'spreadsheet' | 'archive'

/** One of an image's sizes, made when it was uploaded. */
export interface MediaSize {
  /** Its storage key, beside the image's own: `2026/11/photo-300x200.jpg`. */
  file: string
  /** Where it's served. */
  url: string
  width: number
  height: number
  mimeType: string
  /** In bytes. */
  size: number
}

/** An uploaded file, like a WordPress attachment. */
export interface MediaItem {
  id: string
  /** Who uploaded it, when known. */
  authorId: string | null
  /** The entry it was uploaded to, like an attachment's parent; `null` when unattached. */
  entryId: string | null
  /** Its storage key, such as `2026/11/photo.jpg`. */
  file: string
  /** Where it's served. */
  url: string
  /** The file as uploaded, when an image above 2560 pixels was scaled down for `file`. */
  originalFile: string | null
  /** Where the original is served, like `wp_get_original_image_url()`. */
  originalUrl: string | null
  /** Its name as uploaded. */
  filename: string
  mimeType: string
  kind: MediaKind
  /** In bytes. */
  size: number
  /** An image's dimensions; `null` for other files. */
  width: number | null
  height: number | null
  /**
   * An image's sizes by name: `thumbnail`, `medium`, `medium_large`, `large`, `1536x1536`,
   * `2048x2048` and plugins'. Sizes it's no bigger than are left out, as in WordPress.
   */
  sizes: Record<string, MediaSize>
  title: string
  /** Alternative text, for images. */
  alt: string
  caption: string
  description: string
  createdAt: Date
  updatedAt: Date
}

/** A size images get at upload, like `add_image_size()`. 0 leaves a side free. */
export interface ImageSizeDefinition {
  width: number
  height: number
  /** Crops to exactly `width` × `height` from the center; otherwise the image fits within them. */
  crop?: boolean
}

/** A size images get, by name. */
export interface ImageSize extends Required<ImageSizeDefinition> {
  name: string
}

/** A file to add to the library. */
export interface MediaUpload {
  /** Its name as the uploader had it. The extension decides its type, checked against its bytes. */
  name: string
  data: Uint8Array
}

/** Who uploaded a file, what it's for, and what to say about it. */
export interface MediaUploadOptions {
  /** Who uploaded it: a user id. */
  by?: string | null
  /** The entry it's uploaded to. */
  entryId?: string | null
  /** Defaults to the file's name without its extension, as in WordPress. */
  title?: string
  alt?: string
  caption?: string
  description?: string
}

/** What `update()` changes; fields left out keep their values. */
export interface MediaChanges {
  title?: string
  alt?: string
  caption?: string
  description?: string
  entryId?: string | null
}

/** Which files `list()` returns, newest first unless it says. */
export interface MediaQuery {
  kind?: MediaKind
  /** Uploaded to this entry; `null` for unattached files. */
  entryId?: string | null
  authorId?: string
  /** Matches titles and file names. */
  search?: string
  /** `YYYY-MM`: uploaded that month, in UTC. */
  month?: string
  orderBy?: 'date' | 'title'
  order?: 'asc' | 'desc'
  /** 1 to 100; defaults to 20. */
  limit?: number
  offset?: number
}

/** A stored file's bytes, all of them or a range. */
export interface StoredFile {
  body: ReadableStream<Uint8Array>
  /** The whole file's size, in bytes, even for a range. */
  size: number
  modifiedAt: Date
}

/**
 * Where uploads are kept: the site's disk unless a plugin provides another, such as S3. Keys are
 * paths such as `2026/11/photo.jpg`. Files are never overwritten, so they can be cached for good.
 */
export interface MediaStorage {
  /** Writes a new file. Returns `false`, writing nothing, when the key is taken. */
  create(key: string, data: Uint8Array, contentType: string): Promise<boolean>
  /** The file's bytes, or those from `start` to `end` (inclusive); `null` when there's none. */
  read(key: string, range?: { start: number; end: number }): Promise<StoredFile | null>
  stat(key: string): Promise<{ size: number; modifiedAt: Date } | null>
  /** Removes the file; a missing one is not an error. */
  delete(key: string): Promise<void>
  /** Where it's served: a path on this site, or another address, such as a CDN's. */
  url(key: string): string
}

/** `cms.media`: the media library, like WordPress's attachments. */
export interface MediaApi {
  /**
   * Adds a size made for each image uploaded from then on, like `add_image_size()`, named under
   * the plugin: `card` is `lms.card`. In `setup()` only.
   */
  imageSize(name: string, size: ImageSizeDefinition): void
  /** Keeps uploads somewhere other than the disk. In `setup()` only, by one plugin at most. */
  storage(storage: MediaStorage): void
  /** The sizes images get: core's, as Settings › Media has them, then plugins'. */
  imageSizes(): ImageSize[]
  /**
   * Adds a file, like `media_handle_upload()`: checks its type, stores it under a unique name in
   * the month's folder, and makes an image's sizes. Throws `MediaError`.
   */
  upload(file: MediaUpload, options?: MediaUploadOptions): Promise<MediaItem>
  get(id: string): Promise<MediaItem | null>
  /** Several by id, in one query, in the order asked for; missing ones are left out. */
  getMany(ids: readonly string[]): Promise<MediaItem[]>
  list(query?: MediaQuery): Promise<{ items: MediaItem[]; total: number }>
  update(id: string, changes: MediaChanges): Promise<MediaItem>
  /** Deletes it and its files, like `wp_delete_attachment()`. */
  delete(id: string): Promise<void>
  /** The months with uploads, newest first, as `YYYY-MM`. */
  months(): Promise<string[]>
}

// ── Users ────────────────────────────────────────────────────────────────────

/** Custom fields' definitions, without the content types they're for. */
type WithoutTypes<T> = T extends unknown ? Omit<T, 'types'> : never

/**
 * A field on users, like WordPress's user meta with `register_meta( 'user', … )`: typed and
 * checked as entries' custom fields are, and shown on the admin's Profile and Edit User screens.
 */
export type UserMetaDefinition = WithoutTypes<MetaDefinition> & {
  /** The roles whose users have it; every role's when left out. */
  roles?: readonly string[]
  /** Shown on the person's own account page on the site too, for them to change. */
  onAccount?: boolean
}

/** The definitions that can hold a value of type `V`. */
export type UserMetaDefinitionFor<V> = WithoutTypes<MetaDefinitionFor<V>> & {
  roles?: readonly string[]
  onAccount?: boolean
}

/** A user's fields by key, as `UserMeta` declares them. */
export type UserMetaValues = { [K in UserMetaKey]?: UserMeta[K] }

/** Fields to change: a value sets one, `null` removes it. */
export type UserMetaChanges = { [K in UserMetaKey]?: UserMeta[K] | null }

/** A registered user field. */
export interface UserMetaField {
  /** Such as `lms.bio`. */
  key: string
  pluginId: string
  definition: UserMetaDefinition
}

/** `cms.users`: people's accounts, and the fields plugins give them. */
export interface UsersApi {
  /**
   * Registers a field users have, named under the plugin (`lms.bio`), like `register_meta()`
   * for users. In `setup()` only.
   */
  meta<K extends UserMetaKey>(key: K, definition: UserMetaDefinitionFor<UserMeta[K]>): void
  /** The fields registered, or those a role's users have. */
  fields(role?: string): UserMetaField[]
  get(id: string): Promise<User | null>
  /** A user's fields, defaults shown for those not set: `get_user_meta()`. */
  getMeta(userId: string): Promise<UserMetaValues>
  /** Several users' fields in one query, for a page of them. */
  getMetaMany(userIds: readonly string[]): Promise<Map<string, UserMetaValues>>
  /**
   * Changes the fields named: `update_user_meta()`. Each must be registered for the user's role,
   * and valid; a `ContentError` says which isn't, as for custom fields.
   */
  updateMeta(userId: string, changes: UserMetaChanges): Promise<UserMetaValues>
  /** Whether the user has proved their email address, by using a link sent to it. */
  isVerified(userId: string): Promise<boolean>
}

// ── Mail ─────────────────────────────────────────────────────────────────────

/** An email to send, like `wp_mail()`'s arguments. */
export interface MailMessage {
  /** One address or several: `ada@example.com` or `Ada Admin <ada@example.com>`. */
  to: string | readonly string[]
  subject: string
  /** The plain-text body, which every email has. */
  text: string
  /** An HTML body as well, for mail programs that show it. */
  html?: string
  /** Defaults to Settings › General's "Send email from". */
  from?: string
  replyTo?: string
}

/** A message as the transport receives it: checked, with its recipients as a list. */
export interface OutgoingMail {
  /** `null` when the site has no sender set: the transport uses its own. */
  from: string | null
  to: string[]
  subject: string
  text: string
  html: string | null
  replyTo: string | null
}

/**
 * How email leaves the site: SMTP, Postmark, Resend, SES. A plugin provides it, as WordPress's
 * SMTP plugins replace `wp_mail()`'s PHPMailer.
 */
export interface MailTransport {
  /** Sends the message, or throws with a reason for the log. */
  send(message: OutgoingMail): Promise<void>
}

/** `cms.mail`: sending email, like `wp_mail()`. */
export interface MailApi {
  /**
   * Sends an email through the site's transport. Like `wp_mail()`, it doesn't throw for a
   * delivery problem: it returns `false`, logs why, and runs the `mail.failed` action. A message
   * that isn't valid (an address that isn't one, a line break in the subject) throws.
   */
  send(message: MailMessage): Promise<boolean>
  /** Whether a plugin has provided a transport, so email can leave the site. */
  canSend(): boolean
  /** Sends the site's email through `transport`. In `setup()` only, by one plugin at most. */
  transport(transport: MailTransport): void
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

/** Where a job stands: waiting for its time, running, or finished one of three ways. */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/** One run of a job, as its handler sees it. */
export interface JobRun {
  /** The job's id, as Tools › Scheduled Actions shows it. */
  id: string
  /** 1 for the first try. */
  attempt: number
  /**
   * Aborts once the run has used its `timeoutSeconds`. Pass it to `fetch()` and stop when it
   * fires: a run that goes on after it may be started again somewhere else.
   */
  signal: AbortSignal
}

/** A job: work that runs in the background, now, at a time or on a repeat. */
export interface JobDefinition<TArgs> {
  /** Shown in Tools › Scheduled Actions. Defaults to the name. */
  label?: string
  /**
   * Does the work. It runs outside any transaction; use `cms.transaction()` for what must be
   * kept or lost together. Throwing fails this try. A job can run more than once (a retry, or a
   * run whose server stopped), so make it safe to repeat.
   */
  handler: (args: TArgs, run: JobRun) => void | Promise<void>
  /**
   * Runs it on a repeat, this many seconds apart, with no arguments, like
   * `as_schedule_recurring_action()`. The first run is one interval after the site first sees
   * it. At least 60.
   */
  everySeconds?: number
  /** How many times a run is tried before it counts as failed. Defaults to 1: no retry. */
  attempts?: number
  /**
   * Seconds to wait before the next try, given the try that failed (1 for the first). Defaults
   * to 1 minute, then 4, then 16, up to a day.
   */
  backoffSeconds?: number | ((attempt: number) => number)
  /** How long a run may take. Defaults to 300 seconds. */
  timeoutSeconds?: number
}

/** When and how a job is queued. */
export interface EnqueueOptions {
  /** Not before this time. Without it, as soon as possible. */
  at?: Date
  /**
   * Queues it only if no job with this name and key is already waiting, like Action Scheduler's
   * `$unique`: `enqueue()` then answers `null`. For "rebuild the index" asked for many times.
   */
  unique?: string
}

/**
 * `cms.jobs`: work in the background, like WordPress's Action Scheduler. A job is queued in the
 * caller's transaction, so it exists only if what asked for it was kept.
 */
export interface JobsApi {
  /** Declares a job and what runs it. In `setup()`; its name starts with the plugin's id. */
  define<K extends JobName>(name: K, definition: JobDefinition<Jobs[K]>): void
  /**
   * Queues a run, like `as_enqueue_async_action()`, or `as_schedule_single_action()` with
   * `at`. Returns the job's id, or `null` when `unique` found one waiting. The arguments must
   * be plain data: they're stored as JSON.
   */
  enqueue<K extends JobName>(
    name: K,
    args: Jobs[K],
    options?: EnqueueOptions,
  ): Promise<string | null>
  /**
   * Cancels the waiting jobs of this name, or only those queued with this `unique` key, like
   * `as_unschedule_all_actions()`. Returns how many.
   */
  cancel<K extends JobName>(name: K, unique?: string): Promise<number>
  /**
   * When the next waiting job of this name (and `unique` key) is due, like
   * `as_next_scheduled_action()`; `null` when none is waiting.
   */
  next<K extends JobName>(name: K, unique?: string): Promise<Date | null>
}

// ── Cache ────────────────────────────────────────────────────────────────────

/** How long a cached value is kept, and where. */
export interface CacheOptions {
  /** Seconds until it's forgotten. Without it, it's kept until deleted or pushed out. */
  ttlSeconds?: number
  /**
   * Keeps it in the database rather than this server's memory, like a WordPress transient: it
   * survives a restart and is the same on every server, at the cost of a query to read it. For
   * what is slow to get back, such as another service's answer. Without a `ttlSeconds` it stays
   * until deleted. Ask for a durable value as it was kept: `get(key, { durable: true })`.
   */
  durable?: boolean
}

/** Which of a key's two homes to look in: this server's memory, or with `durable` the database. */
export type CacheReadOptions = Pick<CacheOptions, 'durable'>

/**
 * Where cached values are kept when a plugin provides somewhere else than this server's memory
 * and the database, such as Redis: WordPress's persistent object cache. Keys arrive with their
 * plugin's id in front (`shop:rates`); values are JSON text.
 */
export interface CacheStore {
  /** The value, or `null` when there's none or it has expired. */
  get(key: string): Promise<string | null>
  /** Keeps the value, for `ttlSeconds` when given. */
  set(key: string, value: string, ttlSeconds: number | null): Promise<void>
  delete(key: string): Promise<void>
  /** Deletes every key that starts with `prefix`. */
  flush(prefix: string): Promise<void>
}

/**
 * `cms.cache`: values kept so they needn't be worked out again, like WordPress's `wp_cache_*`
 * and transients. Each plugin has its own keys. Values must be plain data (they're stored as
 * JSON), and what `get()` returns is frozen: change a copy, then `set()` it.
 */
export interface CacheApi {
  /**
   * The value, or `undefined` when there's none, like `wp_cache_get()`, or `get_transient()`
   * with `durable`. A value kept in memory is never looked for in the database, nor the other
   * way round.
   */
  get<T = unknown>(key: string, options?: CacheReadOptions): Promise<T | undefined>
  /** Keeps a value, like `wp_cache_set()`, or `set_transient()` with `durable`. */
  set(key: string, value: unknown, options?: CacheOptions): Promise<void>
  /** Forgets a value: the one in memory, or with `durable` the one in the database. */
  delete(key: string, options?: CacheReadOptions): Promise<void>
  /**
   * The cached value, or what `compute` returns, which is then kept. While one call computes,
   * others on this server asking for the same key wait for it rather than computing too. A
   * `compute` that throws caches nothing.
   */
  remember<T>(key: string, compute: () => T | Promise<T>, options?: CacheOptions): Promise<T>
  /** Forgets everything this plugin cached, like `wp_cache_flush_group()`. */
  flush(): Promise<void>
  /** Keeps every plugin's cached values in `store`. In `setup()` only, by one plugin at most. */
  store(store: CacheStore): void
}

// ── Events and webhooks ──────────────────────────────────────────────────────

/** An event other systems can be told about: a topic a webhook can subscribe to. */
export interface EventDefinition {
  /** What Settings › Webhooks calls it, such as "Order paid". */
  label: string
  /** A line under the label, for what the event carries or when it happens. */
  description?: string
}

/** An entry, as the `content.saved` and `content.deleted` events carry it. */
export interface EntryEventData {
  id: string
  /** The content type, such as `core.post`. */
  type: string
  status: EntryStatus
  slug: string
  title: string
  excerpt: string
  authorId: string | null
  parentId: string | null
  /** Its address on the site, when it's published and its type has pages; otherwise `null`. */
  url: string | null
  /** ISO 8601, or `null` before it's published. */
  publishedAt: string | null
  /** ISO 8601. */
  updatedAt: string
}

/** A file, as the `media.uploaded` and `media.deleted` events carry it. */
export interface MediaEventData {
  id: string
  /** Its storage key, such as `2026/11/photo.jpg`. */
  file: string
  /** Where it's served. */
  url: string
  filename: string
  mimeType: string
  /** In bytes. */
  size: number
  authorId: string | null
  /** The entry it was uploaded to, when it was. */
  entryId: string | null
}

/**
 * `cms.events`: what happened on the site, for other systems. An event that's emitted is sent to
 * every webhook subscribed to it in Settings › Webhooks, like WooCommerce's webhook topics.
 */
export interface EventsApi {
  /** Declares an event webhooks can subscribe to. In `setup()`; its name starts with the plugin's id. */
  define<K extends EventName>(name: K, definition: EventDefinition): void
  /**
   * Tells every webhook subscribed to the event, in the background, with retries. The deliveries
   * are queued in the caller's transaction, so they go out only if what happened was kept. The
   * data must be plain data: it's sent as JSON. With no webhook subscribed, it does nothing.
   */
  emit<K extends EventName>(name: K, data: Events[K]): Promise<void>
  /**
   * Whether a webhook is subscribed to the event, so data that's costly to gather can be left
   * ungathered when nobody is. Answered from memory.
   */
  hasSubscribers(name: EventName): boolean
}

// ── Tracing ──────────────────────────────────────────────────────────────────

/** What a span in a request's trace timed. */
export type TraceSpanKind =
  | 'request'
  | 'render'
  | 'query'
  | 'hook'
  | 'page'
  | 'admin'
  | 'api'
  | 'boot'
  | 'setup'
  | 'migration'
  | 'other'

/** One timed piece of a request: Next.js's own work, or the CMS's and its plugins'. */
export interface TraceSpan {
  id: string
  /** The span it ran inside; `null` for the request itself. */
  parentId: string | null
  name: string
  kind: TraceSpanKind
  /** Milliseconds after the request started. */
  start: number
  /** Milliseconds. */
  duration: number
  /** The plugin it ran for: its own, or that of the nearest span around it that has one. */
  plugin: string | null
  /** OpenTelemetry attributes, such as `db.statement` on a query. Query values are never recorded. */
  attributes: Readonly<Record<string, string | number | boolean>>
  /** The error it ended with, if it failed. */
  error?: string
}

/** Everything one request did on the server, from when it arrived to when its response ended. */
export interface RequestTrace {
  /** The OpenTelemetry trace id. */
  id: string
  method: string
  /** The route that answered, such as `/[...slug]`, when Next.js says. */
  route: string | null
  path: string | null
  status: number | null
  /** When the request arrived, in milliseconds since the epoch. */
  startedAt: number
  /** Milliseconds from arrival to the end of the response; `null` while it's still running. */
  duration: number | null
  /** The server process's memory when the response ended, in bytes. */
  memory: { heapUsed: number; rss: number } | null
  /** In the order they started. */
  spans: readonly TraceSpan[]
  /** Spans left out because the request had more than the limit. */
  droppedSpans: number
}

/**
 * `cms.traces`: what each request did on the server, as OpenTelemetry traces. Nothing is
 * recorded until an active plugin calls `enable()`, and the site must load the CMS's
 * instrumentation (`cms generate` writes `instrumentation.ts`).
 */
export interface TracesApi {
  /** Records every request while this plugin is active. Call it in `setup()`. */
  enable(): void
  /** Whether requests are being recorded: enabled, and the site's instrumentation loaded. */
  readonly available: boolean
  /** The current request's trace id, while it's being recorded. */
  currentId(): string | undefined
  /**
   * Keeps this request's trace for `get()` once the response ends. Traces nobody keeps are dropped
   * when their request ends; kept ones are held in memory for a while (the last 100, 10 minutes).
   */
  keep(id: string): void
  /** A kept trace, finished or still running. */
  get(id: string): RequestTrace | undefined
  /** Every kept trace, newest first. */
  list(): RequestTrace[]
}

// ── Plugins ──────────────────────────────────────────────────────────────────

/** A change to the database, run once and recorded so it never runs twice. */
export interface Migration {
  /** Unique within the plugin. Applied in array order, once. */
  id: string
  up: (db: Database) => Promise<unknown>
}

/**
 * A plugin's proxy: the default export of its package's `./proxy` entry. It sees every request
 * to the site before any page or route does, like a WordPress `advanced-cache.php` drop-in, and
 * may answer it; `null` lets it through. It runs apart from `setup()`, with no `cms`: keep it
 * small, and fast for the requests it lets through.
 */
export type ProxyHandler = (
  request: Request,
) => Response | null | undefined | Promise<Response | null | undefined>

/** What a plugin's `uninstall()` receives. The plugin isn't loaded: there is no `cms`. */
export interface UninstallContext {
  readonly plugin: { readonly id: string; readonly version: string }
  /** The transaction the uninstall runs in: if anything fails, nothing is deleted. */
  readonly db: Database
  readonly logger: Logger
}

/** What a plugin's `setup(cms)` receives: every API it registers with. */
export interface PluginContext {
  readonly plugin: { readonly id: string; readonly version: string }
  readonly hooks: HooksApi
  readonly registries: RegistriesApi
  readonly services: ServicesApi
  readonly routes: RoutesApi
  readonly slots: SlotsApi
  readonly settings: SettingsApi
  readonly auth: AuthApi
  readonly admin: AdminApi
  readonly content: ContentApi
  readonly media: MediaApi
  readonly mail: MailApi
  readonly jobs: JobsApi
  readonly events: EventsApi
  readonly cache: CacheApi
  readonly users: UsersApi
  readonly traces: TracesApi
  readonly logger: Logger
  /**
   * The current transaction when called inside `transaction()`, otherwise the root connection.
   * Always read it at call time; never store it in setup.
   */
  readonly db: Database
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>
  /**
   * Runs `fn` only if `pluginId` is active and loaded before this plugin. The dependency must
   * be declared in `requires` or `optional`.
   */
  when(pluginId: string, fn: () => void | Promise<void>): Promise<void>
  isActive(pluginId: string): boolean
}

/** A plugin: what it is, what it needs, and what it sets up. Pass it to `definePlugin()`. */
export interface PluginDefinition {
  /** Lowercase kebab-case, unique across the site. */
  id: string
  /** Semver. */
  version: string
  /** Shown in the admin. Defaults to the id. */
  name?: string
  description?: string
  /** Hard dependencies: plugin id (or `core`) -> semver range. */
  requires?: Readonly<Record<string, string>>
  /** Soft dependencies: loaded first when present; use `when()` to integrate. */
  optional?: Readonly<Record<string, string>>
  migrations?: readonly Migration[]
  /** Declared up front so the admin can show them and values resolve before `setup()` runs. */
  settings?: SettingDefinitions
  /** Beside the plugin's section in the admin menu. Defaults to `admin`, a gear. */
  icon?: AdminIcon
  /**
   * Registers what every part of the site needs: hooks, services, routes, site slots, roles,
   * capabilities and content types. Runs on every boot, after the plugins it depends on, and after its migrations.
   * Admin pages, actions, settings screens and admin slots go in the plugin's admin entry.
   */
  setup?: (cms: PluginContext) => void | Promise<void>
  /**
   * Removes what the plugin made in the database, when an administrator deletes its data from
   * the Plugins screen, like WordPress's `uninstall.php`: drop its tables, delete the entries of
   * its content types. Core then forgets its migrations (so activating it again makes its tables
   * again), its saved settings, its jobs and its cached values. Without it, core deletes only
   * those last three and leaves the plugin's tables be. It runs while the plugin is inactive.
   */
  uninstall?: (context: UninstallContext) => void | Promise<void>
}

/**
 * A plugin's admin entry: what only the admin shows. The plugin's package exports it as
 * `./admin`, and `cms generate` loads it where the admin is and nowhere else, so its components,
 * and the browser code they bring, never reach the site's visitors.
 */
export interface AdminDefinition {
  /** The plugin it belongs to: its main entry's definition. */
  plugin: PluginDefinition
  /**
   * Registers admin pages, form actions, settings screens and fills for admin slots. Runs after
   * every plugin's `setup()`, in the same order, so it can use any plugin's services.
   */
  setup: (cms: PluginContext) => void | Promise<void>
}
