import { definePlugin, HttpError } from '@otwdesign/sdk'

// The e2e tests' plugin: what a plugin can add to the site and the admin, without a business of
// its own. Fixed data, so it needs no tables. Courier (../courier) depends on it.

/** The books on the shelves. */
export const BOOKS = [
  { slug: 'middlemarch', title: 'Middlemarch', author: 'George Eliot' },
  { slug: 'the-waves', title: 'The Waves', author: 'Virginia Woolf' },
  { slug: 'ulysses', title: 'Ulysses', author: 'James Joyce' },
]

/** The loans: a list table with more columns than a phone shows. */
export const LOANS = [
  { id: 'L-1001', book: 'Middlemarch', borrower: 'ana@example.com', due: '2026-12-01' },
  { id: 'L-1002', book: 'The Waves', borrower: 'sam@example.com', due: '2026-12-08' },
]

declare module '@otwdesign/sdk' {
  interface Settings {
    /** Closed, the library page says so. */
    'library.open': boolean
  }
  interface Capabilities {
    'library.manage_loans': true
    'library.manage_settings': true
  }
  interface Jobs {
    /** Does nothing, at the time it's given: what wakes the site's job runner for the tests. */
    'library.tick': Record<string, never>
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const library = definePlugin({
  id: 'library',
  version: '1.0.0',
  name: 'Library',
  icon: 'book',
  description: 'Books on the site and loans in the admin, for the e2e tests.',
  requires: { core: '^1.0.0' },
  // A table of its own, so `cms migrate` and the admin's database checks see a plugin's
  // migrations next to core's. Plain SQL: no drizzle import in a fixture.
  migrations: [
    {
      id: '0001_create_visits',
      up: async (db) => {
        await db.execute(
          'CREATE TABLE library_visits (id serial PRIMARY KEY, visited_at timestamptz NOT NULL DEFAULT now())',
        )
      },
    },
  ],
  // What "Delete Data" on the Plugins screen removes, besides what core kept for the plugin.
  uninstall: async ({ db }) => {
    await db.execute('DROP TABLE library_visits')
  },
  settings: {
    'library.open': {
      type: 'boolean',
      label: 'Open the reading room',
      description: 'Closed, the library page says so.',
      default: true,
    },
  },

  setup(cms) {
    cms.auth.role('librarian', { label: 'Librarian', capabilities: ['core.access_admin'] })
    cms.auth.capability('library.manage_loans', { label: 'Manage loans', roles: ['librarian'] })
    cms.auth.capability('library.manage_settings', {
      label: 'Change library settings',
      roles: ['librarian'],
    })

    cms.routes.page({
      name: 'shelves',
      path: '/library',
      load: () => ({ open: cms.settings.get('library.open') ?? true }),
      metadata: () => ({ title: 'Library' }),
      component: ({ data }) => (
        <>
          <h1>Library</h1>
          {data.open ? (
            <ul>
              {BOOKS.map((book) => (
                <li key={book.slug}>
                  <a href={cms.routes.url('library.book', { slug: book.slug })}>{book.title}</a>
                </li>
              ))}
            </ul>
          ) : (
            <p>The reading room is closed.</p>
          )}
        </>
      ),
    })

    cms.routes.page({
      name: 'book',
      path: '/library/:slug',
      load: ({ params }) => BOOKS.find((book) => book.slug === params.slug) ?? null,
      metadata: ({ data }) => ({ title: data.title }),
      component: ({ data }) => (
        <>
          <h1>{data.title}</h1>
          <p>{data.author}</p>
        </>
      ),
    })

    // A JSON API: the kernel blocks cross-site posts before it; it checks its own input.
    cms.routes.api({
      method: 'POST',
      path: '/loans',
      handler: async (request) => {
        const body: unknown = await request.json().catch(() => null)
        const slug = typeof body === 'object' && body !== null && 'book' in body ? body.book : null
        const book = BOOKS.find((candidate) => candidate.slug === slug)
        if (!book) throw new HttpError(400, 'Choose a book on the shelves')
        return Response.json({ book: book.slug }, { status: 201 })
      },
    })

    // The e2e tests' clock. A scheduled entry is published a minute or more after it's saved, at
    // the soonest; this moves its date, and the job that publishes it, to a moment from now, as
    // if the wait had passed, and has the site's own runner look then. Nothing else is touched:
    // the timer, the job and the publishing are the site's.
    cms.jobs.define('library.tick', { label: 'Nothing, on time', handler: async () => {} })
    cms.routes.api({
      method: 'POST',
      path: '/time-passes',
      handler: async (request, context) => {
        const user = await context.user()
        if (!user || !cms.auth.can(user, 'core.manage_jobs')) throw new HttpError(403, 'Not yours')
        const body: unknown = await request.json().catch(() => null)
        const id = typeof body === 'object' && body !== null && 'entry' in body ? body.entry : null
        if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'Name the entry')
        const at = new Date(Date.now() + 2000)
        // Plain SQL, as the migration above: the id and the time are checked, not typed in.
        await cms.db.execute(
          `UPDATE cms_entries SET published_at = '${at.toISOString()}'
            WHERE id = '${id}' AND status = 'scheduled'`,
        )
        await cms.db.execute(
          `UPDATE cms_jobs SET run_at = '${at.toISOString()}'
            WHERE name = 'core.publish_entry' AND status = 'pending' AND args ->> 'id' = '${id}'`,
        )
        await cms.jobs.enqueue('library.tick', {}, { at })
        return Response.json({ at: at.toISOString() })
      },
    })

    cms.slots.fill('header.nav', {
      component: () => <a href={cms.routes.url('library.shelves')}>Library</a>,
    })

    cms.slots.fill('account.sections', {
      component: () => (
        <section aria-labelledby="library-card">
          <h2 id="library-card">Library card</h2>
          <p>No books on loan.</p>
        </section>
      ),
    })
  },
})

export default library
