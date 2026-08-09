// mailer.js — pluggable email sending for verification + password reset.
//
// Real delivery: set RESEND_API_KEY (https://resend.com) in .env. Any
// provider with a simple HTTP API works the same way — swap the fetch call
// below for Postmark/SES/etc if you'd rather use one of those.
//
// No key configured: the link is logged to the server console instead of
// emailed. That's enough to test the whole flow yourself, or to run a small
// invite-only cohort by hand, but it is NOT a substitute for real delivery
// once signup is public — nobody else can see server logs to get their link.

const APP_URL = process.env.APP_URL || 'http://localhost:' + (process.env.PORT || 3000);
const MAIL_FROM = process.env.MAIL_FROM || 'Kleos <no-reply@kleos.dev>';

async function sendMail({ to, subject, text }) {
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, text })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Email send failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return { delivered: true };
  }

  console.log('\n─── DEV EMAIL (no RESEND_API_KEY set — not actually sent) ───');
  console.log('To:', to);
  console.log('Subject:', subject);
  console.log(text);
  console.log('───────────────────────────────────────────────────────────\n');
  return { delivered: false, devLogged: true };
}

function verifyEmailLink(token) {
  return `${APP_URL}/api/auth/verify?token=${encodeURIComponent(token)}`;
}
function resetPasswordLink(token) {
  return `${APP_URL}/reset-password.html?token=${encodeURIComponent(token)}`;
}

module.exports = { sendMail, verifyEmailLink, resetPasswordLink, APP_URL };
