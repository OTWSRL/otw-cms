import type { AdminDefinition, PluginContext, PluginDefinition, User } from './types'

export type * from './types'
export type { AdminIcon, AdminIconName } from './admin-icons'
export { ADMIN_ICON_NAMES, isAdminIcon } from './admin-icons'
export { ActionError } from './action-error'
export { ForbiddenError } from './forbidden-error'
export { HttpError } from './http-error'

/** Identity helper for type inference. The kernel validates the definition when it loads. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition
}

/**
 * A plugin's admin entry, the default export of its package's `./admin` module: admin pages,
 * actions, settings screens and admin slot fills, which only the admin loads.
 *
 *   import shop from './index'
 *   export default defineAdmin(shop, (cms) => {
 *     cms.admin.page({ name: 'orders', path: '/orders', ... })
 *   })
 */
export function defineAdmin(
  plugin: PluginDefinition,
  setup: (cms: PluginContext) => void | Promise<void>,
): AdminDefinition {
  return { plugin, setup }
}

/*
 * Extension points. They are declared here, in the entry module, so plugins can augment them:
 *
 *   declare module '@otw/sdk' {
 *     interface Registries { 'commerce.gateways': PaymentGateway }
 *     interface Filters { 'commerce.cart.totals': [CartTotals, { lines: QuotedLine[] }] }
 *     interface Actions { 'commerce.order.paid': { order: Order } }
 *     interface Services { commerce: CommerceService }
 *     interface Settings { 'commerce.currency': string }
 *     interface Capabilities { 'commerce.manage_orders': true }
 *     interface MetaCapabilities { 'commerce.cancel_order': [order: Order] }
 *     interface Slots { 'commerce.admin.order': { order: Order; user: User } }
 *   }
 *
 * Names are namespaced with the owning plugin's id to avoid collisions.
 */

/** Registry name -> item type. Items must have a string `id`. */
export interface Registries {}

/** Filter name -> `[value, context]`. Handlers receive the value and return a replacement. */
export interface Filters {}

/** Action name -> payload. */
export interface Actions {}

/** Service name -> the API the providing plugin exposes to others. */
export interface Services {}

/** Setting key -> value type. Declare the field itself in the plugin's `settings`. */
export interface Settings {
  /** The site's name, from Settings › General: page titles and the admin bar show it. */
  'site.title': string
  /**
   * The public origin, such as `https://example.com`, for links sent elsewhere (payment return
   * pages). Empty means the address each request arrives on. `SITE_URL` overrides it.
   */
  'site.url': string
  /** Formats numbers and prices, such as `en-US` or `de-DE`. `SITE_LOCALE` overrides it. */
  'site.locale': string
}

/** Capability name -> `true`. Admin pages and actions each require one. */
export interface Capabilities {
  /** Use the admin at all: every admin screen needs it, on top of its own capability. */
  'core.access_admin': true
  /** Activate and deactivate plugins, and run pending database updates. */
  'core.manage_plugins': true
  /** Open and save Settings › General, and any settings page that doesn't name its own capability. */
  'core.manage_settings': true
  /** Add users and change their roles. */
  'core.manage_users': true
  /** Update the CMS and plugins from Dashboard › Updates. Only administrators have it until a role is granted it. */
  'core.manage_updates': true
}

/**
 * Meta capability name -> the arguments it is checked against. Like WordPress's `edit_post`,
 * it maps an object to the primitive capabilities it requires: `can(user, 'commerce.cancel_order', order)`.
 */
export interface MetaCapabilities {}

/** Slot name -> the props each fill receives. */
export interface Slots {
  /** Links in the site's main navigation, which the site's layout renders with `<Slot name="header.nav" />`. */
  'header.nav': Record<string, never>
  /** Top of every admin screen. */
  'admin.notices': { user: User }
  /** Widgets on the admin dashboard. */
  'admin.dashboard': { user: User }
  /** The end of every admin screen, after the footer, like WordPress's `admin_footer`. */
  'admin.footer': { user: User }
  /**
   * The end of every page on the site, like WordPress's `wp_footer`, where the site's layout
   * renders it with `<Slot name="site.footer" props={{ user }} />`.
   */
  'site.footer': { user: User | null }
}

/** Any declared registry's name. */
export type RegistryName = keyof Registries & string
/** Any declared filter's name. */
export type FilterName = keyof Filters & string
/** Any declared action's name. */
export type ActionName = keyof Actions & string
/** Any declared service's name. */
export type ServiceName = keyof Services & string
/** Any declared setting's key. */
export type SettingName = keyof Settings & string
/** Any declared capability's name. */
export type CapabilityName = keyof Capabilities & string
/** Any declared meta capability's name. */
export type MetaCapabilityName = keyof MetaCapabilities & string
/** Any declared slot's name. */
export type SlotName = keyof Slots & string

/** Arguments a capability check takes: none for primitive capabilities. */
export type CapabilityArgs<C extends string> = C extends MetaCapabilityName
  ? MetaCapabilities[C]
  : []

/** The value a filter passes through its handlers: the first of its `[value, context]`. */
export type FilterValue<K extends FilterName> = Filters[K] extends [infer V, unknown] ? V : never
/** What a filter's handlers are told besides the value: the second of its `[value, context]`. */
export type FilterContext<K extends FilterName> = Filters[K] extends [unknown, infer C] ? C : never

/** Values for any settings, by key, such as the fixed ones a test kernel takes. */
export type SettingsValues = { [K in SettingName]?: Settings[K] }
