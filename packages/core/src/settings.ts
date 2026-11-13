import type {
  Database,
  SettingCondition,
  SettingDefinition,
  SettingDefinitions,
  SettingPair,
  SettingShowWhen,
} from '@otwdesign/sdk'
import { inArray, sql } from 'drizzle-orm'
import { storedSettings } from './core-schema'

export type Env = Readonly<Record<string, string | undefined>>

/** Where a value came from, highest precedence first. */
export type SettingSource = 'override' | 'env' | 'database' | 'default' | 'unset'

export type SettingValue = string | boolean | readonly string[] | readonly SettingPair[]

export interface DeclaredSetting {
  key: string
  pluginId: string
  definition: SettingDefinition
}

export interface ResolvedSetting extends DeclaredSetting {
  value: SettingValue | undefined
  source: SettingSource
}

type Parsed = { ok: true; value: SettingValue | undefined } | { ok: false; error: string }

const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_MAX_LENGTH = 500
const ROLE_ID = /^[a-z0-9_-]{1,64}$/
/** Roles one setting can name: more than any site has. */
const MAX_ROLES = 100
/** Rows a `pairs` setting takes unless it says. */
export const DEFAULT_MAX_ROWS = 20
const MAX_PAIR_NAME = 200
const MAX_PAIR_VALUE = 2000
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/
const TRUE = new Set(['1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off'])

export function declaredSettings(
  pluginId: string,
  settings: SettingDefinitions | undefined,
): DeclaredSetting[] {
  return Object.entries(settings ?? {}).flatMap(([key, definition]) =>
    definition ? [{ key, pluginId, definition: definition as SettingDefinition }] : [],
  )
}

export function validateSettingDefinitions(
  prefix: string,
  settings: SettingDefinitions | undefined,
): string[] {
  const errors: string[] = []
  for (const [key, definition] of Object.entries(settings ?? {})) {
    if (!definition) continue
    const field = definition as SettingDefinition
    if (!key.startsWith(prefix) || key.length === prefix.length) {
      errors.push(`setting "${key}" must start with "${prefix}"`)
    }
    if (field.env !== undefined && !ENV_NAME.test(field.env)) {
      errors.push(`setting "${key}" has an invalid env name "${field.env}"`)
    }
    if (field.type === 'entry' && typeof field.contentType !== 'string') {
      errors.push(`setting "${key}" needs the content type its entries are chosen from`)
    }
    if (field.type === 'pairs' && field.env !== undefined) {
      errors.push(`setting "${key}" is rows of pairs, which an environment variable can't hold`)
    }
    if (field.type === 'select') {
      if (field.options.length === 0) errors.push(`setting "${key}" needs at least one option`)
      if (field.default !== undefined && !field.options.some((o) => o.value === field.default)) {
        errors.push(`setting "${key}" default is not one of its options`)
      }
    }
  }
  return errors
}

/** Role ids from a list, or from text that separates them with commas or spaces. */
function checkRoles(value: unknown): Parsed {
  const list = typeof value === 'string' ? value.split(/[\s,]+/) : value
  if (!Array.isArray(list) || !list.every((role) => typeof role === 'string')) {
    return { ok: false, error: 'Choose from the roles' }
  }
  const roles = [...new Set(list.map((role: string) => role.trim().toLowerCase()).filter(Boolean))]
  return roles.length <= MAX_ROLES && roles.every((role) => ROLE_ID.test(role))
    ? { ok: true, value: roles }
    : { ok: false, error: 'Choose from the roles' }
}

/** Rows of a name and a value, trimmed, without the rows left empty. */
function checkPairs(
  definition: Extract<SettingDefinition, { type: 'pairs' }>,
  value: unknown,
): Parsed {
  if (!Array.isArray(value)) return { ok: false, error: 'Must be rows of a name and a value' }
  const pairs: SettingPair[] = []
  for (const row of value as unknown[]) {
    const { name, value: text } = (row ?? {}) as Partial<SettingPair>
    if (typeof name !== 'string' || typeof text !== 'string') {
      return { ok: false, error: 'Must be rows of a name and a value' }
    }
    if (name.trim() === '' && text.trim() === '') continue
    if (name.trim() === '') {
      return { ok: false, error: `Give "${text.trim().slice(0, 40)}" a name, or remove its row` }
    }
    if (name.trim().length > MAX_PAIR_NAME || text.trim().length > MAX_PAIR_VALUE) {
      return { ok: false, error: 'A row is too long' }
    }
    pairs.push({ name: name.trim(), value: text.trim() })
  }
  const max = definition.maxRows ?? DEFAULT_MAX_ROWS
  if (pairs.length > max) return { ok: false, error: `Use at most ${max} rows` }
  const error = definition.validate?.(pairs) ?? null
  return error ? { ok: false, error } : { ok: true, value: pairs }
}

function check(definition: SettingDefinition, value: SettingValue): Parsed {
  switch (definition.type) {
    case 'roles':
      return checkRoles(value)
    case 'pairs':
      return checkPairs(definition, value)
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, error: 'Must be on or off' }
    case 'select':
      return definition.options.some((option) => option.value === value)
        ? { ok: true, value }
        : { ok: false, error: 'Choose one of the options' }
    case 'secret':
      return typeof value === 'string' ? { ok: true, value } : { ok: false, error: 'Must be text' }
    // An id; whether it's still an entry is checked where it's used, which falls back without it.
    case 'entry':
      return typeof value === 'string' && ENTRY_ID.test(value)
        ? { ok: true, value: value.toLowerCase() }
        : { ok: false, error: 'Choose one of the entries' }
    case 'text': {
      if (typeof value !== 'string') return { ok: false, error: 'Must be text' }
      if (!definition.multiline && /[\r\n]/.test(value)) {
        return { ok: false, error: 'Must be one line' }
      }
      const max = definition.maxLength ?? DEFAULT_MAX_LENGTH
      if (value.length > max) return { ok: false, error: `Use at most ${max} characters` }
      const error = definition.validate?.(value) ?? null
      return error ? { ok: false, error } : { ok: true, value }
    }
  }
}

/** An environment variable, which is always text. */
export function parseEnvValue(definition: SettingDefinition, raw: string): Parsed {
  const text = raw.trim()
  if (definition.type !== 'boolean') {
    return text === '' ? { ok: true, value: undefined } : check(definition, text)
  }
  const lower = text.toLowerCase()
  if (TRUE.has(lower)) return { ok: true, value: true }
  if (FALSE.has(lower)) return { ok: true, value: false }
  return { ok: false, error: 'Use true or false' }
}

/**
 * A setting's value in a submitted admin form. Unchecked checkboxes are absent, so a boolean
 * that isn't there is off, and roles with none ticked are none. A `pairs` field posts its
 * columns as `{key}.name` and `{key}.value`, once per row.
 */
export function parseFormValue(definition: SettingDefinition, form: FormData, key: string): Parsed {
  const raw = form.get(key)
  if (definition.type === 'boolean') return { ok: true, value: raw !== null && raw !== '' }
  if (definition.type === 'roles') return checkRoles(form.getAll(key))
  if (definition.type === 'pairs') {
    const values = form.getAll(`${key}.value`)
    return checkPairs(
      definition,
      form.getAll(`${key}.name`).map((name, row) => ({ name, value: values[row] ?? '' })),
    )
  }
  if (raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, error: 'Must be text' }
  // Browsers post a textarea's line breaks as CRLF.
  const text = raw.replace(/\r\n?/g, '\n').trim()
  return text === '' ? { ok: true, value: undefined } : check(definition, text)
}

export function resolveSettings(input: {
  declared: readonly DeclaredSetting[]
  env: Env
  stored: ReadonlyMap<string, unknown>
  overrides: Readonly<Record<string, unknown>>
}): { values: Record<string, unknown>; settings: ResolvedSetting[]; warnings: string[] } {
  const warnings: string[] = []
  const values: Record<string, unknown> = { ...input.overrides }

  const settings = input.declared.map((declared): ResolvedSetting => {
    const { key, definition } = declared
    const override = input.overrides[key]
    if (override !== undefined) {
      return { ...declared, value: override as SettingValue, source: 'override' }
    }

    const raw = definition.env ? input.env[definition.env] : undefined
    if (raw !== undefined && raw.trim() !== '') {
      const parsed = parseEnvValue(definition, raw)
      if (parsed.ok && parsed.value !== undefined) {
        values[key] = parsed.value
        return { ...declared, value: parsed.value, source: 'env' }
      }
      if (!parsed.ok) warnings.push(`Ignoring ${definition.env} for "${key}": ${parsed.error}`)
    }

    if (definition.type !== 'secret' && input.stored.has(key)) {
      const parsed = check(definition, input.stored.get(key) as SettingValue)
      if (parsed.ok) {
        values[key] = parsed.value
        return { ...declared, value: parsed.value, source: 'database' }
      }
      warnings.push(`Ignoring the stored value of "${key}": ${parsed.error}`)
    }

    if (definition.type !== 'secret' && definition.default !== undefined) {
      values[key] = definition.default
      return { ...declared, value: definition.default, source: 'default' }
    }
    return { ...declared, value: undefined, source: 'unset' }
  })

  // A condition on a setting that isn't there, or isn't a choice, would hide its field for good.
  const byKey = new Map(input.declared.map((declared) => [declared.key, declared.definition]))
  for (const { key, definition } of input.declared) {
    for (const condition of conditionGroups(definition.showWhen).flat()) {
      const type = byKey.get(condition.setting)?.type
      if (type !== 'select' && type !== 'boolean') {
        warnings.push(
          `Setting "${key}" shows when "${condition.setting}" has a value, but that isn't a select or a checkbox setting of an active plugin`,
        )
      }
    }
  }

  return { values, settings, warnings }
}

/** A `showWhen`, as groups of conditions: any group, every condition in it. */
export function conditionGroups(showWhen: SettingShowWhen | undefined): SettingCondition[][] {
  if (!showWhen) return []
  const all = (entry: SettingCondition | readonly SettingCondition[]): SettingCondition[] =>
    'setting' in entry ? [entry] : [...entry]
  return 'any' in showWhen ? showWhen.any.map(all) : [all(showWhen)]
}

/** Set from code or the environment, or a secret: the admin shows these read-only. */
export function isLocked(setting: ResolvedSetting): boolean {
  return (
    setting.definition.type === 'secret' ||
    setting.source === 'env' ||
    setting.source === 'override'
  )
}

/**
 * Every stored value. The column is read as text and parsed here, once: drizzle parses a jsonb
 * string a second time, so the text "90" would come back as a number and "true" as a boolean, and
 * a text setting would lose its value.
 */
export async function loadStoredSettings(db: Database): Promise<Map<string, unknown>> {
  const rows = await db
    .select({ key: storedSettings.key, value: sql<string>`${storedSettings.value}::text` })
    .from(storedSettings)
  return new Map(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]))
}

/** `undefined` deletes the stored value, so the default applies again. */
export async function saveSettings(
  db: Database,
  values: ReadonlyMap<string, SettingValue | undefined>,
): Promise<void> {
  const cleared = [...values].filter(([, value]) => value === undefined).map(([key]) => key)
  const rows = [...values].flatMap(([key, value]) => (value === undefined ? [] : [{ key, value }]))
  if (cleared.length > 0) {
    await db.delete(storedSettings).where(inArray(storedSettings.key, cleared))
  }
  if (rows.length > 0) {
    await db
      .insert(storedSettings)
      .values(rows)
      .onConflictDoUpdate({
        target: storedSettings.key,
        set: { value: sql`excluded.value`, updatedAt: sql`now()` },
      })
  }
}
