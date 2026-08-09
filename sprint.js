// sprint.js — sprint lifecycle: creation, check-in/check-out, the work-day
// clock, and the business-day calendar for "calendar" pace mode.
//
// Design, in one paragraph: a sprint has a chosen duration (2w/1m/3m), which
// is converted up front into a fixed number of business-day "work days"
// (total_work_days). Each check-in starts a work day; each check-out ends it,
// logs the real seconds worked, and advances day_index by one. In
// "self_paced" mode the user can check in again immediately. In "calendar"
// mode, check-in is only allowed on/after the next real business day —
// weekends are skipped, exactly like a real job.

const { query } = require('./db');

const DURATIONS = {
  '2w': { label: '2 weeks', workDays: 10 },
  '1m': { label: '1 month', workDays: 22 },
  '3m': { label: '3 months', workDays: 66 }
};

const PACE_MODES = ['calendar', 'self_paced'];
const DAY_BUDGET_SECONDS = 4 * 60 * 60; // 4-hour work day

// ── date helpers (all UTC, date-only comparisons) ──────────────────────
// Known limitation, documented in the README: this does not account for the
// user's timezone — "business day" means Mon-Fri UTC, plus whatever's in the
// holiday calendar below.

function utcDateOnly(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
function isWeekend(d) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

// Optional holiday calendar for "calendar" pace mode — a comma-separated
// list of YYYY-MM-DD (UTC) dates in the KLEOS_HOLIDAYS env var. Empty by
// default, in which case calendar-mode sprints behave exactly as before
// (weekends only). Re-read lazily rather than parsed once at module load so
// tests can mutate process.env.KLEOS_HOLIDAYS between runs.
function holidaySet() {
  return new Set(
    (process.env.KLEOS_HOLIDAYS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
}
function isHoliday(d) {
  return holidaySet().has(utcDateOnly(d).toISOString().slice(0, 10));
}
function isNonWorkDay(d) {
  return isWeekend(d) || isHoliday(d);
}
function nextBusinessDayFrom(d) {
  let n = utcDateOnly(d);
  while (isNonWorkDay(n)) n = addDays(n, 1);
  return n;
}
function nextBusinessDayAfter(d) {
  return nextBusinessDayFrom(addDays(utcDateOnly(d), 1));
}

// ── eligibility ─────────────────────────────────────────────────────────

function checkInEligibility(sprint, now = new Date()) {
  if (sprint.status !== 'active') return { eligible: false, reason: 'completed' };
  if (sprint.checked_in_at) return { eligible: false, reason: 'already_checked_in' };

  if (sprint.pace_mode === 'self_paced') return { eligible: true };

  // calendar mode
  const today = utcDateOnly(now);
  if (isWeekend(today)) {
    return { eligible: false, reason: 'weekend', nextAvailable: nextBusinessDayFrom(today) };
  }
  if (isHoliday(today)) {
    return { eligible: false, reason: 'holiday', nextAvailable: nextBusinessDayFrom(today) };
  }
  if (!sprint.last_checkout_at) return { eligible: true }; // very first day

  const nextAllowed = nextBusinessDayAfter(new Date(sprint.last_checkout_at));
  if (today.getTime() < nextAllowed.getTime()) {
    return { eligible: false, reason: 'already_worked_today', nextAvailable: nextAllowed };
  }
  return { eligible: true };
}

function eligibilityMessage(elig) {
  switch (elig.reason) {
    case 'completed': return 'This sprint is already complete.';
    case 'already_checked_in': return 'Already checked in.';
    case 'weekend': return "It's the weekend — come back on the next business day.";
    case 'holiday': return "It's a company holiday — come back on the next business day.";
    case 'already_worked_today':
      return `You've already worked today. Come back ${elig.nextAvailable.toISOString().slice(0, 10)}.`;
    default: return 'Not eligible to check in right now.';
  }
}

// ── status / timer ──────────────────────────────────────────────────────

function getStatus(sprint, now = new Date()) {
  const checkedIn = !!sprint.checked_in_at;
  const elapsedSeconds = checkedIn ? Math.max(0, Math.floor((now - new Date(sprint.checked_in_at)) / 1000)) : 0;
  const remainingSeconds = DAY_BUDGET_SECONDS - elapsedSeconds;
  return {
    checkedIn,
    dayIndex: sprint.day_index,
    totalWorkDays: sprint.total_work_days,
    dayBudgetSeconds: DAY_BUDGET_SECONDS,
    elapsedSeconds,
    remainingSeconds,
    overtime: checkedIn && remainingSeconds < 0,
    completed: sprint.status === 'completed',
    eligibility: checkedIn ? null : checkInEligibility(sprint, now)
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────

async function getActiveSprint(userId) {
  const result = await query(
    `SELECT * FROM sprints WHERE user_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

// Active sprint if one exists, otherwise the most recently completed one —
// used by the dashboard so a "job complete" state has something to show
// instead of just disappearing.
async function getLatestSprint(userId) {
  const active = await getActiveSprint(userId);
  if (active) return active;
  const result = await query(
    `SELECT * FROM sprints WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function getOwnedSprint(userId, sprintId) {
  const result = await query(`SELECT * FROM sprints WHERE id=$1 AND user_id=$2`, [sprintId, userId]);
  if (!result.rows.length) {
    const e = new Error('Sprint not found');
    e.status = 404;
    throw e;
  }
  return result.rows[0];
}

const LIVE_TRACKS = ['pm', 'design', 'fe'];

async function createSprint(userId, { track, duration, paceMode }) {
  if (!LIVE_TRACKS.includes(track)) {
    const e = new Error('That role is not live yet. Live tracks: ' + LIVE_TRACKS.join(', ') + '.');
    e.status = 400;
    throw e;
  }
  if (!DURATIONS[duration]) {
    const e = new Error('Unknown duration. Choose one of: ' + Object.keys(DURATIONS).join(', '));
    e.status = 400;
    throw e;
  }
  if (!PACE_MODES.includes(paceMode)) {
    const e = new Error('Unknown pace mode. Choose "calendar" or "self_paced".');
    e.status = 400;
    throw e;
  }

  const existing = await getActiveSprint(userId);
  if (existing) return existing; // idempotent: one active sprint per user

  const totalWorkDays = DURATIONS[duration].workDays;
  const result = await query(
    `INSERT INTO sprints (user_id, track, duration, pace_mode, total_work_days)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, track, duration, paceMode, totalWorkDays]
  );
  return result.rows[0];
}

async function checkInSprint(userId, sprintId) {
  const sprint = await getOwnedSprint(userId, sprintId);
  const elig = checkInEligibility(sprint);
  if (!elig.eligible) {
    const e = new Error(eligibilityMessage(elig));
    e.status = 409;
    e.eligibility = elig;
    throw e;
  }
  const now = new Date();
  const result = await query(
    `UPDATE sprints SET checked_in_at=$1, updated_at=now() WHERE id=$2 RETURNING *`,
    [now, sprintId]
  );
  await query(
    `INSERT INTO day_logs (sprint_id, day_index, checked_in_at) VALUES ($1,$2,$3)`,
    [sprintId, sprint.day_index, now]
  );
  return result.rows[0];
}

async function checkOutSprint(userId, sprintId) {
  const sprint = await getOwnedSprint(userId, sprintId);
  if (!sprint.checked_in_at) {
    const e = new Error('Not checked in.');
    e.status = 409;
    throw e;
  }
  const now = new Date();
  const secondsUsed = Math.max(0, Math.floor((now - new Date(sprint.checked_in_at)) / 1000));

  await query(
    `UPDATE day_logs SET checked_out_at=$1, seconds_used=$2
     WHERE sprint_id=$3 AND day_index=$4 AND checked_out_at IS NULL`,
    [now, secondsUsed, sprint.id, sprint.day_index]
  );

  const newDayIndex = sprint.day_index + 1;
  const completed = newDayIndex >= sprint.total_work_days;
  const result = await query(
    `UPDATE sprints
     SET checked_in_at=NULL, last_checkout_at=$1, day_index=$2, status=$3, updated_at=now()
     WHERE id=$4 RETURNING *`,
    [now, newDayIndex, completed ? 'completed' : 'active', sprint.id]
  );
  return { sprint: result.rows[0], secondsUsed, completed };
}

// A closed laptop, crashed tab, or dead wifi leaves a sprint "checked in"
// forever — the timer keeps counting up (as OVERTIME) with nobody there to
// click "Check out". This sweep force-closes any sprint that's been checked
// in longer than maxIdleSeconds, using the exact same accounting as a normal
// check-out (log real seconds worked, advance day_index) so it doesn't
// silently lose or fabricate a day. Called on an interval from server.js.
const AUTO_CHECKOUT_AFTER_SECONDS = 8 * 60 * 60; // 2x the 4h work day — generous grace before assuming abandonment

async function autoCheckoutStale(maxIdleSeconds = AUTO_CHECKOUT_AFTER_SECONDS) {
  const cutoff = new Date(Date.now() - maxIdleSeconds * 1000);
  const stale = await query(
    `SELECT * FROM sprints WHERE status='active' AND checked_in_at IS NOT NULL AND checked_in_at < $1`,
    [cutoff]
  );

  const closed = [];
  for (const sprint of stale.rows) {
    const now = new Date();
    const secondsUsed = Math.max(0, Math.floor((now - new Date(sprint.checked_in_at)) / 1000));

    await query(
      `UPDATE day_logs SET checked_out_at=$1, seconds_used=$2, auto_checkout=true
       WHERE sprint_id=$3 AND day_index=$4 AND checked_out_at IS NULL`,
      [now, secondsUsed, sprint.id, sprint.day_index]
    );

    const newDayIndex = sprint.day_index + 1;
    const completed = newDayIndex >= sprint.total_work_days;
    const result = await query(
      `UPDATE sprints
       SET checked_in_at=NULL, last_checkout_at=$1, day_index=$2, status=$3, updated_at=now()
       WHERE id=$4 RETURNING *`,
      [now, newDayIndex, completed ? 'completed' : 'active', sprint.id]
    );
    closed.push({ sprint: result.rows[0], secondsUsed, completed, autoCheckout: true });
  }
  return closed;
}

async function saveWorkspaceState(sprintId, state) {
  await query(`UPDATE sprints SET workspace_state=$1, updated_at=now() WHERE id=$2`, [
    JSON.stringify(state),
    sprintId
  ]);
}

// One JSONB column holding every agent's memory, keyed by agent key —
// { "pm": [...history], "cto": [...history], ... } — instead of a
// hardcoded column per agent, so adding another character doesn't need a
// schema change. jsonb_set writes just that one key's history without a
// separate read-then-write round trip.
async function saveAgentHistory(sprintId, agentKey, history) {
  await query(
    `UPDATE sprints SET agent_memory = jsonb_set(agent_memory, $1, $2::jsonb, true), updated_at=now() WHERE id=$3`,
    [`{${agentKey}}`, JSON.stringify(history), sprintId]
  );
}

async function saveReviewHistory(sprintId, history) {
  await query(`UPDATE sprints SET review_history=$1, updated_at=now() WHERE id=$2`, [
    JSON.stringify(history),
    sprintId
  ]);
}

module.exports = {
  DURATIONS,
  PACE_MODES,
  LIVE_TRACKS,
  DAY_BUDGET_SECONDS,
  AUTO_CHECKOUT_AFTER_SECONDS,
  isHoliday,
  isWeekend,
  checkInEligibility,
  eligibilityMessage,
  getStatus,
  getActiveSprint,
  getLatestSprint,
  getOwnedSprint,
  createSprint,
  checkInSprint,
  checkOutSprint,
  autoCheckoutStale,
  saveWorkspaceState,
  saveAgentHistory,
  saveReviewHistory
};
