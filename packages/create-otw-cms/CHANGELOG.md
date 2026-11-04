# create-otw-cms

## 1.0.2

### Patch Changes

- d6c8349: Plugins named with `--plugins` get a range on their own newest version, looked up with `npm view`
  (so a site's `.npmrc` applies), not on the scaffolder's version. A third-party plugin, or one of
  the CMS's own released apart from it, installs again. A plugin npm can't find stops the scaffolder
  before it writes anything.

## 1.0.1

### Patch Changes

- 01f3172: The scaffolder's help and README say that `--plugins` takes a short name for one of the CMS's own
  plugins, such as `performance` for `@otwdesign/plugin-performance`, as well as npm package names.
