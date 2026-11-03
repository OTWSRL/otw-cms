# @otwdesign/plugin-mail-file

Mail for development and tests: every message OTW CMS sends, such as sign-up and password
emails, is written to a file in `.data/mail` (or `MAIL_FILE_DIR`) instead of being sent.

```sh
npm install @otwdesign/plugin-mail-file
```

Add `"@otwdesign/plugin-mail-file"` to `plugins` in the site's `cms.config.json`, restart or rebuild the site, and
activate it on the Plugins screen.

Part of [OTW CMS](https://github.com/OTWSRL/otw-cms), a WordPress-style CMS for Next.js and
PostgreSQL. Licensed under the Apache License 2.0.
