import type {
  CapabilityName,
  ContentRoleLevel,
  ContentTypeName,
  MetaCapabilityName,
  RequiredCapabilities,
  Taxonomy,
  TaxonomyCapabilities,
  TaxonomyDefinition,
  TaxonomyName,
  Term,
} from '@otwdesign/sdk'
import type { CapabilityStore } from './capabilities'
import { DEFAULT_CONTENT_ROLES, inSentence } from './content-types'
import { slugify } from './slugs'

const NAME = /^[a-z][a-z0-9_]*$/
const MAX_LABEL = 100

type Primitive = 'manage' | 'edit' | 'delete' | 'assign'

/** WordPress's split: editors manage terms; authors and contributors may only assign them. */
const LEVELS: Readonly<Record<ContentRoleLevel, readonly Primitive[]>> = {
  editor: ['manage', 'edit', 'delete', 'assign'],
  author: ['assign'],
  contributor: ['assign'],
}

const LABELS: Readonly<Record<Primitive, (plural: string) => string>> = {
  manage: (p) => `Manage ${p}`,
  edit: (p) => `Add and edit ${p}`,
  delete: (p) => `Delete ${p}`,
  assign: (p) => `Assign ${p}`,
}

/** The names a taxonomy's capabilities get, as WordPress's `$taxonomy->cap`. */
export function taxonomyCapabilities(
  pluginId: string,
  name: string,
  plural: string,
): TaxonomyCapabilities {
  const primitive = (verb: Primitive) => `${pluginId}.${verb}_${plural}` as CapabilityName
  const meta = (verb: string) => `${pluginId}.${verb}_${name}` as MetaCapabilityName
  return {
    manage: primitive('manage'),
    edit: primitive('edit'),
    delete: primitive('delete'),
    assign: primitive('assign'),
    editTerm: meta('edit'),
    deleteTerm: meta('delete'),
    assignTerm: meta('assign'),
  }
}

/** Whether `term` is the taxonomy's default term, which can't be deleted or lose its slug. */
export function isDefaultTerm(taxonomy: Taxonomy, term: Pick<Term, 'slug'>): boolean {
  return taxonomy.defaultTerm?.slug === term.slug
}

/**
 * WordPress's `map_meta_cap` for terms: a term of another taxonomy is refused, and the default
 * term can't be deleted by anyone.
 */
export function mapTermCapability(
  taxonomy: Taxonomy,
  verb: 'edit' | 'delete' | 'assign',
  term: Term,
): RequiredCapabilities {
  if (term.taxonomy !== taxonomy.name) return false
  if (verb === 'delete' && isDefaultTerm(taxonomy, term)) return false
  return [taxonomy.capabilities[verb]]
}

/**
 * Taxonomies, like WordPress's `$wp_taxonomies`. Registering one declares its capabilities and
 * grants them, so like roles they're rebuilt on every boot from what the active plugins register.
 */
export class TaxonomyStore {
  readonly #taxonomies = new Map<string, Taxonomy>()
  readonly #assertOpen: (what: string) => void
  readonly #capabilities: CapabilityStore

  constructor(assertOpen: (what: string) => void, capabilities: CapabilityStore) {
    this.#assertOpen = assertOpen
    this.#capabilities = capabilities
  }

  /** `adminPathOf` gives a type's screens, under which the taxonomy's screen goes. */
  register(
    pluginId: string,
    name: string,
    definition: TaxonomyDefinition,
    adminPathOf: (type: string) => string | null | undefined,
  ): Taxonomy {
    const qualified = `${pluginId}.${name}`
    this.#assertOpen(`taxonomy "${qualified}"`)
    if (this.#taxonomies.has(qualified)) {
      throw new Error(`Taxonomy "${qualified}" is already registered`)
    }
    const taxonomy = describeTaxonomy(pluginId, name, definition, adminPathOf)
    const caps = taxonomy.capabilities
    const plural = inSentence(taxonomy.labels.plural)
    for (const verb of Object.keys(LABELS) as Primitive[]) {
      this.#capabilities.capability(pluginId, caps[verb], { label: LABELS[verb](plural) })
    }
    const singular = taxonomy.labels.singular
    for (const verb of ['edit', 'delete', 'assign'] as const) {
      this.#capabilities.metaCapability(pluginId, caps[`${verb}Term`], {
        label: `${singular}: ${verb}`,
        map: (_user, ...args) => mapTermCapability(taxonomy, verb, args[0] as Term),
      })
    }
    for (const [role, level] of Object.entries(definition.roles ?? DEFAULT_CONTENT_ROLES)) {
      this.#capabilities.grant(
        pluginId,
        role,
        LEVELS[level].map((verb) => caps[verb]),
      )
    }
    this.#taxonomies.set(qualified, taxonomy)
    return taxonomy
  }

  has(name: string): boolean {
    return this.#taxonomies.has(name)
  }

  get(name: string): Taxonomy | undefined {
    return this.#taxonomies.get(name)
  }

  /** Every taxonomy, or those classifying `type`. */
  list(type?: string): Taxonomy[] {
    const all = [...this.#taxonomies.values()]
    return type === undefined ? all : all.filter((t) => t.types.includes(type as ContentTypeName))
  }
}

function describeTaxonomy(
  pluginId: string,
  name: string,
  definition: TaxonomyDefinition,
  adminPathOf: (type: string) => string | null | undefined,
): Taxonomy {
  const qualified = `${pluginId}.${name}`
  if (!NAME.test(name)) {
    throw new Error(
      `Invalid taxonomy name "${name}": use lowercase letters, digits and underscores`,
    )
  }
  const plural = definition.plural ?? `${name}s`
  if (!NAME.test(plural) || plural === name) {
    throw new Error(`Invalid plural "${plural}" for taxonomy "${qualified}"`)
  }
  const { singular, plural: pluralLabel } = definition.labels ?? {}
  for (const label of [singular, pluralLabel]) {
    if (typeof label !== 'string' || label.trim() === '' || label.length > MAX_LABEL) {
      throw new Error(`Taxonomy "${qualified}" needs labels.singular and labels.plural`)
    }
  }
  const types = definition.types
  if (!Array.isArray(types) || types.some((type) => typeof type !== 'string')) {
    throw new Error(`Taxonomy "${qualified}" needs the content types it classifies, in types`)
  }
  for (const [role, level] of Object.entries(definition.roles ?? {})) {
    if (!(level in LEVELS)) {
      throw new Error(
        `Taxonomy "${qualified}" gives role "${role}" unknown level "${String(level)}": use editor, author or contributor`,
      )
    }
  }
  const defaultTerm = definition.defaultTerm
  let defaultSlug = ''
  if (defaultTerm !== undefined) {
    defaultSlug = slugify(defaultTerm.slug ?? defaultTerm.name ?? '')
    if (typeof defaultTerm.name !== 'string' || !defaultTerm.name.trim() || !defaultSlug) {
      throw new Error(`Taxonomy "${qualified}" needs a name for its default term`)
    }
  }
  const isPublic = definition.public ?? true
  const showUi = definition.showUi ?? isPublic
  const screens = types.map((type) => adminPathOf(type)).find((path) => path)
  return {
    name: qualified as TaxonomyName,
    pluginId,
    labels: { singular: singular!.trim(), plural: pluralLabel!.trim() },
    description: definition.description ?? '',
    types: [...new Set(types)],
    hierarchical: definition.hierarchical ?? false,
    public: isPublic,
    showUi,
    showAdminColumn: definition.showAdminColumn ?? false,
    defaultTerm: defaultTerm
      ? {
          name: defaultTerm.name.trim(),
          slug: defaultSlug,
          description: defaultTerm.description ?? '',
        }
      : null,
    adminPath: showUi && screens ? `${screens}/${plural}` : null,
    capabilities: taxonomyCapabilities(pluginId, name, plural),
  }
}
