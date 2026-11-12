---
'@otwdesign/sdk': minor
'@otwdesign/core': minor
'@otwdesign/next': minor
---

**Delete Data** on the Plugins screen, as WordPress's Delete runs a plugin's `uninstall.php`: an
inactive plugin's data is deleted after a page that says what will go. A plugin's new
`uninstall({ db })` removes what it made, such as its tables; core then forgets its migrations, and
deletes its saved settings, jobs and cached values, all in one transaction.
