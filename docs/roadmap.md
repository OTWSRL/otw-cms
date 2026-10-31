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
  editable fields placed on it, after a trial boot with the new values: if any plugin fails to
  start, nothing is saved and the error says which plugin and why.

### Admin slots

- Slots are typed by name, with props. `admin.notices` renders at the top of every screen,
  `admin.dashboard` on the dashboard. Plugins offer their own (`commerce.admin.order`) and render
  other plugins' fills with `cms.slots.get()`.

### Not in this milestone

Editable roles in the admin (a role editor needs stored overrides and a reboot path), custom
field renderers for settings, cross-field validation beyond the trial boot, removing other
plugins' menu items.

## 4. Content

Post types, taxonomies and meta, the core of WordPress that every big plugin builds on: courses
and lessons are post types in LearnDash, LifterLMS and Tutor.

- `content.type()` with labels, supports, and generated capabilities mapped through meta
  capabilities (`edit_post` → own, others', published), generic list and edit screens with
  columns, filters and panels other plugins extend.
- Taxonomies and terms; entry meta registered with types and validation.
- Pages served by the site's catch-all route; revisions; the media library (uploads behind a
  storage interface).

## 5. Accounts and email

Customer sign-up and sign-in on the storefront, password reset, profile screens with fields
plugins add (`show_user_profile`), user meta, and a mail transport with filters (`wp_mail`).

## 6. LMS plugin

Courses and lessons as content types, enrollment on `commerce.order.paid`, an instructor role
limited to their own courses through meta capabilities, a learner dashboard, course settings and
a section on Commerce's pages. The second proof that big plugins extend each other.

## 7. Operations

Job queue and scheduled tasks (Action Scheduler), an outbound event outbox, caching, uninstall
and down migrations, and the install flow (`pnpm add`, generate, blue/green rebuild).

## Later

A community plugin (BuddyPress-style profiles, groups, activity) as the third proof, themes and
component overrides, i18n.
