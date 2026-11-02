import type {
  CapabilityName,
  ContentFeature,
  ContentRoleLevel,
  ContentType,
  ContentTypeCapabilities,
  ContentTypeDefinition,
  ContentTypeName,
  Entry,
  MetaCapabilityName,
  RequiredCapabilities,
  User,
} from '@otw/sdk'
import { ADMIN_PREFIX } from './admin'
import { READ, type CapabilityStore } from './capabilities'

const TYPE_NAME = /^[a-z][a-z0-9_]*$/
const FEATURES: readonly ContentFeature[] = [
  'title',
  'body',
  'excerpt',
  'author',
  'position',
  'revisions',
]
/** How many revisions an entry keeps unless its type says. */
const DEFAULT_REVISIONS = 25
const MAX_REVISIONS = 1000
const DEFAULT_SUPPORTS: readonly ContentFeature[] = ['title', 'body']
const MAX_LABEL = 100
/** Core's types have sections of their own (`/admin/posts`); plugins' sit under the plugin. */
const CORE = 'core'

/** As for WordPress's posts, which a post type with the default `capability_type` shares. */
export const DEFAULT_CONTENT_ROLES: Readonly<Record<string, ContentRoleLevel>> = {
  editor: 'editor',
  author: 'author',
  contributor: 'contributor',
}

type Primitive = Exclude<keyof ContentTypeCapabilities, `${string}Entry`>

const PRIMITIVES: Readonly<Record<Primitive, string>> = {
  edit: 'edit',
  editOthers: 'edit_others',
  editPublished: 'edit_published',
  editPrivate: 'edit_private',
  publish: 'publish',
  readPrivate: 'read_private',
  delete: 'delete',
  deleteOthers: 'delete_others',
  deletePublished: 'delete_published',
  deletePrivate: 'delete_private',
}

/** What WordPress's editor, author and contributor roles have over posts. */
const LEVELS: Readonly<Record<ContentRoleLevel, readonly Primitive[]>> = {
  editor: Object.keys(PRIMITIVES) as Primitive[],
  author: ['edit', 'editPublished', 'publish', 'delete', 'deletePublished'],
  contributor: ['edit', 'delete'],
}

/** Each primitive capability's label, as the Roles screen lists it. */
const LABELS: Readonly<Record<Primitive, (plural: string) => string>> = {
  edit: (p) => `Edit their own ${p}`,
  editOthers: (p) => `Edit others' ${p}`,
  editPublished: (p) => `Edit published ${p}`,
  editPrivate: (p) => `Edit private ${p}`,
  publish: (p) => `Publish ${p}`,
  readPrivate: (p) => `Read private ${p}`,
  delete: (p) => `Delete their own ${p}`,
  deleteOthers: (p) => `Delete others' ${p}`,
  deletePublished: (p) => `Delete published ${p}`,
  deletePrivate: (p) => `Delete private ${p}`,
}

/** `Courses` reads as `courses` mid-sentence; `FAQs` stays as it is. */
export function inSentence(label: string): string {
  const [first = '', second = ''] = label
  return second === second.toLowerCase() ? first.toLowerCase() + label.slice(1) : label
}

/** The names a type's capabilities get, like WordPress's `get_post_type_capabilities()`. */
export function contentCapabilities(
  pluginId: string,
  name: string,
  plural: string,
): ContentTypeCapabilities {
  const primitives = Object.fromEntries(
    Object.entries(PRIMITIVES).map(([key, verb]) => [key, `${pluginId}.${verb}_${plural}`]),
  ) as Record<Primitive, CapabilityName>
  const meta = (verb: string) => `${pluginId}.${verb}_${name}` as MetaCapabilityName
  return {
    ...primitives,
    editEntry: meta('edit'),
    readEntry: meta('read'),
    deleteEntry: meta('delete'),
    publishEntry: meta('publish'),
  }
}

type Change = 'edit' | 'delete'

const OWN = { edit: 'edit', delete: 'delete' } as const
const OTHERS = { edit: 'editOthers', delete: 'deleteOthers' } as const
const PUBLISHED = { edit: 'editPublished', delete: 'deletePublished' } as const
const PRIVATE = { edit: 'editPrivate', delete: 'deletePrivate' } as const

/**
 * WordPress's `map_meta_cap` for `edit_post` and `delete_post`. An author needs the type's
 * `edit`, or `editPublished` once it's published; anyone else needs `editOthers`, plus
 * `editPublished` or `editPrivate` for those statuses. An entry in the trash goes by the status it
 * had, for anyone else too: WordPress asks only `editOthers` for another's trashed post, so
 * someone who may not edit published posts could restore and edit one. An entry of another type
 * is refused, so a page can't be checked as a post.
 */
export function mapChange(
  change: Change,
  type: ContentType,
  user: User,
  entry: Entry,
): RequiredCapabilities {
  if (entry.type !== type.name) return false
  const caps = type.capabilities
  const status = entry.trashedFrom ?? entry.status
  if (entry.authorId !== null && entry.authorId === user.id) {
    return [status === 'published' ? caps[PUBLISHED[change]] : caps[OWN[change]]]
  }
  if (status === 'published') return [caps[OTHERS[change]], caps[PUBLISHED[change]]]
  if (status === 'private') return [caps[OTHERS[change]], caps[PRIVATE[change]]]
  return [caps[OTHERS[change]]]
}

/**
 * WordPress's `read_post`: published entries and one's own need only `core.read`; private ones
 * `readPrivate`; anyone else's drafts as much as editing them.
 */
export function mapRead(type: ContentType, user: User, entry: Entry): RequiredCapabilities {
  if (entry.type !== type.name) return false
  if (entry.status === 'published') return [READ as CapabilityName]
  if (entry.authorId !== null && entry.authorId === user.id) return [READ as CapabilityName]
  if (entry.status === 'private') return [type.capabilities.readPrivate]
  return mapChange('edit', type, user, entry)
}

/** WordPress's `publish_post`: the type's `publish`, whoever wrote it. */
export function mapPublish(type: ContentType, entry: Entry): RequiredCapabilities {
  return entry.type === type.name ? [type.capabilities.publish] : false
}

/**
 * Content types, like WordPress's `$wp_post_types`. Registering one declares its capabilities
 * and meta capabilities with the capability store and grants them to its roles, so like roles
 * they're rebuilt on every boot from what the active plugins register.
 */
export class ContentTypeStore {
  readonly #types = new Map<string, ContentType>()
  readonly #assertOpen: (what: string) => void
  readonly #capabilities: CapabilityStore

  constructor(assertOpen: (what: string) => void, capabilities: CapabilityStore) {
    this.#assertOpen = assertOpen
    this.#capabilities = capabilities
  }

  register(pluginId: string, name: string, definition: ContentTypeDefinition): ContentType {
    const qualified = `${pluginId}.${name}`
    this.#assertOpen(`content type "${qualified}"`)
    const type = describeType(pluginId, name, definition)
    const existing = this.#types.get(qualified)
    if (existing) {
      throw new Error(`Content type "${qualified}" is already registered`)
    }
    const caps = type.capabilities
    const plural = inSentence(type.labels.plural)
    for (const [key, label] of Object.entries(LABELS) as [Primitive, (p: string) => string][]) {
      this.#capabilities.capability(pluginId, caps[key], { label: label(plural) })
    }
    const singular = type.labels.singular
    const meta = (
      capability: string,
      label: string,
      map: (user: User, entry: Entry) => RequiredCapabilities,
    ) =>
      this.#capabilities.metaCapability(pluginId, capability, {
        label: `${singular}: ${label}`,
        map: (user, ...args) => map(user, args[0] as Entry),
      })
    meta(caps.editEntry, 'edit', (user, entry) => mapChange('edit', type, user, entry))
    meta(caps.readEntry, 'read', (user, entry) => mapRead(type, user, entry))
    meta(caps.deleteEntry, 'delete', (user, entry) => mapChange('delete', type, user, entry))
    meta(caps.publishEntry, 'publish', (_user, entry) => mapPublish(type, entry))
    for (const [role, level] of Object.entries(definition.roles ?? DEFAULT_CONTENT_ROLES)) {
      this.#capabilities.grant(
        pluginId,
        role,
        LEVELS[level].map((key) => caps[key]),
      )
    }
    this.#types.set(qualified, type)
    return type
  }

  get(name: string): ContentType | undefined {
    return this.#types.get(name)
  }

  list(): ContentType[] {
    return [...this.#types.values()]
  }
}

/** Checks a definition (plugins may be plain JavaScript) and fills in WordPress's defaults. */
function describeType(
  pluginId: string,
  name: string,
  definition: ContentTypeDefinition,
): ContentType {
  const qualified = `${pluginId}.${name}`
  if (!TYPE_NAME.test(name)) {
    throw new Error(
      `Invalid content type name "${name}": use lowercase letters, digits and underscores`,
    )
  }
  const plural = definition.plural ?? `${name}s`
  if (!TYPE_NAME.test(plural) || plural === name) {
    throw new Error(
      `Invalid plural "${plural}" for content type "${qualified}": use lowercase letters, digits and underscores, unlike the name`,
    )
  }
  const { singular, plural: pluralLabel } = definition.labels ?? {}
  for (const label of [singular, pluralLabel]) {
    if (typeof label !== 'string' || label.trim() === '' || label.length > MAX_LABEL) {
      throw new Error(`Content type "${qualified}" needs labels.singular and labels.plural`)
    }
  }
  const supports = definition.supports ?? DEFAULT_SUPPORTS
  const unknown = supports.filter((feature) => !FEATURES.includes(feature))
  if (unknown.length > 0) {
    throw new Error(
      `Content type "${qualified}" supports unknown features: ${unknown.join(', ')}. Use ${FEATURES.join(', ')}`,
    )
  }
  for (const [role, level] of Object.entries(definition.roles ?? {})) {
    if (!(level in LEVELS)) {
      throw new Error(
        `Content type "${qualified}" gives role "${role}" unknown level "${String(level)}": use editor, author or contributor`,
      )
    }
  }
  const revisions = definition.revisions ?? DEFAULT_REVISIONS
  if (!Number.isSafeInteger(revisions) || revisions < 0 || revisions > MAX_REVISIONS) {
    throw new Error(
      `Content type "${qualified}" keeps ${String(revisions)} revisions: use a whole number from 0 to ${MAX_REVISIONS}`,
    )
  }
  const isPublic = definition.public ?? false
  const showUi = definition.showUi ?? isPublic
  const base = pluginId === CORE ? ADMIN_PREFIX : `${ADMIN_PREFIX}/${pluginId}`
  return {
    name: qualified as ContentTypeName,
    pluginId,
    plural,
    labels: { singular: singular!.trim(), plural: pluralLabel!.trim() },
    description: definition.description ?? '',
    public: isPublic,
    hierarchical: definition.hierarchical ?? false,
    supports: [...new Set(supports)],
    showUi,
    showInMenu: showUi && (definition.showInMenu ?? true),
    hasArchive: isPublic && (definition.hasArchive ?? false),
    revisions: supports.includes('revisions') ? revisions : 0,
    adminPath: showUi ? `${base}/${plural}` : null,
    capabilities: contentCapabilities(pluginId, name, plural),
  }
}
