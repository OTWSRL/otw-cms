# Next CMS

A WordPress-style CMS on Next.js where third parties build large plugins (commerce, community,
LMS) that extend each other.

Plugins are npm packages compiled into the app. **Installing** a plugin adds it to
`apps/web/cms.config.json` and rebuilds. **Activating** one is a switch on the admin's Plugins
screen, with no rebuild.

## Layout

```
apps/web               Next.js app: catch-all route, plugin API route, layout slots
packages/sdk           @cms/sdk: the only package plugin authors depend on (types + definePlugin)
packages/core          @cms/core: the kernel (resolver, hooks, registries, services, router, migrations)
packages/testing       @cms/testing: boots the kernel on in-memory Postgres for plugin tests
packages/cli           @cms/cli: `cms generate` writes the static plugin import map
plugins/commerce       products, orders, checkout; defines the extension points other plugins use
plugins/commerce-stripe  Stripe Checkout gateway + signed, idempotent webhook
```

## Commands

```sh
pnpm install
pnpm seed            # demo products in the embedded database (apps/web/.data)
pnpm dev             # http://localhost:3000, admin at /admin
pnpm check           # lint, format, typecheck, unit + integration tests
pnpm test:e2e        # Playwright against a production build
```

There's no database to set up: without `DATABASE_URL` the app uses embedded PGlite. Set
`DATABASE_URL` for Postgres in production. Other settings are in `apps/web/.env.example`.

The first visit to `/admin` creates the administrator account, as WordPress's installer does.

## How the kernel boots

0. **Load site state.** Core's own migrations run, then the kernel reads which plugins are active
   and the stored settings. On first boot every installed plugin is active; plugins installed
   later start inactive.
1. **Resolve.** Check the semver ranges for core and dependencies, then sort plugins so
   dependencies load first. Plugins with unmet requirements or hard cycles are skipped with a
   reason. A cycle that runs through an optional dependency drops only that integration.
2. **Migrate.** Each plugin's migrations run in a transaction under an advisory lock and are
   tracked per plugin in `cms_migrations`.
3. **Set up.** Each plugin registers its hooks, registries, services, routes and slots. After boot
   the registry is sealed, so a late registration fails loudly instead of leaking.
4. **Recovery mode.** If a plugin throws during migrate or setup, the kernel boots again without it
   and without anything that requires it. `strict: true` (the default in `@cms/testing`) throws
   instead.
5. **Reboot on change.** Activating a plugin or saving settings bumps a generation counter in the
   database. The app keeps one kernel per bundle and replaces it when the counter moves: at once
   for changes made in the same process, within two seconds for other instances.

## Writing a plugin

```tsx
import { ActionError, definePlugin } from '@cms/sdk'
import type {} from '@cms/plugin-commerce' // loads commerce's extension-point types

export default definePlugin({
  id: 'lms',
  version: '1.0.0',
  name: 'Courses',
  requires: { core: '^0.1.0' },
  optional: { commerce: '^0.1.0' }, // works alone; integrates when commerce is active
  migrations: [{ id: '0001_courses', up: (db) => db.execute(sql`CREATE TABLE lms_courses (...)`) }],
  settings: {
    'lms.certificates': { type: 'boolean', label: 'Issue certificates', default: true },
  },

  setup(cms) {
    cms.routes.page({
      name: 'course',
      path: '/courses/:slug', // sites can override: { 'lms.course': '/learn/:slug' }
      load: ({ params }) => findCourse(cms.db, params.slug!), // null → 404
      metadata: ({ data }) => ({ title: data.title }),
      component: ({ data }) => <CoursePage course={data} />,
    })

    cms.when('commerce', () => {
      cms.registries.get('commerce.purchasables').add({ id: 'course', resolveMany: findPrices })
      cms.hooks.addAction('commerce.order.paid', ({ order }) => enrollBuyer(cms.db, order))
    })

    cms.auth.role('teacher', { label: 'Teacher', capabilities: ['core.access_admin'] })
    cms.auth.capability('lms.manage_courses', { label: 'Manage courses', roles: ['teacher'] })

    cms.admin.page({
      name: 'courses',
      path: '/courses', // served at /admin/lms/courses
      title: 'Courses',
      capability: 'lms.manage_courses',
      menu: { label: 'Courses' },
      load: () => listCourses(cms.db), // write load before title and component, for inference
      component: ({ data }) => (
        <CourseTable courses={data} action={cms.admin.actionUrl('publish')} />
      ),
    })
    cms.admin.action({
      name: 'publish',
      capability: 'lms.manage_courses',
      async handler({ form, user }) {
        const course = await publishCourse(cms.db, form.get('course'), user)
        if (!course) throw new ActionError('That course no longer exists.') // shown on the form
        return { notice: `${course.title} is live.` }
      },
    })
  },
})
```

Rules the kernel enforces or relies on:

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
  declare module '@cms/sdk' {
    interface Actions {
      'lms.course.completed': { userId: string; courseId: string }
    }
  }
  ```

- **Test with `@cms/testing`:** `createTestKernel({ plugins: [...] })` gives you a kernel on a fresh
  migrated database, `request()` for API routes and admin actions, `signIn(role)` for a session
  cookie, and `reboot()` to see activation and settings changes.

## The admin

- **Users and roles.** A user has one role and a role grants capabilities, as in WordPress.
  Administrators have every capability. Core defines `administrator` and `customer`; commerce
  adds `shop_manager`. Plugins add roles, declare capabilities (`lms.manage_courses`) and grant
  them to other plugins' roles. A grant to a role whose plugin is inactive is dropped.
- **Screens.** Core provides Dashboard, Plugins, Settings and Users. Plugin pages mount at
  `/admin/{pluginId}/...` and appear in the menu for users with the page's capability. Style them
  with the `cms-*` classes in `apps/web/src/app/admin/admin.css` (`cms-table`, `cms-form`,
  `cms-button`, `cms-form-actions`, `cms-details`).
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
- **Admin actions** require an `Origin` header matching the site (stricter than public routes),
  on top of `SameSite=Lax`. Redirects only go to same-site paths.
- **Flash messages** travel in the redirect URL signed with HMAC and expire after 10 minutes, so
  a crafted link can't make the admin display attacker-written text.
- **First-run setup** is open to whoever reaches a fresh install first, as in WordPress. Run setup
  before exposing a new site.

## Not built yet

Customer accounts on the storefront, password reset and email, editing roles in the admin,
component overrides for themes, uninstall (down migrations), job queue, outbound event outbox, and
the install flow (`pnpm add` + generate + blue/green rebuild).
