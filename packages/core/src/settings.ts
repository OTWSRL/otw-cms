import type { Database, SettingDefinition, SettingDefinitions } from '@otwdesign/sdk'
import { inArray, sql } from 'drizzle-orm'
import { storedSettings } from './core-schema'

export type Env = Readonly<Record<string, string | undefined>>

/** Where a value came from, highest precedence first. */
export type SettingSource = 'override' | 'env' | 'database' | 'default' | 'unset'

export type SettingValue = string | boolean

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
    if (field.type === 'select') {
      if (field.options.length === 0) errors.push(`setting "${key}" needs at least one option`)
      if (field.default !== undefined && !field.options.some((o) => o.value === field.default)) {
        errors.push(`setting "${key}" default is not one of its options`)
      }
    }
  }
  return errors
}

function check(definition: SettingDefinition, value: SettingValue): Parsed {
  switch (definition.type) {
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

/** A submitted admin form field. Unchecked checkboxes are absent, so `null` means off. */
export function parseFormValue(
  definition: SettingDefinition,
  raw: FormDataEntryValue | null,
): Parsed {
  if (definition.type === 'boolean') return { ok: true, value: raw !== null && raw !== '' }
  if (raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, error: 'Must be text' }
  const text = raw.trim()
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

  return { values, settings, warnings }
}

/** Set from code or the environment, or a secret: the admin shows these read-only. */
export function isLocked(setting: ResolvedSetting): boolean {
  return (
    setting.definition.type === 'secret' ||
    setting.source === 'env' ||
    setting.source === 'override'
  )
}

export async function loadStoredSettings(db: Database): Promise<Map<string, unknown>> {
  const rows = await db.select().from(storedSettings)
  return new Map(rows.map((row) => [row.key, row.value]))
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
