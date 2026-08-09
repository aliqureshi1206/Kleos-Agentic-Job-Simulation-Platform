require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');

const { pool, migrate } = require('./db');
const auth = require('./auth');
const sprintLib = require('./sprint');
const content = require('./content');
const { AGENT_DEFS, NARRATIVE_SYSTEM, callModel } = require('./agents');
const logger = require('./logger');
const voice = require('./voice');

const app = express();
app.set('trust proxy', 1); // Railway/Render/Fly/etc all sit behind a proxy; needed for secure cookies
// 3mb, not the usual 1mb — the huddle posts a base64-encoded voice recording
// as JSON (POST /api/huddle/transcribe), which is ~33% larger than the raw
// audio. Comfortably covers a minute or two of a compressed voice update.
app.use(express.json({ limit: '3mb' }));

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('\n⚠️  ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key before running a real sprint.\n');
}
if (!process.env.SESSION_SECRET) {
  console.warn('\n⚠️  SESSION_SECRET is not set. Using an insecure default — set a real random value before deploying.\n');
}
if (!voice.ttsEnabled()) {
  console.warn('ℹ️  ELEVENLABS_API_KEY is not set — the daily huddle will still run, but as text only (no spoken audio).');
}
if (!voice.sttEnabled()) {
  console.warn('ℹ️  OPENAI_API_KEY is not set — huddle updates will fall back to a typed box instead of a recorded one.');
}

app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  name: 'kleos.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
  }
}));

// ── CSRF (double-submit cookie) ─────────────────────────────────────────
// SameSite=Lax cookies already block most cross-site POST forgery, but a
// dedicated token is the more complete fix (see README). This is the
// standard double-submit pattern: a random token is set as a *readable*
// (non-httpOnly) cookie; the frontend reads it and echoes it back as an
// X-CSRF-Token header on every mutating request. A cross-site attacker can
// forge the request but can't read the victim's cookie (browser same-origin
// policy), so they can never produce a header that matches. No server-side
// state needed — the cookie and header just have to agree.
const CSRF_COOKIE = 'kleos.csrf';
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
app.use((req, res, next) => {
  if (!readCookie(req, CSRF_COOKIE)) {
    res.cookie(CSRF_COOKIE, crypto.randomBytes(24).toString('hex'), {
      httpOnly: false, // the frontend must be able to read this to echo it back
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 30
    });
  }
  next();
});
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function requireCsrf(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  const cookieToken = readCookie(req, CSRF_COOKIE);
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Missing or invalid CSRF token. Refresh the page and try again.' });
  }
  next();
}
app.use('/api', requireCsrf);

// ── Rate limiting ───────────────────────────────────────────────────────
// Auth endpoints: strict, per-IP, guards against credential stuffing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' }
});
// Model-calling endpoints: per logged-in user (falls back to IP), guards the Anthropic bill.
const modelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session && req.session.userId) || req.ip,
  message: { error: 'Too many requests — slow down a bit.' }
});
// Account-management endpoints (change password, delete account): these
// already require a valid session AND the current password, so the threat
// model is different from anonymous credential stuffing — key by user, not
// IP, so one account's retries never affect (or get affected by) unrelated
// traffic sharing the same IP/NAT.
const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.session && req.session.userId) || req.ip,
  message: { error: 'Too many attempts. Try again in a few minutes.' }
});

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Attaches req.sprint = the caller's active, checked-in sprint, or 403s.
// Everything that talks to the model requires this: you cannot chat, submit,
// or get reviewed while checked out.
const requireCheckedIn = wrap(async (req, res, next) => {
  const sprint = await sprintLib.getActiveSprint(req.session.userId);
  if (!sprint) return res.status(403).json({ error: 'No active sprint. Start one from the dashboard.' });
  if (!sprint.checked_in_at) {
    return res.status(403).json({ error: "You're checked out. Check in from the dashboard to keep working." });
  }
  req.sprint = sprint;
  next();
});

// ── Auth routes ─────────────────────────────────────────────────────────
app.post('/api/auth/signup', authLimiter, wrap(auth.signup));
app.post('/api/auth/login', authLimiter, wrap(auth.login));
app.post('/api/auth/logout', wrap(auth.logout));
app.get('/api/auth/me', wrap(auth.me));
app.get('/api/auth/verify', wrap(auth.verifyEmail));
app.post('/api/auth/resend-verification', auth.requireAuth, authLimiter, wrap(auth.resendVerification));
app.post('/api/auth/request-reset', authLimiter, wrap(auth.requestPasswordReset));
app.post('/api/auth/reset-password', authLimiter, wrap(auth.resetPassword));

// ── Account settings (logged in) ────────────────────────────────────────
app.post('/api/account/change-password', auth.requireAuth, accountLimiter, wrap(auth.changePassword));
app.post('/api/account/preferences', auth.requireAuth, wrap(auth.updatePreferences));
app.post('/api/account/onboarding-seen', auth.requireAuth, wrap(auth.markOnboardingSeen));
app.get('/api/account/export', auth.requireAuth, wrap(auth.exportAccountData));
app.post('/api/account/delete', auth.requireAuth, accountLimiter, wrap(auth.deleteAccount));

// ── Sprint lifecycle routes ─────────────────────────────────────────────
app.post('/api/sprint', auth.requireAuth, wrap(async (req, res) => {
  const verified = await pool.query('SELECT email_verified FROM users WHERE id=$1', [req.session.userId]);
  if (!verified.rows[0] || !verified.rows[0].email_verified) {
    return res.status(403).json({ error: 'Verify your email before starting a job — check your inbox, or resend the link from the dashboard.' });
  }
  const { track, duration, paceMode } = req.body;
  const sprint = await sprintLib.createSprint(req.session.userId, { track, duration, paceMode });
  res.json({ sprint, status: sprintLib.getStatus(sprint) });
}));

app.get('/api/sprint/current', auth.requireAuth, wrap(async (req, res) => {
  // Returns the active sprint, or the most recently completed one so the
  // dashboard can show a "job complete" state instead of nothing.
  const sprint = await sprintLib.getLatestSprint(req.session.userId);
  if (!sprint) return res.json({ sprint: null });
  res.json({ sprint, status: sprintLib.getStatus(sprint) });
}));

app.post('/api/sprint/checkin', auth.requireAuth, wrap(async (req, res) => {
  const current = await sprintLib.getActiveSprint(req.session.userId);
  if (!current) return res.status(404).json({ error: 'No active sprint.' });
  const sprint = await sprintLib.checkInSprint(req.session.userId, current.id);
  res.json({ sprint, status: sprintLib.getStatus(sprint) });
}));

app.post('/api/sprint/checkout', auth.requireAuth, wrap(async (req, res) => {
  const current = await sprintLib.getActiveSprint(req.session.userId);
  if (!current) return res.status(404).json({ error: 'No active sprint.' });
  const { sprint, secondsUsed, completed } = await sprintLib.checkOutSprint(req.session.userId, current.id);
  if (completed) {
    // Best-effort: build and cache the closing report right away so it's
    // ready the instant the user lands on the "job complete" card. If this
    // fails, GET /api/sprint/report builds it lazily on first visit instead.
    try {
      const report = await content.buildClosingReport(sprint);
      await pool.query('UPDATE sprints SET closing_report=$1 WHERE id=$2', [JSON.stringify(report), sprint.id]);
      sprint.closing_report = report;
    } catch (err) {
      console.error('Failed to build closing report at checkout:', err);
    }
  }
  res.json({ sprint, status: sprintLib.getStatus(sprint), secondsUsed, completed });
}));

// The closing competency report for the caller's most recently completed
// run. Doesn't require an active/checked-in sprint (the whole point is to
// view this after the job is over) — just ownership and a completed status.
app.get('/api/sprint/report', auth.requireAuth, wrap(async (req, res) => {
  const sprint = await sprintLib.getLatestSprint(req.session.userId);
  if (!sprint || sprint.status !== 'completed') {
    return res.status(404).json({ error: 'No completed run yet.' });
  }
  if (sprint.closing_report) {
    return res.json({
      report: sprint.closing_report,
      sprint: { track: sprint.track, duration: sprint.duration, totalWorkDays: sprint.total_work_days }
    });
  }
  // Completed via the auto-checkout sweep, or an older run from before this
  // feature existed — build it now and cache it so it doesn't regenerate.
  const report = await content.buildClosingReport(sprint);
  await pool.query('UPDATE sprints SET closing_report=$1 WHERE id=$2', [JSON.stringify(report), sprint.id]);
  res.json({
    report,
    sprint: { track: sprint.track, duration: sprint.duration, totalWorkDays: sprint.total_work_days }
  });
}));

// Toggle the public portfolio link for the caller's most recently completed
// run. The token, once generated, is stable across enable/disable so
// sharing again doesn't hand out a new URL — disabling just 404s the public
// route without forgetting the link.
app.post('/api/sprint/share', auth.requireAuth, wrap(async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required.' });
  const sprint = await sprintLib.getLatestSprint(req.session.userId);
  if (!sprint || sprint.status !== 'completed') {
    return res.status(404).json({ error: 'No completed run yet.' });
  }
  let token = sprint.public_share_token;
  if (enabled && !token) token = crypto.randomBytes(16).toString('hex');
  await pool.query(
    'UPDATE sprints SET public_share_token=$1, public_share_enabled=$2, updated_at=now() WHERE id=$3',
    [token, enabled, sprint.id]
  );
  res.json({ enabled, token, url: enabled ? `/portfolio.html?token=${token}` : null });
}));

app.get('/api/sprint/share', auth.requireAuth, wrap(async (req, res) => {
  const sprint = await sprintLib.getLatestSprint(req.session.userId);
  if (!sprint || sprint.status !== 'completed') return res.json({ enabled: false, token: null });
  res.json({
    enabled: !!sprint.public_share_enabled,
    token: sprint.public_share_token || null,
    url: sprint.public_share_enabled ? `/portfolio.html?token=${sprint.public_share_token}` : null
  });
}));

// Public, unauthenticated — anyone with the link can view a shared closing
// report. Deliberately returns the same 404 whether the token doesn't exist
// or sharing was turned back off, so it never confirms/denies a guess.
app.get('/api/public/portfolio/:token', wrap(async (req, res) => {
  const result = await pool.query(
    `SELECT s.*, u.email AS owner_email FROM sprints s JOIN users u ON u.id = s.user_id
     WHERE s.public_share_token=$1 AND s.public_share_enabled=true AND s.status='completed'`,
    [req.params.token]
  );
  const sprint = result.rows[0];
  if (!sprint) return res.status(404).json({ error: 'This link is invalid or is no longer shared.' });

  let report = sprint.closing_report;
  if (!report) {
    report = await content.buildClosingReport(sprint);
    await pool.query('UPDATE sprints SET closing_report=$1 WHERE id=$2', [JSON.stringify(report), sprint.id]);
  }
  // A first-initial-and-domain display label instead of the full email —
  // enough to feel personal on a public page without publishing an inbox.
  const [localPart, domain] = sprint.owner_email.split('@');
  const displayName = `${localPart[0].toUpperCase()}. — ${domain}`;

  res.json({
    report,
    displayName,
    sprint: { track: sprint.track, duration: sprint.duration, totalWorkDays: sprint.total_work_days, completedAt: sprint.updated_at }
  });
}));

app.get('/api/sprint/status', auth.requireAuth, wrap(async (req, res) => {
  const sprint = await sprintLib.getActiveSprint(req.session.userId);
  if (!sprint) return res.json({ sprint: null });
  res.json({ status: sprintLib.getStatus(sprint) });
}));

// ── Workspace: tickets + channels (require an active, checked-in sprint) ─
// GET /api/workspace is the one call the client makes on entering the
// workspace. It runs the day director (idempotent — a no-op if today's
// content already exists) and returns everything needed to render the
// screen: the active ticket, the channel list with unread flags, DMs, and
// the team roster.
app.get('/api/workspace', auth.requireAuth, requireCheckedIn, wrap(async (req, res) => {
  const sprint = await content.ensureDayContent(req.sprint);
  const ticket = content.getActiveTicket(sprint);
  const channels = await content.listChannels(sprint);
  const huddle = await content.getHuddleForDay(sprint, sprint.day_index);
  res.json({
    sprint: { id: sprint.id, dayIndex: sprint.day_index, totalWorkDays: sprint.total_work_days },
    ticket: { ...ticket, channel: content.channelForTicket(ticket) },
    ticketState: sprint.ticket_state,
    channels,
    dms: content.dmChannels(),
    team: Object.entries(AGENT_DEFS).map(([key, def]) => ({ key, name: def.name })),
    huddle: { isHuddleDay: huddle.isHuddleDay, ranToday: huddle.ranToday, userSpoke: huddle.userSpoke, missedCount: huddle.missedCount }
  });
}));

app.get('/api/messages/:channel', auth.requireAuth, requireCheckedIn, wrap(async (req, res) => {
  const channel = req.params.channel;
  const messages = await content.getChannelMessages(req.sprint.id, channel);
  await content.markChannelRead(req.sprint, channel);
  res.json({ messages });
}));

// Generous but bounded — long enough for a genuine chat message or ticket
// write-up, short enough that nobody accidentally (or deliberately) pastes a
// novel into a single model call.
const MAX_MESSAGE_LENGTH = 6000;

app.post('/api/messages/:channel', auth.requireAuth, requireCheckedIn, modelLimiter, wrap(async (req, res) => {
  const channel = req.params.channel;
  const { text } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
  if (text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` });
  }
  const { agentKey, reply } = await content.postUserMessage(req.sprint, channel, text);
  res.json({ agentKey, reply });
}));

// ticket_state defaults to '{}' (NOT NULL) at the DB level, not to null, so
// "workspace never loaded yet" shows up as a status-less object rather than
// a falsy value — check for a missing status, not a missing object.
function ticketStateReady(sprint) {
  return !!(sprint.ticket_state && sprint.ticket_state.status);
}

app.post('/api/ticket/accept', auth.requireAuth, requireCheckedIn, wrap(async (req, res) => {
  if (!ticketStateReady(req.sprint)) {
    return res.status(400).json({ error: 'Workspace not loaded yet — open the workspace first.' });
  }
  if (req.sprint.ticket_state.status !== 'BACKLOG') {
    return res.status(409).json({ error: 'This ticket has already been accepted.' });
  }
  const ticketState = await content.acceptTicket(req.sprint);
  res.json({ ticketState });
}));

app.post('/api/ticket/submit', auth.requireAuth, requireCheckedIn, modelLimiter, wrap(async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required' });
  if (text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Submission is too long (max ${MAX_MESSAGE_LENGTH} characters).` });
  }
  if (!ticketStateReady(req.sprint)) {
    return res.status(400).json({ error: 'Workspace not loaded yet — open the workspace first.' });
  }
  const status = req.sprint.ticket_state.status;
  if (status === 'BACKLOG') {
    return res.status(409).json({ error: 'Accept this ticket before submitting work on it.' });
  }
  if (status === 'DONE') {
    return res.status(409).json({ error: 'This ticket is already complete.' });
  }
  const { verdict, channel } = await content.submitTicket(req.sprint, text);
  res.json({ verdict, channel });
}));

// ── Daily huddle (a few times a week — Mon/Wed/Fri-equivalent cadence) ──
// GET /api/huddle/today runs the same idempotent day-director check as
// /api/workspace (ensureDayContent no-ops if today's content, huddle
// included, already exists), then returns the transcript plus whether
// voice is actually configured so the client knows whether to offer audio
// playback / mic capture or fall back to a text-only huddle.
app.get('/api/huddle/today', auth.requireAuth, requireCheckedIn, wrap(async (req, res) => {
  const sprint = await content.ensureDayContent(req.sprint);
  const huddle = await content.getHuddleForDay(sprint, sprint.day_index);
  // Spoken audio requires BOTH the server having a real ElevenLabs key AND
  // this user not having turned voice off in /settings.html — either one
  // being false just means a text-only huddle, same degraded path as if
  // ELEVENLABS_API_KEY were never set.
  const prefs = await pool.query('SELECT voice_enabled FROM users WHERE id=$1', [req.session.userId]);
  const userWantsVoice = !prefs.rows[0] || prefs.rows[0].voice_enabled !== false;
  res.json({ voiceEnabled: voice.ttsEnabled() && userWantsVoice, micEnabled: voice.sttEnabled(), ...huddle });
}));

// Text-to-speech for one huddle line. The audio is never persisted — it's
// generated on demand and streamed straight through, same as any other
// pass-through proxy to a paid API; the transcript (what's actually stored)
// stays plain text in the messages table.
app.post('/api/huddle/tts', auth.requireAuth, requireCheckedIn, modelLimiter, wrap(async (req, res) => {
  const { agentKey, text } = req.body;
  if (!agentKey || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'agentKey and text are required' });
  }
  if (!AGENT_DEFS[agentKey]) return res.status(400).json({ error: 'Unknown teammate' });
  const audio = await voice.synthesizeSpeech(agentKey, text);
  res.set('Content-Type', 'audio/mpeg');
  res.send(audio);
}));

// Speech-to-text for the user's turn. Takes a base64-encoded recording from
// the browser's MediaRecorder and returns Whisper's transcript — the client
// is expected to show this to the user to confirm/edit before it's actually
// submitted via POST /api/huddle/speak; this route alone doesn't post
// anything to the transcript.
app.post('/api/huddle/transcribe', auth.requireAuth, requireCheckedIn, modelLimiter, wrap(async (req, res) => {
  const { audioBase64, mimeType } = req.body;
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return res.status(400).json({ error: 'audioBase64 is required' });
  }
  const buffer = Buffer.from(audioBase64, 'base64');
  const text = await voice.transcribeAudio(buffer, mimeType);
  res.json({ text });
}));

// The user's actual turn — a confirmed (transcribed-then-edited, or typed)
// update, posted to today's huddle transcript with a short facilitator ack.
app.post('/api/huddle/speak', auth.requireAuth, requireCheckedIn, modelLimiter, wrap(async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Update is too long (max ${MAX_MESSAGE_LENGTH} characters).` });
  }
  const result = await content.recordHuddleUpdate(req.sprint, text.trim());
  res.json(result);
}));

app.post('/api/narrative', auth.requireAuth, requireCheckedIn, modelLimiter, wrap(async (req, res) => {
  const st = req.sprint.ticket_state || {};
  const log = st.completedLog || [];
  const ticket = content.getActiveTicket(req.sprint);
  const summary = `Tickets completed this run: ${log.length ? log.map(t => `${t.id} (${t.title}, ${t.revisions} revision${t.revisions > 1 ? 's' : ''}${t.pivotFired ? ', survived a pivot' : ''})`).join('; ') : 'none yet'}.
Currently on: ${ticket.id} (${ticket.title}), status ${st.status}, revision ${st.revision}.`;
  const narrative = await callModel(NARRATIVE_SYSTEM, [{ role: 'user', content: summary }], 500);
  res.json({ narrative });
}));

// ── Admin (read-only visibility, gated by is_admin — see ADMIN_EMAILS in
// .env.example) ───────────────────────────────────────────────────────────
app.get('/api/admin/users', auth.requireAdmin, wrap(async (req, res) => {
  const result = await pool.query(`
    SELECT u.id, u.email, u.email_verified, u.is_admin, u.created_at,
           s.track, s.duration, s.pace_mode, s.day_index, s.total_work_days,
           s.status AS sprint_status, s.checked_in_at, s.created_at AS sprint_started_at
    FROM users u
    LEFT JOIN LATERAL (
      SELECT * FROM sprints WHERE sprints.user_id = u.id ORDER BY created_at DESC LIMIT 1
    ) s ON true
    ORDER BY u.created_at DESC
  `);
  res.json({ users: result.rows });
}));

app.get('/api/admin/stats', auth.requireAdmin, wrap(async (req, res) => {
  const [users, sprints, activeNow] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE email_verified) ::int AS verified FROM users`),
    pool.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status='completed')::int AS completed FROM sprints`),
    pool.query(`SELECT COUNT(*)::int AS n FROM sprints WHERE checked_in_at IS NOT NULL`)
  ]);
  res.json({
    totalUsers: users.rows[0].n,
    verifiedUsers: users.rows[0].verified,
    totalSprints: sprints.rows[0].n,
    completedSprints: sprints.rows[0].completed,
    checkedInNow: activeNow.rows[0].n
  });
}));

app.get('/api/health', wrap(async (req, res) => {
  const dbOk = await pool.query('SELECT 1').then(() => true).catch(() => false);
  res.json({ ok: true, hasKey: !!process.env.ANTHROPIC_API_KEY, db: dbOk });
}));

// Static files last, so /api/* never falls through to the file server.
app.use(express.static(path.join(__dirname, 'public')));

// Centralized error handler for anything wrap() catches. Expected client
// errors (bad input, not checked in, wrong password, etc.) are routine and
// shouldn't spam the server log with a stack trace — only genuine 5xx
// failures get logged.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) logger.logError(err, { path: req.path, method: req.method, userId: req.session && req.session.userId });
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

// Force-closes any sprint left checked in past AUTO_CHECKOUT_AFTER_SECONDS
// (closed laptop, crashed tab, dead wifi — nobody left to click "Check
// out"). Runs on boot and then every 15 minutes; cheap no-op most ticks
// since it's a single indexed query when nothing is stale.
const AUTO_CHECKOUT_SWEEP_MS = 15 * 60 * 1000;
async function runAutoCheckoutSweep() {
  try {
    const closed = await sprintLib.autoCheckoutStale();
    if (closed.length) {
      logger.logInfo(`Auto-checkout: force-closed ${closed.length} stale session(s).`, { count: closed.length });
    }
  } catch (err) {
    logger.logError(err, { context: 'auto-checkout-sweep' });
  }
}

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Kleos server running at http://localhost:${PORT}`);
    });
    runAutoCheckoutSweep();
    setInterval(runAutoCheckoutSweep, AUTO_CHECKOUT_SWEEP_MS);
  })
  .catch((err) => {
    logger.logError(err, { context: 'migration-failed' });
    process.exit(1);
  });

// Belt-and-suspenders: an uncaught error anywhere outside an Express request
// (a stray unhandled promise rejection, etc) should still be logged
// somewhere durable instead of silently killing the process with no trace.
process.on('unhandledRejection', (reason) => {
  logger.logError(reason instanceof Error ? reason : new Error(String(reason)), { context: 'unhandledRejection' });
});
