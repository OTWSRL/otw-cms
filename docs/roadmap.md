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
5. **Packaging and updates.** Below.
6. **Updates from the admin.** Below.

Next: 7, Content.

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

## 5. Packaging and updates (done)

A site is a small Next.js app that depends on versioned `@cms/*` packages, so updating core or a
plugin is a version bump, as `wp-admin/update-core.php` is for WordPress. WordPress swaps PHP
files in place; a Next.js app has to be rebuilt, and on git-based hosts the running site can't
change itself, so the update path differs by hosting. Both are supported:

| Hosting                                   | Update                                         | Database changes                                        |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| Own server, one instance (VPS, Docker)    | `cms update`, then rebuild and restart         | At startup, as now                                      |
| Several instances, or serverless (Vercel) | `cms update --commit`, push, the host rebuilds | `cms migrate` in the deploy step, or the admin's button |

### The split

- **`@cms/next`** holds everything the CMS owns in a Next.js app: the database and kernel
  runtime, sessions, the admin (frame, core screens, plugin screens, sign-in, setup, styles), the
  storefront page that serves plugin routes, the API handler, and `withCms()` for
  `next.config` (plain JavaScript, since Node loads it before anything is compiled).
- **The site** owns `cms.config.json` (plugins), `next.config.ts`, its storefront layout and
  styles (the theme, until themes exist), `.env`, and its own routes.
- **Managed route files.** `cms generate`, which already runs before `dev` and `build`, writes
  the CMS's route files into the site: the admin root layout, one admin catch-all page with its
  403 and 404 pages, the API route, the storefront's home page and catch-all (separate, so a site
  can write its own home page), and `src/cms/site.generated.ts` (the installed plugins). Each
  starts with a marker line; a file without it belongs to the site and is never overwritten, and
  one a newer version no longer writes is removed. The admin is one catch-all route, so a new core screen arrives with
  the package, and changed route files arrive with the next `cms generate`.
- **`create-next-cms`** scaffolds a site from the template, and `apps/web` is exactly such a
  site, so the end-to-end suite tests the split.

### Database changes

- `CMS_MIGRATIONS=startup` (default) applies pending migrations when the site boots, as now.
  `CMS_MIGRATIONS=deploy` never migrates at runtime: `cms migrate` runs in the deploy step.
- With pending migrations and nothing to run them, plugins with pending migrations stay off
  with the reason shown, and administrators get WooCommerce's "Database update required" notice
  with an Update database button (`core.manage_plugins`). Activating a plugin runs its own
  migrations, as an administrator asked for it. If core's are pending, the site doesn't start and
  its log says to run `cms migrate`: new code against the old schema isn't safe, and the tables
  that changed may be the ones the admin needs to sign in, so there is no maintenance screen
  with a button, unlike WordPress.
- The embedded database (PGlite) loads its files into one process and doesn't lock them, so a
  lock file holds the owner's process id: a second server, or `cms migrate` beside a running
  site, stops with an explanation instead of corrupting it. Several processes need Postgres.
- Migrations add, never remove, within a major version, so the previous release keeps working
  against the new schema while instances switch over, and rolling the code back is safe.
- `cms migrate` copies the embedded database before migrating, or runs `pg_dump` (the password
  through the environment, not the command line); without `pg_dump` it stops unless told
  `--no-backup`, for hosts that take their own. `--dry-run` lists what would run and creates
  nothing. A new site's `build:deploy` script migrates before building, for Vercel.

### `cms update`

- `cms update --check` lists newer versions of core (the `@cms/*` packages, released together)
  and of installed plugins, and what is compatible: a plugin declares the core it works with as
  a peer dependency on `@cms/sdk`, so this is known before anything changes, as WordPress's
  "Requires at least" and "Tested up to" are. The kernel's `requires.core` remains the runtime
  check.
- `cms update` picks the newest core within the installed version's caret range (`--major` for
  any) and the newest version of each plugin that supports it. Plugins that declare nothing stay
  within their own caret range, flagged "compatibility unknown". It refuses if a plugin would be
  left without a compatible version (unless `--force`), bumps `package.json` keeping each spec's
  style, installs with the site's package manager, and regenerates the route files with the
  newly installed CLI. It doesn't migrate: the running site may hold the embedded database, and
  the new release's migrations should run with its code, so it ends with the steps for the
  hosting (stop, `cms migrate`, build, start; or migrate at deploy). `--commit` needs a clean
  working tree and puts the change on a new branch, for git-based hosts.
- Plugins declare what they need from other plugins as peer dependencies on them (Stripe on
  Commerce). The plan honours those between the versions it picks: a plugin another one needs
  in an older version is held back if it can be, otherwise the one needing it is, and the report
  says why ("1.0.0 is out, but Stripe 0.1.2 needs Commerce ^0.1.0"). Versions only go down
  while settling, so it always ends.
- `cms update <packages>` updates only those (`commerce`, `@acme/forum`, `core`), and
  `--plugins-only` leaves core alone; a core update that would strand a plugin left out of it is
  refused.
- Versions come from `npm view` in the site's directory, so `.npmrc` applies: scoped registries
  and tokens for private and paid plugins. A plugin npm can't reach is reported and left as it
  is rather than stopping the update.
- `cms` is a small JavaScript file that registers tsx, which loads the CLI, the CMS and the
  site's plugins from TypeScript source, so it works from `node_modules` without a build step.

### Versioning

Semantic versioning for core and plugins. A minor or patch release of core never breaks the
plugin API; anything to be removed logs a deprecation warning for at least one minor release
first, as `_deprecated_function()` does, and goes in the next major.

### Not in this milestone

Publishing: the packages are still private, and a release needs a pipeline that versions the
core packages together and publishes them with provenance. A `deprecated()` helper for the
policy above. `--link` sites see two copies of shared dependencies such as `drizzle-orm`, which
only matters to the type checker.

## 6. Updates from the admin (done)

WordPress's Dashboard › Updates and "update now", for a site that has to be rebuilt to change.
How an update is applied depends on the hosting, so the admin talks to an update channel:

| Channel     | When                                                              | Update now                                  | Checks                      |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------- | --------------------------- |
| `cms serve` | Your own server, started with `cms serve`                         | Builds a release and switches to it         | Twice a day, and on request |
| GitHub      | `CMS_GITHUB_REPO` and `CMS_GITHUB_TOKEN` set (Vercel and similar) | Starts a workflow that opens a pull request | In the workflow             |
| None        | Anything else (Docker images, `next start`)                       | The command to run                          | None                        |

### `cms serve`

- Runs the site from built releases in `.cms/releases`, behind a small proxy on the public port,
  instead of `next start`. A site is built once into a release before it first serves.
- **Update now** builds a new release beside the live one: copy the site, apply the plan (the
  same planner as `cms update`), install, build. Then back up and migrate, start the new
  release, check it answers, switch the proxy to it, and stop the old one. With Postgres both
  run during the switch, so there is no downtime; the embedded database belongs to one process,
  so the proxy answers "being updated" (503, Retry-After) for the seconds between. If anything
  fails, the old release keeps or resumes serving, and the embedded database's backup is put
  back.
- **Roll back** switches to the previous release. Migrations only add within a major version,
  so the older code runs on the newer schema.
- After a successful update, `package.json`, the lockfile and the managed route files are copied
  back to the site, so the repository matches what runs.
- Checks for updates twice a day, as WordPress does; automatic updates (off by default) apply
  patch releases of core and plugins the same way.
- The admin reaches it on a loopback port with a random token it passes to the release it
  starts. Jobs run one at a time; the admin shows their steps as they run.

### GitHub

- A new site includes `.github/workflows/cms-update.yml`: run by hand, from the admin, or weekly,
  it runs `cms update --commit` (with the plugins asked for) and opens a pull request. Merging
  deploys it, and `build:deploy` migrates.
- The admin starts it through the GitHub API with a token allowed to run workflows, and links to
  the runs.

### The admin

- Dashboard › Updates: when it last checked and Check again; core; plugins with checkboxes, the
  version each goes to, compatibility with the core it will run on, and why one is held back;
  automatic updates; releases with Roll back; and the current job's progress.
- The update count on Dashboard and Plugins in the menu, and "There is a new version of … update
  now" under the plugin on the Plugins screen.
- `core.manage_updates`, administrators only unless granted.

### Behind proxies

Next.js reports every request at its own address, so behind `cms serve`'s proxy (or nginx) the
admin's same-site check refused every form. The site's origin is now the request's, `site.url`,
or, with `CMS_TRUST_PROXY=1`, the forwarded host and protocol. `cms serve` passes those headers
on, keeping an outer proxy's, and sets `CMS_TRUST_PROXY` for its releases.

### Not in this milestone

Tried for real: `cms serve` on the embedded database, building, updating a plugin from a local
registry with a migration, and rolling back, all from the admin. Covered only with fakes: the
Postgres path (both releases running through the switch, `pg_dump` backups) and the GitHub
workflow, which hasn't run on GitHub yet. `cms serve` is one server; several instances update
through git. Docker images update by rebuilding. Installing new plugins from the admin, as
WordPress's Add New does, needs a plugin directory first.

## 7. Content

Post types, taxonomies and meta, the core of WordPress that every big plugin builds on: courses
and lessons are post types in LearnDash, LifterLMS and Tutor.

- `content.type()` with labels, supports, and generated capabilities mapped through meta
  capabilities (`edit_post` → own, others', published), generic list and edit screens with
  columns, filters and panels other plugins extend.
- Taxonomies and terms; entry meta registered with types and validation.
- Pages served by the site's catch-all route; revisions; the media library (uploads behind a
  storage interface).

## 8. Accounts and email

Customer sign-up and sign-in on the storefront, password reset, profile screens with fields
plugins add (`show_user_profile`), user meta, and a mail transport with filters (`wp_mail`).

## 9. LMS plugin

Courses and lessons as content types, enrollment on `commerce.order.paid`, an instructor role
limited to their own courses through meta capabilities, a learner dashboard, course settings and
a section on Commerce's pages. The second proof that big plugins extend each other.

## 10. Operations

Job queue and scheduled tasks (Action Scheduler), an outbound event outbox, caching, uninstalling
plugins (their data and migrations), and installing plugins from the admin.

## Later

A community plugin (BuddyPress-style profiles, groups, activity) as the third proof, themes and
component overrides, i18n.
