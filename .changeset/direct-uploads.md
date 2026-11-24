---
'@otwdesign/sdk': minor
'@otwdesign/core': minor
'@otwdesign/admin-ui': minor
'@otwdesign/next': minor
'@otwdesign/cli': minor
'@otwdesign/testing': minor
'create-otw-cms': minor
---

Uploads straight to storage, for hosts that cap a request's size. A `MediaStorage` can take
large files from the browser (`directUploads`): the site signs an address, the browser sends the
bytes there, and the site reads the file back and stores it as any upload. `cms.media.disk`
reads the disk's files, for a storage plugin to copy them. Sites on the disk are unchanged.
