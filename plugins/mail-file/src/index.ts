import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { definePlugin, type MailTransport, type PluginDefinition } from '@otw/sdk'

declare module '@otw/sdk' {
  interface Settings {
    /** The folder emails are written to, relative to the site: `MAIL_FILE_DIR`. */
    'mail-file.dir': string
  }
}

/** Where emails go unless `MAIL_FILE_DIR` says, relative to the site. */
export const DEFAULT_DIR = '.data/mail'

/**
 * Writes each email to `dir` as a JSON file, named by when it was sent so they list in order,
 * instead of sending it: the site's mail, readable, for development and tests. Each file appears
 * whole, written beside it and renamed, so a reader never sees half of one.
 */
export function fileTransport(dir: string): MailTransport {
  return {
    async send(message) {
      const folder = resolve(dir)
      await mkdir(folder, { recursive: true })
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.json`
      const body = JSON.stringify({ sentAt: new Date().toISOString(), ...message }, null, 2)
      const partial = join(folder, `.${name}.partial`)
      await writeFile(partial, body, { flag: 'wx' })
      await rename(partial, join(folder, name))
    },
  }
}

/**
 * Mail to files: the site's email, written to a folder rather than sent, as a development mail
 * catcher (MailHog, Mailpit) shows it. Never activate it on a live site: nothing reaches anyone.
 */
export function createMailFilePlugin(): PluginDefinition {
  return definePlugin({
    id: 'mail-file',
    version: '0.1.0',
    name: 'Mail to files',
    description: 'Writes each email to a folder instead of sending it. For development and tests.',
    requires: { core: '^0.1.0' },
    settings: {
      'mail-file.dir': {
        type: 'text',
        label: 'Folder',
        description: 'Where emails are written, relative to the site.',
        default: DEFAULT_DIR,
        env: 'MAIL_FILE_DIR',
        maxLength: 500,
      },
    },
    setup(cms) {
      cms.mail.transport(fileTransport(cms.settings.get('mail-file.dir') || DEFAULT_DIR))
    },
  })
}

export default createMailFilePlugin()
