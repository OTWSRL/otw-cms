---
'@otwdesign/core': patch
---

A signed value passes only with its signature as it was written. The admin's one-time messages
and the sign-in provider cookie compared decoded bytes, so one signature also passed with its
last character swapped for its neighbour, which decodes alike. Nothing could be forged with it:
it was the same signature, written another way.
