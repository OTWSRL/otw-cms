# @otwdesign/cli

The `cms` command for OTW CMS sites:

- `cms generate` writes the site module and the CMS's route files from `cms.config.json`.
- `cms migrate` backs up the database, then runs pending migrations.
- `cms update` updates the CMS and its plugins to the newest compatible versions.
- `cms serve` runs the site from built releases, with updates from the admin.

A site made with `npm create otw-cms` has it as a development dependency. Run `cms --help` for the
options.

Part of [OTW CMS](https://github.com/OTWSRL/otw-cms), a WordPress-style CMS for Next.js and
PostgreSQL. Licensed under the Apache License 2.0.
