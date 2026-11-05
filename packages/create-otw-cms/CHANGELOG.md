# create-otw-cms

## 1.1.0

### Minor Changes

- e4e5d69: A new site's Dockerfile builds an image of Next.js's standalone server, with `CMS_STANDALONE=1`:
  the site adds about 65 MB to Node.js's image, down from about 550 MB. A `migrate` target runs
  `cms migrate` for sites on several containers. Sites made before keep their Dockerfile, which
  still works.

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
