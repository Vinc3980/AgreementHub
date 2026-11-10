import type { Mailer, MailMessage } from './types.js';

export interface CapturedMail extends MailMessage {
  sentAt: string;
}

const captured: CapturedMail[] = [];

export function getCapturedEmails(): CapturedMail[] {
  return [...captured];
}

export function clearCapturedEmails(): void {
  captured.length = 0;
}

/** Test provider: captures messages in-process. */
export function createMemoryMailer(): Mailer {
  return {
    async send(message: MailMessage): Promise<boolean> {
      captured.push({ ...message, sentAt: new Date().toISOString() });
      return true;
    },
  };
}
