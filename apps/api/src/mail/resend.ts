import type { Config } from '../config.js';
import { mailFrom } from '../config.js';
import type { Mailer, MailMessage } from './types.js';

export function createResendMailer(config: Config): Mailer {
  return {
    async send(message: MailMessage): Promise<boolean> {
      const key = config.RESEND_API_KEY;
      if (!key) {
        console.error('[mail/resend] RESEND_API_KEY is not configured');
        return false;
      }
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: mailFrom(config),
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
          }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          console.error('[mail/resend] delivery failed:', res.status, text.slice(0, 300));
          return false;
        }
        return true;
      } catch (err) {
        console.error('[mail/resend] delivery failed:', (err as Error).message);
        return false;
      }
    },
  };
}
