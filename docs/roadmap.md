# Roadmap

The yardstick is WordPress: a plugin should be able to do what a WordPress plugin can, through
typed APIs, and big plugins (commerce, learning, community) should extend each other the way
WooCommerce extensions and LMS add-ons do. Where WordPress has a known flaw (roles persisted in the
database, output escaped by hand, settings pages that trust any registered option), we keep the
extensibility and drop the flaw.

## Done

1. **Kernel and SDK.** Typed hooks, registries, services, routes and slots; migrations;
   dependency resolution; recovery mode. Commerce and Stripe plugins.
2. **Admin.** Users, sessions, roles and capabilities; plugin activation and settings in the
   database; plugin admin pages and form actions; first-run setup.
3. **Admin extensibility.** Below, kept as the spec it was built to.
4. **WordPress admin UI.** Below.

## 3. Admin extensibility (done)

What a plugin needs to extend the admin, and other plugins' admin, as in WordPress.

| WordPress                                            | Here                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `add_role()`, `$role->add_cap()`, `remove_cap()`     | `auth.role()`, `auth.grant()`, `auth.revoke()`                  |
| `map_meta_cap`, `current_user_can('edit_post', $id)` | `auth.metaCapability()`, `can(user, 'lms.edit_course', course)` |
| `map_meta_cap` filter                                | `auth.extendCapability()`                                       |
| `add_menu_page()`, `add_submenu_page($parent)`       | `admin.page({ menu: { parent } })`                              |
| `add_options_page()`, WooCommerce settings tabs      | `admin.settingsPage()`                                          |
| `add_settings_section($page)`                        | `admin.settingsSection({ page })`                               |
| `add_settings_field($page, $section)`                | `admin.settingsFields({ section })`                             |
| `option_page_capability_{$page}`                     | `settingsPage({ capability })`                                  |
| `allowed_options` (what `options.php` may save)      | A page saves only the fields placed on it                       |
| `wp_add_dashboard_widget()`, `admin_notices`         | `admin.dashboard` and `admin.notices` slots                     |
| Meta boxes on another plugin's screen                | Typed slots with props, e.g. `commerce.admin.order`             |

### Capabilities

- `grant(role, caps)` and `revoke(role, caps)` work across plugins. They apply after every
  plugin has set up, in load order, so a grant to a role from an inactive plugin is dropped and
  comes back when that plugin is activated. Nothing is stored: deactivating a plugin removes its
  grants, unlike WordPress, where capabilities outlive the plugin that added them.
- Meta capabilities map an object to the primitive capabilities it requires, as `map_meta_cap`
  does. The checker receives the loaded object rather than an id, so `can()` stays synchronous
  and a list screen can check every row without a query per row. Returning `false` denies
  everyone, administrators included (WordPress's `do_not_allow`).
- Other plugins can extend a meta capability's mapping, in load order.
- `ForbiddenError` thrown from an admin page loader or action answers 403, for checks that need
  the object.

### Menu

- Sections: Dashboard, one per plugin, Plugins, Users, Settings. A page goes in its own plugin's
  section unless it names a `parent`: a core section or another plugin's id. A parent from an
  inactive plugin falls back to the page's own section.
- A section with one visible item shows as a single link.

### Settings API

- What a setting is stays where it was: declared on the plugin, keyed by the plugin's id,
  resolved override > env > database > default before `setup()` runs.
- Where it shows is free. A plugin adds settings pages (mounted under its admin path, listed
  under Settings by default), sections on any page, and its own fields in any section. It can
  place only its own fields.
- Placement falls back instead of failing: a section on a page from an inactive plugin moves to
  the owner's first settings page, and fields nobody placed get a section there too. A plugin
  with unplaced fields and no settings page gets one automatically, so a plugin that only
  declares settings still works.
- Each page has a capability (default `core.manage_settings`). Saving a page writes only the
  editable fields placed on it. The kernel records which plugins read each setting during
  `setup()` (a read through another plugin's service counts as the plugin being set up); a save
  boots only those plugins, with the new values and their dependencies. If one fails to start,
  nothing is saved and the error says which plugin and why. A value nobody reads at startup is
  saved without a boot, so the cost tracks the change, not the number of plugins (40 plugins:
  40 setups and ~90 ms per save before, 1 setup and ~7 ms after).

### Admin slots

- Slots are typed by name, with props. `admin.notices` renders at the top of every screen,
  `admin.dashboard` on the dashboard. Plugins offer their own (`commerce.admin.order`) and render
  other plugins' fills with `cms.slots.get()`.

### Not in this milestone

Editable roles in the admin (a role editor needs stored overrides and a reboot path), custom
field renderers for settings, cross-field validation beyond the trial boot, removing other
plugins' menu items.

## 4. WordPress admin UI (done)

The admin should feel like WordPress to the people who run sites and to the developers who write
plugins, on every screen size. Measured against WordPress 7.1.4's default ("modern") scheme in a
browser, at desktop, folded and phone widths.

- **Frame.** Admin bar (32px; 46px below 783px, scrolling away below 601px) with the site link
  and the account menu; the left menu with icons, the current section's submenu inline and the
  others flying out on hover or focus; Collapse Menu, remembered in a cookie so the server
  renders it folded; the footer.
- **Breakpoints, as WordPress.** Over 960px: full menu. 783–960px: icons only, submenus fly out,
  Collapse Menu keeps it open instead. Up to 782px: the menu opens from the bar's button and
  pushes the screen aside, list tables collapse to their primary column with a row toggle, form
  tables stack, controls grow to 40px with 16px text. Touch screens open a section's submenu on
  the first tap, as WordPress's `opensub` does.
- **Components.** `@cms/admin-ui` renders WordPress's markup and class names, so plugins get the
  look and the phone layout by using it: `ListTable` (primary column, row actions, bulk-select
  column, row toggle), `Views` (`subsubsub`), `TableNav` (count and pages), `FormTable` and
  `FormField`, `SubmitButton`, `Postbox`, `EditColumns` (`#poststuff`), `Notice` (dismissible),
  `Button`, `FormButton`, `AdminIcon`. Hand-written WordPress markup is styled too.
- **Plugin API.** `icon` on the plugin definition (a built-in icon or a base64 SVG data URI,
  validated so it can't break out of CSS), and `titleAction` on admin pages for "Add New".
- **Core screens.** Dashboard with At a Glance and plugin widgets in WordPress's columns;
  Plugins with views, highlighted active rows and actions under the name; All Users with role
  views and "Change role to…" for the ticked users; Add User; Roles; settings pages as form
  tables; log-in and first-run setup in wp-login.php's layout; 403 as `wp_die()`.
- **Tests.** Component tests for the markup; Playwright on desktop Chrome, iPhone SE and 15
  (WebKit), Pixel 7 portrait and landscape, and iPad Pro 11 portrait and landscape (WebKit).

### Not in this milestone

Admin colour schemes (the CSS uses variables so they can come), screen options and help tabs,
drag-and-drop dashboard widgets, a user edit and profile screen, bulk plugin actions, the
front-end admin bar, right-to-left layout.

## 5. Content

Post types, taxonomies and meta, the core of WordPress that every big plugin builds on: courses
and lessons are post types in LearnDash, LifterLMS and Tutor.

- `content.type()` with labels, supports, and generated capabilities mapped through meta
  capabilities (`edit_post` → own, others', published), generic list and edit screens with
  columns, filters and panels other plugins extend.
- Taxonomies and terms; entry meta registered with types and validation.
- Pages served by the site's catch-all route; revisions; the media library (uploads behind a
  storage interface).

## 6. Accounts and email

Customer sign-up and sign-in on the storefront, password reset, profile screens with fields
plugins add (`show_user_profile`), user meta, and a mail transport with filters (`wp_mail`).

## 7. LMS plugin

Courses and lessons as content types, enrollment on `commerce.order.paid`, an instructor role
limited to their own courses through meta capabilities, a learner dashboard, course settings and
a section on Commerce's pages. The second proof that big plugins extend each other.

## 8. Operations

Job queue and scheduled tasks (Action Scheduler), an outbound event outbox, caching, uninstall
and down migrations, and the install flow (`pnpm add`, generate, blue/green rebuild).

## Later

A community plugin (BuddyPress-style profiles, groups, activity) as the third proof, themes and
component overrides, i18n.
