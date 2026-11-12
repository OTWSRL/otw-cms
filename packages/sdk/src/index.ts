import type {
  AdminDefinition,
  Entry,
  EntryEventData,
  Term,
  EntryFields,
  EntryStatus,
  MediaEventData,
  MediaItem,
  OutgoingMail,
  PluginContext,
  PluginDefinition,
  User,
} from './types'

export type * from './types'
export type { AdminIcon, AdminIconName } from './admin-icons'
export { ADMIN_ICON_NAMES, isAdminIcon } from './admin-icons'
export { ActionError } from './action-error'
export { ContentError, type ContentErrorCode } from './content-error'
export { MediaError, type MediaErrorCode } from './media-error'
export { isSafeHref } from './links'
export { ForbiddenError } from './forbidden-error'
export { PageRedirect } from './page-redirect'
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
 *   declare module '@otwdesign/sdk' {
 *     interface Registries { 'commerce.gateways': PaymentGateway }
 *     interface Filters { 'commerce.cart.totals': [CartTotals, { lines: QuotedLine[] }] }
 *     interface Actions { 'commerce.order.paid': { order: Order } }
 *     interface Services { commerce: CommerceService }
 *     interface Settings { 'commerce.currency': string }
 *     interface Capabilities { 'commerce.manage_orders': true }
 *     interface MetaCapabilities { 'commerce.cancel_order': [order: Order] }
 *     interface Slots { 'commerce.admin.order': { order: Order; user: User } }
 *     interface ContentTypes { 'lms.course': true }
 *   }
 *
 * Names are namespaced with the owning plugin's id to avoid collisions.
 */

/** Registry name -> item type. Items must have a string `id`. */
export interface Registries {}

/** Filter name -> `[value, context]`. Handlers receive the value and return a replacement. */
export interface Filters {
  /**
   * The fields an entry is about to be saved with, by `create()` and `update()`, like WordPress's
   * `wp_insert_post_data`. They're checked again after the filters.
   */
  'content.entry': [EntryFields, { type: string; previous: Entry | null }]
  /**
   * The file types people may upload, by extension (`jpg|jpeg|jpe`) to type, like
   * `upload_mimes`. Remove types here; added ones are checked only by extension.
   */
  'media.mimes': [Record<string, string>, { by: string | null }]
  /**
   * An email about to be sent, like `wp_mail`: change its recipients, subject, bodies or sender.
   * It's checked again after the filters.
   */
  'mail.message': [OutgoingMail, Record<string, never>]
}

/** Action name -> payload. */
export interface Actions {
  /**
   * An entry was added or changed, trashed and restored included, like `save_post`. Runs in the
   * save's transaction: what a handler writes is kept or rolled back with the entry.
   */
  'content.saved': { entry: Entry; previous: Entry | null }
  /** An entry's status changed, or a new entry got its first (`from` is `null`): `transition_post_status`. */
  'content.status': { entry: Entry; from: EntryStatus | null; to: EntryStatus }
  /** An entry went to the trash, after `content.saved`: `trashed_post`. */
  'content.trashed': { entry: Entry }
  /** An entry came out of the trash as a draft, after `content.saved`: `untrashed_post`. */
  'content.restored': { entry: Entry }
  /** An entry was deleted for good: `deleted_post`. Runs in the delete's transaction. */
  'content.deleted': { entry: Entry }
  /** A term was added or changed: WordPress's `created_term` and `edited_term`. */
  'content.term.saved': { term: Term; previous: Term | null }
  /** A term was deleted, after its entries and children were moved: `delete_term`. */
  'content.term.deleted': { term: Term }
  /** An entry's terms in a taxonomy were set: `set_object_terms`. */
  'content.entry.terms': {
    entryId: string
    taxonomy: string
    terms: Term[]
    previous: Term[]
  }
  /** A file was added to the library: `add_attachment`. Runs in the upload's transaction. */
  'media.uploaded': { item: MediaItem }
  /** A file's details changed: `attachment_updated`. */
  'media.updated': { item: MediaItem; previous: MediaItem }
  /** A file was deleted: `delete_attachment`. Its files go once the transaction commits. */
  'media.deleted': { item: MediaItem }
  /** An email was handed to the transport: `wp_mail_succeeded`. */
  'mail.sent': { message: OutgoingMail }
  /** An email couldn't be sent, or there's no transport: `wp_mail_failed`. */
  'mail.failed': { message: OutgoingMail; error: string }
  /**
   * A job failed its last try, like `action_scheduler_failed_action`: for telling someone. Its
   * `error` is the last try's.
   */
  'job.failed': { id: string; name: string; args: unknown; attempts: number; error: string }
}

/**
 * Job name -> its arguments, which must be plain data. Declare the job itself with
 * `cms.jobs.define()`. A job that repeats takes none: `Record<string, never>`.
 */
export interface Jobs {
  /**
   * Core's daily housekeeping: sessions and emailed links that ran out, old failed sign-ins, and
   * jobs that finished more than 30 days ago.
   */
  'core.cleanup': Record<string, never>
  /** Daily, like `wp_scheduled_delete`: deletes what has been in the Trash for 30 days. */
  'core.empty_trash': Record<string, never>
  /** Sends one event to one webhook: the delivery, with its retries. */
  'core.deliver_webhook': {
    /** The webhook's id. */
    webhook: string
    /** The event's own id, the same on every try: what a receiver can deduplicate by. */
    event: string
    /** The event's name. */
    type: string
    /** When it happened, in seconds since 1970. */
    timestamp: number
    data: unknown
  }
  /**
   * Publishes a scheduled entry when its date comes, like `publish_future_post`. Core queues it
   * when an entry is scheduled, and cancels it when the entry no longer is.
   */
  'core.publish_entry': { id: string }
}

/**
 * Event name -> the data it carries, which must be plain data. Declare the event itself with
 * `cms.events.define()`. Webhooks subscribe to events in Settings › Webhooks.
 */
export interface Events {
  /** An entry was added or changed, trashed and restored included: the `content.saved` action. */
  'content.saved': EntryEventData
  /** An entry was deleted for good. */
  'content.deleted': EntryEventData
  /** A file was added to the media library. */
  'media.uploaded': MediaEventData
  /** A file was deleted from the media library. */
  'media.deleted': MediaEventData
}

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
  /** Settings › Reading: the home page shows the latest `posts`, or a static `page`. */
  'reading.show_on_front': string
  /** The page the home page shows, when `reading.show_on_front` is `page`. */
  'reading.page_on_front': string
  /** A page whose address lists the latest posts, when the home page is a static page. */
  'reading.page_for_posts': string
  /** How many entries an archive page lists. */
  'reading.posts_per_page': string
  /** Settings › Media: the thumbnail size's width, in pixels. */
  'media.thumbnail_size_w': string
  /** The thumbnail size's height, in pixels. */
  'media.thumbnail_size_h': string
  /** Whether thumbnails are cropped to their exact size. */
  'media.thumbnail_crop': boolean
  /** The medium size's largest width; 0 leaves it free. */
  'media.medium_size_w': string
  /** The medium size's largest height; 0 leaves it free. */
  'media.medium_size_h': string
  /** The large size's largest width; 0 leaves it free. */
  'media.large_size_w': string
  /** The large size's largest height; 0 leaves it free. */
  'media.large_size_h': string
  /** Uploads go in year and month folders, `2026/11/`, as WordPress's do by default. */
  'media.uploads_use_yearmonth_folders': boolean
  /**
   * Who the site's email comes from, such as `My Site <hello@example.com>`. Empty leaves it to
   * the mail plugin. `MAIL_FROM` overrides it.
   */
  'mail.from': string
  /**
   * Settings › General › Membership: anyone can sign up on the site, as a Customer, with an
   * address they prove. WordPress's `users_can_register`. Off by default.
   */
  'users.can_register': boolean
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
  /**
   * Add, change and delete webhooks in Settings › Webhooks, and see their secrets. Only
   * administrators have it until a role is granted it: a webhook sends the site's data elsewhere.
   */
  'core.manage_webhooks': true
  /**
   * See the job queue in Tools › Scheduled Actions, and run or cancel its jobs. Only
   * administrators have it until a role is granted it: a job's arguments can name anything.
   */
  'core.manage_jobs': true
  /**
   * Read published entries and one's own, like WordPress's `read`. Every role has it unless it's
   * revoked.
   */
  'core.read': true
  /** Upload files and use the media library, like WordPress's `upload_files`: authors and up. */
  'core.upload_files': true
}

/**
 * Meta capability name -> the arguments it is checked against. Like WordPress's `edit_post`,
 * it maps an object to the primitive capabilities it requires: `can(user, 'commerce.cancel_order', order)`.
 */
export interface MetaCapabilities {
  /** Change a file's details: one's own with `core.edit_posts`, others' with `core.edit_others_posts`. */
  'core.edit_media': [MediaItem]
  /** Delete a file: one's own with `core.delete_posts`, others' with `core.delete_others_posts`. */
  'core.delete_media': [MediaItem]
}

/**
 * Content type name -> `true`, or `{ plural }` when its plural isn't the name and an `s`. Declaring
 * a type here types its capability names, such as `lms.edit_courses` and `lms.edit_course`.
 */
export interface ContentTypes {
  /** Posts, as in WordPress: core's blog entries. */
  'core.post': true
  /** Pages, as in WordPress: hierarchical, and edited by editors only unless granted. */
  'core.page': true
}

/**
 * Taxonomy name -> `true`, or `{ plural }` when its plural isn't the name and an `s`. Declaring a
 * taxonomy here types its capability names, such as `lms.manage_topics` and `lms.edit_topic`.
 */
export interface Taxonomies {
  /** Categories for posts, as in WordPress: hierarchical, with "Uncategorized" by default. */
  'core.category': { plural: 'categories' }
  /** Tags for posts, as in WordPress. */
  'core.tag': true
}

/**
 * Custom field key -> its value's type, for entries' `meta`. Register each with
 * `cms.content.meta()`; keys start with the plugin's id, as `lms.level`.
 */
export interface EntryMeta {}

/**
 * User field key -> its value's type. Register each with `cms.users.meta()`; keys start with the
 * plugin's id, as `lms.bio`.
 */
export interface UserMeta {}

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
  /**
   * Sections of the signed-in person's account page, after its own, like WooCommerce's My Account
   * tabs: a shop's orders, a course's progress.
   */
  'account.sections': { user: User }
}

/** Any declared registry's name. */
export type RegistryName = keyof Registries & string
/** Any declared filter's name. */
export type FilterName = keyof Filters & string
/** Any declared action's name. */
export type ActionName = keyof Actions & string
/** Any declared event's name. */
export type EventName = keyof Events & string
/** Any declared job's name. */
export type JobName = keyof Jobs & string
/** Any declared service's name. */
export type ServiceName = keyof Services & string
/** Any declared setting's key. */
export type SettingName = keyof Settings & string
/** Any declared content type's name. */
export type ContentTypeName = keyof ContentTypes & string
/** Any declared custom field's key. */
export type EntryMetaKey = keyof EntryMeta & string
/** Any declared user field's key. */
export type UserMetaKey = keyof UserMeta & string
/** Any declared taxonomy's name. */
export type TaxonomyName = keyof Taxonomies & string
/** Any declared capability's name, content types' and taxonomies' included. */
export type CapabilityName =
  (keyof Capabilities & string) | ContentCapabilityName | TaxonomyCapabilityName
/** Any declared meta capability's name, content types' and taxonomies' included. */
export type MetaCapabilityName =
  (keyof MetaCapabilities & string) | ContentMetaCapabilityName | TaxonomyMetaCapabilityName

type PluginOf<K extends string> = K extends `${infer P}.${string}` ? P : never
type SingularOf<K extends string> = K extends `${string}.${infer N}` ? N : never
type PluralOf<K extends ContentTypeName> = ContentTypes[K] extends {
  plural: infer P extends string
}
  ? P
  : `${SingularOf<K>}s`
type TaxonomyPluralOf<K extends TaxonomyName> = Taxonomies[K] extends {
  plural: infer P extends string
}
  ? P
  : `${SingularOf<K>}s`

/** The words in a content type's primitive capabilities, as in WordPress's `edit_others_posts`. */
export type ContentCapabilityVerb =
  | 'edit'
  | 'edit_others'
  | 'edit_published'
  | 'edit_private'
  | 'publish'
  | 'read_private'
  | 'delete'
  | 'delete_others'
  | 'delete_published'
  | 'delete_private'

/** The primitive capabilities of declared content types, such as `lms.edit_others_courses`. */
export type ContentCapabilityName = {
  [K in ContentTypeName]: `${PluginOf<K>}.${ContentCapabilityVerb}_${PluralOf<K>}`
}[ContentTypeName]

/** The meta capabilities of declared content types, such as `lms.edit_course`: each takes an entry. */
export type ContentMetaCapabilityName = {
  [
    K in ContentTypeName
  ]: `${PluginOf<K>}.${'edit' | 'read' | 'delete' | 'publish'}_${SingularOf<K>}`
}[ContentTypeName]
/** The primitive capabilities of declared taxonomies, such as `core.manage_categories`. */
export type TaxonomyCapabilityName = {
  [
    K in TaxonomyName
  ]: `${PluginOf<K>}.${'manage' | 'edit' | 'delete' | 'assign'}_${TaxonomyPluralOf<K>}`
}[TaxonomyName]

/** The meta capabilities of declared taxonomies, such as `core.edit_category`: each takes a term. */
export type TaxonomyMetaCapabilityName = {
  [K in TaxonomyName]: `${PluginOf<K>}.${'edit' | 'delete' | 'assign'}_${SingularOf<K>}`
}[TaxonomyName]

/** Any declared slot's name. */
export type SlotName = keyof Slots & string

/** Arguments a capability check takes: an entry for content types' meta capabilities, none for primitive ones. */
export type CapabilityArgs<C extends string> = C extends keyof MetaCapabilities
  ? MetaCapabilities[C]
  : C extends ContentMetaCapabilityName
    ? [entry: Entry]
    : C extends TaxonomyMetaCapabilityName
      ? [term: Term]
      : []

/** The value a filter passes through its handlers: the first of its `[value, context]`. */
export type FilterValue<K extends FilterName> = Filters[K] extends [infer V, unknown] ? V : never
/** What a filter's handlers are told besides the value: the second of its `[value, context]`. */
export type FilterContext<K extends FilterName> = Filters[K] extends [unknown, infer C] ? C : never

/** Values for any settings, by key, such as the fixed ones a test kernel takes. */
export type SettingsValues = { [K in SettingName]?: Settings[K] }
