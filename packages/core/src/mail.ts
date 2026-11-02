import type { Logger, MailApi, MailMessage, MailTransport, OutgoingMail } from '@otw/sdk'
import type { HookBus } from './hooks'

/** What the kernel serves: sending, without the transport's registration. */
export type MailService = Omit<MailApi, 'transport'>

const ADDRESS = /^[^\s@<>",;:()[\]\\]+@[^\s@<>",;:()[\]\\]+\.[^\s@<>",;:()[\]\\]+$/
/** RFC 5322's line limit, for a subject that's one header line. */
const MAX_SUBJECT = 998
const MAX_RECIPIENTS = 50
const MAX_BODY = 1_000_000

/**
 * An address as a header may hold it: `ada@example.com` or `Ada Admin <ada@example.com>`. Never
 * a line break, which would let a value add headers of its own (header injection).
 */
export function isMailbox(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 320 || /[\r\n\0]/.test(value)) return false
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(value.trim())
  if (!named) return ADDRESS.test(value.trim())
  return !/[<>]/.test(named[1]!) && ADDRESS.test(named[2]!)
}

function invalid(message: string): never {
  throw new TypeError(`Can't send this email: ${message}`)
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') invalid(`${what} must be text`)
  if (value.length > max) invalid(`${what} is longer than ${max} characters`)
  return value
}

/** A message checked and in one shape, before and again after the `mail.message` filter. */
export function outgoing(message: MailMessage | OutgoingMail, from: string | null): OutgoingMail {
  if (!message || typeof message !== 'object') invalid('pass a message')
  const to = (typeof message.to === 'string' ? [message.to] : [...(message.to ?? [])]).map((a) =>
    typeof a === 'string' ? a.trim() : a,
  )
  if (to.length === 0) invalid('it has no recipient')
  if (to.length > MAX_RECIPIENTS) invalid(`it has more than ${MAX_RECIPIENTS} recipients`)
  for (const address of to) {
    if (!isMailbox(address)) invalid(`"${String(address)}" isn't an email address`)
  }
  const subject = text(message.subject, 'The subject', MAX_SUBJECT).trim()
  if (/[\r\n\0]/.test(subject)) invalid('the subject has a line break')
  const sender = message.from ?? from
  if (sender !== null && sender !== undefined && sender !== '' && !isMailbox(sender)) {
    invalid(`the sender "${String(sender)}" isn't an email address`)
  }
  const replyTo = message.replyTo ?? null
  if (replyTo !== null && !isMailbox(replyTo)) {
    invalid(`the reply-to "${String(replyTo)}" isn't an email address`)
  }
  const html = message.html ?? null
  return {
    from: sender ? sender.trim() : null,
    to: to as string[],
    subject,
    text: text(message.text, 'The text', MAX_BODY),
    html: html === null ? null : text(html, 'The HTML', MAX_BODY),
    replyTo: replyTo?.trim() ?? null,
  }
}

export interface MailServiceOptions {
  hooks: HookBus
  logger: Logger
  /** Settings › General's sender, or empty. */
  from(): string
  transport(): MailTransport | null
  /** Bodies hold reset links: the log gets them only outside production. */
  production: boolean
}

/** `cms.mail`, like `wp_mail()`: a filter, the plugin's transport, and actions after. */
export function createMailService(options: MailServiceOptions): MailService {
  const { hooks, logger } = options
  return {
    canSend: () => options.transport() !== null,

    async send(message) {
      const prepared = outgoing(message, options.from() || null)
      const filtered = await hooks.applyFilters('mail.message', prepared, {})
      const mail = outgoing(filtered, null)
      const transport = options.transport()
      const about = { to: mail.to, subject: mail.subject }
      if (!transport) {
        logger.warn('No mail plugin is set up to send email, so this one was not sent', about)
        if (!options.production) logger.info('The email that was not sent', { text: mail.text })
        await hooks.doAction('mail.failed', { message: mail, error: 'No mail transport' })
        return false
      }
      try {
        await transport.send(mail)
      } catch (error) {
        logger.error('An email could not be sent', { ...about, error })
        const reason = error instanceof Error ? error.message : String(error)
        await hooks.doAction('mail.failed', { message: mail, error: reason })
        return false
      }
      await hooks.doAction('mail.sent', { message: mail })
      return true
    },
  }
}
