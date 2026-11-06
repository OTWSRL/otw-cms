# Changesets

Each change that should reach npm comes with a changeset: `pnpm changeset`, pick the packages and
the bump, and describe the change for the changelog. Commit the file with the change.

- The core packages (`sdk`, `core`, `admin-ui`, `next`, `cli`, `testing`) and `create-otw-cms`
  always release together, at one version: the scaffolder writes that version into new sites.
- First-party plugins version on their own. A core release within their peer range leaves them
  alone.
- A minor or patch release of core never breaks the plugin API; a change that does is a major
  one, after a deprecation in a minor release first.

To release, run `pnpm version-packages`, which writes the bumps and the changelogs, then commit
and push to `main`. Once CI passes, the release workflow publishes to npm.
