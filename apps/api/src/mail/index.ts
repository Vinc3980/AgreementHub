import type { Config } from '../config.js';
import { mailProvider } from '../config.js';
import { createConsoleMailer } from './console.js';
import { clearCapturedEmails, createMemoryMailer, getCapturedEmails } from './memory.js';
import { createResendMailer } from './resend.js';
import { createSmtpMailer } from './smtp.js';
import type { Mailer, MailMessage } from './types.js';

export type { MailMessage, Mailer } from './types.js';
export { getCapturedEmails, clearCapturedEmails };

/** Create a mailer for the configured provider. */
export function createMailer(config: Config): Mailer {
  switch (mailProvider(config)) {
    case 'memory':
      return createMemoryMailer();
    case 'smtp':
      return createSmtpMailer(config);
    case 'resend':
      return createResendMailer(config);
    case 'disabled':
      return { async send() { return true; } };
    case 'console':
    default:
      return createConsoleMailer();
  }
}

/** Convenience send using the configured provider. Never throws. */
export async function sendMail(config: Config, message: MailMessage): Promise<boolean> {
  return createMailer(config).send(message);
}
