// auth.js — email/password accounts, backed by express-session (see
// server.js for the session store config), plus email verification and
// password reset via mailer.js.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('./db');
const mailer = require('./mailer');

const VERIFY_TOKEN_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const RESET_TOKEN_TTL_MS = 1000 * 60 * 60; // 1h
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Deliberately simple (not RFC 5322-complete) — just enough to reject
// obviously-malformed input like "a@" or "nope" before it hits the DB or a
// real send attempt, without rejecting legitimate addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function signup(req, res) {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;

  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const existing = await query('SELECT id FROM users WHERE email=$1', [email]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const isAdmin = ADMIN_EMAILS.includes(email);
  const verifyToken = newToken();
  const verifyExpires = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);

  const result = await query(
    `INSERT INTO users (email, password_hash, is_admin, verify_token, verify_token_expires)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, email, is_admin, email_verified`,
    [email, passwordHash, isAdmin, verifyToken, verifyExpires]
  );
  const user = result.rows[0];

  mailer.sendMail({
    to: email,
    subject: 'Verify your Kleos account',
    text: `Welcome to Kleos. Verify your email to start your first job:\n\n${mailer.verifyEmailLink(verifyToken)}\n\nThis link expires in 24 hours.`
  }).catch(err => console.error('Failed to send verification email:', err.message));

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.userId = user.id;
    req.session.isAdmin = user.is_admin;
    res.json({ user: { id: user.id, email: user.email, emailVerified: user.email_verified, isAdmin: user.is_admin } });
  });
}

async function login(req, res) {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const result = await query('SELECT id, email, password_hash, is_admin, email_verified FROM users WHERE email=$1', [email]);
  const user = result.rows[0];
  // Compare against a dummy hash even when the user doesn't exist, so the
  // response time doesn't leak whether an email is registered.
  const hash = user ? user.password_hash : '$2a$12$C6UzMDM.H6dfI/f/IKcEeOxYbQF9zY9WgQ6JXybqNhXk9RH.QW3iC';
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session.' });
    req.session.userId = user.id;
    req.session.isAdmin = user.is_admin;
    res.json({ user: { id: user.id, email: user.email, emailVerified: user.email_verified, isAdmin: user.is_admin } });
  });
}

function logout(req, res) {
  req.session.destroy(() => {
    res.clearCookie('kleos.sid');
    res.json({ ok: true });
  });
}

async function me(req, res) {
  if (!req.session || !req.session.userId) return res.json({ user: null });
  const result = await query(
    'SELECT id, email, is_admin, email_verified, voice_enabled, notify_email, onboarding_seen FROM users WHERE id=$1',
    [req.session.userId]
  );
  const row = result.rows[0];
  if (!row) return res.json({ user: null });
  res.json({
    user: {
      id: row.id, email: row.email, isAdmin: row.is_admin, emailVerified: row.email_verified,
      voiceEnabled: row.voice_enabled, notifyEmail: row.notify_email, onboardingSeen: row.onboarding_seen
    }
  });
}

// GET /api/auth/verify?token=... — a real link clicked from an email, so
// this redirects rather than returning JSON.
async function verifyEmail(req, res) {
  const token = String(req.query.token || '');
  if (!token) return res.redirect('/login.html?verify=missing');

  const result = await query(
    `SELECT id, email_verified, verify_token_expires FROM users WHERE verify_token=$1`,
    [token]
  );
  const user = result.rows[0];
  if (!user) return res.redirect('/login.html?verify=expired');
  // The token is intentionally left in place after use (rather than nulled)
  // so a second click on the same link can be told apart from a genuinely
  // invalid/expired one, instead of both looking like "expired."
  if (user.email_verified) return res.redirect('/login.html?verify=already');
  if (new Date(user.verify_token_expires) < new Date()) {
    return res.redirect('/login.html?verify=expired');
  }
  await query(
    `UPDATE users SET email_verified=true WHERE id=$1`,
    [user.id]
  );
  res.redirect('/dashboard.html?verify=ok');
}

async function resendVerification(req, res) {
  const result = await query('SELECT email, email_verified FROM users WHERE id=$1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });

  const verifyToken = newToken();
  const verifyExpires = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);
  await query('UPDATE users SET verify_token=$1, verify_token_expires=$2 WHERE id=$3', [verifyToken, verifyExpires, req.session.userId]);

  await mailer.sendMail({
    to: user.email,
    subject: 'Verify your Kleos account',
    text: `Verify your email to start your first job:\n\n${mailer.verifyEmailLink(verifyToken)}\n\nThis link expires in 24 hours.`
  });
  res.json({ ok: true });
}

async function requestPasswordReset(req, res) {
  const email = normalizeEmail(req.body.email);
  // Always respond the same way whether or not the email exists, so this
  // endpoint can't be used to enumerate registered accounts.
  const genericResponse = { ok: true, message: 'If that email has an account, a reset link is on its way.' };
  if (!email) return res.json(genericResponse);

  const result = await query('SELECT id FROM users WHERE email=$1', [email]);
  const user = result.rows[0];
  if (user) {
    const resetToken = newToken();
    const resetExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await query('UPDATE users SET reset_token=$1, reset_token_expires=$2 WHERE id=$3', [resetToken, resetExpires, user.id]);
    mailer.sendMail({
      to: email,
      subject: 'Reset your Kleos password',
      text: `Someone (hopefully you) asked to reset the password on this account:\n\n${mailer.resetPasswordLink(resetToken)}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore it.`
    }).catch(err => console.error('Failed to send reset email:', err.message));
  }
  res.json(genericResponse);
}

async function resetPassword(req, res) {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const result = await query('SELECT id, reset_token_expires FROM users WHERE reset_token=$1', [token]);
  const user = result.rows[0];
  if (!user || new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await query(
    `UPDATE users SET password_hash=$1, reset_token=NULL, reset_token_expires=NULL WHERE id=$2`,
    [passwordHash, user.id]
  );
  res.json({ ok: true });
}

// ── settings (change password / preferences / delete / export) ──────────
// All require an active session (requireAuth) — this is "manage my own
// account while logged in," distinct from the token-based reset flow above
// for someone who's locked out entirely.

async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const result = await query('SELECT password_hash FROM users WHERE id=$1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, req.session.userId]);
  res.json({ ok: true });
}

async function updatePreferences(req, res) {
  const { voiceEnabled, notifyEmail } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (typeof voiceEnabled === 'boolean') { fields.push(`voice_enabled=$${i++}`); values.push(voiceEnabled); }
  if (typeof notifyEmail === 'boolean') { fields.push(`notify_email=$${i++}`); values.push(notifyEmail); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  values.push(req.session.userId);
  await query(`UPDATE users SET ${fields.join(', ')} WHERE id=$${i}`, values);
  res.json({ ok: true });
}

async function markOnboardingSeen(req, res) {
  await query('UPDATE users SET onboarding_seen=true WHERE id=$1', [req.session.userId]);
  res.json({ ok: true });
}

// A JSON export of everything this account owns — the sprint rows, the day
// logs, and every message ever posted in one of their sprints. Not a GDPR
// implementation by itself, but the actual data-portability piece of one.
async function exportAccountData(req, res) {
  const userId = req.session.userId;
  const userRes = await query(
    'SELECT id, email, is_admin, email_verified, created_at FROM users WHERE id=$1', [userId]
  );
  if (!userRes.rows[0]) return res.status(404).json({ error: 'Account not found.' });

  const sprintsRes = await query(
    `SELECT id, track, duration, pace_mode, total_work_days, day_index, status,
            checked_in_at, last_checkout_at, closing_report, created_at, updated_at
     FROM sprints WHERE user_id=$1 ORDER BY created_at ASC`,
    [userId]
  );
  const sprintIds = sprintsRes.rows.map(s => s.id);
  let dayLogs = [];
  let messages = [];
  if (sprintIds.length) {
    const dl = await query(
      `SELECT sprint_id, day_index, checked_in_at, checked_out_at, seconds_used, auto_checkout
       FROM day_logs WHERE sprint_id = ANY($1::uuid[]) ORDER BY checked_in_at ASC`,
      [sprintIds]
    );
    dayLogs = dl.rows;
    const msg = await query(
      `SELECT sprint_id, channel, author_key, body, day_index, created_at
       FROM messages WHERE sprint_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
      [sprintIds]
    );
    messages = msg.rows;
  }

  res.set('Content-Disposition', 'attachment; filename="kleos-account-export.json"');
  res.json({
    exportedAt: new Date().toISOString(),
    account: userRes.rows[0],
    sprints: sprintsRes.rows,
    dayLogs,
    messages
  });
}

async function deleteAccount(req, res) {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password is required to delete your account.' });

  const result = await query('SELECT password_hash FROM users WHERE id=$1', [req.session.userId]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Password is incorrect.' });

  // ON DELETE CASCADE on sprints.user_id takes care of sprints/day_logs/messages.
  await query('DELETE FROM users WHERE id=$1', [req.session.userId]);
  req.session.destroy(() => {
    res.clearCookie('kleos.sid');
    res.json({ ok: true });
  });
}

module.exports = {
  requireAuth, requireAdmin,
  signup, login, logout, me,
  verifyEmail, resendVerification,
  requestPasswordReset, resetPassword,
  changePassword, updatePreferences, markOnboardingSeen,
  exportAccountData, deleteAccount
};
