# {{name}}

A Next CMS site: Next.js with WordPress-style plugins, roles and admin.

```sh
{{run}} dev      # http://localhost:3000; the admin is at /admin
```

The first visit to `/admin` creates the administrator account. Without `DATABASE_URL` the site
uses an embedded database in `.data/`; see `.env.example` for the other settings.

## What's yours and what's the CMS's

- **Yours:** `cms.config.json` (installed plugins), `next.config.ts`, `src/app/(site)/layout.tsx`
  and `src/app/globals.css` (the storefront's look), `.env`, and any routes you add.
- **The CMS's:** the files whose first line says `@generated`. `cms generate` writes them
  before every `dev` and `build`, so updates can change them. Delete that line to keep a file
  as your own; it is never overwritten again.

## Plugins

Install the package, add its name to `cms.config.json`, and restart. Switch plugins on and off
under Plugins in the admin.

## Hosting

- **Your own server, one instance:** `{{run}} build`, then `{{run}} start`, or the Dockerfile.
  Database migrations run when the site starts.
- **Several instances, or serverless (Vercel and similar):** set `DATABASE_URL` (Postgres) and
  `CMS_MIGRATIONS=deploy`, and build with `{{run}} build:deploy`, which migrates before building,
  so the database is ready before the new version takes traffic (on Vercel, set it as the build
  command). It skips the backup: use your database host's.

## Updating

```sh
{{exec}} cms update --check   # what's new, and which plugins support it
{{exec}} cms update           # update core and plugins, install and regenerate
{{exec}} cms migrate          # back up the database, then migrate (stop the site first)
{{run}} build                # then restart
```

`{{exec}} cms update forum` updates one plugin (`core` for the CMS itself), and `--plugins-only`
leaves the CMS alone. Plugins from a private or paid registry update with the registry and token
in your `.npmrc`, as npm installs them.

On hosts that build from git, `{{exec}} cms update --commit` puts the update on a new branch: push
it and open a pull request. Migrations run in the deploy step as above, or from the admin's
"Database update required" notice.
