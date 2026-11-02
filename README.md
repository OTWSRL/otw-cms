# OTW CMS

A WordPress-style CMS on Next.js where third parties build large plugins (commerce, community,
LMS) that extend each other.

A site is a small Next.js app that depends on the CMS's packages, so updating the CMS or a
plugin is a version bump (`cms update`). Plugins are npm packages compiled into the site.
**Installing** a plugin adds it to the site's `cms.config.json` and rebuilds. **Activating** one
is a switch on the admin's Plugins screen, with no rebuild.

## Layout

```
apps/web               the CMS's own site, exactly what create-otw-cms makes, plus e2e tests
packages/next          @otw/next: the admin, the storefront route, the API route and the runtime
packages/sdk           @otw/sdk: the only package plugin authors depend on (types + definePlugin)
packages/admin-ui      @otw/admin-ui: WordPress-style admin components (list and form tables, boxes)
packages/core          @otw/core: the kernel (resolver, hooks, registries, services, router, migrations)
packages/testing       @otw/testing: boots the kernel on in-memory Postgres for plugin tests
packages/cli           @otw/cli: `cms generate`, `cms migrate`, `cms update`, `cms serve`
packages/create-otw-cms  scaffolds a new site (`pnpm create otw-cms my-site`)
plugins/commerce       products, orders, checkout; defines the extension points other plugins use
plugins/commerce-stripe  Stripe Checkout gateway + signed, idempotent webhook
```

Plugins that aren't part of the CMS live in repositories of their own, next to this one, and link
to its packages until they're on npm: `../otw-plugin-performance` is the first.

## Commands

```sh
pnpm install
pnpm seed            # demo products in the embedded database (apps/web/.data)
pnpm dev             # http://localhost:3000, admin at /admin
pnpm check           # lint, format, typecheck, unit + integration tests
pnpm test:e2e        # Playwright against a production build, desktop plus phone and tablet
```

The phone and tablet runs use Playwright's WebKit as well as Chromium; install it once with
`pnpm --filter @otw/web exec playwright install webkit`.

There's no database to set up: without `DATABASE_URL` the app uses embedded PGlite. Set
`DATABASE_URL` for Postgres in production. Other settings are in `apps/web/.env.example`.

The first visit to `/admin` creates the administrator account, as WordPress's installer does.

## Sites, hosting and updates

- **A site owns** `cms.config.json`, `next.config.ts` (wrapped in `withCms()`), its storefront
  layout and styles (`src/app/(site)/layout.tsx`, `globals.css`), `.env` and its own routes.
- **The CMS owns** the files `cms generate` writes before every `dev` and `build`: the site
  module (`src/cms/site.generated.ts`, the installed plugins), the admin's
  (`src/cms/admin.generated.ts`, the plugins with their admin entries, imported only by the admin
  and the API, so admin code never reaches visitors), the admin's root layout and its one
  catch-all page with 403 and 404 pages, the API route, the storefront's home page and
  catch-all, and `instrumentation.ts`, which Next.js loads to record requests. Each starts with an `@generated` line; delete it and the file is the site's, never
  overwritten. The admin is one route, so new core screens arrive with the package. For its own
  home page a site writes `src/app/(site)/page.tsx`; otherwise plugins can claim `/`. Files a
  version stops managing are removed while they still carry the line.
- **Tracing.** Every request can be recorded as an OpenTelemetry trace: Next.js's own spans
  (routing, rendering, metadata) and the CMS's (kernel boot, each plugin's setup and migrations,
  hook handlers, page and admin loads, API routes, and every query, with its statement but never
  its values), each attributed to the plugin it ran for. Nothing is recorded until an active
  plugin calls `cms.traces.enable()`; then requests are recorded and dropped when they end unless
  a plugin keeps them (`cms.traces.keep()`), up to 100 for 10 minutes. The performance plugin
  (`../otw-plugin-performance`) shows them in a bar at the bottom of every page (the
  `site.footer` and `admin.footer` slots) for people with `performance.view`, with the browser's
  timings and Web Vitals. Measured on `/shop`: 0.08 ms per request with nothing recording,
  0.15 ms recording a visitor's request. A site that sets up OpenTelemetry itself adds
  `cmsTracing()`'s span processor, from `@otw/next/tracing`, to its provider, in a file only the
  Node.js runtime loads: Next.js builds `instrumentation.ts` for the Edge runtime too.
- **Plugin page paths.** A site can move a plugin's pages with `routes` in `cms.config.json`:
  `"routes": { "commerce.product": "/p/:slug" }`. The new path must keep the page's parameters;
  links built with `cms.routes.url()` follow it. An override for a page no plugin has is a warning
  on the Dashboard; one with different parameters leaves that plugin off, with the reason.
- **White label.** The admin calls the CMS "OTW CMS": the footer, the Dashboard, Updates, and
  the logo on the sign-in screens. A `brand` in `cms.config.json` gives it another name:
  `"brand": { "name": "Acme Sites", "url": "https://acme.example", "logo": "/brand/logo.svg" }`.
  The name links to `url`, as WordPress links to wordpress.org, and `logo` (a path on the site,
  or an https URL) replaces the mark. It's set per deploy rather than in the admin, so a client
  can't take it off, and `cms generate` rejects any other kind of link. The code keeps its own
  names (`@otw/*`, the `cms` command, `CMS_*` variables, `cms_*` tables), as a white-labelled
  WordPress keeps its `wp_` tables. A new site is called "My Site" until it gets a title.
- **Database changes.** `CMS_MIGRATIONS=startup` (default) migrates when the site starts, for one
  server. `CMS_MIGRATIONS=deploy` never migrates at runtime: run `cms migrate` in the deploy
  step (`build:deploy` in a new site), for several instances or serverless. Until then plugins
  with pending migrations wait, and administrators get WooCommerce's "Database update required"
  notice with an Update database button; pending core migrations stop the site with the command
  to run in the log. `cms migrate` backs up first (a copy of the embedded database, or
  `pg_dump`), and `--dry-run` lists what would run. The embedded database belongs to one
  process: a lock file stops a second server, or `cms migrate` beside a running site.
- **Updating.** `cms update --check` lists newer core and plugin versions and which plugins
  support the new core. Plugins declare it as a peer dependency on `@otw/sdk`, and what they
  need from each other as peer dependencies on those plugins, so this is known before anything
  changes: a plugin another one still needs in an older version is held back, and says why.
  `cms update` bumps `package.json` within core's compatible range (`--major` to cross it),
  installs, and regenerates the route files with the new version; then migrate, build and
  restart. `cms update commerce` (or `@acme/forum`, or `core`) updates only those, and
  `--plugins-only` leaves core alone. Versions come from `npm view` in the site's directory, so
  `.npmrc` registries and tokens for private and paid plugins apply; one npm can't reach is
  reported and left as it is. `--commit` puts it on a git branch for hosts that build from git.
- **Updates from the admin.** Dashboard › Updates and the Plugins screen's "update now", as in
  WordPress, through whichever channel the hosting allows. `cms serve` (your own server) runs
  the site from built releases in `.cms/releases` behind a small proxy: an update builds a new
  release beside the live one with the same planner, backs up and migrates, starts it, checks
  it answers and switches. With Postgres there's no downtime; with the embedded database
  visitors get a few seconds of 503 "being updated". A failure leaves the old release serving
  and restores the backup; earlier releases can be rolled back to; `package.json`, the lockfile
  and managed route files are written back to the site. It checks twice a day and can install
  patch releases on its own. With `CMS_GITHUB_REPO` and `CMS_GITHUB_TOKEN` (Vercel and other
  git-built hosts) the admin starts the site's `cms-update.yml` workflow, which opens a pull
  request. Otherwise the screen gives the commands. Needs `core.manage_updates`.
- **Behind a reverse proxy** (nginx, Caddy), Next.js sees its own address, not the visitor's.
  Set `CMS_TRUST_PROXY=1` so the admin trusts `X-Forwarded-Host` and `X-Forwarded-Proto`, or set
  `SITE_URL` (the site address on Settings › General); until one is set, admin forms answer 403.
  `cms serve` sets `CMS_TRUST_PROXY` for its releases.
- **A new site:** `pnpm create otw-cms my-site --plugins commerce,commerce-stripe`, or
  `--link <checkout>` to try unreleased changes. It includes a Dockerfile for your own server.

## How the kernel boots

0. **Load site state.** Core's own migrations run (or, with `CMS_MIGRATIONS=deploy`, are checked:
   pending ones stop the boot), then the kernel reads which plugins are active
   and the stored settings. On first boot every installed plugin is active; plugins installed
   later start inactive.
1. **Resolve.** Check the semver ranges for core and dependencies, then sort plugins so
   dependencies load first. Plugins with unmet requirements or hard cycles are skipped with a
   reason. A cycle that runs through an optional dependency drops only that integration.
2. **Migrate.** Each plugin's migrations run in a transaction under an advisory lock and are
   tracked per plugin in `cms_migrations`. With `CMS_MIGRATIONS=deploy` nothing runs here;
   plugins with pending migrations are left out, with the reason, until `cms migrate` or an
   administrator runs them.
3. **Set up.** Each plugin registers its hooks, registries, services, routes and slots. After boot
   the registry is sealed, so a late registration fails loudly instead of leaking.
4. **Recovery mode.** If a plugin throws during migrate or setup, the kernel boots again without it
   and without anything that requires it. `strict: true` (the default in `@otw/testing`) throws
   instead.
5. **Reboot on change.** Activating a plugin or saving settings bumps a generation counter in the
   database. The app keeps one kernel per bundle and replaces it when the counter moves: at once
   for changes made in the same process, within two seconds for other instances.

## Writing a plugin

```tsx
// src/index.tsx: the main entry, which the site's pages, the API and the admin all load
import { definePlugin } from '@otw/sdk'
import type {} from '@otw/plugin-commerce' // loads commerce's extension-point types

export default definePlugin({
  id: 'lms',
  version: '1.0.0',
  name: 'Courses',
  icon: 'book', // the menu icon: a built-in name, or a base64 SVG data URI as in add_menu_page()
  requires: { core: '^0.1.0' },
  optional: { commerce: '^0.1.0' }, // works alone; integrates when commerce is active
  migrations: [{ id: '0001_courses', up: (db) => db.execute(sql`CREATE TABLE lms_courses (...)`) }],
  settings: {
    'lms.certificates': { type: 'boolean', label: 'Issue certificates', default: true },
  },

  setup(cms) {
    cms.auth.role('teacher', { label: 'Teacher', capabilities: ['core.access_admin'] })
    // WordPress's register_post_type(): courses are entries of the type lms.course, with
    // WordPress's capabilities (lms.edit_courses, lms.edit_others_courses, lms.publish_courses…
    // and lms.edit_course for one course). Teachers write and publish their own.
    cms.content.type('course', {
      labels: { singular: 'Course', plural: 'Courses' },
      public: true,
      supports: ['title', 'body', 'excerpt', 'author'],
      roles: { editor: 'editor', teacher: 'author' },
    })

    cms.routes.page({
      name: 'course',
      path: '/courses/:slug', // a site can move it: "routes": { "lms.course": "/learn/:slug" }
      load: ({ params }) => cms.content.getBySlug('lms.course', params.slug!), // null → 404
      metadata: ({ data }) => ({ title: data.title }),
      component: ({ data }) => <CoursePage course={data} />,
    })

    cms.when('commerce', () => {
      cms.registries.get('commerce.purchasables').add({ id: 'course', resolveMany: findPrices })
      cms.hooks.addAction('commerce.order.paid', ({ order }) => enrollBuyer(cms.db, order))
    })

    cms.auth.capability('lms.grade', { label: 'Grade students', roles: ['teacher'] })
    cms.auth.grant('shop_manager', ['lms.edit_courses']) // any plugin's role
    // WordPress's map_meta_cap: the object decides which capabilities are needed.
    cms.auth.metaCapability('lms.grade_enrollment', {
      label: 'Grade a student',
      map: (user, enrollment) => (enrollment.teacherId === user.id ? ['lms.grade'] : false),
    })
  },
})
```

```tsx
// src/admin.tsx: the admin entry, the package's "./admin" export, which only the admin and the
// API load: Next.js sends every client component a page imports to its visitors.
import { ActionError, defineAdmin, ForbiddenError } from '@otw/sdk'
import lms from './index'

export default defineAdmin(lms, (cms) => {
    cms.admin.page({
      name: 'courses',
      path: '/courses', // served at /admin/lms/courses
      title: 'Courses',
      capability: 'lms.edit_courses',
      menu: { label: 'Courses' },
      // Write load before title and component, so their data is typed from it.
      load: () => cms.content.list({ type: 'lms.course', limit: 50 }),
      titleAction: () => ({ label: 'Add Course', url: cms.admin.url('lms.course-new') }),
      component: ({ data, user }) => (
        // From @otw/admin-ui: WP_List_Table's markup, striped, with a phone layout.
        <ListTable
          caption="Courses"
          rows={data.entries.filter((course) => cms.auth.can(user, 'lms.edit_course', course))}
          rowKey={(course) => course.id}
          rowActions={(course) => [
            <a key="edit" href={cms.admin.url('lms.course', { id: course.id })}>
              Edit
            </a>,
          ]}
          columns={[{ key: 'title', label: 'Title', render: (course) => course.title }]}
          empty="No courses found."
        />
      ),
    })
    cms.admin.page({ ..., menu: { label: 'Course sales', parent: 'commerce' } }) // another menu

    // Settings stay declared in the definition; these say where they show.
    cms.admin.settingsPage({ name: 'settings', path: '/settings', title: 'Course settings' })
    cms.admin.settingsSection({
      name: 'certificates',
      page: 'lms.settings', // or another plugin's page, e.g. 'commerce.payments'
      title: 'Certificates',
      fields: ['lms.certificates'],
    })

    // Fill admin slots here and site slots in setup(); offer your own with declaration merging
    // and cms.slots.get().
    cms.slots.fill('admin.dashboard', { component: ({ user }) => <EnrollmentsWidget user={user} /> })
    cms.admin.action({
      name: 'publish',
      capability: 'lms.edit_courses',
      async handler({ form, user }) {
        const course = await cms.content.get(String(form.get('course')))
        if (!course) throw new ActionError('That course no longer exists.') // shown on the form
        // The content API doesn't check capabilities, like wp_insert_post(): its callers do.
        if (!cms.auth.can(user, 'lms.publish_course', course)) throw new ForbiddenError()
        await cms.content.update(course.id, { status: 'published' })
        return { notice: `${course.title} is live.` }
      },
    })
})
```

Rules the kernel enforces or relies on:

- **Admin code goes in the admin entry.** `cms.admin.*` registrations and fills for admin slots
  (`admin.*`, `{plugin}.admin.*`) belong in `defineAdmin()`; roles and capabilities in `setup()`,
  so every part of the site agrees on them. The kernel refuses either in the wrong place.
  `cms.admin.url('lms.courses')` works where the admin is loaded; site code links by path,
  `cms.admin.url('/courses')`, like WordPress's `admin_url()`.

- **Namespace everything** with your plugin id: tables (`lms_*`), hooks (`lms.course.completed`),
  registries and settings.
- **Own your tables.** Foreign keys may point at core tables and at your _required_ dependencies'
  tables. Integrations with _optional_ dependencies keep their links in your own tables. Use other
  plugins' **services**, never their tables.
- **Read `cms.db` at call time.** Inside `cms.transaction()` it returns the transaction (through
  AsyncLocalStorage), so filters and actions write atomically with the operation that fired them.
- **Filters abort, actions don't.** A throwing filter fails the operation. A throwing action is
  logged and skipped, and runs in a savepoint so it can't poison the surrounding transaction.
- **Expose extension points** with declaration merging, so other plugins get types:

  ```ts
  declare module '@otw/sdk' {
    interface Actions {
      'lms.course.completed': { userId: string; courseId: string }
    }
    interface ContentTypes {
      'lms.course': true // types lms.edit_courses, lms.edit_course and the rest
    }
    interface MetaCapabilities {
      'lms.grade_enrollment': [enrollment: Enrollment]
    }
    interface Slots {
      'lms.admin.course': { course: Course; user: User }
    }
  }
  ```

- **Throw `ForbiddenError`** from an admin loader, action or API route when a check needs the
  loaded object (a meta capability). It answers 403.

- **Test with `@otw/testing`:** `createTestKernel({ plugins: [...] })` gives you a kernel on a fresh
  migrated database, `request()` for API routes and admin actions, `signIn(role)` for a session
  cookie, and `reboot()` to see activation and settings changes.

## The admin

- **Users and roles.** A user has one role and a role grants capabilities, as in WordPress.
  Administrators have every capability. Core defines `administrator`, WordPress's `editor`,
  `author` and `contributor`, and `customer`; commerce adds `shop_manager`. Every role starts
  with `core.read`, WordPress's `read`. Plugins add roles, declare capabilities (`lms.grade`), and
  `grant()` or `revoke()` them on any role. Nothing is stored: roles and grants are rebuilt on
  every boot from the active plugins, so deactivating a plugin removes what it added. Users ›
  All Users filters by role and changes the role of the ticked users at once (all or none, and
  never the last administrator); Add User and Roles are their own screens, as in WordPress.
- **Meta capabilities** map an object to the capabilities it requires, like `map_meta_cap`:
  `can(user, 'commerce.mark_order_paid', order)`. A map returns the required capabilities, or
  `false` to deny everyone, administrators included. Other plugins adjust a mapping with
  `extendCapability()`: a bank-transfer gateway lets shop managers confirm its orders by hand.
  Checks receive the loaded object, so they are synchronous and list screens need no extra
  queries.
- **Look.** The admin is WordPress 7.1's, default colour scheme: the black admin bar, the menu on
  the left with icons and fly-out submenus, Collapse Menu (remembered in a cookie), and the same
  breakpoints. From 960px down the menu folds to icons; below 783px it hides behind the admin
  bar's button, list tables show one column with a toggle for the rest, form tables stack, and
  fields use 16px text so iOS doesn't zoom. On touch screens the first tap on a section opens
  its submenu, as in WordPress. The stylesheet is our own, written to WordPress's measurements,
  not copied from it. There is no dark mode, as in WordPress.
- **Menu.** Sections in order: Dashboard, one per plugin (load order, with the plugin's `icon`),
  Plugins, Users, Settings. A section links to its first page and lists the rest as its
  submenu. A page joins another section with `menu.parent` (a core section or a plugin id); a
  parent whose plugin is inactive falls back to the page's own section.
- **Screens.** Plugin pages mount at `/admin/{pluginId}/...` and appear for users with the page's
  capability. The title and notices come from core; `titleAction` adds the "Add New" button.
  Build the body from `@otw/admin-ui` (`ListTable`, `Views`, `TableNav`, `FormTable`,
  `FormField`, `SubmitButton`, `Postbox`, `EditColumns`, `Notice`, `Button`, `FormButton`), or
  write WordPress's markup by hand: the admin styles its class names (`wrap`, `button-primary`,
  `notice-warning`, `form-table`, `wp-list-table`, `postbox`, `subsubsub`, `row-actions`).
- **Slots.** `admin.notices` shows on every screen, `admin.dashboard` on the dashboard, and
  `admin.footer` after every screen; `site.footer` ends every page of the site, where the site's
  layout renders it.
  Commerce offers `commerce.admin.order`, which Stripe fills with the Checkout session. Fills
  decide what to show from the `user` prop.
- **Actions.** Admin forms post to `cms.admin.actionUrl(name)`. Before the handler runs, the kernel
  requires a same-site `Origin`, a session and the capability. It then answers with a 303 back to
  the form, or to `redirect`, carrying a one-time message. Throw `ActionError` for messages the
  user should see; anything else is logged and shown as a generic error.
- **Activation.** A plugin can't be activated until its required plugins are active, and can't be
  deactivated while an active plugin requires it. Activation boots the site once with the plugin
  on first, so a plugin that crashes in setup stays off and the reason is shown.
  `CMS_ACTIVE_PLUGINS` pins the list and turns this screen read-only.
- **Settings.** Plugins declare fields in `settings`. Values resolve in this order: code, then
  environment variable (shown read-only), then database, then default. `secret` fields come from
  the environment only and the admin only says whether they are set. Invalid stored or env values
  are ignored with a warning instead of breaking boot.
- **Settings pages** follow WordPress's Settings API. Core has Settings › General with a Site
  section. Plugins add pages (`settingsPage`), sections on any page (`settingsSection`) and fields
  in any section (`settingsFields`), but place only their own settings. Commerce has Shop and
  Payments; Stripe adds its section to Payments. A section aimed at an inactive plugin's page
  moves to its owner's page, and fields nobody placed get a section there, or a page of their
  own. Each page has a capability (default `core.manage_settings`), so shop managers edit shop
  settings but not the site's. Saving a page writes only the editable fields on it. Plugins that
  read a changed setting during `setup()` are first booted with the new values (with what they
  depend on); if one can't start, nothing is saved. The rest can't fail on the change and aren't
  booted, so a save costs what it touches, not every plugin.

## Content

Post types and posts, as in WordPress, which every big plugin builds on: courses and lessons are
post types in LearnDash, LifterLMS and Tutor.

- **Types.** `cms.content.type('course', …)` in `setup()` registers `lms.course`, like
  `register_post_type()`. Core registers Posts (`core.post`) and Pages (`core.page`,
  hierarchical). A type declares WordPress's capabilities under its plugin's id: ten primitive
  ones (`lms.edit_courses`, `lms.edit_others_courses`, `lms.edit_published_courses`,
  `lms.publish_courses`, `lms.read_private_courses`, the `delete_*` ones…) and four meta ones
  that take an entry (`lms.edit_course`, `lms.read_course`, `lms.delete_course`,
  `lms.publish_course`), mapped as `map_meta_cap` maps posts: own, others', published, private,
  and in the trash by the status the entry had. `roles` grants them at WordPress's levels
  (`editor`, `author`, `contributor`); by default editors, authors and contributors get a type
  as they get posts. Pages are editors' only, as in WordPress. Nothing is stored, so the grants
  go with the plugin.
- **Entries.** One table, `cms_entries`, for every type, as `wp_posts` is.
  `cms.content.create/update/get/getBySlug/list/trash/restore/delete` work anywhere and, like
  `wp_insert_post()`, check no capabilities: screens, actions and API routes do. Statuses are
  `draft`, `pending`, `published`, `private` and `trash`; a restored entry comes back as a draft,
  as in WordPress 5.6 and later. The body is a list of blocks stored as JSON and rendered by
  React components, so stored content can't add markup of its own.
- **Slugs** come from the title (accents off Latin letters; other scripts kept). Published and
  private entries own theirs, among their siblings for hierarchical types; a taken slug gets
  `-2`, `-3`, enforced by a unique index. Drafts own none, so a draft's slug follows its title
  until it's published.
- **Hooks.** The `content.entry` filter sees the fields before they're saved, and its result is
  checked like any input. `content.status`, `content.saved`, `content.trashed`,
  `content.restored` and `content.deleted` run in the save's transaction.
- **Cost.** Types and their capabilities are built in memory at boot: 50 types add about
  0.002 ms each.

## Security model

Plugins run in-process with full access, the same trust model as WordPress and npm. Declared
dependencies are enforced. Any other boundary (marketplace review, package signing) has to come
from distribution, not from the runtime. Plugin API routes get a same-origin check on unsafe
methods. Payment webhooks verify their signatures and are idempotent.

- **Passwords** are hashed with scrypt (N=2^15, r=8, p=3, OWASP's lower-memory equivalent). The
  parameters are stored per hash so they can be raised later.
- **Sessions** are 32 random bytes; the database stores only their SHA-256, so a leaked table
  gives no working sessions. The cookie is `HttpOnly`, `SameSite=Lax`, and `__Host-` plus
  `Secure` when the site runs on HTTPS. Sessions last 14 days and end on sign-out or user deletion.
- **Sign-in** is throttled to 5 failures per email per 15 minutes. Unknown emails cost the same
  hash as wrong passwords, so timing doesn't reveal accounts. Throttling per IP belongs at the
  edge (WAF or proxy), where the client address is trustworthy.
- **Plugin API routes** are public, and ask for the signed-in user with `context.user()`. An unsafe
  request (POST, PUT, PATCH, DELETE) counts as signed in only when it carries this site's `Origin`,
  so a cookie on a request no browser vouched for can't act as its owner.
- **Admin actions** require an `Origin` header matching the site (stricter than public routes),
  on top of `SameSite=Lax`. The site is the request's own origin, the site address setting, or,
  with `CMS_TRUST_PROXY`, the forwarded host and protocol; forwarded headers are ignored
  otherwise, since anyone can send them. Redirects only go to same-site paths.
- **`cms serve`'s control port**, which the admin uses to start updates, listens on loopback
  only and requires a random bearer token (compared in constant time) that it hands to the
  releases it starts. Starting an update needs `core.manage_updates`.
- **Flash messages** travel in the redirect URL signed with HMAC and expire after 10 minutes, so
  a crafted link can't make the admin display attacker-written text.
- **First-run setup** is open to whoever reaches a fresh install first, as in WordPress. Run setup
  before exposing a new site.

## Roadmap

See [docs/roadmap.md](docs/roadmap.md): content continues with its admin screens, taxonomies and
meta, site pages and revisions, and media; then accounts and email, then the LMS plugin.
