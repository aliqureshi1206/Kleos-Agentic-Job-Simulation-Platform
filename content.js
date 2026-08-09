// content.js — the "day director." Decides what's new each work day: the
// first ticket assignment, rotating to the next ticket once the current one
// is DONE, and rolling a seeded chance of a hiccup (pivot / incident /
// deadline shift) on the ticket in flight. Also owns the messaging layer
// (channels, posting, unread tracking) that the Slack-like UI reads from.
//
// Split of responsibility, so this stays readable:
//   - tickets.js   — what the work is (static content)
//   - agents.js    — who says it and in what voice
//   - content.js   — when things happen and where they get posted
//   - sprint.js    — the work-day/calendar clock this all runs on top of

const { query } = require('./db');
const {
  COMPANY, AGENT_DEFS, buildReviewSystem, NARRATIVE_SYSTEM, HICCUP_INSTRUCTIONS, COMPANY_UPDATE_BEATS, callModel,
  HUDDLE_CORE, HUDDLE_GUEST_POOL, CROSS_FUNCTIONAL_AGENTS
} = require('./agents');
const { getTicket, totalTickets } = require('./tickets');
const { saveAgentHistory, saveReviewHistory } = require('./sprint');
const mailer = require('./mailer');

// Best-effort email notification (huddle-ready, review verdict). Never
// throws — a notification failing to send should never break the actual
// feature it's describing. Respects the per-user notify_email preference
// from /settings.html; account-critical mail (verification, password reset)
// goes through auth.js directly and ignores this flag entirely on purpose.
async function notifyUser(sprint, subject, text) {
  try {
    const result = await query('SELECT email, notify_email FROM users WHERE id=$1', [sprint.user_id]);
    const user = result.rows[0];
    if (!user || user.notify_email === false) return;
    await mailer.sendMail({ to: user.email, subject, text });
  } catch (e) {
    // Notifications are flavor, not a critical path — swallow and move on.
  }
}

const HICCUP_CHANCE = 0.4; // per work day, while a ticket is in progress
const COMPANY_UPDATE_INTERVAL = 14; // work days between company-wide beats
const CROSS_FUNCTIONAL_PING_CHANCE = 0.25; // per work day, independent of ticket status
// Which work-day-of-week (dayIndex % 5, 0-indexed) gets a huddle — a
// Mon/Wed/Fri-equivalent cadence that works the same in both calendar and
// self-paced mode, since self-paced days don't line up with real weekdays.
const HUDDLE_DAYS_OF_WEEK = [0, 2, 4];

// ── deterministic per-(sprint,day) pseudo-randomness ────────────────────
// Same sprint + same day always rolls the same way, so a page refresh or a
// retried request never re-rolls and gets a different outcome.
function seededRoll(seedStr) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = (Math.imul(31, h) + seedStr.charCodeAt(i)) | 0;
  }
  // xorshift-ish mix, then normalize to [0,1)
  h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
  return ((h >>> 0) % 100000) / 100000;
}

function channelForTicket(ticket) {
  return ticket.id.toLowerCase();
}

// messages.body is stored as render-ready HTML, not raw text — the client
// just does innerHTML on it. Anything that isn't a deliberately-built HTML
// card (the rubric verdict, a templated system notice) has to be escaped
// and newline-converted *before* it goes in the database, not at render
// time, so history loaded from a refresh looks identical to a fresh message.
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function chatSafe(s) {
  return escapeHtml(s).replace(/\n/g, '<br>');
}

// A narrow allowlist sanitizer for the small amount of model-generated HTML
// that gets stored (filler ticket brief/delivLabel) and later rendered with
// innerHTML by the client. Rebuilds every tag from scratch with no
// attributes, so anything like onerror=/javascript: is dropped outright, and
// any tag outside the allowlist (including <script>) is stripped, leaving
// only its escaped-looking text behind rather than executing.
const RICH_TEXT_ALLOWED_TAGS = new Set(['p', 'b', 'strong', 'em', 'code']);
function sanitizeLimitedHtml(html) {
  if (typeof html !== 'string') return '';
  return html.replace(/<\/?([a-zA-Z0-9]+)[^>]*>/g, (match, tag) => {
    const lower = tag.toLowerCase();
    if (!RICH_TEXT_ALLOWED_TAGS.has(lower)) return '';
    return match.startsWith('</') ? `</${lower}>` : `<${lower}>`;
  });
}

function getActiveTicket(sprint) {
  const st = sprint.ticket_state || {};
  if (st.customTicket) return st.customTicket;
  return getTicket(sprint.track, sprint.ticket_idx);
}

function freshTicketState(ticket, dayIndex, customTicket) {
  const estDays = parseInt(ticket.est, 10) || 2;
  return {
    status: 'BACKLOG',
    revision: 1,
    submits: 0,
    accepted: false,
    pivotFired: false,
    assignedOnDay: dayIndex,
    dueAt: new Date(Date.now() + estDays * 86400000).toISOString(),
    lastSubmissionText: '',
    priorFeedbackSummary: null,
    lastReview: null,
    completedLog: [], // carried forward across rotations — see rotateTicket()
    customTicket: customTicket || null
  };
}

// ── messages (the Slack-like display layer) ─────────────────────────────

async function postMessage(sprintId, channel, authorKey, body, dayIndex) {
  await query(
    `INSERT INTO messages (sprint_id, channel, author_key, body, day_index) VALUES ($1,$2,$3,$4,$5)`,
    [sprintId, channel, authorKey, body, dayIndex]
  );
}

async function getChannelMessages(sprintId, channel) {
  const result = await query(
    `SELECT author_key, body, day_index, created_at FROM messages
     WHERE sprint_id=$1 AND channel=$2 ORDER BY created_at ASC`,
    [sprintId, channel]
  );
  return result.rows;
}

async function markChannelRead(sprint, channel) {
  const reads = { ...(sprint.channel_reads || {}), [channel]: new Date().toISOString() };
  await query(`UPDATE sprints SET channel_reads=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(reads), sprint.id]);
  sprint.channel_reads = reads;
  return reads;
}

// Team channels (not DMs) that currently have any history for this sprint,
// plus 'general' and 'incidents' which always exist. Unread = there's a
// message newer than the last read time, from someone other than the user.
async function listChannels(sprint) {
  const result = await query(
    `SELECT channel, MAX(created_at) AS last_at,
            (ARRAY_AGG(author_key ORDER BY created_at DESC))[1] AS last_author
     FROM messages WHERE sprint_id=$1 AND channel NOT LIKE 'dm-%' GROUP BY channel`,
    [sprint.id]
  );
  const known = new Map(result.rows.map(r => [r.channel, r]));
  known.set('general', known.get('general') || { channel: 'general', last_at: null, last_author: null });
  known.set('incidents', known.get('incidents') || { channel: 'incidents', last_at: null, last_author: null });

  const reads = sprint.channel_reads || {};
  const channels = [...known.values()].map(row => {
    const lastRead = reads[row.channel] ? new Date(reads[row.channel]) : null;
    const unread = !!(row.last_at && row.last_author !== 'user' && (!lastRead || new Date(row.last_at) > lastRead));
    return { key: row.channel, label: '#' + row.channel, unread };
  });
  // Stable order: general, incidents, then ticket channels by first appearance.
  const order = { general: 0, incidents: 1 };
  channels.sort((a, b) => (order[a.key] ?? 2) - (order[b.key] ?? 2) || a.key.localeCompare(b.key));
  return channels;
}

function dmChannels() {
  return Object.keys(AGENT_DEFS).map(key => ({ key: 'dm-' + key, label: AGENT_DEFS[key].name, agentKey: key }));
}

// ── model calls ──────────────────────────────────────────────────────────

// Send one turn to an agent, keeping its persistent per-sprint memory in
// sync. Used both for real user messages and for system-triggered hiccups
// (the agent "remembers" having said it afterward either way).
async function agentSpeak(sprint, agentKey, userText, maxTokens = 220) {
  if (!AGENT_DEFS[agentKey]) throw new Error('Unknown agent: ' + agentKey);
  const memory = sprint.agent_memory || {};
  const history = memory[agentKey] || [];
  history.push({ role: 'user', content: userText });
  // Every agent gets the same compact career-memory digest folded into their
  // system prompt — the office grapevine effect: a teammate who has never
  // reviewed your work can still have heard you're on a roll, the same way a
  // real coworker picks up on how someone's doing without reading their file.
  const system = AGENT_DEFS[agentKey].system + buildMemoryDigest(getCareerMemory(sprint));
  const reply = await callModel(system, history, maxTokens);
  history.push({ role: 'assistant', content: reply });
  await saveAgentHistory(sprint.id, agentKey, history);
  memory[agentKey] = history;
  sprint.agent_memory = memory;
  return reply;
}

function routeTeamChannelAgent(text) {
  if (/design|figma|flow|\bui\b|\bux\b|emma/i.test(text)) return 'design';
  if (/market|campaign|launch|messaging|grace/i.test(text)) return 'marketing';
  if (/\bsales\b|client|deal|ryan/i.test(text)) return 'sales';
  if (/\bceo\b|rania/i.test(text)) return 'ceo';
  if (/\bcto\b|nathan/i.test(text)) return 'cto';
  if (/director of product|claire/i.test(text)) return 'dirproduct';
  return /omar|stake|wallet|pivot|priorit|contradict|business|growth/i.test(text) ? 'stake' : 'pm';
}

async function postUserMessage(sprint, channel, text) {
  let agentKey;
  if (channel.startsWith('dm-')) {
    agentKey = channel.slice(3);
    if (!AGENT_DEFS[agentKey]) throw Object.assign(new Error('Unknown teammate'), { status: 400 });
  } else if (channel === 'incidents') {
    agentKey = 'qa';
  } else {
    agentKey = routeTeamChannelAgent(text);
  }
  await postMessage(sprint.id, channel, 'user', chatSafe(text), sprint.day_index);
  const reply = await agentSpeak(sprint, agentKey, text);
  await postMessage(sprint.id, channel, agentKey, chatSafe(reply), sprint.day_index);
  return { agentKey, reply };
}

// ── rubric rendering (server-side, so history reloads look identical to a
// fresh verdict without re-calling the model) ────────────────────────────

function renderVerdictHTML(ticket, verdict) {
  const type = verdict.verdict === 'pass' ? 'pass' : 'fail';
  const flags = (verdict.flags || []).map(f => `<div class="rub ${type}">
      <span class="mk">${type === 'fail' ? '✕' : '✓'}</span>
      <span class="rt"><b>${escapeHtml(f.title)}</b><span>${escapeHtml(f.detail)}</span></span></div>`).join('');
  const statusNote = type === 'fail'
    ? `<div class="callout warn" style="margin-top:11px"><span class="k">Status</span>Ticket moved to <code>QA_FAILED</code>. Revise and resubmit — the clock did not stop.</div>`
    : `<div class="callout info" style="margin-top:11px"><span class="k">Status</span>Ticket <code>DONE</code>.</div>`;
  return `${escapeHtml(verdict.opening).replace(/\n/g, '<br>')}<div class="rubric">
    <div class="rubric-h"><span>Rubric · ${ticket.id}</span><span>${type === 'fail' ? '3 blocking' : '3 met'}</span></div>
    ${flags}
  </div>${statusNote}`;
}

// ── ticket lifecycle ─────────────────────────────────────────────────────

async function persistTicketState(sprint) {
  await query(
    `UPDATE sprints SET ticket_idx=$1, ticket_state=$2, updated_at=now() WHERE id=$3`,
    [sprint.ticket_idx, JSON.stringify(sprint.ticket_state), sprint.id]
  );
}

// ── career memory (performance trends + notable moments) ────────────────
// A compact, deterministic summary of this run so far — distinct from
// agent_memory (the raw per-agent chat transcript used as literal model
// context). This is what lets a teammate act like they actually remember
// working with this person: reference a specific ticket by name, notice a
// pass streak, or check in after a rough patch — without replaying the
// entire chat history into every system prompt.
const MAX_CAREER_MOMENTS = 12;
const MILESTONE_EVERY = 5;

function defaultCareerMemory() {
  return {
    performance: { passStreak: 0, failStreak: 0, totalCompleted: 0, totalRevisions: 0, recentVerdicts: [] },
    moments: [],
    milestoneAnnounced: 0,
    pairingOfferedFor: null
  };
}

function getCareerMemory(sprint) {
  const mem = sprint.career_memory;
  if (!mem || typeof mem !== 'object' || !mem.performance) return defaultCareerMemory();
  return mem;
}

async function persistCareerMemory(sprint) {
  await query(`UPDATE sprints SET career_memory=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(sprint.career_memory), sprint.id]);
}

function recordMoment(mem, dayIndex, note) {
  mem.moments.push({ day: dayIndex, note });
  if (mem.moments.length > MAX_CAREER_MOMENTS) mem.moments = mem.moments.slice(-MAX_CAREER_MOMENTS);
}

// A short, plain-language digest appended to every agent's system prompt (see
// agentSpeak below) and the formal reviewer's prompt (see submitTicket). Pure
// string templating from state already in memory — no model call, so it's
// free and deterministic. Framed explicitly as private awareness rather than
// a script, so a persona can let it inform their tone without narrating it
// back verbatim every single message.
function buildMemoryDigest(mem) {
  if (!mem || (!mem.moments.length && !mem.performance.totalCompleted)) return '';
  const perf = mem.performance;
  const lines = [`Track record so far: ${perf.totalCompleted} ticket${perf.totalCompleted === 1 ? '' : 's'} completed, averaging ${perf.totalCompleted ? (perf.totalRevisions / perf.totalCompleted).toFixed(1) : '0'} revision(s) each.`];
  if (perf.passStreak >= 2) lines.push(`Currently on a ${perf.passStreak}-submission pass streak — recent work has needed little to no revision.`);
  if (perf.failStreak >= 2) lines.push(`Currently on a ${perf.failStreak}-submission rough patch — the last few submissions needed real revisions.`);
  const recent = mem.moments.slice(-3);
  if (recent.length) lines.push('Recent notable moments: ' + recent.map(m => `Day ${m.day + 1} — ${m.note}`).join(' '));
  return `\n\nCONTEXT ON THIS TEAMMATE (private awareness — something you'd genuinely remember from working with them, not a script to recite verbatim or announce unprompted): ${lines.join(' ')}`;
}

// Called once per submitTicket verdict. Updates the running performance
// trend and notable-moments log, then fires deterministic, performance-
// triggered messages (as opposed to the purely random hiccups above) — a
// manager noticing a rough patch, a teammate offering to pair after repeated
// revisions on the same ticket, recognition for a pass streak or a
// milestone. Each trigger fires exactly once per crossing (equality checks,
// not thresholds), so a long streak doesn't spam the same message every day.
async function updateCareerMemory(sprint, ticket, verdict) {
  const mem = getCareerMemory(sprint);
  const st = sprint.ticket_state;

  mem.performance.recentVerdicts.push(verdict.verdict);
  if (mem.performance.recentVerdicts.length > 8) mem.performance.recentVerdicts.shift();

  if (verdict.verdict === 'pass') {
    mem.performance.passStreak += 1;
    mem.performance.failStreak = 0;
    mem.performance.totalCompleted += 1;
    mem.performance.totalRevisions += st.revision;
    mem.pairingOfferedFor = null;
    if (st.revision <= 1) recordMoment(mem, sprint.day_index, `Clean first-try pass on ${ticket.id} ("${ticket.title}").`);
    else if (st.revision >= 3) recordMoment(mem, sprint.day_index, `Hard-won pass on ${ticket.id} after ${st.revision} attempts.`);
    if (st.pivotFired) recordMoment(mem, sprint.day_index, `Adapted to a pivot mid-ticket on ${ticket.id} and still landed it.`);
  } else {
    mem.performance.failStreak += 1;
    mem.performance.passStreak = 0;
    recordMoment(mem, sprint.day_index, `${ticket.id} sent back for revision ${st.revision}.`);
  }

  sprint.career_memory = mem;
  await persistCareerMemory(sprint);

  // Manager checks in privately the first time a rough patch hits 2 in a row.
  if (verdict.verdict !== 'pass' && mem.performance.failStreak === 2) {
    try {
      const msg = await agentSpeak(sprint, 'pm', HICCUP_INSTRUCTIONS.manager_checkin_struggling(ticket), 130);
      await postMessage(sprint.id, 'dm-pm', 'pm', chatSafe(msg), sprint.day_index);
    } catch (e) { /* flavor only */ }
  }
  // A teammate (this ticket's reviewer, in their casual voice) offers to pair
  // the first time this specific ticket needs a 3rd attempt.
  if (verdict.verdict !== 'pass' && st.revision >= 3 && mem.pairingOfferedFor !== ticket.id) {
    mem.pairingOfferedFor = ticket.id;
    sprint.career_memory = mem;
    await persistCareerMemory(sprint);
    try {
      const helper = ticket.reviewer || 'tlead';
      const msg = await agentSpeak(sprint, helper, HICCUP_INSTRUCTIONS.pairing_offer(ticket), 130);
      await postMessage(sprint.id, channelForTicket(ticket), helper, chatSafe(msg), sprint.day_index);
    } catch (e) { /* flavor only */ }
  }
  // Manager privately notices growing trust the first time a pass streak hits 3.
  if (verdict.verdict === 'pass' && mem.performance.passStreak === 3) {
    try {
      const msg = await agentSpeak(sprint, 'pm', HICCUP_INSTRUCTIONS.manager_trust_streak(ticket), 130);
      await postMessage(sprint.id, 'dm-pm', 'pm', chatSafe(msg), sprint.day_index);
    } catch (e) { /* flavor only */ }
  }
  // Public shout-out in #general every MILESTONE_EVERY completed tickets.
  const milestone = Math.floor(mem.performance.totalCompleted / MILESTONE_EVERY) * MILESTONE_EVERY;
  if (milestone > 0 && milestone > (mem.milestoneAnnounced || 0)) {
    mem.milestoneAnnounced = milestone;
    sprint.career_memory = mem;
    await persistCareerMemory(sprint);
    try {
      const msg = await agentSpeak(sprint, 'pm', HICCUP_INSTRUCTIONS.manager_milestone(milestone), 130);
      await postMessage(sprint.id, 'general', 'pm', chatSafe(msg), sprint.day_index);
    } catch (e) { /* flavor only */ }
  }
}

// After this many AI-generated fillers in a single sprint, stop calling the
// model for new ones and cycle a small hand-curated evergreen set instead.
// Guards against runaway API spend on a very long or very fast-paced run,
// and against an unbounded stream of unreviewed model content — a human
// wrote and reviewed everything past this point, same as the curated bank.
const MAX_AI_FILLERS_PER_SPRINT = 6;

const EVERGREEN_FILLERS = {
  pm: [
    {
      id: 'QE-EVG1',
      title: 'Write a short retro on the work so far',
      desc: 'The backlog is caught up for now — use this to reflect on the run so far.',
      brief: '<p>Nothing new is queued today. Write a short retrospective covering what shipped, what you learned, and what you would do differently.</p>',
      delivLabel: '<b>Deliverable — retro.</b> What shipped, one lesson, one thing you would change.',
      rubric: [
        'Names at least one specific thing that actually shipped this run',
        'States one concrete lesson, not a generic platitude',
        'States one thing that would be done differently next time',
        "Written in the candidate's own voice, referencing real specifics from the run"
      ]
    },
    {
      id: 'QE-EVG2',
      title: 'Draft a one-pager proposing the next quarter\'s checkout bet',
      desc: 'Leadership wants a lightweight pitch for what checkout should tackle next quarter.',
      brief: '<p>Pick one real problem from this run\'s tickets and argue for it as next quarter\'s top checkout bet.</p><p>Assume the reader is <b>Rania</b> (CEO) and has five minutes.</p>',
      delivLabel: '<b>Deliverable — one-pager.</b> Problem, why now, rough scope, one success metric.',
      rubric: [
        'Grounds the pitch in a real problem raised earlier in this run, not a generic idea',
        'States why this quarter specifically, not just why it matters eventually',
        'Names one measurable success metric',
        'Fits a five-minute read — no padding'
      ]
    },
    {
      id: 'QE-EVG3',
      title: 'Audit checkout for one underserved market segment',
      desc: 'Pick a market Meridian serves and write up where checkout currently falls short for it.',
      brief: '<p>Choose Cairo, Riyadh, Karachi, or another market Meridian serves, and identify one concrete gap in the checkout experience for that segment.</p>',
      delivLabel: '<b>Deliverable — gap memo.</b> The gap, who it affects, and a rough fix.',
      rubric: [
        'Names a specific market and a specific, non-generic gap',
        'Explains who is affected and roughly how many users',
        'Proposes a rough fix, not just a complaint',
        'Consistent with what has been established about Meridian so far'
      ]
    }
  ],
  design: [
    {
      id: 'QD-EVG1',
      title: 'Write a short retro on the design work so far',
      desc: 'The backlog is caught up for now — use this to reflect on the run so far.',
      brief: '<p>Nothing new is queued today. Write a short retrospective covering what you designed, what you learned, and what you would do differently.</p>',
      delivLabel: '<b>Deliverable — retro.</b> What shipped, one lesson, one thing you would change.',
      rubric: [
        'Names at least one specific spec or component actually delivered this run',
        'States one concrete lesson, not a generic platitude',
        'States one thing that would be done differently next time',
        "Written in the candidate's own voice, referencing real specifics from the run"
      ]
    },
    {
      id: 'QD-EVG2',
      title: 'Propose one small usability improvement to checkout',
      desc: 'Pick one real friction point noticed during this run and spec a small fix for it.',
      brief: '<p>Choose one concrete usability issue you noticed working through checkout this run, and write a small, shippable spec to fix it.</p>',
      delivLabel: '<b>Deliverable — small-fix spec.</b> The friction point, the fix, and why it\'s worth doing now.',
      rubric: [
        'Names a specific, real friction point rather than a generic "improve UX" statement',
        'The fix is genuinely small/shippable, not a disguised redesign',
        'States why this is worth doing now given everything else in flight',
        'Consistent with the existing design system'
      ]
    },
    {
      id: 'QD-EVG3',
      title: 'Audit checkout for one underserved market segment',
      desc: 'Pick a market Meridian serves and write up a design gap for it.',
      brief: '<p>Choose Cairo, Riyadh, Karachi, or another market Meridian serves, and identify one concrete design gap in the checkout experience for that segment.</p>',
      delivLabel: '<b>Deliverable — gap memo.</b> The gap, who it affects, and a rough design fix.',
      rubric: [
        'Names a specific market and a specific, non-generic design gap',
        'Explains who is affected and roughly how many users',
        'Proposes a rough design fix, not just a complaint',
        'Consistent with what has been established about Meridian so far'
      ]
    }
  ],
  fe: [
    {
      id: 'QF-EVG1',
      title: 'Write a short retro on the engineering work so far',
      desc: 'The backlog is caught up for now — use this to reflect on the run so far.',
      brief: '<p>Nothing new is queued today. Write a short retrospective covering what you shipped, what you learned, and what you would do differently.</p>',
      delivLabel: '<b>Deliverable — retro.</b> What shipped, one lesson, one thing you would change.',
      rubric: [
        'Names at least one specific thing actually shipped this run',
        'States one concrete lesson, not a generic platitude',
        'States one thing that would be done differently next time',
        "Written in the candidate's own voice, referencing real specifics from the run"
      ]
    },
    {
      id: 'QF-EVG2',
      title: 'Propose one small technical-debt fix in checkout',
      desc: 'Pick one real piece of tech debt noticed this run and scope a small fix for it.',
      brief: '<p>Choose one concrete piece of technical debt you noticed while working through checkout this run, and write a small, shippable plan to address it.</p>',
      delivLabel: '<b>Deliverable — small-fix plan.</b> The debt, the fix, and why it\'s worth doing now.',
      rubric: [
        'Names a specific, real piece of tech debt rather than a generic "clean up the code" statement',
        'The fix is genuinely small/shippable, not a disguised rewrite',
        'States why this is worth doing now given everything else in flight',
        'Names the risk of NOT fixing it soon'
      ]
    },
    {
      id: 'QF-EVG3',
      title: 'Audit checkout for one performance regression risk',
      desc: 'Pick one part of checkout and assess its risk of a future performance regression.',
      brief: '<p>Choose one part of the checkout flow and identify a concrete way it could regress in performance as the codebase grows, plus a guardrail to catch it.</p>',
      delivLabel: '<b>Deliverable — risk memo.</b> The risk, why it\'s plausible, and a guardrail to catch it.',
      rubric: [
        'Names a specific, plausible regression risk rather than a generic "things could get slower" statement',
        'Explains why it\'s plausible given how the codebase actually works',
        'Proposes a concrete guardrail (a budget, a CI check), not just a warning',
        'Consistent with what has been established about Meridian\'s checkout so far'
      ]
    }
  ]
};

function validateFillerTicket(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const idOk = typeof parsed.id === 'string' && /^[A-Za-z0-9-]{3,20}$/.test(parsed.id.trim());
  const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 140) : '';
  const desc = typeof parsed.desc === 'string' ? parsed.desc.trim().slice(0, 400) : '';
  const brief = typeof parsed.brief === 'string' ? parsed.brief.trim().slice(0, 1500) : '';
  const delivLabel = typeof parsed.delivLabel === 'string' ? parsed.delivLabel.trim().slice(0, 400) : '';
  const rubricRaw = Array.isArray(parsed.rubric) ? parsed.rubric : [];
  const rubric = rubricRaw
    .filter(r => typeof r === 'string' && r.trim().length > 0)
    .map(r => r.trim().slice(0, 220))
    .slice(0, 6);

  if (!idOk || !title || !desc || !brief || !delivLabel || rubric.length < 3) return null;

  return {
    id: parsed.id.trim(),
    title,
    desc,
    brief: sanitizeLimitedHtml(brief),
    delivLabel: sanitizeLimitedHtml(delivLabel),
    rubric
  };
}

// Per-track config for AI-generated filler: whose voice invents the ticket,
// who formally reviews it, and a one-word role label for the prompt. The PM
// track keeps its historical reviewer ('tlead', i.e. the same eng-lead
// review PM tickets have always gotten); Design and Frontend are reviewed
// by their own track lead.
const TRACK_FILLER_CONFIG = {
  pm: { roleLabel: 'PM', personaAgent: 'pm', reviewer: 'tlead', idPrefix: 'QE' },
  design: { roleLabel: 'product design', personaAgent: 'design', reviewer: 'design', idPrefix: 'QD' },
  fe: { roleLabel: 'frontend engineering', personaAgent: 'tlead', reviewer: 'tlead', idPrefix: 'QF' }
};

async function generateFillerTicket(sprint, index) {
  const cfg = TRACK_FILLER_CONFIG[sprint.track] || TRACK_FILLER_CONFIG.pm;

  // Beyond the cap, don't call the model at all — cycle the evergreen set.
  if (index >= MAX_AI_FILLERS_PER_SPRINT) {
    const bank = EVERGREEN_FILLERS[sprint.track] || EVERGREEN_FILLERS.pm;
    const evergreen = bank[(index - MAX_AI_FILLERS_PER_SPRINT) % bank.length];
    return { ...evergreen, pri: 'med', est: '1 day', reviewer: cfg.reviewer, pivotEligible: false };
  }

  // The curated bank (tickets.js) is exhausted but the user still has work
  // days left in their chosen duration. Ask the model for one more
  // reasonable, reviewable ticket in the same world, in the track lead's
  // voice, rather than leaving the backlog empty.
  const instruction = `[SYSTEM EVENT — not visible to the user] The curated ticket backlog for this checkout team is caught up. Invent one more realistic, medium-scope ${cfg.roleLabel} ticket in the same world (Meridian, a checkout platform for MENA/South Asia commerce) that this teammate could plausibly be assigned next. Respond with ONLY valid JSON, no markdown fences, in exactly this shape:
{"id":"${cfg.idPrefix}-<a plausible 3-digit number>","title":"...","desc":"one sentence backlog description","brief":"2-4 sentences of HTML context using only <p> and <b> tags, no other tags and no attributes","delivLabel":"one sentence describing the deliverable, wrapped in <b>Deliverable — X.</b> plus one more sentence","rubric":["4 to 5 short rubric bullet strings describing what a passing submission needs"]}`;
  let raw;
  try {
    raw = await callModel(AGENT_DEFS[cfg.personaAgent].system, [{ role: 'user', content: instruction }], 500);
  } catch (e) {
    raw = null;
  }
  let parsed = null;
  if (raw) {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
    try { parsed = JSON.parse(cleaned); } catch (e) { parsed = null; }
  }

  const validated = validateFillerTicket(parsed);
  const result = validated || {
    // Safety net: the model call failed, returned unparseable JSON, or
    // returned something that didn't pass validation. Never leave a work
    // day with literally nothing assigned, and never trust an unvalidated
    // shape through to the client.
    id: cfg.idPrefix + '-F' + (500 + index),
    title: 'Write a short retro on the last quarter of checkout work',
    desc: 'The backlog is caught up for now — use this to reflect on the run so far.',
    brief: '<p>Nothing urgent is queued. Write a short retrospective covering what shipped, what you learned, and what you would do differently.</p>',
    delivLabel: '<b>Deliverable — retro.</b> What shipped, one lesson, one thing you would change.',
    rubric: [
      'Names at least one specific thing that actually shipped this run',
      'States one concrete lesson, not a generic platitude',
      'States one thing that would be done differently next time',
      "Written in the candidate's own voice, referencing real specifics from the run"
    ]
  };

  result.pri = result.pri || 'med';
  result.est = result.est || '1 day';
  result.reviewer = cfg.reviewer;
  result.pivotEligible = false;
  return result;
}

// Track-specific framing for the one-time onboarding message — the actual
// day-to-day work (tickets, review, manager DMs) all comes from Yusra
// regardless of track, since she coordinates the whole embedded pod; this
// only changes the cosmetic "you're joining as X" line so a designer or
// engineer doesn't get welcomed with the PM's job title.
const TRACK_USER_TITLES = {
  pm: 'Associate Product Manager, Checkout Experience',
  design: 'Product Designer, Checkout Experience',
  fe: 'Frontend Engineer, Checkout Experience'
};

// Runs exactly once per sprint, ever — the literal first day, before the
// first ticket is assigned. This is the "you just got hired" moment: who
// you report to, what team you're on, what the company actually does.
async function runOnboarding(sprint, dayIndex) {
  const userTitle = TRACK_USER_TITLES[sprint.track] || TRACK_USER_TITLES.pm;
  const contextHTML = `<b>Welcome to ${COMPANY.name}.</b> The mission here is to ${COMPANY.mission} — ${COMPANY.size}, ${COMPANY.funding}, HQ in ${COMPANY.hq}. You're joining as <b>${userTitle}</b> on the ${COMPANY.team} team, reporting to ${COMPANY.managerName}.`;
  await postMessage(sprint.id, 'general', 'sys', contextHTML, dayIndex);

  const welcome = await agentSpeak(sprint, 'pm', HICCUP_INSTRUCTIONS.onboarding_welcome(userTitle), 150);
  await postMessage(sprint.id, 'general', 'pm', chatSafe(welcome), dayIndex);

  const guidelines = await agentSpeak(sprint, 'tlead', HICCUP_INSTRUCTIONS.onboarding_guidelines(), 120);
  await postMessage(sprint.id, 'general', 'tlead', chatSafe(guidelines), dayIndex);

  const qaIntro = await agentSpeak(sprint, 'qa', HICCUP_INSTRUCTIONS.onboarding_qa_intro(), 100);
  await postMessage(sprint.id, 'general', 'qa', chatSafe(qaIntro), dayIndex);
}

async function assignTicket(sprint, ticket, dayIndex, customTicket) {
  sprint.ticket_state = freshTicketState(ticket, dayIndex, customTicket);
  const channel = channelForTicket(ticket);
  const msg = await agentSpeak(sprint, 'pm', HICCUP_INSTRUCTIONS.assignment(ticket), 150);
  await postMessage(sprint.id, channel, 'pm', chatSafe(msg), dayIndex);
  await postMessage(sprint.id, 'general', 'sys', `New ticket assigned: <b>${ticket.id}</b> — see <code>#${channel}</code>`, dayIndex);
}

async function rotateToNextTicket(sprint, dayIndex) {
  const finishedTicket = getActiveTicket(sprint);
  const finalScores = (sprint.ticket_state.lastReview && sprint.ticket_state.lastReview.scores) || null;
  const log = (sprint.ticket_state.completedLog || []).concat([{
    id: finishedTicket.id,
    title: finishedTicket.title,
    revisions: sprint.ticket_state.revision,
    pivotFired: !!sprint.ticket_state.pivotFired,
    scores: finalScores
  }]);

  sprint.ticket_idx += 1;
  const total = totalTickets(sprint.track);
  if (sprint.ticket_idx < total) {
    const next = getTicket(sprint.track, sprint.ticket_idx);
    await assignTicket(sprint, next, dayIndex, null);
  } else {
    const filler = await generateFillerTicket(sprint, sprint.ticket_idx - total);
    await assignTicket(sprint, filler, dayIndex, filler);
  }
  sprint.ticket_state.completedLog = log;
}

async function maybeFireHiccup(sprint, dayIndex) {
  const ticket = getActiveTicket(sprint);
  const roll = seededRoll(sprint.id + ':' + dayIndex);
  if (roll >= HICCUP_CHANCE) return;

  const sub = seededRoll(sprint.id + ':' + dayIndex + ':type');
  const channel = channelForTicket(ticket);
  let kind = 'incident';
  if (ticket.pivotEligible && !sprint.ticket_state.pivotFired && sub < 0.4) kind = 'pivot';
  else if (sub < 0.75) kind = 'incident';
  else kind = 'deadline_shift';

  if (kind === 'pivot') {
    const reasons = [
      'a board update changed the growth team\'s priority',
      'new data came in overnight that contradicts the original brief',
      'a partner commitment moved the goalposts'
    ];
    const reason = reasons[Math.floor(seededRoll(sprint.id + ':' + dayIndex + ':reason') * reasons.length)];
    const msg = await agentSpeak(sprint, 'stake', HICCUP_INSTRUCTIONS.pivot(ticket, reason), 150);
    await postMessage(sprint.id, channel, 'stake', chatSafe(msg), dayIndex);
    sprint.ticket_state.pivotFired = true;
  } else if (kind === 'incident') {
    const msg = await agentSpeak(sprint, 'qa', HICCUP_INSTRUCTIONS.incident(ticket), 150);
    await postMessage(sprint.id, 'incidents', 'qa', chatSafe(msg), dayIndex);
  } else {
    const direction = seededRoll(sprint.id + ':' + dayIndex + ':dir') < 0.5 ? 'earlier' : 'later';
    const msg = await agentSpeak(sprint, 'pm', HICCUP_INSTRUCTIONS.deadline_shift(ticket, direction), 120);
    await postMessage(sprint.id, channel, 'pm', chatSafe(msg), dayIndex);
    const deltaDays = direction === 'earlier' ? -1 : 2;
    const due = new Date(sprint.ticket_state.dueAt);
    due.setDate(due.getDate() + deltaDays);
    sprint.ticket_state.dueAt = due.toISOString();
  }
}

// Company-wide news, independent of whatever ticket is in flight — posted
// to #general every ~2 work-weeks so a long run feels like it's moving
// through real company time, not just ticket time.
async function maybeFireCompanyUpdate(sprint, dayIndex) {
  const beatIdx = Math.floor(dayIndex / COMPANY_UPDATE_INTERVAL) % COMPANY_UPDATE_BEATS.length;
  const beat = COMPANY_UPDATE_BEATS[beatIdx];
  const msg = await agentSpeak(sprint, 'stake', HICCUP_INSTRUCTIONS.company_update(beat), 150);
  await postMessage(sprint.id, 'general', 'stake', chatSafe(msg), dayIndex);
}

// ── daily huddle (a few times a week, spoken not typed) ─────────────────

function isHuddleDay(dayIndex) {
  return HUDDLE_DAYS_OF_WEEK.includes(dayIndex % 5);
}

// Yusra and Daniyal are always there; 2-3 more join from a rotating pool
// (leadership + cross-functional partners + QA) so the CEO/CTO showing up
// stays a bit of an event rather than a daily fixture — seeded so the same
// sprint+day always picks the same attendee list.
function pickHuddleAttendees(sprint, dayIndex) {
  const seed = sprint.id + ':huddle:' + dayIndex;
  const shuffled = [...HUDDLE_GUEST_POOL].sort((a, b) => seededRoll(seed + ':' + a) - seededRoll(seed + ':' + b));
  const guestCount = 2 + Math.floor(seededRoll(seed + ':count') * 2); // 2 or 3 guests
  return [...HUDDLE_CORE, ...shuffled.slice(0, guestCount)];
}

async function persistHuddleState(sprint) {
  await query(`UPDATE sprints SET huddle_state=$1, updated_at=now() WHERE id=$2`, [JSON.stringify(sprint.huddle_state), sprint.id]);
}

// Runs once per huddle day (guarded by huddle_state.lastHuddleDay, the same
// idempotency pattern ensureDayContent already uses for tickets). Each
// attendee gives a short spoken-cadence update via their existing
// persistent memory — same call as a normal chat message, just phrased for
// TTS instead of Slack. The transcript is plain text in the 'huddle'
// channel; the client converts it to audio on demand via /api/huddle/tts.
async function runHuddle(sprint, dayIndex) {
  const prev = sprint.huddle_state || {};
  // If the previous huddle came and went without a user update, count it as
  // missed — a running tally for the run, not a penalty, just visibility
  // (mirrors OVERTIME: surfaced, never enforced).
  const missedPrevious = typeof prev.lastHuddleDay === 'number' && prev.lastHuddleDay !== dayIndex && !prev.userSpoke;
  const missedCount = (prev.missedCount || 0) + (missedPrevious ? 1 : 0);

  const attendees = pickHuddleAttendees(sprint, dayIndex);
  const hasTicket = sprint.ticket_state && sprint.ticket_state.status;
  const ticket = hasTicket ? getActiveTicket(sprint) : null;

  await postMessage(sprint.id, 'huddle', 'sys',
    `<b>Daily huddle — Day ${dayIndex + 1}.</b> ${attendees.map(k => AGENT_DEFS[k].name).join(', ')} joined.`, dayIndex);

  for (const key of attendees) {
    const instruction = HICCUP_INSTRUCTIONS.huddle_update(ticket, sprint.ticket_state || {});
    const msg = await agentSpeak(sprint, key, instruction, 120);
    await postMessage(sprint.id, 'huddle', key, chatSafe(msg), dayIndex);
  }

  sprint.huddle_state = { lastHuddleDay: dayIndex, attendees, userSpoke: false, missedCount };
  await persistHuddleState(sprint);

  await notifyUser(
    sprint,
    "Today's huddle is ready — Kleos",
    `Day ${dayIndex + 1}'s huddle just started with ${attendees.map(k => AGENT_DEFS[k].name).join(', ')}. Head to ${mailer.APP_URL}/huddle.html to catch up and give your update.`
  );
}

// Today's huddle transcript plus enough state for the client to know
// whether to show "join the huddle" or "you already spoke today."
async function getHuddleForDay(sprint, dayIndex) {
  const result = await query(
    `SELECT author_key, body, created_at FROM messages WHERE sprint_id=$1 AND channel='huddle' AND day_index=$2 ORDER BY created_at ASC`,
    [sprint.id, dayIndex]
  );
  const hs = sprint.huddle_state || {};
  const ranToday = hs.lastHuddleDay === dayIndex;
  return {
    dayIndex,
    isHuddleDay: isHuddleDay(dayIndex),
    ranToday,
    userSpoke: ranToday && !!hs.userSpoke,
    attendees: (ranToday ? hs.attendees : []) || [],
    missedCount: hs.missedCount || 0,
    lines: result.rows.map(r => ({ agentKey: r.author_key, name: AGENT_DEFS[r.author_key] ? AGENT_DEFS[r.author_key].name : 'System', text: r.body, createdAt: r.created_at }))
  };
}

// The user's turn — called once their spoken update has been recorded and
// transcribed (or typed, if voice isn't configured). Posts it into the
// transcript and has the facilitator (Yusra) close the loop, the same way a
// real standup ends with someone acknowledging what you said.
async function recordHuddleUpdate(sprint, text) {
  await postMessage(sprint.id, 'huddle', 'user', chatSafe(text), sprint.day_index);
  const ack = await agentSpeak(sprint, 'pm', HICCUP_INSTRUCTIONS.huddle_ack(text), 100);
  await postMessage(sprint.id, 'huddle', 'pm', chatSafe(ack), sprint.day_index);
  sprint.huddle_state = { ...(sprint.huddle_state || {}), userSpoke: true };
  await persistHuddleState(sprint);
  return { ack };
}

// ── cross-functional pings (design/marketing/sales reaching out to the PM) ─

async function maybeFireCrossFunctionalPing(sprint, dayIndex) {
  const roll = seededRoll(sprint.id + ':xfn:' + dayIndex);
  if (roll >= CROSS_FUNCTIONAL_PING_CHANCE) return;
  const who = CROSS_FUNCTIONAL_AGENTS[Math.floor(seededRoll(sprint.id + ':xfn:' + dayIndex + ':who') * CROSS_FUNCTIONAL_AGENTS.length)];
  const hasTicket = sprint.ticket_state && sprint.ticket_state.status;
  const ticket = hasTicket ? getActiveTicket(sprint) : null;
  const msg = await agentSpeak(sprint, who, HICCUP_INSTRUCTIONS.cross_functional_ping(who, ticket), 130);
  await postMessage(sprint.id, 'dm-' + who, who, chatSafe(msg), dayIndex);
}

// Main entry point — call once per work day (idempotent). Safe to call on
// every GET /api/workspace; it no-ops instantly once today's content exists.
async function ensureDayContent(sprint) {
  if (sprint.last_generated_day >= sprint.day_index) return sprint;
  const dayIndex = sprint.day_index;

  const hasTicket = sprint.ticket_state && sprint.ticket_state.status;
  if (!hasTicket) {
    await runOnboarding(sprint, dayIndex);
    await assignTicket(sprint, getTicket(sprint.track, 0), dayIndex, null);
  } else if (sprint.ticket_state.status === 'DONE') {
    await rotateToNextTicket(sprint, dayIndex);
  } else if (sprint.ticket_state.status !== 'BACKLOG') {
    // Ticket is genuinely in flight (accepted, in review, or sent back) —
    // this is the only case a hiccup can land on top of.
    await maybeFireHiccup(sprint, dayIndex);
  }

  // Company-wide texture fires on its own cadence, independent of whatever
  // branch ran above.
  if (dayIndex > 0 && dayIndex % COMPANY_UPDATE_INTERVAL === 0) {
    await maybeFireCompanyUpdate(sprint, dayIndex);
  }

  // Huddle and cross-functional pings are both independent of ticket
  // status — a huddle happens on its own weekly cadence, and design/
  // marketing/sales don't wait for a convenient moment to ping you, same
  // as a real job.
  if (isHuddleDay(dayIndex) && (!sprint.huddle_state || sprint.huddle_state.lastHuddleDay !== dayIndex)) {
    await runHuddle(sprint, dayIndex);
  }
  await maybeFireCrossFunctionalPing(sprint, dayIndex);

  sprint.last_generated_day = dayIndex;
  await persistTicketState(sprint);
  await query(`UPDATE sprints SET last_generated_day=$1, updated_at=now() WHERE id=$2`, [dayIndex, sprint.id]);
  return sprint;
}

// ── accept / submit (the sandbox actions) ────────────────────────────────

async function acceptTicket(sprint) {
  const ticket = getActiveTicket(sprint);
  sprint.ticket_state.status = 'IN_PROGRESS';
  sprint.ticket_state.accepted = true;
  await persistTicketState(sprint);
  await postMessage(sprint.id, channelForTicket(ticket), 'sys', `You accepted <b>${ticket.id}</b>.`, sprint.day_index);
  return sprint.ticket_state;
}

async function submitTicket(sprint, submissionText) {
  const ticket = getActiveTicket(sprint);
  const channel = channelForTicket(ticket);
  const st = sprint.ticket_state;
  st.submits += 1;
  st.lastSubmissionText = submissionText;

  await postMessage(sprint.id, channel, 'user', `Submitted <b>${ticket.id}</b> for review · revision ${st.revision}.`, sprint.day_index);

  const userTurn = `TICKET BRIEF:
${ticket.desc}

PIVOT STATUS: ${st.pivotFired ? 'A pivot has already fired on this ticket.' : 'No pivot has happened on this ticket.'}
REVISION: ${st.revision}
${st.priorFeedbackSummary ? 'PRIOR REVIEW FEEDBACK (revision ' + (st.revision - 1) + '):\n' + st.priorFeedbackSummary + '\n' : ''}
CANDIDATE'S ACTUAL SUBMISSION:
"""
${submissionText}
"""

Return your JSON verdict now.`;

  const history = sprint.review_history || [];
  history.push({ role: 'user', content: userTurn });
  // The reviewer gets the same career-memory digest as any other agent, so a
  // strict-but-fair reviewer can genuinely calibrate: more surgical feedback
  // for someone on a clean streak, extra clarity and patience for someone on
  // a rough patch — a real senior reviewer's judgment shifts with track
  // record, not just the rubric in front of them.
  const raw = await callModel(buildReviewSystem(ticket, buildMemoryDigest(getCareerMemory(sprint))), history, 800);
  history.push({ role: 'assistant', content: raw });
  await saveReviewHistory(sprint.id, history);
  sprint.review_history = history;

  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  let verdict;
  try {
    verdict = JSON.parse(cleaned);
  } catch (e) {
    const err = new Error('Reviewer returned malformed JSON');
    err.status = 502;
    err.raw = cleaned.slice(0, 500);
    throw err;
  }

  if (verdict.verdict === 'pass') {
    st.status = 'DONE';
  } else {
    st.status = 'QA_FAILED';
    st.priorFeedbackSummary = verdict.opening + ' ' + (verdict.flags || []).map(f => f.title + ': ' + f.detail).join(' ');
    st.revision += 1;
  }
  st.lastReview = verdict;
  await persistTicketState(sprint);

  const verdictHTML = renderVerdictHTML(ticket, verdict);
  await postMessage(sprint.id, channel, ticket.reviewer || 'tlead', verdictHTML, sprint.day_index);

  await notifyUser(
    sprint,
    verdict.verdict === 'pass'
      ? `Your submission for ${ticket.id} passed review — Kleos`
      : `Your submission for ${ticket.id} needs another pass — Kleos`,
    `${verdict.opening}\n\n${mailer.APP_URL}/index.html`
  );

  // A private, personal note from the manager (Yusra) — separate from the
  // technical review — landing in her DM rather than the ticket channel.
  // Best-effort: a failure here shouldn't fail the whole submission.
  try {
    const pulse = await agentSpeak(sprint, 'pm', HICCUP_INSTRUCTIONS.manager_pulse(ticket, verdict.verdict), 100);
    await postMessage(sprint.id, 'dm-pm', 'pm', chatSafe(pulse), sprint.day_index);
  } catch (e) { /* flavor only */ }

  // Update the running performance trend and fire any deterministic,
  // performance-triggered messages this verdict crosses (rough-patch
  // check-in, pairing offer, trust streak, milestone). Best-effort — never
  // let career-memory bookkeeping fail an otherwise-successful submission.
  try {
    await updateCareerMemory(sprint, ticket, verdict);
  } catch (e) { /* flavor only */ }

  return { verdict, channel };
}

// ── closing report (built once, when a run completes) ───────────────────

const SCORE_DIMENSIONS = ['technical', 'scope', 'communication', 'speed'];

// Aggregates every ticket's rubric scores (captured in completedLog by
// rotateToNextTicket) into per-dimension averages and one manager-voiced
// closing note. Called once from server.js right after a checkout completes
// a sprint (or lazily, the first time GET /api/sprint/report is hit for a
// sprint the auto-checkout sweep completed) and cached in sprints.closing_report
// so it never re-rolls between visits.
async function buildClosingReport(sprint) {
  const log = (sprint.ticket_state && sprint.ticket_state.completedLog) || [];

  const sums = {}; const counts = {};
  SCORE_DIMENSIONS.forEach(d => { sums[d] = 0; counts[d] = 0; });
  log.forEach(t => {
    if (!t.scores) return;
    SCORE_DIMENSIONS.forEach(d => {
      const s = t.scores[d];
      if (s && typeof s.score === 'number') { sums[d] += s.score; counts[d] += 1; }
    });
  });
  const averages = {};
  SCORE_DIMENSIONS.forEach(d => { averages[d] = counts[d] ? Math.round(sums[d] / counts[d]) : null; });
  const scoredDims = SCORE_DIMENSIONS.filter(d => averages[d] !== null);
  const overall = scoredDims.length
    ? Math.round(scoredDims.reduce((sum, d) => sum + averages[d], 0) / scoredDims.length)
    : null;

  let narrative = '<p>No tickets were completed this run, so there is nothing yet to close out.</p>';
  if (log.length) {
    const mem = getCareerMemory(sprint);
    const momentsLine = mem.moments.length
      ? `\nNotable moments across the run: ${mem.moments.map(m => `Day ${m.day + 1} — ${m.note}`).join('; ')}.`
      : '';
    const summary = `Tickets completed this run: ${log.map(t =>
      `${t.id} (${t.title}, ${t.revisions} revision${t.revisions > 1 ? 's' : ''}${t.pivotFired ? ', survived a pivot' : ''})`
    ).join('; ')}.
Average scores across the run — technical ${averages.technical ?? 'n/a'}, scope ${averages.scope ?? 'n/a'}, communication ${averages.communication ?? 'n/a'}, speed ${averages.speed ?? 'n/a'}.${momentsLine}`;
    try {
      const raw = await callModel(NARRATIVE_SYSTEM, [{ role: 'user', content: summary }], 500);
      narrative = sanitizeLimitedHtml(raw);
    } catch (e) {
      narrative = '<p>Closing note unavailable right now — your ticket history below still reflects everything you completed.</p>';
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalTickets: log.length,
    averages,
    overall,
    narrative,
    tickets: log
  };
}

module.exports = {
  ensureDayContent,
  getActiveTicket,
  channelForTicket,
  listChannels,
  dmChannels,
  getChannelMessages,
  markChannelRead,
  postUserMessage,
  acceptTicket,
  submitTicket,
  buildClosingReport,
  isHuddleDay,
  getHuddleForDay,
  recordHuddleUpdate,
  getCareerMemory,
  buildMemoryDigest
};
