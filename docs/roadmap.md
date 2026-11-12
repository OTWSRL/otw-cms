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

Between 6 and 7: **request tracing**, with OpenTelemetry in core, and the **performance plugin**,
WordPress's Query Monitor plus the browser's timings and Web Vitals (README, Tracing). The plugin
is the first in a repository of its own, `../otw-plugin-performance`, as third-party plugins are.
Then **admin entries**: a plugin's admin code is a second entry, `./admin`, which only the admin
and the API routes load, so none of it reaches the site's visitors (Plugin Handbook › Admin
screens).

Milestone 7, Content, is complete: content types and entries, their screens and the block
editor, taxonomies and custom fields, site pages and revisions, and the media library.

Milestone 8, Accounts and email, is complete: email through a plugin's transport, accounts on
the site, and profiles with user fields. Next: 9, the LMS plugin.

The CMS is OTW CMS: its packages are `@otwdesign/*` and the scaffolder is `create-otw-cms`. A site can
sell it under another name with a `brand` in `cms.config.json` (README, White label).

Every milestone ships with its documentation. The docs site, a project of its own beside this one
(`../hello-world`), gets handbook pages for what changed, and every new public API gets a doc
comment, which its Code Reference reads from the source. Its `pnpm check` fails on an
undocumented export or extension point, a sample that no longer compiles, or a broken link.

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
- **Components.** `@otwdesign/admin-ui` renders WordPress's markup and class names, so plugins get the
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

A site is a small Next.js app that depends on versioned `@otwdesign/*` packages, so updating core or a
plugin is a version bump, as `wp-admin/update-core.php` is for WordPress. WordPress swaps PHP
files in place; a Next.js app has to be rebuilt, and on git-based hosts the running site can't
change itself, so the update path differs by hosting. Both are supported:

| Hosting                                   | Update                                         | Database changes                                        |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| Own server, one instance (VPS, Docker)    | `cms update`, then rebuild and restart         | At startup, as now                                      |
| Several instances, or serverless (Vercel) | `cms update --commit`, push, the host rebuilds | `cms migrate` in the deploy step, or the admin's button |

### The split

- **`@otwdesign/next`** holds everything the CMS owns in a Next.js app: the database and kernel
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
- **`create-otw-cms`** scaffolds a site from the template, and `apps/web` is exactly such a
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

- `cms update --check` lists newer versions of core (the `@otwdesign/*` packages, released together)
  and of installed plugins, and what is compatible: a plugin declares the core it works with as
  a peer dependency on `@otwdesign/sdk`, so this is known before anything changes, as WordPress's
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

A `deprecated()` helper for the policy above. `--link` sites see two copies of shared dependencies such as `drizzle-orm`, which
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
and lessons are post types in LearnDash, LifterLMS and Tutor. Each part starts from WordPress's
source.

| Part | What                                                                         | WordPress's                          |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------ |
| 7a   | `content.type()`, entries, and capabilities (own, others', published) (done) | `register_post_type`, `map_meta_cap` |
| 7b   | List and edit screens, the block editor; columns, boxes plugins add (done)   | `edit.php`, `post.php`, meta boxes   |
| 7c   | Taxonomies and terms; typed, validated meta                                  | `register_taxonomy`, `register_meta` |
| 7d   | Pages served by the site's catch-all route; revisions                        | template hierarchy, revisions        |
| 7e   | The media library, uploads behind a storage interface                        | `upload.php`, `wp_handle_upload`     |

### 7a. Content types and entries (done)

- **Types.** `cms.content.type(name, definition)` in `setup()`, qualified with the plugin's id
  (`lms.course`): labels, `public`, `hierarchical`, `supports`, and `roles`. Core registers
  Posts and Pages, and WordPress's Editor, Author and Contributor roles; every role starts with
  `core.read`, WordPress's `read`.
- **Capabilities** as `get_post_type_capabilities()` names them, under the plugin's id: ten
  primitive and four meta ones (`edit_`, `read_`, `delete_`, `publish_` one entry), mapped as
  `map_meta_cap` maps posts. `roles` grants them at WordPress's levels; a type that doesn't say
  gets posts' (editor, author, contributor); pages are editors'. A type's entry in the
  `ContentTypes` interface types its capability names. Unlike WordPress, a type always has its
  own capabilities and its grants aren't stored, so nothing outlives the plugin. Someone else's
  entry in the trash is checked by the status it had, where WordPress asks only
  `edit_others_posts`.
- **Entries** in one table, `cms_entries`. Statuses `draft`, `pending`, `published`, `private`
  and `trash`, and since 10a `scheduled`. The body is JSON blocks, rendered by React (the blocks
  come with the editor in 7b). Slugs are owned by published, private and scheduled entries,
  unique per type and parent through a
  partial unique index, numbered from 2 when taken, and retried when two saves race. The trash
  keeps the status for checks; restoring gives a draft. Deleting a page moves its children up.
- **Hooks:** the `content.entry` filter, checked after it runs, and `content.status`, `.saved`,
  `.trashed`, `.restored`, `.deleted` in the save's transaction.

### 7b. Screens and the editor (done)

- **List** (`edit.php`): views with counts (All, Mine, each status, Trash), search over title,
  excerpt and body text (LIKE wildcards escaped), the month filter, sorting by title or date,
  pages of 20, pages as a tree built in SQL rather than by loading every page. Row actions and
  bulk actions are checked against each entry; Empty Trash deletes what the user may delete.
- **Edit** (`post.php`, `post-new.php`): WordPress's two columns and Publish box. The entry is
  created on first save. The save action decides the status as the Publish box does
  (contributors submit for review), refuses an author change without `edit_others_`, and refuses
  a form older than the entry's `updatedAt`, which now moves forward by at least a millisecond
  on every change. The editor keeps title, excerpt and body in `sessionStorage` until they're
  saved and offers them back, like WordPress's local backup.
- **Editor**: Tiptap 3.31.4, pinned, in a chunk only edit screens fetch (393 KB unpacked; the
  other admin screens are unchanged). Paragraphs, headings, lists, quotes, code, separators;
  bold, italic, strike, code, links. The server checks bodies against the same schema and
  `isSafeHref()` on save and render; `Blocks` renders them as a server component.
- **Plugins** add `column` (loaded once per page), `metaBox` (saved in the entry's transaction),
  `rowAction` and `bulkAction` from their admin entry, for one type, several or `'*'`.
- Core: Posts and Pages menu sections, `posts` and `pages` reserved as plugin ids (and `updates`,
  which a core screen already used), `AuthService.getUsers()` and `listUsers({ roles })`.

### 7e. The media library and images in entries (done)

- **The library** (`upload.php`, `media-new.php`, the attachment's edit screen): a grid or a list,
  filtered by kind, month, unattached and mine, searched by title and file name, with bulk delete;
  Add New uploads each dropped file with its progress through `POST /api/p/core/media`
  (`async-upload.php`), and is a plain form without JavaScript; Edit Media has the title, alt text,
  caption, description and the file's details. Settings › Media has the sizes and year/month
  folders.
- **Records** in `cms_media` (migration core/0006_media), apart from entries; `entry_id` is the
  attachment's parent and is cleared when the entry goes.
- **Uploads** (`wp_handle_upload`): WordPress's allowed types for people without
  `unfiltered_html`, less CSS and the image formats browsers can't show, changed by the
  `media.mimes` filter; contents checked against the type (sharp decodes images; signatures for the
  rest), a lying image extension corrected; `CMS_MAX_UPLOAD_MB` (64), refused from Content-Length
  before a form is read; names sanitized and lower case, in year/month folders, claimed by an
  exclusive create, numbered as `wp_unique_filename()`.
- **Images**: WordPress's six sizes (three from Settings › Media) and plugins' (`imageSize()`), made
  from a `-scaled` copy above 2560 (`big_image_size_threshold`), never enlarged, shared when two
  come out the same; EXIF orientation applied and metadata stripped in sizes; the original kept.
- **Storage**: `MediaStorage` (create without overwriting, read with ranges, stat, delete, url),
  the disk by default (`CMS_UPLOADS_DIR`, shared by `cms serve`'s releases, in Docker's volume),
  or one plugin's. A generated `/uploads/[...path]` route serves it with ETag and Last-Modified,
  ranges, `nosniff`, a sandbox CSP (not for PDFs) and a day's caching.
- **Capabilities**: `core.upload_files` for Authors, Editors and Administrators; `core.edit_media`
  and `core.delete_media` mapped onto posts' capabilities, as attachments are. Files go after the
  delete's transaction commits (`afterCommit()` on the database context).
- **Images in entries**: an `image` block (the file's id, address and alt text, checked on save:
  a library id, a site path or web address) inserted from a media picker, a modal with Upload
  and Library tabs (`GET /api/p/core/media`, `query-attachments`), with alt text editable when
  it's selected. Featured images with the `thumbnail` feature (Posts and Pages), in
  `cms_entries.thumbnail_id` (migration core/0007_featured_images) referencing the file, cleared
  when it's deleted; the edit screen's Featured image box.
- **On the site**: templates get `thumbnail` and the body's `media` from one query (`items[].thumbnail`
  on archives); `Image` writes the size with its dimensions, `srcset` from same-shaped sizes up
  to 2048 and `sizes`, lazy unless `priority`; `Blocks` renders images with `media`, leaving out
  deleted ones. The default templates show the featured image, and thumbnails in lists.
- Not in 7e: image editing, captions and alignment in image blocks, regenerating sizes, custom
  fields and taxonomies on media, a media trash, and a storage plugin for S3.

### 7d. Site pages and revisions (done)

- **Routes** after plugins' own, as WordPress orders its rewrite rules: archives, terms, entries
  under a prefix, then pages by path and posts by slug ("Post name"). Plugin types at
  `/{name}/:slug`, archives at `/{plural}` (`hasArchive`), terms at `/{taxonomy}/:slug`. Sites
  move them with `routes` under `{type}.single`, `{type}.archive` and `{taxonomy}.term`, suffixed
  so they can't clash with a plugin's page route of the same name.
- **Visibility**: published for everyone, private for `read_private_`, drafts only in preview
  (`/?preview={id}`, checked against `read_`, noindex, a 404 for anyone else); the rest 404s.
- **Settings › Reading**: latest posts or a static homepage with a posts page, through a new
  `entry` setting type (a dropdown of a type's published entries), and posts per page.
- **Templates**: defaults in `@otwdesign/next/site` (`EntryTemplate`, `ArchiveTemplate`, `Blocks`,
  `excerptOf`); plugins' by priority (`cms.content.template()`); the site's own in
  `src/cms/templates.tsx`, which `cms generate` adds to the site module and never to the
  admin's. Authors show by name, never by email address.
- **Links**: `permalinks()` builds a page of addresses with one recursive query for pages'
  ancestors; an entry under a draft has none. The admin's list and edit screen show View or
  Preview, and the permalink.
- **Revisions**, with the `revisions` feature (Posts and Pages): a snapshot of title, body,
  excerpt and custom fields in `cms_revisions` (migration core/0005_revisions), apart from
  entries, on every save that changed one, with who saved it (`{ by }`), in the save's
  transaction. Status-only saves keep none. Each entry keeps its type's `revisions` (25 by
  default), pruned with one delete per save. `revisions()`, `getRevision()`,
  `restoreRevision()` (a save with its own revision). The revisions screen compares a revision
  with the one before, field by field (a line diff of the body's text, block by block), and
  restores it; the Publish box shows Revisions: N with Browse.
- Not in 7d: autosave, so previews show the last save; comments, feeds, sitemaps, date
  archives.

### 7c. Taxonomies and custom fields (done)

- **Taxonomies**: `cms.content.taxonomy()` in `setup()`, sharing names with content types.
  WordPress's capabilities (`manage_`, `edit_`, `delete_`, `assign_`, and `edit_`, `delete_`,
  `assign_` one term), with editors managing and authors and contributors assigning. Core's
  Categories (hierarchical, default Uncategorized) and Tags on posts.
- **Terms** in `cms_terms` (slug unique per taxonomy; name unique among siblings, by index) and
  `cms_entry_terms`. Counts are computed per page, not stored. Deleting a term moves its children
  up and gives entries left with none the default; setting by name adds missing terms, as for
  WordPress's tags. The default term is created when first needed, with an insert that's safe
  when two saves race. `list({ terms })` includes descendants.
- **Screens**: `edit-tags.php` with the add form, `term.php`, the edit screen's checklist and
  tags field (each checked against `assign_`), list columns and an "All Categories" filter.
- **Custom fields**: `cms.content.meta(key, definition)` in `setup()`, typed by `EntryMeta`.
  Unlike WordPress, registration is required: unknown keys are refused, so what's stored is
  valid. Types `string` (options, multiline, validate), `number` (integer, min, max), `boolean`,
  `strings` and `json` (validate required); a default must pass its own checks. One `meta`
  jsonb column per entry (migration core/0004_entry_meta) with a GIN index for
  `list({ meta })`; updates merge key by key under the entry's row lock, `null` removes a key,
  and defaults fill in on read. The `content.entry` filter sees and may change meta; what it
  changes is checked again. A deactivated plugin's values stay, read-only.
- **Field boxes**: `cms.admin.metaBox(type, { fields })` renders the fields as a form table and
  the save stores them with the entry (empty removes, unticked is false); a field's
  `capability` is checked on save. Boxes naming unregistered fields are warned about.
- Not yet: term meta, ordering by a field, adding a category from the edit screen, term pages
  on the site (7d). No e2e for field boxes: no plugin on the test site has custom fields, so
  the screen is covered by a component test and the save by integration tests.

Not in 7b: Quick Edit and Bulk Edit, preview and View links (7d), plugin-defined blocks and a
raw-HTML block, autosave to the server, screen options, a site time
zone (dates show and filter in UTC).

Not in 7a: custom statuses (`register_post_status`), edit locks, search in `list()`, and sharing
another type's capabilities (`capability_type => 'post'`). Scheduled publishing and emptying the
trash after 30 days came with the job queue, in 10a.

## 8. Accounts and email

Customer sign-up and sign-in on the storefront, password reset, profile screens with fields
plugins add (`show_user_profile`), user meta, and a mail transport with filters (`wp_mail`).

| Part | What                                                                     | WordPress's                               |
| ---- | ------------------------------------------------------------------------ | ----------------------------------------- |
| 8a   | `cms.mail.send()`, a transport from one plugin, hooks (done)             | `wp_mail()`, SMTP plugins                 |
| 8b   | Sign-up with a verified email, sign-in, lost password, `/account` (done) | `wp-login.php`, WooCommerce's My Account  |
| 8c   | User meta, Profile and Edit User screens, account sections (done)        | `profile.php`, `user-edit.php`, user meta |

### 8a. Email (done)

- `cms.mail.send(message)`, like `wp_mail()`: `to` (up to 50), `subject`, `text`, `html`, `from`,
  `replyTo`; checked before and after the `mail.message` filter (addresses, and no line breaks
  where a header goes). Returns `false` when it can't be sent, logging why, with `mail.failed`;
  `mail.sent` after. `canSend()` says whether a transport is set up.
- **No mailer in core**, as chosen: one plugin provides the transport (`cms.mail.transport()`),
  as WordPress's SMTP plugins replace PHPMailer. Without one, the log says nothing was sent, with
  the text outside production only (it can hold reset links).
- Settings › General › **Send email from** (`mail.from`, `MAIL_FROM`).
- **Mail to files** (`@otwdesign/plugin-mail-file`), a first-party transport for development and tests:
  each email as a JSON file in `MAIL_FILE_DIR`. The reference site uses it.

### 8b. Accounts on the site (done)

- **Pages** at `/account`, after plugins' routes and before content: sign in (and register),
  the account, lost password, set a password (`/account/reset?token=`), confirm an email address
  (`/account/email?token=`). `kernel.resolveAccount()` gives `AccountTemplateProps`;
  `AccountTemplate` in `@otwdesign/next/site` renders plain forms; a site's `account` template replaces
  it. Pages are noindex, and token pages send Referer to the site only (`same-origin`:
  `no-referrer` would post their forms with `Origin: null`, which actions refuse).
- **Sign-up**, with Settings › General › Membership › Anyone can register (`users.can_register`)
  and a mail plugin: name and email; a Customer with no password, and an emailed link to set one,
  which proves the address (`cms_users.email_verified_at`, migration core/0008_accounts). An
  address that has an account gets an email saying so, with a reset link; the form answers the
  same.
- **Links** in `cms_user_tokens`: random, stored as SHA-256, one purpose (`password`, `email`),
  single-use, a day (WordPress's `password_reset_expiration`), at most three emails an hour per
  address.
- **Lost password**, the same answer whether or not an account uses the address; setting the
  password ends every session (WordPress's reset) and signs in.
- **Signed in**: name; password with the current one (counted against sign-in's throttle), ending
  the other sessions and emailing the address; email changed only from a link sent to the new
  address, the old one told. `auth.checkPassword()` and `auth.signOutEverywhere()`.
- Admin sign-in: Lost your password?, and a customer is sent to `/account`. Sign-in for an
  account with no password costs a hash too, so it can't be told apart.

### 8c. Profiles and user fields (done)

- `cms.users.meta(key, definition)`: custom fields' types and checks (a `MetaStore` of its own),
  plus `roles` and `onAccount`; values in `cms_users.meta` (migration core/0009_user_meta).
  `get()`, `getMeta()` with defaults, `getMetaMany()` in one query, `updateMeta()` checked against
  the user's role, `fields()`, `isVerified()`.
- **Users › Profile** (`profile.php`): name and fields (`profile-save`, each field's capability
  checked), email and password through the account's own forms, Log Out Everywhere Else. Edit
  Profile in the admin bar; everyone in the admin has the menu item.
- **Edit User** (`user-edit.php`, `/admin/users/:id`, `core.manage_users`): role, name, email
  (at once, the old address told, the new one unconfirmed), fields, Send Reset Link, Log Out
  Everywhere. Editing yourself goes to Profile.
- **Account page**: `onAccount` fields under Your details, the only ones its form may change;
  plugins' sections through the `account.sections` slot. Commerce lists the orders placed with
  the account's address (`listOrders({ email })`), once the address is proven.

## Admin speed (done)

Measured before milestone 9 on a production build with PGlite, 1,500 posts, 300 pages and 441
users: the server's time to first byte (median of seven) and what the browser waits for.

| What                                | Before        | After       |
| ----------------------------------- | ------------- | ----------- |
| Users                               | 38 ms, 1.1 MB | 7 ms, 85 KB |
| Posts, searched                     | 79 ms         | 20 ms       |
| Edit Page                           | 23 ms         | 11 ms       |
| The editor usable, after the screen | 320 ms        | 60 ms       |
| Update, until the editor is usable  | 365 ms        | 120 ms      |
| Other screens                       | 4–22 ms       | unchanged   |

- **The editor** loads its chunk in an effect. `next/dynamic` suspends, and React 19 holds a
  suspended boundary's content for 300 ms after its fallback shows.
- **Users** are paged (20) and searched in SQL, every word in the email or name
  (`auth.findUsers()`), with the role counts from one grouped query (`countUsersByRole()`).
- **Search** (`content.list({ search })`) matches words and the words they begin, in any case,
  against `cms_entries.search_vector`: a stored `tsvector` of the title, excerpt and body text,
  GIN-indexed (migration core/0010_entry_search, which rewrites the table once). Stored, not an
  expression index: with parameters, Postgres may walk entries by date and would compute every
  entry's words. The column is left out of the Drizzle schema, so entries never carry it.
- **The Parent dropdown** is `content.outline()`, one recursive query of ids, titles and depths.
- **The update count** reuses `cms serve`'s status for five seconds, on `globalThis` so route
  handlers (where update actions run) and screens share it; never while an update runs, cleared
  after every action, and given up after three seconds.
- **Feedback**: a bar along the top after 150 ms of any navigation or form post.
- Not done: saving without reloading the screen (Update takes about 120 ms already), an author
  picker and a searchable Parent box for sites with thousands of authors or pages, and timings
  against a Postgres server over the network.

## 9. LMS plugin (done)

Courses and lessons, enrollment on `commerce.order.paid`, an instructor role limited to their own
courses through meta capabilities, a learner dashboard, course settings and sections on Commerce's
pages: the second proof that big plugins extend each other. It's a repository of its own,
`../otw-plugin-lms` (`@otwdesign/plugin-lms`), linked to this checkout, and needs nothing new from core
or Commerce: everything below is built on extension points they already had.

- **Courses and lessons** are content types with core's screens. A lesson's `lms.course` field
  puts it in a course, its Order places it; the Course box offers only courses its editor teaches
  (`lms.teach_course`). A course's access is open, free, paid or closed (LearnDash's), and its
  lessons open in order unless it says otherwise; sample lessons open for everyone.
- **The site's pages** are the plugin's routes, not core's content pages, because who's looking
  decides what they show (core's templates don't get the viewer): `/courses`, the course, its
  lessons (a locked lesson's body never leaves the server), `/my-courses`, and previews by id.
  Enroll, Buy and Mark complete post forms to its API, which counts a session only with the site's
  Origin.
- **Selling** is Commerce's `commerce.purchasables` registry, with the buyer recorded by the
  plugin: courses are priced only inside its own checkout, which runs Commerce's `checkout()` for
  the signed-in person, so `commerce.order.created` records whose order it is and
  `commerce.order.paid` enrolls them, idempotently, in Commerce's transaction. Commerce's own
  checkout can't sell a course. The order screen gets a Courses box (`commerce.admin.order`),
  Commerce's menu a Course sales screen (`menu.parent`).
- **Progress and the dashboard**: a learner's courses and progress, the account page's Courses
  section (`account.sections`), and `lms.lesson.completed` / `lms.course.completed` for other
  plugins. An index of which course each lesson is in (`lms_lessons`, kept from `content.saved`)
  makes a page of courses' counts and progress one query each: measured, `/my-courses` runs the
  same queries for 2 courses as for 8.
- **Instructors** are authors of their own courses, or contributors until Courses › Settings lets
  them publish; `lms.enroll_students` keeps paid courses' giving away to editors.

Left for later, each needing core: the viewer in content templates, and a site's own address for
a type (`rewrite['slug']`), so courses could be core's content pages; a customer on Commerce's
orders; `cms.users` lookups by email and for a page of users (the plugin joins `cms_users` for
now); a slot on the order-received page. Quizzes, certificates, drip content, and refunds that
unenroll.

## Optional plugins in repos of their own (done)

Commerce and Stripe left the CMS's repo, with their history, for `../otw-plugin-commerce` and
`../otw-plugin-commerce-stripe`, as the LMS and performance plugins had: every plugin is optional,
and this repo holds the core packages and mail-file. Each plugin repo links the CMS's checkout
(Stripe links Commerce's too), has its own test site and e2e tests, and checks out what it links
in CI.

- The CMS's e2e tests exercise plugins through two test-only ones in `apps/web/fixtures`: Library
  (site pages, a plugin API, an admin section, a settings page, a dashboard widget, a role) and
  Courier (which needs Library, adds a section to its settings page, and a notice while its key is
  unset). They cover what the tests did through Commerce and Stripe.
- The shop's own tests, the demo products seed and the shop's styles went with Commerce; the site
  template no longer carries those styles.

## A lighter, faster server (done)

Measured on production builds. Memory and image size in Docker (Linux), a small site after 60
pages; speed on the Performance plugin's site with 1,500 posts, 300 pages and 440 users.

| What                                         | Before             | After              |
| -------------------------------------------- | ------------------ | ------------------ |
| Memory, first start (a new database)         | 575 MiB            | 194 MiB            |
| Memory, after a restart                      | 444 MiB            | 237 MiB            |
| Docker image                                 | 1.07 GB            | 436 MB             |
| Home page / a post / a category, server time | 7.8 / 6.4 / 9.7 ms | 6.2 / 5.0 / 7.2 ms |
| Category pages a second, 16 at a time        | 139                | 194                |
| Posts list's counts and months, 31,500 posts | about 30 ms        | under 0.5 ms       |

- **A new embedded database** is created by a short-lived process (`createEmbeddedDatabase`):
  PGlite's initdb takes about 700 MB, which a server kept until it restarted.
- **The embedded database's cache** is 16 MB (`CMS_SHARED_BUFFERS`), not PostgreSQL's 128 MB.
  In a 130 MB database, lists and counts took three times as long; lookups didn't change.
- **It maintains itself** (`maintainEmbeddedDatabase`): PGlite runs no autovacuum, so its tables
  were never analyzed, and the planner guessed 36 rows where there were 1,500. The server applies
  autovacuum's thresholds itself, 30 s after starting and every five minutes.
- **Loaded when used**: sharp with the first image, OpenTelemetry's SDK when a plugin turns
  tracing on. The database drivers still load together: making `openDatabase()` async would
  break scripts that call it, such as Commerce's seed, for a few MB.
- **Counts and months** come from `cms_entry_counts` and `cms_entry_months`, which a trigger
  keeps (migration core/0011_entry_counts), as WordPress caches `wp_count_posts()`.
- **Term filters** find the terms and their descendants once per query, not per entry.
- **The Docker image** is Next.js's standalone server (`CMS_STANDALONE=1`), with a `migrate`
  target for several containers.
- **The embedded database's lock** records its process's start time too, so a restarted
  container whose processes reuse ids takes it over. Before, a site in a container could stay
  down after `docker restart` until the lock file was deleted.
- Not done, measured: counting archive pages over ids only (0.5 ms, lost to a second round trip
  on a PostgreSQL server). The categories filter on the Posts list still counts each term's
  entries (about 3 ms at 1,500 posts).

## 10. Operations

In five parts, each a release: 10a the job queue and scheduled tasks, 10b webhooks (the outbound
event outbox), 10c caching, 10d uninstalling plugins (their data and migrations), and 10e
installing plugins from the admin.

### 10a. Jobs and scheduled tasks (done)

`cms.jobs`, after WordPress's Action Scheduler, which also does what WP-Cron does: a plugin
defines a job by name in `setup()`, and queues runs of it.

| Action Scheduler                 | Here                                                   |
| -------------------------------- | ------------------------------------------------------ |
| `as_enqueue_async_action()`      | `cms.jobs.enqueue(name, args)`                         |
| `as_schedule_single_action()`    | `enqueue(name, args, { at })`                          |
| `$unique`                        | `enqueue(…, { unique })`: one waiting run per key      |
| `as_schedule_recurring_action()` | `define(name, { everySeconds })`: declared, not queued |
| `as_unschedule_all_actions()`    | `cancel(name, unique?)`                                |
| `as_next_scheduled_action()`     | `next(name, unique?)`                                  |
| `action_scheduler_failed_action` | The `job.failed` action                                |
| Tools › Scheduled Actions        | The same screen, for `core.manage_jobs`                |

- **The queue is a table**, `cms_jobs`, one row per run, kept after it finishes as the log (30
  days). A job is queued in the caller's transaction, so it exists only if what asked for it was
  kept: the outbox every later part builds on.
- **Runs** are claimed with `FOR UPDATE SKIP LOCKED`, so several servers never take the same one;
  tried again with a growing wait as often as the job allows (once by default, as Action
  Scheduler); timed out, with an `AbortSignal` for the handler; and taken over once their lock
  runs out, when their server stopped. Only the run that holds a job may finish it.
- **A repeating job** is declared, not queued: the site queues its first run an interval after
  first seeing it, and each run queues the next, on its rhythm. Booting reads the waiting repeats
  once and writes only when a definition changed. A job no active plugin defines waits.
- **What runs them.** Where the server keeps running (`cms serve`, Docker), the site's own
  process: a job due now runs once the request that queued it has been answered (`after()`), and
  one timer, never polling, wakes for the next job's time. With the embedded database nothing
  looks while nothing waits; with PostgreSQL each server also looks once a minute, for jobs
  another queued (the transaction pooler rules out LISTEN/NOTIFY). On serverless hosts a
  scheduled request to `GET /api/p/core/cron`, with `CRON_SECRET`, runs what's due, and `after()`
  still runs a request's own jobs. A new site has the `vercel.json` entry, once a day, which is
  the most a Hobby project may.
- **Core's jobs**: `core.cleanup` daily (sessions and emailed links that ran out, old failed
  sign-ins, the job log), `core.empty_trash` daily (`wp_scheduled_delete`, 30 days), and
  `core.publish_entry` at a scheduled entry's date (`publish_future_post`).
- **Scheduled publishing**, WordPress's `future` status: as `wp_insert_post()` has it, an entry
  saved as published with a date a minute or more ahead is stored as `scheduled`, and one saved
  as scheduled whose date has come as published. It owns its slug but isn't on the site. The
  save queues `core.publish_entry` in its transaction, keyed by the entry; a new date moves the
  job, and a draft, trashed or deleted entry cancels it. The job publishes through the content
  service, so `content.status` and `content.saved` run. The Publish box has the date (in UTC),
  and its button reads Schedule for a date ahead; lists have a Scheduled view, and say Missed
  schedule for an entry a minute past its date. A save that isn't scheduled before or after
  asks the queue nothing.
- **Cost**, on the embedded database with 50,000 finished and 2,300 waiting jobs: queueing 0.15
  ms, the next job's time 0.17 ms, taking a job 0.24 ms. A request that queues nothing runs no
  query for the queue.
- **Measured** on the Performance plugin's site (1,500 posts, 300 pages, 440 users), the build
  before 10a and the build after running side by side, 500 requests to each page alternating
  between them, so both see the same load. The median difference, after minus before: home
  −0.35 ms, a post +0.10 ms, a category −1.43 ms, the Posts list −1.81 ms, the Pages list −0.74
  ms, a post's edit screen −0.78 ms, the Dashboard −0.05 ms; the middle half of the differences
  spans zero for all but the category page and the Posts list. Those two are faster because
  migration core/0013 analyzes `cms_entries` after rebuilding its slug index; without that, the
  planner took the new index for cheaper than it is, and the Posts list's category counts went
  from 2.5 ms to 6 ms. Memory after 60 Posts lists: 406–416 MiB before, 414–417 MiB after.

Not in this part: cron expressions (`as_schedule_cron_action`), job groups and priorities, more
than one job at a time per server, a time zone for "every day at 3", and jobs in a request's
trace.

## 11. Page cache plugin

A full-page cache for signed-out visitors, as WordPress sites get from caching plugins, in a
repository of its own and on npm as an optional plugin. Every site page is rendered for every
visit today (`Cache-Control: no-store`): 6–10 ms each, 140–265 pages a second on one process.
Served from a cache, the same pages would answer thousands a second.

- **What's cached**: pages for visitors with no session, by address. Signed-in people, previews,
  form posts and the account pages always reach the site.
- **Invalidation** is the work: saving, trashing or restoring an entry, or changing a term or a
  setting, must drop the pages that show it (the entry, its archives, the home page). It needs
  hooks core may not have yet, and a plugin's own pages need a way to say what they show.
- **Where it's kept**: memory for one server, and a store plugins can provide (Redis) for
  several; `Cache-Control` for a CDN in front.
- **Measured** against today's numbers above.

## Later

A community plugin (BuddyPress-style profiles, groups, activity) as the third proof, themes and
component overrides, i18n.
