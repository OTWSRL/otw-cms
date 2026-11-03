import type {
  ContentBulkAction,
  ContentColumn,
  ContentMetaBox,
  ContentRowAction,
  ContentTypeSelector,
} from '@otwdesign/sdk'

const NAME = /^[a-z][a-z0-9-]*$/
const DEFAULT_ORDER = 10

/** An extension, named `${pluginId}.${name}` so plugins' own names can't clash. */
export type Keyed<T> = T & { key: string; pluginId: string }

/** What plugins add to one content type's screens. */
export interface ContentScreenExtensions {
  columns: Keyed<ContentColumn>[]
  metaBoxes: Keyed<ContentMetaBox>[]
  rowActions: Keyed<ContentRowAction>[]
  bulkActions: Keyed<ContentBulkAction>[]
}

interface Registered<T> {
  types: '*' | ReadonlySet<string>
  item: Keyed<T>
}

type Kind = keyof ContentScreenExtensions

const WHAT: Record<Kind, string> = {
  columns: 'column',
  metaBoxes: 'meta box',
  rowActions: 'row action',
  bulkActions: 'bulk action',
}

/**
 * Columns, meta boxes, row actions and bulk actions plugins add to content types' screens, like
 * the `manage_{$post_type}_posts_columns` and `add_meta_boxes` hooks. Registered by admin entries;
 * a type that isn't registered (its plugin is off) simply never asks for them.
 */
export class ContentScreenStore {
  readonly #assertOpen: (what: string) => void
  readonly #registered: { [K in Kind]: Registered<ContentScreenExtensions[K][number]>[] } = {
    columns: [],
    metaBoxes: [],
    rowActions: [],
    bulkActions: [],
  }

  constructor(assertOpen: (what: string) => void) {
    this.#assertOpen = assertOpen
  }

  column(pluginId: string, types: ContentTypeSelector, column: ContentColumn<unknown>): void {
    if (typeof column.render !== 'function') {
      throw new TypeError(`Column "${pluginId}.${column.name}" needs a render function`)
    }
    this.#add('columns', pluginId, types, column)
  }

  metaBox(pluginId: string, types: ContentTypeSelector, box: ContentMetaBox): void {
    const fields = box.fields
    const hasFields =
      Array.isArray(fields) && fields.length > 0 && fields.every((key) => typeof key === 'string')
    if (fields !== undefined && !hasFields) {
      throw new TypeError(`Meta box "${pluginId}.${box.name}" needs its fields as a list of keys`)
    }
    if (typeof box.component !== 'function' && !hasFields) {
      throw new TypeError(`Meta box "${pluginId}.${box.name}" needs a component or fields`)
    }
    if (box.context !== undefined && box.context !== 'normal' && box.context !== 'side') {
      throw new Error(`Meta box "${pluginId}.${box.name}" goes in "normal" or "side"`)
    }
    this.#add('metaBoxes', pluginId, types, box)
  }

  rowAction(pluginId: string, types: ContentTypeSelector, action: ContentRowAction): void {
    if (typeof action.link !== 'function') {
      throw new TypeError(`Row action "${pluginId}.${action.name}" needs a link function`)
    }
    this.#add('rowActions', pluginId, types, action)
  }

  bulkAction(pluginId: string, types: ContentTypeSelector, action: ContentBulkAction): void {
    if (typeof action.handler !== 'function') {
      throw new TypeError(`Bulk action "${pluginId}.${action.name}" needs a handler`)
    }
    this.#add('bulkActions', pluginId, types, action)
  }

  /** Every meta box, whichever types it's for. */
  allMetaBoxes(): Keyed<ContentMetaBox>[] {
    return this.#registered.metaBoxes.map(({ item }) => item)
  }

  /** What applies to `type`, in registration (load) order; meta boxes by `order` first. */
  for(type: string): ContentScreenExtensions {
    const pick = <K extends Kind>(kind: K) =>
      this.#registered[kind]
        .filter(({ types }) => types === '*' || types.has(type))
        .map(({ item }) => item) as ContentScreenExtensions[K]
    return {
      columns: pick('columns'),
      metaBoxes: pick('metaBoxes').sort(
        (a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER),
      ),
      rowActions: pick('rowActions'),
      bulkActions: pick('bulkActions'),
    }
  }

  #add<K extends Kind>(
    kind: K,
    pluginId: string,
    types: ContentTypeSelector,
    item: Omit<ContentScreenExtensions[K][number], 'key' | 'pluginId'>,
  ): void {
    const what = WHAT[kind]
    this.#assertOpen(`${what} "${pluginId}.${item.name}"`)
    if (typeof item.name !== 'string' || !NAME.test(item.name)) {
      throw new Error(`Invalid ${what} name "${String(item.name)}"`)
    }
    const key = `${pluginId}.${item.name}`
    if (this.#registered[kind].some((entry) => entry.item.key === key)) {
      throw new Error(`The ${what} "${key}" is already registered`)
    }
    this.#registered[kind].push({
      types: selectedTypes(types, `${what} "${key}"`),
      item: { ...item, key, pluginId } as Keyed<ContentScreenExtensions[K][number]>,
    } as Registered<ContentScreenExtensions[K][number]>)
  }
}

/** A selector's type names, or `'*'`; `what` names the registration in errors. */
export function selectedTypes(types: ContentTypeSelector, what: string): '*' | ReadonlySet<string> {
  if (types === '*') return '*'
  const list: readonly unknown[] = typeof types === 'string' ? [types] : types
  if (!Array.isArray(list) || list.length === 0 || list.some((t) => typeof t !== 'string')) {
    throw new Error(`The ${what} needs content type names, or '*' for all`)
  }
  return new Set(list as string[])
}
