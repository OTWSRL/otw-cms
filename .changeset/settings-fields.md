---
'@otwdesign/sdk': minor
'@otwdesign/core': minor
'@otwdesign/next': minor
'@otwdesign/admin-ui': minor
---

Settings pages gain what a plugin needed its own screen for:

- **`roles` settings**: a checkbox for each of the site's roles, plugins' included.
- **`pairs` settings**: rows of a name and a value, added and removed in the admin, such as a
  request's headers.
- **`multiline`** on a text setting: a box of several lines.
- **`showWhen`** on a setting or a section: it shows only while another setting has a value, such
  as a provider's own fields once that provider is chosen. It follows the form as it's changed,
  before saving, with a style rule and no script; a hidden field keeps its value.
- **`link`** on a section: a button under its fields, to a screen that goes with them.

`FormField` takes `row`, for attributes on its table row.
