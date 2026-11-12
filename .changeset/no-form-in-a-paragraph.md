---
'@otwdesign/next': patch
---

Three admin screens no longer report a hydration error: a trashed entry's edit screen, a plugin
with an update on the Plugins screen, and "Check again" on Updates each had a form inside a
paragraph, which browsers split in two.
