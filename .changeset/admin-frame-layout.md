---
'@otwdesign/core': minor
'@otwdesign/next': minor
'@otwdesign/admin-ui': minor
'@otwdesign/sdk': minor
'@otwdesign/cli': minor
---

Fewer bytes on every admin screen, and on every click between them.

- **The admin's frame is a layout.** The bar, the menu with its counts, and the footer are drawn
  once per page load, by `app/(cms)/admin/layout.tsx`, which `cms generate` now writes (a site's
  `dev` and `build` scripts run it). A click on a menu link fetches the screen alone: 42% fewer
  bytes for a click from Settings to Users, and about 0.2 ms less server time. Each page still
  checks who may open it. The `admin.footer` slot stays with each screen, so a fill can show that
  request, as the performance bar does. A screen someone may not open now shows inside the frame.
- **A plugin's drawn icon and a sign-in button's mark come from an address.** Core serves them
  (`/api/p/core/icons/{plugin}`, to people who can open the admin, and
  `/api/p/core/sign-in/{provider}/image`), and browsers keep them for a year. Pages carry the
  address instead of the base64 image, which went out twice, or three times for a menu icon.
  Plugins change nothing.
- **`AdminIcon` writes its image once**: the admin's stylesheet holds the mask, with and without
  the `-webkit-` prefix.
- **`Tabs`** in `@otwdesign/admin-ui`: WordPress's tabs across a screen, for a plugin that keeps
  one link in the menu. A tab opens the next screen as a menu link does, without loading the page
  again; so does any link with `data-admin-link` (`ADMIN_LINK`).
