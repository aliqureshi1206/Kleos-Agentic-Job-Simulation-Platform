// Unit-level test of the day-director engine (content.js) against a real
// (embedded, throwaway) Postgres instance, with agents.js's callModel
// mocked so this runs deterministically with no real Anthropic key.
// Run from inside the app directory (relative requires resolve there).
const assert = require('assert');

const agentsMod = require('./agents');
let forceReviewFail = false;
let fillerOverride = null;
const modelCalls = [];
agentsMod.callModel = async (system, messages) => {
  const lastMsg = (messages[messages.length - 1] || {}).content || '';
  modelCalls.push({ system: system.slice(0, 30), lastMsg: lastMsg.slice(0, 60) });
  if (/formally reviewing/.test(system)) {
    if (forceReviewFail) {
      return JSON.stringify({
        verdict: 'fail', opening: 'Not there yet — missing the basics.',
        flags: [
          { title: 'No baseline', detail: 'Metrics have no starting point.' },
          { title: 'Scope undefined', detail: 'No in/out-of-scope split.' },
          { title: 'No risk named', detail: 'Risk section is empty.' }
        ],
        scores: { technical: { score: 40, note: 'weak' }, scope: { score: 35, note: 'weak' }, communication: { score: 45, note: 'weak' }, speed: { score: 50, note: 'ok' } }
      });
    }
    return JSON.stringify({
      verdict: 'pass', opening: 'Solid — references the real numbers from the brief.',
      flags: [
        { title: 'Good scope cut', detail: 'Cut appropriately given the constraint.' },
        { title: 'Clear metrics', detail: 'Numbers with baselines included.' },
        { title: 'Risk named', detail: 'A specific, real risk was called out.' }
      ],
      scores: { technical: { score: 82, note: 'ok' }, scope: { score: 80, note: 'ok' }, communication: { score: 78, note: 'ok' }, speed: { score: 75, note: 'ok' } }
    });
  }
  if (/invent one more/i.test(lastMsg)) {
    if (fillerOverride) return fillerOverride;
    return JSON.stringify({
      id: 'QE-999', title: 'Mock filler ticket', desc: 'A generated filler ticket for testing.',
      brief: '<p>Mock brief.</p>', delivLabel: '<b>Deliverable — mock.</b> Mock deliverable.',
      rubric: ['Rubric bullet one', 'Rubric bullet two', 'Rubric bullet three', 'Rubric bullet four']
    });
  }
  return 'Mock in-character reply about: ' + lastMsg.slice(0, 40);
};

const mailerMod = require('./mailer');
const sentEmails = [];
mailerMod.sendMail = async (opts) => { sentEmails.push(opts); return { delivered: false, devLogged: true }; };

const { query, migrate } = require('./db');
const sprintLib = require('./sprint');
const content = require('./content');
const { TOTAL_TICKETS } = require('./tickets');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function forceAdvanceDay(sprint, userId) {
  const co = await sprintLib.checkOutSprint(userId, sprint.id);
  let s = co.sprint;
  s = await sprintLib.checkInSprint(userId, s.id);
  return content.ensureDayContent(s);
}

async function main() {
  await migrate();
  const email = 'contenttest+' + Date.now() + '@example.com';
  const uRes = await query(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [email]);
  const userId = uRes.rows[0].id;

  // 3m so there's enough work-day budget to burn through the whole ticket
  // bank plus a few filler tickets without hitting the day-budget ceiling.
  let sprint = await sprintLib.createSprint(userId, { track: 'pm', duration: '3m', paceMode: 'self_paced' });
  sprint = await sprintLib.checkInSprint(userId, sprint.id);

  // ── first day: ticket 0 gets assigned ──
  sprint = await content.ensureDayContent(sprint);
  ok('first ticket assigned is QE-402', content.getActiveTicket(sprint).id === 'QE-402', sprint.ticket_state);
  ok('fresh ticket starts BACKLOG', sprint.ticket_state.status === 'BACKLOG');

  const generalMsgs1 = await content.getChannelMessages(sprint.id, 'general');
  ok('onboarding posts a company-context message', generalMsgs1.some(m => m.author_key === 'sys' && /Welcome to/.test(m.body)), generalMsgs1);
  ok('onboarding welcome comes from the manager (pm)', generalMsgs1.some(m => m.author_key === 'pm'), generalMsgs1);
  ok('onboarding guidelines come from the eng lead (tlead)', generalMsgs1.some(m => m.author_key === 'tlead'), generalMsgs1);
  ok('onboarding intro comes from QA', generalMsgs1.some(m => m.author_key === 'qa'), generalMsgs1);
  ok('onboarding posts a pointer to the first ticket', generalMsgs1.some(m => m.author_key === 'sys' && /New ticket assigned/.test(m.body)), generalMsgs1);
  const ticketMsgs1 = await content.getChannelMessages(sprint.id, 'qe-402');
  ok('assignment message posted in the ticket channel', ticketMsgs1.length === 1 && ticketMsgs1[0].author_key === 'pm', ticketMsgs1);

  // ── idempotency: same day, no duplicate content ──
  sprint = await content.ensureDayContent(sprint);
  const ticketMsgs1b = await content.getChannelMessages(sprint.id, 'qe-402');
  ok('ensureDayContent is idempotent within the same day', ticketMsgs1b.length === ticketMsgs1.length);

  // ── accept + submit: fail path ──
  await content.acceptTicket(sprint);
  ok('accept sets IN_PROGRESS', sprint.ticket_state.status === 'IN_PROGRESS');

  forceReviewFail = true;
  let { verdict } = await content.submitTicket(sprint, 'A thin first draft.');
  ok('review fail sets QA_FAILED', sprint.ticket_state.status === 'QA_FAILED' && verdict.verdict === 'fail');
  ok('revision increments on fail', sprint.ticket_state.revision === 2);
  ok('prior feedback summary captured for next attempt', !!sprint.ticket_state.priorFeedbackSummary);

  ok('a failed review sends a "needs another pass" notification email', sentEmails.some(m => m.to === email && /needs another pass/.test(m.subject)), sentEmails);

  // ── resubmit: pass path ──
  forceReviewFail = false;
  ({ verdict } = await content.submitTicket(sprint, 'A much more complete revision with real metrics.'));
  ok('review pass sets DONE', sprint.ticket_state.status === 'DONE' && verdict.verdict === 'pass');
  ok('a passed review sends a "passed review" notification email', sentEmails.some(m => m.to === email && /passed review/.test(m.subject)), sentEmails);

  const ticketMsgsAfterReview = await content.getChannelMessages(sprint.id, 'qe-402');
  ok('verdict card posted into the ticket channel', ticketMsgsAfterReview.some(m => m.author_key === 'tlead' && /Rubric/.test(m.body)));

  const dmPmMsgs = await content.getChannelMessages(sprint.id, 'dm-pm');
  ok('manager sends a private pulse note after the ticket resolves', dmPmMsgs.some(m => m.author_key === 'pm'), dmPmMsgs);

  // ── next day: rotates to ticket 1 ──
  sprint = await forceAdvanceDay(sprint, userId);
  ok('rotates to QE-405 the next work day', content.getActiveTicket(sprint).id === 'QE-405', content.getActiveTicket(sprint));
  ok('completedLog records the finished ticket', (sprint.ticket_state.completedLog || []).some(t => t.id === 'QE-402'));

  // ── messaging: routing + unread tracking ──
  const r1 = await content.postUserMessage(sprint, 'general', 'quick check on scope');
  ok('general channel defaults to pm', r1.agentKey === 'pm');
  const r2 = await content.postUserMessage(sprint, 'general', 'omar keeps changing priorities on this');
  ok('keyword routing sends stakeholder questions to Omar', r2.agentKey === 'stake');
  const r3 = await content.postUserMessage(sprint, 'dm-qa', 'any flakiness today?');
  ok('DM channel routes unambiguously to that agent', r3.agentKey === 'qa');

  let channels = await content.listChannels(sprint);
  const general = channels.find(c => c.key === 'general');
  ok('general channel shows unread after an agent reply', general.unread === true, general);
  await content.markChannelRead(sprint, 'general');
  channels = await content.listChannels(sprint);
  ok('marking read clears the unread flag', channels.find(c => c.key === 'general').unread === false);

  const dms = content.dmChannels();
  ok('all ten teammates have a DM channel', dms.length === 10 && dms.some(d => d.key === 'dm-stake') && dms.some(d => d.key === 'dm-cto') && dms.some(d => d.key === 'dm-sales'));

  // ── burn through the whole bank to exercise rotation + filler generation ──
  // For each ticket: accept it and let it sit IN_PROGRESS for one work day
  // first (so maybeFireHiccup actually gets a chance to roll), *then*
  // fast-complete it and advance — instead of always fast-completing
  // same-day, which would never leave a ticket in-flight across a day
  // boundary and so could never trigger a hiccup.
  let sawHiccupMessage = false;
  for (let i = 0; i < TOTAL_TICKETS + 3; i++) {
    if (sprint.ticket_state.status === 'BACKLOG') await content.acceptTicket(sprint);
    sprint = await forceAdvanceDay(sprint, userId); // one day in-progress — hiccup may roll here
    const ticketChannel = content.channelForTicket(content.getActiveTicket(sprint));
    const incidentMsgs = await content.getChannelMessages(sprint.id, 'incidents');
    const ticketMsgs = await content.getChannelMessages(sprint.id, ticketChannel);
    if (incidentMsgs.length > 0 || ticketMsgs.some(m => m.author_key === 'stake')) sawHiccupMessage = true;

    sprint.ticket_state.status = 'DONE';
    await query(`UPDATE sprints SET ticket_state=$1 WHERE id=$2`, [JSON.stringify(sprint.ticket_state), sprint.id]);
    sprint = await forceAdvanceDay(sprint, userId); // rotates to the next ticket
  }
  ok(`ticket_idx advanced past the curated bank (${TOTAL_TICKETS} tickets)`, sprint.ticket_idx >= TOTAL_TICKETS, sprint.ticket_idx);
  ok('a filler ticket was generated once the bank was exhausted', !!sprint.ticket_state.customTicket && sprint.ticket_state.customTicket.id === 'QE-999', sprint.ticket_state.customTicket);
  ok('at least one hiccup fired somewhere across ~16 simulated work days', sawHiccupMessage);

  const generalMsgsFinal = await content.getChannelMessages(sprint.id, 'general');
  // One 'stake' message in #general already came from the earlier routing
  // test (the "omar keeps changing priorities" message) — more than that
  // means at least one company update fired during the ~33-day burn-through.
  ok('a company-wide update fired at some point in a 30+ day run', generalMsgsFinal.filter(m => m.author_key === 'stake').length > 1, generalMsgsFinal.filter(m => m.author_key === 'stake').length);

  // The three tests below each need precise control over ticket_idx (which
  // filler index gets generated next) — set it explicitly via direct SQL
  // rather than relying on the accumulated count from everything run so
  // far. Deliberately NOT touching day_index here: ensureDayContent no-ops
  // if day_index doesn't move past last_generated_day, so day advancement
  // has to keep coming from the normal checkout/checkin cycle in
  // forceAdvanceDay, same as everywhere else in this file.

  // ── filler ticket hardening: validation rejects a bad response ──
  await query(`UPDATE sprints SET ticket_idx=$1 WHERE id=$2`, [TOTAL_TICKETS, sprint.id]); // next rotate -> index 1, under the cap
  fillerOverride = JSON.stringify({
    id: 'QE-BAD', title: 'Ok title', desc: 'Ok desc',
    brief: '<p>fine</p>', delivLabel: '<b>Deliverable.</b> ok',
    rubric: ['only one'] // fewer than 3 — should fail validation
  });
  sprint.ticket_state.status = 'DONE';
  await query(`UPDATE sprints SET ticket_state=$1 WHERE id=$2`, [JSON.stringify(sprint.ticket_state), sprint.id]);
  sprint = await forceAdvanceDay(sprint, userId);
  ok('a filler ticket failing validation (too few rubric items) falls back to the safety-net ticket, not the bad id',
    content.getActiveTicket(sprint).id !== 'QE-BAD', content.getActiveTicket(sprint));

  // ── filler ticket hardening: a structurally-valid response still gets its HTML sanitized ──
  await query(`UPDATE sprints SET ticket_idx=$1 WHERE id=$2`, [TOTAL_TICKETS + 2, sprint.id]); // next rotate -> index 3, under the cap
  fillerOverride = JSON.stringify({
    id: 'QE-SAFE', title: 'Ok title', desc: 'Ok desc',
    brief: '<script>alert(1)</script><p>Real content here.</p><img src=x onerror=alert(1)>',
    delivLabel: '<b onclick="alert(1)">Deliverable — safe.</b> ok',
    rubric: ['one', 'two', 'three', 'four']
  });
  sprint.ticket_state.status = 'DONE';
  await query(`UPDATE sprints SET ticket_state=$1 WHERE id=$2`, [JSON.stringify(sprint.ticket_state), sprint.id]);
  sprint = await forceAdvanceDay(sprint, userId);
  const safeTicket = content.getActiveTicket(sprint);
  ok('a valid filler ticket keeps its content but strips disallowed HTML tags',
    safeTicket.id === 'QE-SAFE'
    && !/<script|<img|onclick/i.test(safeTicket.brief + safeTicket.delivLabel)
    && /<p>Real content here\.<\/p>/.test(safeTicket.brief)
    && /<b>Deliverable — safe\.<\/b>/.test(safeTicket.delivLabel),
    safeTicket);
  fillerOverride = null;

  // ── filler ticket hardening: beyond the per-sprint AI cap, no model call is made at all ──
  await query(`UPDATE sprints SET ticket_idx=$1 WHERE id=$2`, [TOTAL_TICKETS + 10, sprint.id]); // next rotate -> index 11, past MAX_AI_FILLERS_PER_SPRINT (6)
  sprint.ticket_state.status = 'DONE';
  await query(`UPDATE sprints SET ticket_state=$1 WHERE id=$2`, [JSON.stringify(sprint.ticket_state), sprint.id]);
  sprint = await forceAdvanceDay(sprint, userId);
  ok('beyond the AI-filler cap, an evergreen filler ticket is used instead of calling the model',
    /^QE-EVG/.test(content.getActiveTicket(sprint).id), content.getActiveTicket(sprint));

  // ── closing report: aggregation math ──
  const fakeSprintWithScores = {
    ticket_state: {
      completedLog: [
        { id: 'A1', title: 'Ticket A', revisions: 1, pivotFired: false,
          scores: { technical: { score: 80 }, scope: { score: 70 }, communication: { score: 90 }, speed: { score: 60 } } },
        { id: 'A2', title: 'Ticket B', revisions: 2, pivotFired: true,
          scores: { technical: { score: 60 }, scope: { score: 90 }, communication: { score: 70 }, speed: { score: 80 } } }
      ]
    }
  };
  const closing = await content.buildClosingReport(fakeSprintWithScores);
  ok('closing report averages each score dimension across completed tickets',
    closing.averages.technical === 70 && closing.averages.scope === 80 && closing.averages.communication === 80 && closing.averages.speed === 70,
    closing.averages);
  ok('closing report overall is the mean of the dimension averages', closing.overall === 75, closing);
  ok('closing report includes a narrative when tickets were completed', typeof closing.narrative === 'string' && closing.narrative.length > 0, closing.narrative);
  ok('closing report totalTickets matches the completed log length', closing.totalTickets === 2);

  const emptyClosing = await content.buildClosingReport({ ticket_state: { completedLog: [] } });
  ok('closing report on an empty run has a null overall and a placeholder narrative',
    emptyClosing.overall === null && /nothing yet to close out/.test(emptyClosing.narrative), emptyClosing);

  // ── daily huddle + cross-functional pings (isolated fresh sprint) ──
  {
    const email3 = 'huddletest+' + Date.now() + '@example.com';
    const uRes3 = await query(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [email3]);
    const userId3 = uRes3.rows[0].id;
    let hSprint = await sprintLib.createSprint(userId3, { track: 'pm', duration: '3m', paceMode: 'self_paced' });
    hSprint = await sprintLib.checkInSprint(userId3, hSprint.id);
    hSprint = await content.ensureDayContent(hSprint); // day 0 — always a huddle day (Mon-equivalent)

    ok('days 0/2/4 are huddle days (Mon/Wed/Fri-equivalent)', content.isHuddleDay(0) && content.isHuddleDay(2) && content.isHuddleDay(4));
    ok('days 1/3 are not huddle days (Tue/Thu-equivalent)', !content.isHuddleDay(1) && !content.isHuddleDay(3));

    const huddle0 = await content.getHuddleForDay(hSprint, 0);
    ok('huddle runs automatically on day 0', huddle0.ranToday === true, huddle0);
    ok('a "huddle is ready" notification email went out when the huddle started', sentEmails.some(m => m.to === email3 && /huddle is ready/.test(m.subject)), sentEmails);
    ok('huddle always includes the manager and eng lead', huddle0.attendees.includes('pm') && huddle0.attendees.includes('tlead'), huddle0.attendees);
    ok('huddle includes 2-3 rotating guests beyond the core two', huddle0.attendees.length >= 4 && huddle0.attendees.length <= 5, huddle0.attendees);
    ok('huddle transcript has one line per attendee plus a system announcement', huddle0.lines.length === huddle0.attendees.length + 1, huddle0.lines);
    ok('the user has not spoken yet', huddle0.userSpoke === false);

    const rec = await content.recordHuddleUpdate(hSprint, 'Shipped the PRD revisions, no blockers today.');
    ok('recording a huddle update returns a facilitator ack', typeof rec.ack === 'string' && rec.ack.length > 0, rec);

    const huddle0After = await content.getHuddleForDay(hSprint, 0);
    ok('huddle_state marks the user as having spoken', huddle0After.userSpoke === true, huddle0After);
    ok("the user's update and a facilitator ack both land in the transcript",
      huddle0After.lines.some(l => l.agentKey === 'user') && huddle0After.lines.filter(l => l.agentKey === 'pm').length >= 2, huddle0After.lines);

    // Re-running the same day must not duplicate content (shares the
    // existing last_generated_day guard with tickets/hiccups/company updates).
    const linesBeforeNoop = huddle0After.lines.length;
    hSprint = await content.ensureDayContent(hSprint);
    const huddle0Noop = await content.getHuddleForDay(hSprint, 0);
    ok('re-running ensureDayContent the same day does not duplicate huddle content', huddle0Noop.lines.length === linesBeforeNoop);

    // Advance to day 1 (not a huddle day), then day 2 (a huddle day) — a
    // fresh huddle should run with userSpoke reset to false.
    hSprint = await forceAdvanceDay(hSprint, userId3); // -> day 1
    const huddle1 = await content.getHuddleForDay(hSprint, 1);
    ok('day 1 does not get a new huddle', huddle1.ranToday === false, huddle1);

    hSprint = await forceAdvanceDay(hSprint, userId3); // -> day 2
    const huddle2 = await content.getHuddleForDay(hSprint, 2);
    ok('day 2 gets a fresh huddle with a reset userSpoke flag', huddle2.ranToday === true && huddle2.userSpoke === false, huddle2);
    ok('missedCount stays 0 after day 0 was answered before day 2\'s huddle started', huddle2.missedCount === 0, huddle2);

    // Skip day 2's update entirely, advance past day 3 (not a huddle day) to
    // day 4 (a huddle day) — day 2 should now count as a missed huddle.
    // Also turn notify_email off for this user right before day 4's huddle,
    // to confirm the preference actually suppresses the notification.
    await query(`UPDATE users SET notify_email=false WHERE id=$1`, [userId3]);
    const emailCountBeforeDay4 = sentEmails.filter(m => m.to === email3).length;
    hSprint = await forceAdvanceDay(hSprint, userId3); // -> day 3
    hSprint = await forceAdvanceDay(hSprint, userId3); // -> day 4
    const huddle4 = await content.getHuddleForDay(hSprint, 4);
    ok('skipping a huddle update increments the missed-huddle count on the next huddle', huddle4.missedCount === 1, huddle4);
    ok('notify_email=false suppresses the huddle-ready email', sentEmails.filter(m => m.to === email3).length === emailCountBeforeDay4, sentEmails);

    // Cross-functional pings are a 25%/day independent roll — scan forward
    // far enough that seeing zero pings would be a red flag, not bad luck
    // (0.75^23 ≈ 0.1% chance of a false failure here).
    const xfnChannels = ['dm-design', 'dm-marketing', 'dm-sales'];
    async function anyCrossFunctionalPingSoFar() {
      for (const ch of xfnChannels) {
        const msgs = await content.getChannelMessages(hSprint.id, ch);
        if (msgs.length > 0) return true;
      }
      return false;
    }
    let sawPing = await anyCrossFunctionalPingSoFar();
    for (let i = 0; i < 20 && !sawPing; i++) {
      hSprint = await forceAdvanceDay(hSprint, userId3);
      sawPing = await anyCrossFunctionalPingSoFar();
    }
    ok('a cross-functional ping (design/marketing/sales) fires within a reasonable number of days', sawPing);
  }

  // ── auto-checkout sweep: force-closes a sprint left checked in too long ──
  {
    const email2 = 'autocheckout+' + Date.now() + '@example.com';
    const uRes2 = await query(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [email2]);
    const userId2 = uRes2.rows[0].id;
    let staleSprint = await sprintLib.createSprint(userId2, { track: 'pm', duration: '1m', paceMode: 'self_paced' });
    staleSprint = await sprintLib.checkInSprint(userId2, staleSprint.id);

    // Backdate checked_in_at well past AUTO_CHECKOUT_AFTER_SECONDS so the
    // sweep treats it as abandoned, exactly like a closed laptop would.
    const ninehoursAgo = new Date(Date.now() - 9 * 60 * 60 * 1000);
    await query(`UPDATE sprints SET checked_in_at=$1 WHERE id=$2`, [ninehoursAgo, staleSprint.id]);

    const closed = await sprintLib.autoCheckoutStale();
    const closedThisOne = closed.find(c => c.sprint.id === staleSprint.id);
    ok('auto-checkout sweep force-closes a sprint checked in past the threshold', !!closedThisOne, closed.map(c => c.sprint.id));
    ok('auto-checkout sweep advances day_index like a normal checkout', closedThisOne && closedThisOne.sprint.day_index === 1, closedThisOne && closedThisOne.sprint);
    ok('auto-checkout sweep clears checked_in_at', closedThisOne && closedThisOne.sprint.checked_in_at === null, closedThisOne && closedThisOne.sprint);

    const logRow = await query(`SELECT auto_checkout, seconds_used FROM day_logs WHERE sprint_id=$1 AND day_index=0`, [staleSprint.id]);
    ok('day_logs marks the auto-closed day as auto_checkout=true', logRow.rows[0] && logRow.rows[0].auto_checkout === true, logRow.rows[0]);

    // A sprint checked in recently shouldn't be touched by the sweep.
    let freshSprint = await sprintLib.createSprint(userId2, { track: 'pm', duration: '1m', paceMode: 'self_paced' }).catch(() => null);
    // createSprint is idempotent per-user-while-active; staleSprint is now checked out
    // (status still 'active', day_index 1), so this returns the same sprint rather
    // than creating a second one — check it back in to test the "not stale" branch.
    freshSprint = await sprintLib.checkInSprint(userId2, staleSprint.id);
    const closedAgain = await sprintLib.autoCheckoutStale();
    ok('auto-checkout sweep leaves a recently-checked-in sprint alone', !closedAgain.find(c => c.sprint.id === freshSprint.id), closedAgain.map(c => c.sprint.id));
  }

  // ── design and frontend tracks (isolated fresh sprints per track) ──
  {
    const trackCases = [
      { track: 'design', firstTicket: 'QD-401', reviewerName: 'Emma Sullivan', reviewerKey: 'design', title: 'Product Designer' },
      { track: 'fe', firstTicket: 'QF-401', reviewerName: 'Daniyal Rehman', reviewerKey: 'tlead', title: 'Frontend Engineer' }
    ];
    for (const tc of trackCases) {
      const emailT = tc.track + 'test+' + Date.now() + '@example.com';
      const uResT = await query(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [emailT]);
      const userIdT = uResT.rows[0].id;
      let tSprint = await sprintLib.createSprint(userIdT, { track: tc.track, duration: '2w', paceMode: 'self_paced' });
      tSprint = await sprintLib.checkInSprint(userIdT, tSprint.id);
      tSprint = await content.ensureDayContent(tSprint);

      ok(`${tc.track} track assigns its own first ticket (${tc.firstTicket})`, content.getActiveTicket(tSprint).id === tc.firstTicket, content.getActiveTicket(tSprint));

      const onboardingMsgs = await content.getChannelMessages(tSprint.id, 'general');
      const contextMsg = onboardingMsgs.find(m => m.author_key === 'sys' && /Welcome to/.test(m.body));
      ok(`${tc.track} track onboarding names the right role title`, !!contextMsg && contextMsg.body.includes(tc.title), contextMsg);

      await content.acceptTicket(tSprint);
      const { verdict } = await content.submitTicket(tSprint, 'A reasonably complete first draft.');
      const ticketChannel = content.channelForTicket(content.getActiveTicket(tSprint));
      const verdictMsgs = await content.getChannelMessages(tSprint.id, ticketChannel);
      ok(`${tc.track} track ticket is formally reviewed by the right person`, verdictMsgs.some(m => m.author_key === tc.reviewerKey && /Rubric/.test(m.body)), verdictMsgs);
      ok(`${tc.track} track review verdict came back well-formed`, verdict && (verdict.verdict === 'pass' || verdict.verdict === 'fail'), verdict);
    }
  }

  // ── career memory: performance-triggered dynamic behaviors ──
  // Isolated fresh sprint so exact message counts stay deterministic and
  // don't get tangled up with the bank-burn-through loop above.
  {
    const email5 = 'career+' + Date.now() + '@example.com';
    const uRes5 = await query(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [email5]);
    const userId5 = uRes5.rows[0].id;
    let cSprint = await sprintLib.createSprint(userId5, { track: 'pm', duration: '3m', paceMode: 'self_paced' });
    cSprint = await sprintLib.checkInSprint(userId5, cSprint.id);
    cSprint = await content.ensureDayContent(cSprint);

    ok('career memory starts with nothing completed', content.getCareerMemory(cSprint).performance.totalCompleted === 0);
    ok('memory digest is blank text with no track record yet', content.buildMemoryDigest(content.getCareerMemory(cSprint)) === '');

    // First ticket: fail, fail, pass — should trigger a manager check-in
    // after the 2nd fail in a row, a teammate's pairing offer once this
    // specific ticket needs a 3rd attempt, and a "hard-won pass" moment
    // once it finally lands.
    await content.acceptTicket(cSprint);
    const firstChannel = content.channelForTicket(content.getActiveTicket(cSprint));

    forceReviewFail = true;
    await content.submitTicket(cSprint, 'weak first draft');
    let dmPm = await content.getChannelMessages(cSprint.id, 'dm-pm');
    ok('a single fail gets only the usual pulse note, no proactive check-in yet', dmPm.length === 1, dmPm);

    await content.submitTicket(cSprint, 'still-thin second draft');
    dmPm = await content.getChannelMessages(cSprint.id, 'dm-pm');
    ok('manager proactively checks in once a rough patch hits 2 fails in a row', dmPm.length === 3, dmPm);

    let ticketMsgs = await content.getChannelMessages(cSprint.id, firstChannel);
    let tleadMsgs = ticketMsgs.filter(m => m.author_key === 'tlead');
    ok('a teammate offers to pair once this ticket needs a 3rd attempt',
      tleadMsgs.length === 3 && tleadMsgs.filter(m => /Rubric/.test(m.body)).length === 2,
      tleadMsgs);

    forceReviewFail = false;
    const { verdict: v1 } = await content.submitTicket(cSprint, 'a much stronger revision with real specifics');
    ok('the third attempt finally passes', v1.verdict === 'pass', v1);
    dmPm = await content.getChannelMessages(cSprint.id, 'dm-pm');
    ok('a normal pulse note still follows the eventual pass', dmPm.length === 4, dmPm);

    let mem = content.getCareerMemory(cSprint);
    ok('career memory counts the ticket as completed once it passes', mem.performance.totalCompleted === 1, mem);
    ok('fail streak resets to 0 after a pass', mem.performance.failStreak === 0, mem);
    ok('a hard-won-pass moment is recorded for a 3-attempt ticket', mem.moments.some(m => /Hard-won pass/.test(m.note)), mem.moments);
    ok('the pairing-offer flag clears once the ticket actually passes', mem.pairingOfferedFor === null, mem);
    ok('the memory digest now reflects one completed ticket', /1 ticket completed/.test(content.buildMemoryDigest(mem)), content.buildMemoryDigest(mem));

    // Four more clean passes in a row: the 3rd consecutive pass (ticket 3
    // overall) should trigger a private "I trust you more now" note, and the
    // 5th completed ticket overall should trigger a public #general
    // milestone shout-out — each firing exactly once, not on every pass.
    for (let i = 0; i < 4; i++) {
      cSprint = await forceAdvanceDay(cSprint, userId5);
      await content.acceptTicket(cSprint);
      await content.submitTicket(cSprint, 'a solid, complete submission with real specifics and a clear plan');
    }

    mem = content.getCareerMemory(cSprint);
    ok('five tickets completed after four more clean passes', mem.performance.totalCompleted === 5, mem);
    ok('pass streak reflects five passes with no intervening fails', mem.performance.passStreak === 5, mem);

    dmPm = await content.getChannelMessages(cSprint.id, 'dm-pm');
    ok('a trust-streak DM fires once on top of the usual pulse notes (9 total: 4 pulses+2 events for ticket 1, 4 pulses+1 trust note after)',
      dmPm.length === 9, dmPm.length);

    const generalMsgs = await content.getChannelMessages(cSprint.id, 'general');
    const pmGeneralMsgs = generalMsgs.filter(m => m.author_key === 'pm');
    ok('a public milestone shout-out posts to #general once 5 tickets are completed',
      pmGeneralMsgs.length === 2, pmGeneralMsgs);

    // Reviewer prompts also fold in the same digest, so a strict-but-fair
    // reviewer's framing can reflect the track record without touching the
    // rubric itself.
    const reviewSystem = agentsMod.buildReviewSystem(content.getActiveTicket(cSprint), content.buildMemoryDigest(mem));
    ok('the reviewer system prompt includes the career-memory digest', /CONTEXT ON THIS TEAMMATE/.test(reviewSystem), reviewSystem.slice(-400));
  }

  // ── holiday calendar (calendar pace mode) ──
  {
    const email4 = 'holiday+' + Date.now() + '@example.com';
    const uRes4 = await query(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [email4]);
    const userId4 = uRes4.rows[0].id;

    // Pick the next Wednesday (never a weekend) so this is deterministic
    // regardless of what day the test suite happens to run on.
    const d = new Date();
    while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
    const wednesday = d.toISOString().slice(0, 10);
    const prevEnv = process.env.KLEOS_HOLIDAYS;

    process.env.KLEOS_HOLIDAYS = '';
    ok('with no holiday calendar set, an ordinary Wednesday is not a holiday', sprintLib.isHoliday(d) === false, wednesday);

    process.env.KLEOS_HOLIDAYS = wednesday;
    ok('a date listed in KLEOS_HOLIDAYS is treated as a holiday', sprintLib.isHoliday(d) === true, wednesday);

    let holidaySprint = await sprintLib.createSprint(userId4, { track: 'pm', duration: '2w', paceMode: 'calendar' });
    // Force the eligibility check to evaluate "today" as our holiday date.
    const elig = sprintLib.checkInEligibility(holidaySprint, d);
    ok('calendar-mode check-in is blocked on a configured holiday', elig.eligible === false && elig.reason === 'holiday', elig);
    ok('the holiday message points at the next real business day', !!elig.nextAvailable, elig);

    process.env.KLEOS_HOLIDAYS = prevEnv || '';
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`(${modelCalls.length} mocked model calls made)`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('CONTENT TEST CRASHED', e); process.exit(1); });
