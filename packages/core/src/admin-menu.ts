import type { AdminIcon, CapabilityName, User } from '@otw/sdk'

/** Sections core owns. Plugin sections sit between the dashboard and these, in load order. */
const CORE_SECTIONS = {
  dashboard: { label: 'Dashboard', icon: 'dashboard' },
  plugins: { label: 'Plugins', icon: 'plugins' },
  users: { label: 'Users', icon: 'users' },
  settings: { label: 'Settings', icon: 'settings' },
} as const satisfies Record<string, { label: string; icon: AdminIcon }>

type CoreSection = keyof typeof CORE_SECTIONS

const DEFAULT_ORDER = 10

export interface MenuEntry {
  /** Qualified page name, for warnings. */
  key: string
  /** The plugin that registered the page. */
  pluginId: string
  label: string
  url: string
  order?: number
  capability: CapabilityName
  /** A core section or a plugin id. Defaults to the registering plugin's section. */
  parent?: string
}

export interface AdminMenuItem {
  key: string
  label: string
  url: string
}

/**
 * A top-level menu entry, linking to its first item. With more than one item, the items show as
 * its submenu, as in WordPress.
 */
export interface AdminMenuSection {
  id: string
  label: string
  icon: AdminIcon
  items: AdminMenuItem[]
}

interface Placed extends Required<Omit<MenuEntry, 'parent'>> {
  section: string
  sequence: number
}

function isCoreSection(id: string): id is CoreSection {
  return Object.hasOwn(CORE_SECTIONS, id)
}

/** The screens core serves from the app itself. */
export const CORE_MENU: readonly MenuEntry[] = [
  {
    key: 'core.dashboard',
    pluginId: 'core',
    label: 'Home',
    url: '/admin',
    order: 0,
    capability: 'core.access_admin',
    parent: 'dashboard',
  },
  {
    key: 'core.updates',
    pluginId: 'core',
    label: 'Updates',
    url: '/admin/updates',
    order: 1,
    capability: 'core.manage_updates',
    parent: 'dashboard',
  },
  {
    key: 'core.plugins',
    pluginId: 'core',
    label: 'Installed Plugins',
    url: '/admin/plugins',
    order: 0,
    capability: 'core.manage_plugins',
    parent: 'plugins',
  },
  {
    key: 'core.users',
    pluginId: 'core',
    label: 'All Users',
    url: '/admin/users',
    order: 0,
    capability: 'core.manage_users',
    parent: 'users',
  },
  {
    key: 'core.user-new',
    pluginId: 'core',
    label: 'Add User',
    url: '/admin/users/new',
    order: 1,
    capability: 'core.manage_users',
    parent: 'users',
  },
  {
    key: 'core.roles',
    pluginId: 'core',
    label: 'Roles',
    url: '/admin/users/roles',
    order: 2,
    capability: 'core.manage_users',
    parent: 'users',
  },
]

/**
 * The admin menu, like WordPress's `$menu` and `$submenu`: every plugin gets a section, and a
 * page can join a core section or another plugin's instead (`add_submenu_page`).
 */
export class AdminMenu {
  readonly #entries: MenuEntry[] = [...CORE_MENU]
  #placed: Placed[] = []
  #sections: { id: string; label: string; icon: AdminIcon }[] = []

  add(entry: MenuEntry): void {
    this.#entries.push(entry)
  }

  /** Resolves parents once the active plugins are known. Returns warnings about unknown ones. */
  seal(input: {
    active: readonly string[]
    installed: ReadonlySet<string>
    label(pluginId: string): string
    icon(pluginId: string): AdminIcon
  }): string[] {
    const warnings: string[] = []
    const active = new Set(input.active)
    const sectionFor = (entry: MenuEntry): string => {
      const parent = entry.parent ?? entry.pluginId
      if (isCoreSection(parent) || active.has(parent)) return parent
      if (!input.installed.has(parent)) {
        warnings.push(`Admin page "${entry.key}" names unknown menu parent "${parent}"`)
      }
      return entry.pluginId
    }
    this.#placed = this.#entries.map((entry, sequence) => ({
      key: entry.key,
      pluginId: entry.pluginId,
      label: entry.label,
      url: entry.url,
      order: entry.order ?? DEFAULT_ORDER,
      capability: entry.capability,
      section: sectionFor(entry),
      sequence,
    }))
    this.#sections = [
      { id: 'dashboard', ...CORE_SECTIONS.dashboard },
      ...input.active.map((id) => ({ id, label: input.label(id), icon: input.icon(id) })),
      ...(['plugins', 'users', 'settings'] as const).map((id) => ({ id, ...CORE_SECTIONS[id] })),
    ]
    return warnings
  }

  /** The sections and items this user may open; empty sections are left out. */
  build(user: User, can: (user: User, capability: CapabilityName) => boolean): AdminMenuSection[] {
    if (!can(user, 'core.access_admin')) return []
    const visible = this.#placed
      .filter((entry) => can(user, entry.capability))
      .sort((a, b) => a.order - b.order || a.sequence - b.sequence)
    return this.#sections.flatMap(({ id, label, icon }) => {
      const items = visible
        .filter((entry) => entry.section === id)
        .map(({ key, label, url }) => ({ key, label, url }))
      return items.length > 0 ? [{ id, label, icon, items }] : []
    })
  }
}
