---
'@otwdesign/sdk': minor
'@otwdesign/core': minor
'@otwdesign/next': minor
'@otwdesign/cli': minor
'create-otw-cms': minor
---

**Plugins › Add Plugin**, as WordPress's Add Plugins, with npm as the directory: plugins tagged
`otw-cms-plugin` are listed and searched, and any plugin is installed by its package name. **Delete**
on an inactive plugin removes its data and its package. Both rebuild the site through `cms serve`
or the GitHub update workflow, and take the new `core.install_plugins` capability.

`cms plugin add <package>` and `cms plugin remove <package>` do the same from the command line.
A new site's update workflow takes `add_plugin` and `remove_plugin`; replace an older site's
`.github/workflows/cms-update.yml` to add plugins from the admin there.
