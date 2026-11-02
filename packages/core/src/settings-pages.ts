import type {
  CapabilityName,
  SettingDefinition,
  SettingsFields,
  SettingsPage,
  SettingsSection,
} from '@otw/sdk'
import { ActionError } from '@otw/sdk'
import {
  isLocked,
  parseFormValue,
  type ResolvedSetting,
  type SettingSource,
  type SettingValue,
} from './settings'

const NAME = /^[a-z][a-z0-9-]*$/
const DEFAULT_ORDER = 10
/** Sections made for fields nobody placed come after the ones plugins asked for. */
const LEFTOVER_ORDER = 1000
export const SETTINGS_CAPABILITY: CapabilityName = 'core.manage_settings'

export interface SettingsPageEntry {
  key: string
  pluginId: string
  title: string
  description?: string
  url: string
  capability: CapabilityName
  menu: { label: string; order: number; parent: string }
  /** Made by core for a plugin that declares settings but no page for them. */
  automatic: boolean
}

export interface PlacedSection {
  key: string
  pluginId: string
  title: string
  description?: string
  fields: string[]
}

export interface ResolvedSettingsPage extends SettingsPageEntry {
  sections: PlacedSection[]
}

export interface SettingField {
  key: string
  type: SettingDefinition['type']
  label: string
  description?: string
  options?: readonly { value: string; label: string }[]
  /** For `entry` fields: the content type whose entries it chooses from. */
  contentType?: string
  /** Never set for secrets. */
  value?: SettingValue
  /** Secrets only: whether the environment variable is set. */
  configured?: boolean
  source: SettingSource
  locked: boolean
  env?: string
}

export interface SettingsSectionView {
  key: string
  title: string
  description?: string
  fields: SettingField[]
}

export interface SettingsPageView {
  key: string
  title: string
  description?: string
  sections: SettingsSectionView[]
  /** False when every field is locked, so there is nothing to save. */
  editable: boolean
}

interface SectionEntry extends PlacedSection {
  page: string
  order: number
  sequence: number
}

function ownerOf(qualified: string): string {
  return qualified.slice(0, qualified.indexOf('.'))
}

function assertName(what: string, name: string): void {
  if (!NAME.test(name)) throw new Error(`Invalid ${what} name "${name}"`)
}

/**
 * Where settings show, like WordPress's Settings API: pages, sections on any page, and fields in
 * any section. A plugin may place only its own fields; values stay owned by the plugin that
 * declares them, so deactivating it takes its fields off every page.
 */
export class SettingsLayoutStore {
  readonly #pages: (SettingsPageEntry & { sequence: number })[] = []
  readonly #sections: SectionEntry[] = []
  readonly #extensions: (SettingsFields & { pluginId: string; sequence: number })[] = []
  readonly #placed = new Map<string, string>()
  readonly #owners: ReadonlyMap<string, string>
  readonly #assertOpen: (what: string) => void
  #sequence = 0

  /** `owners` maps each declared setting key to its plugin, for the active plugins. */
  constructor(assertOpen: (what: string) => void, owners: ReadonlyMap<string, string>) {
    this.#assertOpen = assertOpen
    this.#owners = owners
  }

  page(pluginId: string, page: SettingsPage, url: string): SettingsPageEntry {
    this.#assertOpen(`settings page "${page.name}"`)
    assertName('settings page', page.name)
    const entry: SettingsPageEntry = {
      key: `${pluginId}.${page.name}`,
      pluginId,
      title: page.title,
      description: page.description,
      url,
      capability: page.capability ?? SETTINGS_CAPABILITY,
      menu: {
        label: page.menu?.label ?? page.title,
        order: page.menu?.order ?? DEFAULT_ORDER,
        parent: page.menu?.parent ?? 'settings',
      },
      automatic: false,
    }
    this.#pages.push({ ...entry, sequence: this.#sequence++ })
    return entry
  }

  section(pluginId: string, section: SettingsSection): void {
    this.#assertOpen(`settings section "${section.name}"`)
    assertName('settings section', section.name)
    const key = `${pluginId}.${section.name}`
    if (this.#sections.some((existing) => existing.key === key)) {
      throw new Error(`Settings section "${key}" is already registered`)
    }
    this.#claim(pluginId, key, section.fields)
    this.#sections.push({
      key,
      pluginId,
      page: section.page,
      title: section.title,
      description: section.description,
      order: section.order ?? DEFAULT_ORDER,
      fields: [...section.fields],
      sequence: this.#sequence++,
    })
  }

  fields(pluginId: string, extension: SettingsFields): void {
    this.#assertOpen(`settings fields for "${extension.section}"`)
    this.#claim(pluginId, extension.section, extension.fields)
    this.#extensions.push({ ...extension, pluginId, sequence: this.#sequence++ })
  }

  /**
   * Places every section and field. Anything aimed at a page or section that isn't there moves
   * to its owner's first settings page, as do fields nobody placed; a plugin without a page gets
   * one. Only targets from active plugins are reported, since the rest are optional integrations.
   */
  resolve(input: {
    isActive(pluginId: string): boolean
    label(pluginId: string): string
    automaticUrl(pluginId: string): string
  }): { pages: ResolvedSettingsPage[]; warnings: string[] } {
    const warnings: string[] = []
    const pages = new Map<string, ResolvedSettingsPage & { sequence: number }>(
      this.#pages.map((page) => [page.key, { ...page, sections: [] }]),
    )
    const sectionOrder = new Map<string, { order: number; sequence: number }>()
    // Pages and sections made here sort after everything registered.
    let next = this.#sequence

    const fallbackFor = (pluginId: string) => {
      const own = [...pages.values()].find((page) => page.pluginId === pluginId)
      if (own) return own
      const title = input.label(pluginId)
      const page = {
        key: `${pluginId}.settings`,
        pluginId,
        title,
        url: input.automaticUrl(pluginId),
        capability: SETTINGS_CAPABILITY,
        menu: { label: title, order: DEFAULT_ORDER, parent: 'settings' },
        automatic: true,
        sections: [] as PlacedSection[],
        sequence: next++,
      }
      pages.set(page.key, page)
      return page
    }
    const report = (target: string, message: string) => {
      if (input.isActive(ownerOf(target))) warnings.push(message)
    }

    const placed = new Map<string, PlacedSection>()
    for (const { page, order, sequence, ...section } of this.#sections) {
      let target = pages.get(page)
      if (!target) {
        report(page, `Settings section "${section.key}" names unknown page "${page}"`)
        target = fallbackFor(section.pluginId)
      }
      const entry = { ...section, fields: [...section.fields] }
      target.sections.push(entry)
      placed.set(entry.key, entry)
      sectionOrder.set(entry.key, { order, sequence })
    }

    const leftovers = new Map<string, string[]>()
    const leave = (pluginId: string, keys: readonly string[]) =>
      leftovers.set(pluginId, [...(leftovers.get(pluginId) ?? []), ...keys])
    for (const extension of this.#extensions) {
      const target = placed.get(extension.section)
      if (target) {
        target.fields.push(...extension.fields)
        continue
      }
      report(
        extension.section,
        `Settings fields from "${extension.pluginId}" name unknown section "${extension.section}"`,
      )
      leave(extension.pluginId, extension.fields)
    }
    for (const [key, pluginId] of this.#owners) {
      if (!this.#placed.has(key)) leave(pluginId, [key])
    }

    for (const [pluginId, fields] of leftovers) {
      const page = fallbackFor(pluginId)
      const key = `${pluginId}.unplaced`
      page.sections.push({ key, pluginId, title: input.label(pluginId), fields })
      sectionOrder.set(key, { order: LEFTOVER_ORDER, sequence: next++ })
    }

    const rank = (key: string) => sectionOrder.get(key)!
    const resolved = [...pages.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .map(({ sequence: _sequence, ...page }) => ({
        ...page,
        sections: page.sections.sort(
          (a, b) =>
            rank(a.key).order - rank(b.key).order || rank(a.key).sequence - rank(b.key).sequence,
        ),
      }))
    return { pages: resolved, warnings }
  }

  #claim(pluginId: string, target: string, fields: readonly string[]): void {
    for (const key of fields) {
      if (this.#owners.get(key) !== pluginId) {
        throw new Error(`Plugin "${pluginId}" can only place its own settings, not "${key}"`)
      }
      const existing = this.#placed.get(key)
      if (existing) throw new Error(`Setting "${key}" is already placed in "${existing}"`)
      this.#placed.set(key, target)
    }
  }
}

export function toField(setting: ResolvedSetting): SettingField {
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
    contentType: definition.type === 'entry' ? definition.contentType : undefined,
  }
}

export function pageView(
  page: ResolvedSettingsPage,
  settings: ReadonlyMap<string, ResolvedSetting>,
): SettingsPageView {
  const sections = page.sections.map((section) => ({
    key: section.key,
    title: section.title,
    description: section.description,
    fields: section.fields.map((key) => toField(settings.get(key)!)),
  }))
  return {
    key: page.key,
    title: page.title,
    description: page.description,
    sections,
    editable: sections.some((section) => section.fields.some((field) => !field.locked)),
  }
}

/**
 * The values a form post would save: only editable fields placed on this page, so a crafted
 * form can't reach settings from another page (WordPress's `allowed_options`). Throws on the
 * first invalid field, so nothing is saved.
 */
export function pageUpdates(
  page: ResolvedSettingsPage,
  settings: ReadonlyMap<string, ResolvedSetting>,
  form: FormData,
): Map<string, SettingValue | undefined> {
  const editable = page.sections
    .flatMap((section) => section.fields)
    .map((key) => settings.get(key)!)
    .filter((setting) => !isLocked(setting))
  if (editable.length === 0) throw new ActionError('There is nothing to save on this page.')
  const updates = new Map<string, SettingValue | undefined>()
  for (const setting of editable) {
    const parsed = parseFormValue(setting.definition, form.get(setting.key))
    if (!parsed.ok) throw new ActionError(`${setting.definition.label}: ${parsed.error}.`)
    updates.set(setting.key, parsed.value)
  }
  return updates
}
