---
'@otwdesign/core': patch
---

A text setting whose value reads as JSON (a number such as `90`, `true`, `null`) keeps it: the
value was saved, then ignored at the next start with "Must be text", so the setting went back to
its default.
