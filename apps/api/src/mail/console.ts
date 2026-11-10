import type { Mailer, MailMessage } from './types.js';

/** Development provider: logs the full message (including any link) to the API terminal. */
export function createConsoleMailer(): Mailer {
  return {
    async send(message: MailMessage): Promise<boolean> {
      console.info(
        '\n========== EMAIL (console provider) ==========\n' +
          `To:      ${message.to}\n` +
          `Subject: ${message.subject}\n` +
          `Body:\n${message.text}\n` +
          '==============================================\n',
      );
      return true;
    },
  };
}
