import type { ContentTypeSelector, EntryMetaValues, MetaDefinition, MetaField } from '@otw/sdk'
import { ContentError } from '@otw/sdk'
import { selectedTypes } from './content-screens'

/** All of an entry's custom fields together, as JSON. */
export const MAX_META_BYTES = 1_000_000
const MAX_STRING = 10_000
const MAX_ITEMS = 100
const MAX_ITEM = 500
const KEY = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/
const TYPES = ['string', 'number', 'boolean', 'strings', 'json'] as const

function invalid(message: string): never {
  throw new ContentError('invalid_input', message)
}

/** A string field's options, as `{ value, label }` whichever way they were written. */
export function metaOptions(definition: MetaDefinition): { value: string; label: string }[] {
  if (definition.type !== 'string' || !definition.options) return []
  return definition.options.map((option) =>
    typeof option === 'string' ? { value: option, label: option } : option,
  )
}

/**
 * Checks one value against its field and returns it tidied: control characters out of text,
 * lists trimmed. Throws a `ContentError` naming the field.
 */
export function cleanMetaValue(field: MetaField, value: unknown): unknown {
  const { definition } = field
  const label = definition.label
  switch (definition.type) {
    case 'string': {
      if (typeof value !== 'string') invalid(`${label} must be text`)
      const clean = definition.multiline
        ? value.replace(/(?![\n\t])\p{Cc}/gu, '').trim()
        : value.replace(/\p{Cc}+/gu, ' ').trim()
      const max = definition.maxLength ?? MAX_STRING
      if (clean.length > max) invalid(`${label} is limited to ${max} characters`)
      const options = metaOptions(definition)
      if (options.length > 0 && !options.some((option) => option.value === clean)) {
        invalid(`${label} must be one of ${options.map((option) => option.label).join(', ')}`)
      }
      const error = definition.validate?.(clean)
      if (error) invalid(`${label}: ${error}`)
      return clean
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} must be a number`)
      if (definition.integer && !Number.isSafeInteger(value)) {
        invalid(`${label} must be a whole number`)
      }
      if (definition.min !== undefined && value < definition.min) {
        invalid(`${label} must be at least ${definition.min}`)
      }
      if (definition.max !== undefined && value > definition.max) {
        invalid(`${label} must be at most ${definition.max}`)
      }
      return value
    }
    case 'boolean':
      if (typeof value !== 'boolean') invalid(`${label} must be true or false`)
      return value
    case 'strings': {
      if (!Array.isArray(value)) invalid(`${label} must be a list of texts`)
      const items = value.map((item: unknown) => {
        if (typeof item !== 'string') invalid(`${label} must be a list of texts`)
        return item.replace(/\p{Cc}+/gu, ' ').trim()
      })
      const clean = items.filter(Boolean)
      const maxItems = definition.maxItems ?? MAX_ITEMS
      if (clean.length > maxItems) invalid(`${label} holds at most ${maxItems} items`)
      const max = definition.maxLength ?? MAX_ITEM
      if (clean.some((item) => item.length > max)) {
        invalid(`Each of ${label} is limited to ${max} characters`)
      }
      return clean
    }
    case 'json': {
      let parsed: unknown
      try {
        parsed = JSON.parse(JSON.stringify(value))
      } catch {
        invalid(`${label} must be plain data`)
      }
      if (parsed === undefined) invalid(`${label} must be plain data`)
      const error = definition.validate(parsed)
      if (error) invalid(`${label}: ${error}`)
      return parsed
    }
  }
}

/**
 * Custom fields, like WordPress's registered meta (`register_meta()`), but required: an entry
 * holds only fields registered for its type, so what's stored is always valid. Rebuilt on every
 * boot, like content types.
 */
export class MetaStore {
  readonly #fields = new Map<string, { field: MetaField; types: '*' | ReadonlySet<string> }>()
  readonly #assertOpen: (what: string) => void

  constructor(assertOpen: (what: string) => void) {
    this.#assertOpen = assertOpen
  }

  register(pluginId: string, key: string, definition: MetaDefinition): void {
    this.#assertOpen(`custom field "${key}"`)
    if (typeof key !== 'string' || !KEY.test(key) || !key.startsWith(`${pluginId}.`)) {
      throw new Error(
        `Invalid custom field key "${String(key)}": start it with "${pluginId}." and use lowercase letters, digits and underscores`,
      )
    }
    const owner = this.#fields.get(key)?.field.pluginId
    if (owner) throw new Error(`Custom field "${key}" is already registered by plugin "${owner}"`)
    if (typeof definition !== 'object' || definition === null) {
      throw new Error(`Custom field "${key}" needs a definition`)
    }
    if (!(TYPES as readonly string[]).includes(definition.type)) {
      throw new Error(
        `Custom field "${key}" has unknown type "${String(definition.type)}": use ${TYPES.join(', ')}`,
      )
    }
    if (typeof definition.label !== 'string' || !definition.label.trim()) {
      throw new Error(`Custom field "${key}" needs a label`)
    }
    if (definition.type === 'json' && typeof definition.validate !== 'function') {
      throw new Error(`Custom field "${key}" holds JSON, so it needs a validate function`)
    }
    const field: MetaField = { key, pluginId, definition }
    if (definition.default !== undefined) {
      try {
        cleanMetaValue(field, definition.default)
      } catch (error) {
        throw new Error(
          `Custom field "${key}" has an invalid default: ${(error as Error).message}`,
          { cause: error },
        )
      }
    }
    this.#fields.set(key, {
      field,
      types: selectedTypes(definition.types as ContentTypeSelector, `custom field "${key}"`),
    })
  }

  get(key: string): MetaField | undefined {
    return this.#fields.get(key)?.field
  }

  /** Whether entries of `type` have the field. */
  has(key: string, type: string): boolean {
    const found = this.#fields.get(key)
    return found !== undefined && (found.types === '*' || found.types.has(type))
  }

  /** The fields entries of `type` have, or all of them. */
  list(type?: string): MetaField[] {
    return [...this.#fields.values()]
      .filter(({ types }) => type === undefined || types === '*' || types.has(type))
      .map(({ field }) => field)
  }

  /** The defaults of `type`'s fields, under what an entry stores: what a reader sees. */
  withDefaults(type: string, stored: EntryMetaValues): EntryMetaValues {
    const defaults: Record<string, unknown> = {}
    for (const field of this.list(type)) {
      if (field.definition.default !== undefined) defaults[field.key] = field.definition.default
    }
    return { ...defaults, ...stored } as EntryMetaValues
  }

  /**
   * `stored` with `changes` applied: a value sets a field, `null` removes it. Every field set must
   * be registered for `type`; fields a deactivated plugin left are kept as they are.
   */
  merge(type: string, stored: EntryMetaValues, changes: unknown): EntryMetaValues {
    if (changes === undefined) return stored
    if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
      invalid('Pass custom fields as an object')
    }
    const merged: Record<string, unknown> = { ...stored }
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue
      if (value === null) {
        delete merged[key]
        continue
      }
      merged[key] = this.#clean(type, key, value)
    }
    return merged as EntryMetaValues
  }

  /**
   * Checks what a filter returned: every field that differs from `base` must be registered for
   * the type and valid. The whole must fit the size limit and Postgres's text (no NUL).
   */
  check(type: string, meta: unknown, base: EntryMetaValues): EntryMetaValues {
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      invalid('Custom fields must be an object')
    }
    const checked: Record<string, unknown> = {}
    const before = base as Record<string, unknown>
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined || value === null) continue
      checked[key] =
        JSON.stringify(value) === JSON.stringify(before[key])
          ? value
          : this.#clean(type, key, value)
    }
    const json = JSON.stringify(checked)
    if (Buffer.byteLength(json) > MAX_META_BYTES) invalid('The custom fields are too large')
    if (json.includes('\\u0000')) invalid('Custom fields cannot contain NUL characters')
    return checked as EntryMetaValues
  }

  #clean(type: string, key: string, value: unknown): unknown {
    const field = this.#fields.get(key)
    if (!field || !this.has(key, type)) invalid(`Unknown custom field "${key}" for ${type}`)
    return cleanMetaValue(field.field, value)
  }
}
