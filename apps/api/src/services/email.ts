/**
 * Email templates and delivery (outbox + Mailer providers).
 *
 * Emails are NEVER sent inside a database transaction. Business code enqueues
 * rows through `enqueueEmail()` (email_outbox); the scheduler worker renders and
 * sends via the configured Mailer (MAIL_PROVIDER / legacy EMAIL_TRANSPORT).
 */
import type { Config } from '../config.js';
import { webBaseUrl } from '../config.js';
import {
  clearCapturedEmails,
  getCapturedEmails,
  sendMail,
  type MailMessage,
} from '../mail/index.js';

export interface EmailMessage extends MailMessage {}

export type EmailTransport = 'console' | 'smtp' | 'memory' | 'disabled' | 'resend';

export function getSentEmails(): Array<EmailMessage & { sentAt: string }> {
  return getCapturedEmails();
}

export function clearSentEmails(): void {
  clearCapturedEmails();
}

/** Core send function. Never throws; returns false on delivery failure. */
export async function sendEmail(config: Config, msg: EmailMessage): Promise<boolean> {
  return sendMail(config, msg);
}

/* ------------------------------------------------------------------ */
/* Typed email builders                                                */
/* ------------------------------------------------------------------ */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildVerificationEmail(
  config: Config,
  to: string,
  rawToken: string,
): EmailMessage {
  const url = `${webBaseUrl(config)}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const subject = 'Verify your AgreementHub email address';
  const text =
    `AgreementHub\n\n` +
    `Confirm your email address to finish setting up your account.\n\n` +
    `Verify your email:\n${url}\n\n` +
    `This link expires in 24 hours and can be used once.\n` +
    `If you did not create an AgreementHub account, you can ignore this email.`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f1e8;color:#1f2937;font-family:Georgia,serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fffdf8;border:1px solid #d8d1c4;">
      <tr><td style="padding:28px 28px 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#5f6b7a;">AgreementHub</td></tr>
      <tr><td style="padding:0 28px 16px;font-size:24px;line-height:1.25;color:#111827;">Verify your email address</td></tr>
      <tr><td style="padding:0 28px 20px;font-size:16px;line-height:1.5;">Confirm your email address to finish setting up your account.</td></tr>
      <tr><td style="padding:0 28px 20px;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1e3a5f;color:#fffdf8;text-decoration:none;padding:12px 18px;font-size:15px;">Verify email address</a></td></tr>
      <tr><td style="padding:0 28px 8px;font-size:14px;line-height:1.5;color:#374151;">If the button does not work, use this link:</td></tr>
      <tr><td style="padding:0 28px 20px;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${escapeHtml(url)}" style="color:#1e3a5f;">${escapeHtml(url)}</a></td></tr>
      <tr><td style="padding:0 28px 28px;font-size:13px;line-height:1.5;color:#5f6b7a;">This link expires in 24 hours and can be used once. If you did not create an AgreementHub account, you can ignore this email.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { to, subject, text, html };
}

export function buildPasswordResetEmail(
  config: Config,
  to: string,
  rawToken: string,
): EmailMessage {
  const url = `${webBaseUrl(config)}/reset-password?token=${encodeURIComponent(rawToken)}`;
  const subject = 'Reset your AgreementHub password';
  const text =
    `AgreementHub\n\n` +
    `A password reset was requested for your account.\n\n` +
    `Reset your password:\n${url}\n\n` +
    `This link expires in 30 minutes and can be used once.\n` +
    `If you did not request this, you can ignore this email.`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f1e8;color:#1f2937;font-family:Georgia,serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fffdf8;border:1px solid #d8d1c4;">
      <tr><td style="padding:28px 28px 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#5f6b7a;">AgreementHub</td></tr>
      <tr><td style="padding:0 28px 16px;font-size:24px;line-height:1.25;color:#111827;">Reset your password</td></tr>
      <tr><td style="padding:0 28px 20px;font-size:16px;line-height:1.5;">A password reset was requested for your account.</td></tr>
      <tr><td style="padding:0 28px 20px;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1e3a5f;color:#fffdf8;text-decoration:none;padding:12px 18px;font-size:15px;">Reset password</a></td></tr>
      <tr><td style="padding:0 28px 8px;font-size:14px;line-height:1.5;color:#374151;">If the button does not work, use this link:</td></tr>
      <tr><td style="padding:0 28px 20px;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${escapeHtml(url)}" style="color:#1e3a5f;">${escapeHtml(url)}</a></td></tr>
      <tr><td style="padding:0 28px 28px;font-size:13px;line-height:1.5;color:#5f6b7a;">This link expires in 30 minutes and can be used once. If you did not request this, you can ignore this email.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { to, subject, text, html };
}

export function buildInvitationEmail(
  config: Config,
  to: string,
  opts: {
    rawToken: string;
    agreementTitle: string;
    inviterName: string;
    role: string;
    expiresAt: Date;
  },
): EmailMessage {
  const url = `${webBaseUrl(config)}/invitations/accept?token=${encodeURIComponent(opts.rawToken)}`;
  return {
    to,
    subject: `You have been invited to sign "${opts.agreementTitle}" on AgreementHub`,
    text:
      `${opts.inviterName} has invited you as a ${opts.role} on "${opts.agreementTitle}".\n\n` +
      `Click the link below to view and accept the invitation:\n${url}\n\n` +
      `This invitation expires at ${opts.expiresAt.toUTCString()}.`,
    html:
      `<p>${escapeHtml(opts.inviterName)} has invited you as a <strong>${escapeHtml(opts.role)}</strong> on <em>${escapeHtml(opts.agreementTitle)}</em>.</p>` +
      `<p><a href="${escapeHtml(url)}">View and accept invitation</a></p>` +
      `<p>This invitation expires at ${opts.expiresAt.toUTCString()}.</p>`,
  };
}

export function buildSignatureRequestEmail(
  config: Config,
  to: string,
  opts: {
    agreementTitle: string;
    publicId: string;
    requestMessage?: string | null;
  },
): EmailMessage {
  const url = `${webBaseUrl(config)}/agreements/${opts.publicId}`;
  return {
    to,
    subject: `Your signature is required: "${opts.agreementTitle}"`,
    text:
      `Your signature is required on "${opts.agreementTitle}" (${opts.publicId}).\n\n` +
      (opts.requestMessage ? `Message: ${opts.requestMessage}\n\n` : '') +
      `Click the link below to sign:\n${url}`,
    html:
      `<p>Your signature is required on <strong>${escapeHtml(opts.agreementTitle)}</strong> (${escapeHtml(opts.publicId)}).</p>` +
      (opts.requestMessage ? `<p><em>${escapeHtml(opts.requestMessage)}</em></p>` : '') +
      `<p><a href="${escapeHtml(url)}">Sign the agreement</a></p>`,
  };
}

export function buildSignatureReminderEmail(
  config: Config,
  to: string,
  opts: { agreementTitle: string; publicId: string },
): EmailMessage {
  const url = `${webBaseUrl(config)}/agreements/${opts.publicId}`;
  return {
    to,
    subject: `Reminder: signature still required on "${opts.agreementTitle}"`,
    text:
      `This is a reminder that your signature is still required on ` +
      `"${opts.agreementTitle}" (${opts.publicId}).\n\nView the agreement:\n${url}`,
    html:
      `<p>This is a reminder that your signature is still required on ` +
      `<strong>${escapeHtml(opts.agreementTitle)}</strong> (${escapeHtml(opts.publicId)}).</p>` +
      `<p><a href="${escapeHtml(url)}">View the agreement</a></p>`,
  };
}

export function buildSignatureOtpEmail(
  to: string,
  opts: { agreementTitle: string; publicId: string; code: string; expiresMinutes: number },
): EmailMessage {
  return {
    to,
    subject: `Your AgreementHub signing code: ${opts.code}`,
    text:
      `Your one-time signing code for "${opts.agreementTitle}" (${opts.publicId}) is:\n\n` +
      `    ${opts.code}\n\n` +
      `It expires in ${opts.expiresMinutes} minutes and can be used once.\n` +
      `If you did not request this, do not share the code and contact the sender.`,
    html:
      `<p>Your one-time signing code for <strong>${escapeHtml(opts.agreementTitle)}</strong> (${escapeHtml(opts.publicId)}) is:</p>` +
      `<p style="font-size:24px;letter-spacing:4px"><strong>${opts.code}</strong></p>` +
      `<p>It expires in ${opts.expiresMinutes} minutes and can be used once.</p>`,
  };
}

export function buildAgreementFinalizedEmail(
  config: Config,
  to: string,
  opts: { agreementTitle: string; publicId: string },
): EmailMessage {
  const url = `${webBaseUrl(config)}/verify/${opts.publicId}`;
  return {
    to,
    subject: `Agreement finalized: "${opts.agreementTitle}"`,
    text:
      `The agreement "${opts.agreementTitle}" (${opts.publicId}) has been fully signed and finalized.\n\n` +
      `You can verify its integrity at:\n${url}`,
    html:
      `<p>The agreement <strong>${escapeHtml(opts.agreementTitle)}</strong> (${escapeHtml(opts.publicId)}) has been fully signed and finalized.</p>` +
      `<p><a href="${escapeHtml(url)}">Verify document integrity</a></p>`,
  };
}

export function buildExpiryReminderEmail(
  config: Config,
  to: string,
  opts: { agreementTitle: string; publicId: string; expiresAt: Date; daysLeft: number },
): EmailMessage {
  const url = `${webBaseUrl(config)}/agreements/${opts.publicId}`;
  return {
    to,
    subject: `Agreement expiring soon: "${opts.agreementTitle}"`,
    text:
      `Your agreement "${opts.agreementTitle}" (${opts.publicId}) expires in ${opts.daysLeft} day(s) ` +
      `on ${opts.expiresAt.toUTCString()}.\n\nView the agreement:\n${url}`,
    html:
      `<p>Your agreement <strong>${escapeHtml(opts.agreementTitle)}</strong> (${escapeHtml(opts.publicId)}) expires in ` +
      `<strong>${opts.daysLeft} day(s)</strong> on ${opts.expiresAt.toUTCString()}.</p>` +
      `<p><a href="${escapeHtml(url)}">View the agreement</a></p>`,
  };
}

export function buildAgreementExpiredEmail(
  config: Config,
  to: string,
  opts: { agreementTitle: string; publicId: string; expiresAt: Date },
): EmailMessage {
  const url = `${webBaseUrl(config)}/agreements/${opts.publicId}`;
  return {
    to,
    subject: `Agreement expired: "${opts.agreementTitle}"`,
    text:
      `The agreement "${opts.agreementTitle}" (${opts.publicId}) reached its expiry date ` +
      `(${opts.expiresAt.toUTCString()}) and is now EXPIRED.\n\nView the agreement:\n${url}`,
    html:
      `<p>The agreement <strong>${escapeHtml(opts.agreementTitle)}</strong> (${escapeHtml(opts.publicId)}) ` +
      `reached its expiry date (${opts.expiresAt.toUTCString()}) and is now <strong>EXPIRED</strong>.</p>` +
      `<p><a href="${escapeHtml(url)}">View the agreement</a></p>`,
  };
}

export function buildObligationReminderEmail(
  config: Config,
  to: string,
  opts: {
    agreementTitle: string;
    publicId: string;
    obligationTitle: string;
    dueAt: Date;
    daysLeft: number;
    responsible?: string | null;
  },
): EmailMessage {
  const url = `${webBaseUrl(config)}/agreements/${opts.publicId}`;
  const when =
    opts.daysLeft < 0
      ? `was due ${Math.abs(opts.daysLeft)} day(s) ago`
      : opts.daysLeft === 0
        ? 'is due today'
        : `is due in ${opts.daysLeft} day(s)`;
  const who = opts.responsible ? `Responsible: ${opts.responsible}.\n` : '';
  return {
    to,
    subject: `Agreement obligation reminder: ${opts.obligationTitle}`,
    text:
      `Reminder for "${opts.agreementTitle}" (${opts.publicId}).\n\n` +
      `Obligation: ${opts.obligationTitle}\n${who}` +
      `This obligation ${when} (${opts.dueAt.toUTCString()}).\n\nView the agreement:\n${url}`,
    html:
      `<p>Reminder for <strong>${escapeHtml(opts.agreementTitle)}</strong> (${escapeHtml(opts.publicId)}).</p>` +
      `<p><strong>Obligation:</strong> ${escapeHtml(opts.obligationTitle)}<br>` +
      (opts.responsible ? `<strong>Responsible:</strong> ${escapeHtml(opts.responsible)}<br>` : '') +
      `This obligation ${escapeHtml(when)} (${opts.dueAt.toUTCString()}).</p>` +
      `<p><a href="${escapeHtml(url)}">View the agreement</a></p>`,
  };
}

export function buildObligationOverdueEmail(
  config: Config,
  to: string,
  opts: {
    agreementTitle: string;
    publicId: string;
    obligationTitle: string;
    dueAt: Date;
    daysOverdue: number;
    responsible?: string | null;
  },
): EmailMessage {
  const url = `${webBaseUrl(config)}/agreements/${opts.publicId}`;
  return {
    to,
    subject: `Overdue obligation: ${opts.obligationTitle}`,
    text:
      `An obligation for "${opts.agreementTitle}" (${opts.publicId}) is overdue.\n\n` +
      `Obligation: ${opts.obligationTitle}\n` +
      (opts.responsible ? `Responsible: ${opts.responsible}\n` : '') +
      `Due: ${opts.dueAt.toUTCString()} (${opts.daysOverdue} day(s) overdue).\n\n` +
      `This is a reminder only; the obligation is not automatically completed.\n\nView the agreement:\n${url}`,
    html:
      `<p>An obligation for <strong>${escapeHtml(opts.agreementTitle)}</strong> (${escapeHtml(opts.publicId)}) is overdue.</p>` +
      `<p><strong>Obligation:</strong> ${escapeHtml(opts.obligationTitle)}<br>` +
      (opts.responsible ? `<strong>Responsible:</strong> ${escapeHtml(opts.responsible)}<br>` : '') +
      `Due: ${opts.dueAt.toUTCString()} (${opts.daysOverdue} day(s) overdue).</p>` +
      `<p>This is a reminder only; the obligation is not automatically completed.</p>` +
      `<p><a href="${escapeHtml(url)}">View the agreement</a></p>`,
  };
}

/* ------------------------------------------------------------------ */
/* Outbox template rendering                                           */
/* ------------------------------------------------------------------ */

export type EmailTemplate =
  | 'EMAIL_VERIFICATION'
  | 'PASSWORD_RESET'
  | 'INVITATION'
  | 'SIGNATURE_REQUEST'
  | 'SIGNATURE_OTP'
  | 'AGREEMENT_FINALIZED'
  | 'AGREEMENT_EXPIRED'
  | 'EXPIRY_REMINDER'
  | 'SIGNATURE_REMINDER'
  | 'OBLIGATION_REMINDER'
  | 'OBLIGATION_OVERDUE'
  | 'GENERIC';

/** Render an outbox row into a concrete message using config + payload. */
export function renderEmailTemplate(
  config: Config,
  template: EmailTemplate,
  to: string,
  payload: Record<string, unknown>,
): EmailMessage {
  const title = String(payload.agreementTitle ?? 'Agreement');
  const publicId = String(payload.publicId ?? '');
  const daysLeft = Number(payload.daysLeft ?? 0);
  const expiresAt = new Date(String(payload.expiresAt ?? Date.now()));

  switch (template) {
    case 'EMAIL_VERIFICATION':
      return buildVerificationEmail(config, to, String(payload.token ?? ''));
    case 'PASSWORD_RESET':
      return buildPasswordResetEmail(config, to, String(payload.token ?? ''));
    case 'INVITATION':
      return buildInvitationEmail(config, to, {
        rawToken: String(payload.token ?? ''),
        agreementTitle: title,
        inviterName: String(payload.inviterName ?? 'An AgreementHub user'),
        role: String(payload.role ?? 'SIGNER'),
        expiresAt,
      });
    case 'SIGNATURE_REQUEST':
      return buildSignatureRequestEmail(config, to, {
        agreementTitle: title,
        publicId,
        requestMessage: payload.message ? String(payload.message) : null,
      });
    case 'SIGNATURE_REMINDER':
      return buildSignatureReminderEmail(config, to, { agreementTitle: title, publicId });
    case 'SIGNATURE_OTP':
      return buildSignatureOtpEmail(to, {
        agreementTitle: title,
        publicId,
        code: String(payload.code ?? ''),
        expiresMinutes: Number(payload.expiresMinutes ?? 10),
      });
    case 'AGREEMENT_FINALIZED':
      return buildAgreementFinalizedEmail(config, to, { agreementTitle: title, publicId });
    case 'AGREEMENT_EXPIRED':
      return buildAgreementExpiredEmail(config, to, {
        agreementTitle: title,
        publicId,
        expiresAt,
      });
    case 'EXPIRY_REMINDER':
      return buildExpiryReminderEmail(config, to, {
        agreementTitle: title,
        publicId,
        expiresAt,
        daysLeft,
      });
    case 'OBLIGATION_REMINDER':
      return buildObligationReminderEmail(config, to, {
        agreementTitle: title,
        publicId,
        obligationTitle: String(payload.obligationTitle ?? 'Obligation'),
        dueAt: new Date(String(payload.dueAt ?? Date.now())),
        daysLeft,
        responsible: payload.responsible ? String(payload.responsible) : null,
      });
    case 'OBLIGATION_OVERDUE':
      return buildObligationOverdueEmail(config, to, {
        agreementTitle: title,
        publicId,
        obligationTitle: String(payload.obligationTitle ?? 'Obligation'),
        dueAt: new Date(String(payload.dueAt ?? Date.now())),
        daysOverdue: Number(payload.daysOverdue ?? Math.max(0, -daysLeft)),
        responsible: payload.responsible ? String(payload.responsible) : null,
      });
    case 'GENERIC':
    default:
      return {
        to,
        subject: String(payload.subject ?? 'AgreementHub notification'),
        text: String(payload.text ?? ''),
        html: payload.html ? String(payload.html) : undefined,
      };
  }
}
