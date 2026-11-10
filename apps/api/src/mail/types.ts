import type { Config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Sends an email. Returns true on success, false on delivery failure (never throws). */
export interface Mailer {
  send(message: MailMessage): Promise<boolean>;
}

export interface MailerContext {
  config: Config;
}
