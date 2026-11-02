'use client'

import { AdminIcon, cx } from '@otw/admin-ui'
import type { AdminMenuSection } from '@otw/core'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MouseEvent,
} from 'react'
import { MENU_COOKIE, type MenuPreference } from './admin-menu-preference'
import { cancelNavigationProgress, NavigationProgress } from './navigation-progress'

interface Frame {
  menuOpen: boolean
  setMenuOpen(open: boolean): void
  toggleFolded(): void
}

const FrameContext = createContext<Frame | null>(null)

function useFrame(): Frame {
  const frame = useContext(FrameContext)
  if (!frame) throw new Error('Admin frame controls must be inside <AdminFrame>')
  return frame
}

/** WordPress folds the menu to icons from 960px down to 783px, and hides it below that. */
const AUTO_FOLD = '(max-width: 960px)'

/**
 * The admin's outer frame. Holds what WordPress keeps in body classes: `folded` (collapsed by
 * the user, remembered in a cookie as WordPress's `mfold` user setting is), `auto-fold`
 * (collapsed by screen width) and `wp-responsive-open` (the phone menu is showing).
 */
export function AdminFrame({
  preference: initial,
  children,
}: {
  preference: MenuPreference
  children: ReactNode
}) {
  const [preference, setPreference] = useState(initial)
  const [menuOpen, setMenuOpen] = useState(false)

  const toggleFolded = () => {
    // Between 783px and 960px the menu folds by itself, so the button there means "keep it open".
    const narrow = window.matchMedia(AUTO_FOLD).matches
    const next: MenuPreference = narrow
      ? preference === 'unfolded'
        ? 'auto'
        : 'unfolded'
      : preference === 'folded'
        ? 'auto'
        : 'folded'
    setPreference(next)
    document.cookie =
      next === 'auto'
        ? `${MENU_COOKIE}=; path=/admin; max-age=0; samesite=lax`
        : `${MENU_COOKIE}=${next}; path=/admin; max-age=31536000; samesite=lax`
  }

  return (
    <FrameContext.Provider value={{ menuOpen, setMenuOpen, toggleFolded }}>
      <div
        className={cx(
          'cms-admin',
          preference !== 'unfolded' && 'auto-fold',
          preference === 'folded' && 'folded',
          menuOpen && 'wp-responsive-open',
        )}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && menuOpen) setMenuOpen(false)
        }}
      >
        <NavigationProgress />
        {children}
      </div>
    </FrameContext.Provider>
  )
}

/** The admin bar's hamburger, shown below 783px. */
export function MenuToggle() {
  const { menuOpen, setMenuOpen } = useFrame()
  return (
    <button
      type="button"
      className="ab-item menu-toggle"
      aria-expanded={menuOpen}
      aria-controls="adminmenumain"
      onClick={() => {
        // The menu opens at the top of the page, where the bar is on small phones.
        if (!menuOpen) window.scrollTo({ top: 0 })
        setMenuOpen(!menuOpen)
      }}
    >
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
        <path d="M2 4h16v2.2H2zM2 8.9h16v2.2H2zM2 13.8h16V16H2z" fill="currentColor" />
      </svg>
      <span className="screen-reader-text">Menu</span>
    </button>
  )
}

/**
 * The item whose URL is the longest match for the current path, so an edit screen marks its
 * list and `/admin/commerce/settings/payments` marks Payments rather than Shop as well.
 */
function currentUrl(sections: readonly AdminMenuSection[], pathname: string): string | undefined {
  return sections
    .flatMap((section) => section.items.map((item) => item.url))
    .filter((url) => pathname === url || (url !== '/admin' && pathname.startsWith(`${url}/`)))
    .sort((a, b) => b.length - a.length)[0]
}

const CORE_SECTIONS = new Set(['plugins', 'users', 'settings'])

/** Separators after the dashboard and before core's sections, as WordPress groups them. */
function separatorBefore(sections: readonly AdminMenuSection[], index: number): boolean {
  const section = sections[index]!
  const previous = sections[index - 1]
  if (!previous) return false
  return (
    previous.id === 'dashboard' ||
    (CORE_SECTIONS.has(section.id) && !CORE_SECTIONS.has(previous.id))
  )
}

/** Touch screens can't hover, so the first tap on a section opens its submenu, as in WordPress. */
function opensOnTap(event: MouseEvent): boolean {
  return window.matchMedia('(hover: none)').matches && !event.metaKey && !event.ctrlKey
}

/** The admin menu (`#adminmenu`): sections with icons, submenus inline or flying out. */
/** WordPress's count bubble: updates waiting, by section id or item key. */
function Badge({ count }: { count: number | undefined }) {
  if (!count) return null
  return (
    <>
      {' '}
      <span className="update-plugins" aria-hidden="true">
        {count}
      </span>
      <span className="screen-reader-text">
        {' '}
        ({count} {count === 1 ? 'update' : 'updates'})
      </span>
    </>
  )
}

export function AdminMenu({
  sections,
  badges = {},
}: {
  sections: readonly AdminMenuSection[]
  badges?: Readonly<Record<string, number>>
}) {
  const { setMenuOpen, toggleFolded } = useFrame()
  const current = currentUrl(sections, usePathname())
  const [opened, setOpened] = useState<string | null>(null)
  const menu = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (!opened) return
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpened(null)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [opened])

  const navigate = () => {
    setOpened(null)
    setMenuOpen(false)
  }

  return (
    <div id="adminmenumain">
      <div id="adminmenuback" />
      <div id="adminmenuwrap">
        <nav aria-label="Main menu">
          <ul id="adminmenu" ref={menu}>
            {sections.map((section, index) => {
              const isCurrent = section.items.some((item) => item.url === current)
              const hasSubmenu = section.items.length > 1
              const first = section.items[0]!
              return (
                <li
                  key={section.id}
                  id={`menu-${section.id}`}
                  className={cx(
                    'menu-top',
                    separatorBefore(sections, index) && 'menu-top-separated',
                    hasSubmenu && 'wp-has-submenu',
                    isCurrent ? 'wp-has-current-submenu wp-menu-open' : 'wp-not-current-submenu',
                    opened === section.id && 'opensub',
                  )}
                >
                  <Link
                    href={first.url}
                    className="menu-top"
                    aria-current={isCurrent && !hasSubmenu ? 'page' : undefined}
                    onClick={(event) => {
                      if (hasSubmenu && !isCurrent && opened !== section.id && opensOnTap(event)) {
                        // Opens the flyout rather than going anywhere.
                        event.preventDefault()
                        cancelNavigationProgress()
                        setOpened(section.id)
                        return
                      }
                      navigate()
                    }}
                  >
                    <span className="wp-menu-image">
                      <AdminIcon icon={section.icon} />
                    </span>
                    <span className="wp-menu-name">
                      {section.label}
                      <Badge count={badges[section.id]} />
                    </span>
                  </Link>
                  <ul className="wp-submenu" aria-label={section.label}>
                    <li className="wp-submenu-head" aria-hidden="true">
                      {section.label}
                    </li>
                    {hasSubmenu &&
                      section.items.map((item) => (
                        <li key={item.key} className={item.url === current ? 'current' : undefined}>
                          <Link
                            href={item.url}
                            aria-current={item.url === current ? 'page' : undefined}
                            onClick={navigate}
                          >
                            {item.label}
                            <Badge count={badges[item.key]} />
                          </Link>
                        </li>
                      ))}
                  </ul>
                </li>
              )
            })}
            <li id="collapse-menu">
              <button type="button" id="collapse-button" onClick={toggleFolded}>
                <span className="collapse-button-icon" aria-hidden="true">
                  <svg viewBox="0 0 20 20" width="20" height="20" focusable="false">
                    <path
                      d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm1.6 4.4L7.5 10l4.1 4.1-1.4 1.4L4.7 10l5.5-5.5Z"
                      fill="currentColor"
                    />
                  </svg>
                </span>
                <span className="collapse-button-label">Collapse Menu</span>
              </button>
            </li>
          </ul>
        </nav>
      </div>
    </div>
  )
}

/** "Howdy, Ada" and its dropdown. Hover opens it with a mouse; a tap or Enter toggles it. */
export function AccountMenu({ greeting, children }: { greeting: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const item = useRef<HTMLLIElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!item.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  return (
    <li
      ref={item}
      id="wp-admin-bar-my-account"
      className={cx('menupop', open && 'hover')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      <button
        type="button"
        className="ab-item"
        aria-expanded={open}
        aria-controls="wp-admin-bar-user-actions"
        onClick={() => setOpen(!open)}
      >
        {greeting}
      </button>
      <div className="ab-sub-wrapper" id="wp-admin-bar-user-actions">
        {children}
      </div>
    </li>
  )
}
