# create-otw-cms

Creates an OTW CMS site in a folder of its own and installs it, with whichever package manager
runs it:

```sh
npm create otw-cms@latest my-site
pnpm create otw-cms my-site
yarn create otw-cms my-site
bun create otw-cms my-site
```

`--plugins lms,performance` starts the site with plugins (with npm, after `--`:
`npm create otw-cms@latest my-site -- --plugins lms`), and `--no-install` only writes the
files. Then `cd my-site` and start it; the first visit to `/admin` sets up the administrator.

Part of [OTW CMS](https://github.com/OTWSRL/otw-cms), a WordPress-style CMS for Next.js and
PostgreSQL. Licensed under the Apache License 2.0.
