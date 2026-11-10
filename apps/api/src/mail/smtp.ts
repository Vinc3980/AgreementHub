import type { Config } from '../config.js';
import { mailFrom } from '../config.js';
import type { Mailer, MailMessage } from './types.js';

let transport: import('nodemailer').Transporter | undefined;

export function createSmtpMailer(config: Config): Mailer {
  return {
    async send(message: MailMessage): Promise<boolean> {
      const host = config.SMTP_HOST ?? config.EMAIL_SMTP_HOST;
      if (!host) {
        console.error('[mail/smtp] SMTP host is not configured (SMTP_HOST or EMAIL_SMTP_HOST)');
        return false;
      }
      try {
        if (!transport) {
          const nodemailer = await import('nodemailer');
          transport = nodemailer.createTransport({
            host,
            port: config.SMTP_PORT ?? config.EMAIL_SMTP_PORT,
            secure: config.SMTP_SECURE || config.EMAIL_SMTP_SECURE,
            auth:
              (config.SMTP_USER ?? config.EMAIL_SMTP_USER) &&
              (config.SMTP_PASS ?? config.EMAIL_SMTP_PASS)
                ? {
                    user: (config.SMTP_USER ?? config.EMAIL_SMTP_USER)!,
                    pass: (config.SMTP_PASS ?? config.EMAIL_SMTP_PASS)!,
                  }
                : undefined,
          });
        }
        await transport.sendMail({
          from: mailFrom(config),
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        return true;
      } catch (err) {
        console.error('[mail/smtp] delivery failed:', (err as Error).message);
        return false;
      }
    },
  };
}

/** Test/helper hook: reset cached transporter (e.g. when config changes). */
export function resetSmtpTransport(): void {
  transport = undefined;
}
