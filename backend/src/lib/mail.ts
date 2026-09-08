import nodemailer from "nodemailer";

// Any standard SMTP server works — a real provider (your own mailserver,
// Postfix, etc.) in production, or a free local catch-all like Mailpit
// (https://github.com/axllent/mailpit) in dev so you never need a paid
// email API. If SMTP isn't configured, we log a warning and skip sending
// instead of crashing the request — the caller still returns 200 so we
// don't leak account existence either way.
export function mailEnabled(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

export async function sendPasswordResetEmail(to: string, resetToken: string) {
  if (!mailEnabled()) {
    console.warn("SMTP not configured — skipping password reset email send");
    return;
  }
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost").replace(/\/$/, "");
  const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || "Visiyon AI <no-reply@visiyon.local>",
    to,
    subject: "Reset your Visiyon password",
    text: `Click this link to reset your password (valid for 30 minutes): ${resetUrl}\n\nIf you didn't request this, ignore this email.`,
    html: `<p>Click the link below to reset your password (valid for 30 minutes):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, ignore this email.</p>`,
  });
}

export async function sendInviteEmail(to: string, inviteToken: string) {
  if (!mailEnabled()) {
    console.warn("SMTP not configured — skipping invite email send");
    return;
  }
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost").replace(/\/$/, "");
  const inviteUrl = `${frontendUrl}/register?invite=${encodeURIComponent(inviteToken)}`;

  await getTransporter().sendMail({
    from: process.env.SMTP_FROM || "Visiyon AI <no-reply@visiyon.local>",
    to,
    subject: "You've been invited to Visiyon AI",
    text: `You've been invited to join Visiyon AI. Create your account here: ${inviteUrl}\n\nThis invite link expires in 7 days.`,
    html: `<p>You've been invited to join Visiyon AI.</p><p><a href="${inviteUrl}">${inviteUrl}</a></p><p>This invite link expires in 7 days.</p>`,
  });
}
