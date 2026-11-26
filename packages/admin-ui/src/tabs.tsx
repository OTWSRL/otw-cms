import { cx } from './button'

/**
 * The attribute that has the admin open a plain link as it opens its menu's: the next screen
 * without loading the page again. For links between admin screens only; a link to anything
 * else, or to a screen that runs a script of its own as it loads, stays plain.
 */
export const ADMIN_LINK = 'data-admin-link'

/** One of a screen's tabs. */
export interface Tab {
  label: string
  href: string
  current?: boolean
}

/**
 * WordPress's tabs across the top of a screen (`.nav-tab-wrapper`), for one plugin's screens:
 * a plugin keeps one link in the menu and its screens as tabs. A tab opens without loading the
 * page again, as a menu link does.
 */
export function Tabs({ label, tabs }: { label: string; tabs: readonly Tab[] }) {
  return (
    <nav className="nav-tab-wrapper" aria-label={label}>
      {tabs.map((tab) => (
        <a
          key={tab.href}
          href={tab.href}
          className={cx('nav-tab', tab.current && 'nav-tab-active')}
          aria-current={tab.current ? 'page' : undefined}
          {...{ [ADMIN_LINK]: '' }}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  )
}
