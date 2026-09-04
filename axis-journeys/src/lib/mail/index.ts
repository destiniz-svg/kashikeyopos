/**
 * Outbound mail: one seam, two drivers (AWS SES, and a log driver for development and CI).
 *
 * The contract is that a send never pretends. `sent` is derived from what the transport answered,
 * and where nothing is configured the answer says so — a screen that reports a send it did not make
 * is worse than one that offers no send at all.
 */
import { signRequest } from '../aws/sigv4'
import { config } from '../config'
import { log } from '../http/log'

export interface Message {
  to: string[]
  subject: string
  /** Plain text. Nothing in this app composes HTML mail, so nothing has to escape it. */
  text: string
  replyTo?: string
}

export interface SendResult {
  sent: boolean
  /** What an operator is told. Class and status, never a provider's verbatim body. */
  reason: string
  /** The provider's own words, for the log only. */
  detail?: string
  id?: string
}

export interface Mailer {
  send(msg: Message): Promise<SendResult>
  health(): { configured: boolean; reason: string }
}

class LogMailer implements Mailer {
  async send(msg: Message): Promise<SendResult> {
    log.info('mail', 'no transport configured — message written to the log', {
      to: msg.to.join(','),
      subject: msg.subject,
      body: msg.text,
    })
    return { sent: false, reason: 'no email transport is configured on this install' }
  }
  health() {
    return { configured: false, reason: 'no email transport is configured on this install — set SES_FROM' }
  }
}

class SesMailer implements Mailer {
  private readonly fetchImpl: typeof fetch

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl
  }

  async send(msg: Message): Promise<SendResult> {
    const payload = {
      FromEmailAddress: config.mail.from,
      Destination: { ToAddresses: msg.to },
      ...(msg.replyTo ? { ReplyToAddresses: [msg.replyTo] } : {}),
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: msg.text, Charset: 'UTF-8' } },
        },
      },
    }
    const body = JSON.stringify(payload)
    const signed = signRequest({
      method: 'POST',
      url: `https://email.${config.mail.region}.amazonaws.com/v2/email/outbound-emails`,
      region: config.mail.region,
      service: 'ses',
      headers: { 'content-type': 'application/json' },
      body,
      credentials: {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
        sessionToken: config.aws.sessionToken || undefined,
      },
    })
    try {
      const res = await this.fetchImpl(signed.url, {
        method: signed.method,
        headers: signed.headers,
        body: signed.body as BodyInit,
        signal: AbortSignal.timeout(10_000),
      })
      const text = await res.text()
      if (!res.ok) {
        const detail = text.replace(/\s+/g, ' ').slice(0, 400)
        log.error('mail', `SES refused this install (HTTP ${res.status})`, { detail })
        return { sent: false, reason: `the email transport refused this install (HTTP ${res.status})`, detail }
      }
      const id = (JSON.parse(text || '{}') as { MessageId?: string }).MessageId
      return { sent: true, reason: 'sent', id }
    } catch (e) {
      const detail = (e as Error).message
      log.error('mail', 'SES unreachable', { detail })
      return { sent: false, reason: 'the email transport could not be reached', detail }
    }
  }

  health() {
    if (!config.aws.accessKeyId) return { configured: false, reason: 'SES is selected but no AWS credentials are set' }
    return { configured: true, reason: `SES from ${config.mail.from} in ${config.mail.region}` }
  }
}

let mailer: Mailer | null = null

export function getMailer(): Mailer {
  if (!mailer) mailer = config.mail.driver === 'ses' ? new SesMailer() : new LogMailer()
  return mailer
}

/** Test support. */
export function setMailer(m: Mailer | null): void {
  mailer = m
}
