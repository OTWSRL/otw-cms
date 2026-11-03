import type { MailTransport, OutgoingMail } from '@otwdesign/sdk'
import { describe, expect, it } from 'vitest'
import { isMailbox, outgoing } from '../src/mail'
import { bootKernel, formPost, memoryLogger, ORIGIN, plugin, redirectOf, signIn } from './helpers'

/** A transport that keeps what it's given, and fails when told to. */
function catcher(fail?: string) {
  const sent: OutgoingMail[] = []
  const transport: MailTransport = {
    async send(message) {
      if (fail) throw new Error(fail)
      sent.push(message)
    },
  }
  return { sent, transport }
}

const transporting = (transport: MailTransport, id = 'smtp') =>
  plugin(id, {
    setup(cms) {
      cms.mail.transport(transport)
    },
  })

describe('addresses', () => {
  it('are an address or a name and an address, never with a line break', () => {
    expect(isMailbox('ada@example.com')).toBe(true)
    expect(isMailbox('Ada Admin <ada@example.com>')).toBe(true)
    expect(isMailbox('"Ada, Admin" <ada@example.com>')).toBe(true)
    for (const bad of [
      'ada',
      'ada@example',
      'ada@example.com\r\nBcc: everyone@example.com',
      'Ada <ada@example.com',
      'a <b> <ada@example.com>',
      '',
    ]) {
      expect(isMailbox(bad)).toBe(false)
    }
  })

  it('are checked, with the subject, before anything is sent', () => {
    const base = { to: 'ada@example.com', subject: 'Hi', text: 'Hello' }
    expect(outgoing(base, 'Site <site@example.com>')).toEqual({
      from: 'Site <site@example.com>',
      to: ['ada@example.com'],
      subject: 'Hi',
      text: 'Hello',
      html: null,
      replyTo: null,
    })
    expect(() => outgoing({ ...base, to: [] }, null)).toThrow('no recipient')
    expect(() => outgoing({ ...base, subject: 'Hi\nBcc: x@example.com' }, null)).toThrow(
      'line break',
    )
    expect(() => outgoing({ ...base, to: 'x@example.com, y@example.com' }, null)).toThrow(
      "isn't an email address",
    )
    expect(() => outgoing({ ...base, replyTo: 'nope' }, null)).toThrow('reply-to')
  })
})

describe('sending', () => {
  it('goes through the plugin’s transport, from Settings › General’s sender', async () => {
    const { sent, transport } = catcher()
    const seen: string[] = []
    const watcher = plugin('watcher', {
      setup(cms) {
        cms.hooks.addAction('mail.sent', ({ message }) => void seen.push(message.subject))
      },
    })
    const kernel = await bootKernel({
      plugins: [transporting(transport), watcher],
      settings: { 'mail.from': 'My Site <hello@example.com>' },
    })
    expect(kernel.mail.canSend()).toBe(true)
    expect(
      await kernel.mail.send({ to: ['a@example.com', 'b@example.com'], subject: 'Hi', text: 'x' }),
    ).toBe(true)
    expect(sent).toEqual([
      {
        from: 'My Site <hello@example.com>',
        to: ['a@example.com', 'b@example.com'],
        subject: 'Hi',
        text: 'x',
        html: null,
        replyTo: null,
      },
    ])
    expect(seen).toEqual(['Hi'])
  })

  it('lets plugins change a message, checking it again after', async () => {
    const { sent, transport } = catcher()
    const footer = plugin('footer', {
      setup(cms) {
        cms.hooks.addFilter('mail.message', (message) => ({
          ...message,
          text: `${message.text}\n\n-- My Site`,
        }))
      },
    })
    const sneaky = plugin('sneaky', {
      setup(cms) {
        cms.hooks.addFilter('mail.message', (message) => ({ ...message, subject: 'x\ny' }))
      },
    })
    const kernel = await bootKernel({ plugins: [transporting(transport), footer] })
    await kernel.mail.send({ to: 'a@example.com', subject: 'Hi', text: 'Hello' })
    expect(sent[0]?.text).toBe('Hello\n\n-- My Site')
    const broken = await bootKernel({ plugins: [transporting(catcher().transport), sneaky] })
    await expect(
      broken.mail.send({ to: 'a@example.com', subject: 'Hi', text: '' }),
    ).rejects.toThrow('line break')
  })

  it('returns false and logs why when the transport fails, as wp_mail() does', async () => {
    const logger = memoryLogger()
    const failures: string[] = []
    const watcher = plugin('watcher', {
      setup(cms) {
        cms.hooks.addAction('mail.failed', ({ error }) => void failures.push(error))
      },
    })
    const kernel = await bootKernel({
      plugins: [transporting(catcher('SMTP said no').transport), watcher],
      logger,
    })
    expect(await kernel.mail.send({ to: 'a@example.com', subject: 'Hi', text: 'x' })).toBe(false)
    expect(failures).toEqual(['SMTP said no'])
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'An email could not be sent',
        context: expect.objectContaining({ to: ['a@example.com'], subject: 'Hi' }),
      }),
    )
  })

  it('without a transport, logs that nothing was sent, and the body only outside production', async () => {
    const send = async (env: Record<string, string>) => {
      const logger = memoryLogger()
      const kernel = await bootKernel({ plugins: [], logger, env })
      expect(kernel.mail.canSend()).toBe(false)
      expect(
        await kernel.mail.send({ to: 'a@example.com', subject: 'Reset', text: 'secret link' }),
      ).toBe(false)
      return JSON.stringify(logger.entries)
    }
    const development = await send({ NODE_ENV: 'development' })
    expect(development).toContain('No mail plugin is set up')
    expect(development).toContain('secret link')
    const production = await send({ NODE_ENV: 'production' })
    expect(production).toContain('No mail plugin is set up')
    expect(production).not.toContain('secret link')
  })

  it('takes one transport, from setup()', async () => {
    await expect(
      bootKernel({
        plugins: [
          transporting(catcher().transport, 'one'),
          transporting(catcher().transport, 'two'),
        ],
      }),
    ).rejects.toThrow('only one can')
  })

  it('refuses a sender in Settings › General that isn’t an address', async () => {
    const kernel = await bootKernel({ plugins: [] })
    const { cookie } = await signIn(kernel)
    const save = (from: string) =>
      kernel
        .handleApi(
          formPost(
            '/api/p/core/actions/save-settings',
            {
              page: 'core.general',
              'site.title': 'My Site',
              'site.url': '',
              'site.locale': 'en-US',
              'mail.from': from,
            },
            { cookie, referer: `${ORIGIN}/admin/settings` },
          ),
        )
        .then((response) => redirectOf(kernel, response).flash)
    expect(await save('not an address')).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Use an address'),
    })
    expect(await save('My Site <hello@example.com>')).toMatchObject({ kind: 'notice' })
    expect((await bootKernel({ plugins: [], db: kernel.db })).setting('mail.from')).toBe(
      'My Site <hello@example.com>',
    )
  })
})
