import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestKernel, type TestKernel } from '@otw/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createMailFilePlugin, fileTransport } from '../src'

let harness: TestKernel | undefined
let folder: string | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
  if (folder) await rm(folder, { recursive: true, force: true })
  folder = undefined
})

const message = {
  from: 'My Site <hello@example.com>',
  to: ['ada@example.com'],
  subject: 'Hello',
  text: 'Hi Ada',
  html: null,
  replyTo: null,
}

describe('mail to files', () => {
  it('writes each email whole, as JSON, named so they list in order', async () => {
    folder = await mkdtemp(join(tmpdir(), 'mail-file-'))
    const transport = fileTransport(folder)
    await transport.send(message)
    await transport.send({ ...message, subject: 'Again' })
    const files = (await readdir(folder)).sort()
    expect(files).toHaveLength(2)
    expect(files.every((file) => file.endsWith('.json') && !file.startsWith('.'))).toBe(true)
    const first = JSON.parse(await readFile(join(folder, files[0]!), 'utf8')) as typeof message
    expect(first).toMatchObject({ ...message, sentAt: expect.any(String) })
  })

  it('is the site’s transport, in the folder MAIL_FILE_DIR names', async () => {
    folder = await mkdtemp(join(tmpdir(), 'mail-file-'))
    harness = await createTestKernel({
      plugins: [createMailFilePlugin()],
      env: { MAIL_FILE_DIR: folder },
    })
    expect(harness.kernel.mail.canSend()).toBe(true)
    expect(
      await harness.kernel.mail.send({ to: 'ada@example.com', subject: 'Hi', text: 'There' }),
    ).toBe(true)
    const [file] = await readdir(folder)
    expect(JSON.parse(await readFile(join(folder, file!), 'utf8'))).toMatchObject({
      to: ['ada@example.com'],
      subject: 'Hi',
      text: 'There',
    })
  })
})
