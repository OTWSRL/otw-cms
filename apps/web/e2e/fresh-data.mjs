// Before the e2e server builds: the data the last run left, deleted, so the first visit sets the
// site up again. Only these folders, under the site's .data.
import { rmSync } from 'node:fs'

for (const dir of ['.data/e2e', '.data/e2e-uploads', '.data/e2e-mail']) {
  rmSync(dir, { recursive: true, force: true })
}
