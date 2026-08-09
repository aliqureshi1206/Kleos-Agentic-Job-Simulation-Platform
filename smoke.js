// Smoke test harness — exercises the real HTTP API against a real
// (embedded, throwaway) Postgres instance. Not a permanent part of the app;
// lives only in the verification sandbox.
const { Pool } = require('pg');
const BASE = process.env.BASE_URL || 'http://localhost:3400';
const dbPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

// Test-only helper: real users verify via the emailed link; here we just
// read the token straight out of the database (no email transport in this
// sandbox) and hit the same verify endpoint a real click would hit.
async function verifyEmailDirectly(email) {
  const r = await dbPool.query('SELECT verify_token FROM users WHERE email=$1', [email]);
  const token = r.rows[0] && r.rows[0].verify_token;
  if (!token) throw new Error('No verify_token found for ' + email);
  const res = await fetch(BASE + '/api/auth/verify?token=' + encodeURIComponent(token), { redirect: 'manual' });
  return res.status; // expect a 302 redirect on success
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// A double-submit CSRF cookie (kleos.csrf) is set on every response — real
// browsers echo it back as an X-CSRF-Token header from JS reading the
// cookie. This jar does the same thing a browser would: track every cookie
// the server sets, and mirror kleos.csrf into the header on mutating verbs.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function makeJar() {
  let cookies = {};
  function cookieHeader() {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  const jar = {
    async req(method, path, body) {
      // A real browser always has the kleos.csrf cookie by the time it
      // submits a form — it was set on the very first page load. A jar
      // whose first-ever request happens to be a POST has nothing to echo
      // back yet, so prime it with a harmless GET first, exactly like
      // landing on any page would.
      if (MUTATING.has(method) && !cookies['kleos.csrf']) {
        await jar.req('GET', '/api/health');
      }
      const headers = { 'Content-Type': 'application/json' };
      const ch = cookieHeader();
      if (ch) headers['Cookie'] = ch;
      if (cookies['kleos.csrf'] && MUTATING.has(method)) headers['X-CSRF-Token'] = cookies['kleos.csrf'];
      const res = await fetch(BASE + path, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const setCookies = res.headers.getSetCookie
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
      for (const sc of setCookies) {
        const first = sc.split(';')[0];
        const eq = first.indexOf('=');
        if (eq === -1) continue;
        cookies[first.slice(0, eq).trim()] = first.slice(eq + 1);
      }
      let data = {};
      try { data = await res.json(); } catch (e) {}
      return { status: res.status, data };
    },
    csrfToken() { return cookies['kleos.csrf'] || null; }
  };
  return jar;
}

async function main() {
  const u1 = makeJar();
  const u2 = makeJar();
  const email1 = 'alice+' + Date.now() + '@example.com';
  const email2 = 'bob+' + Date.now() + '@example.com';

  // ── health ──
  {
    const r = await fetch(BASE + '/api/health');
    const d = await r.json();
    ok('health check reports db ok', r.ok && d.db === true, d);
  }

  // ── CSRF ──
  {
    const primed = await u1.req('GET', '/api/auth/me'); // picks up the kleos.csrf cookie
    ok('csrf cookie is set on a plain GET', !!u1.csrfToken(), primed);
    const noHeader = await fetch(BASE + '/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'kleos.csrf=' + u1.csrfToken() },
      body: JSON.stringify({ email: 'nope+' + Date.now() + '@example.com', password: 'a-real-password-123' })
    });
    ok('POST without an X-CSRF-Token header is rejected (403)', noHeader.status === 403, noHeader.status);
    const wrongHeader = await fetch(BASE + '/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'kleos.csrf=' + u1.csrfToken(), 'X-CSRF-Token': 'not-the-right-token' },
      body: JSON.stringify({ email: 'nope2+' + Date.now() + '@example.com', password: 'a-real-password-123' })
    });
    ok('POST with a mismatched X-CSRF-Token header is rejected (403)', wrongHeader.status === 403, wrongHeader.status);
  }

  // ── auth: not logged in ──
  {
    const r = await u1.req('GET', '/api/auth/me');
    ok('me() with no session returns user:null', r.status === 200 && r.data.user === null, r);
  }
  {
    const r = await u1.req('GET', '/api/sprint/current');
    ok('sprint/current requires auth (401)', r.status === 401, r);
  }

  // ── signup validation ──
  {
    const r = await u1.req('POST', '/api/auth/signup', { email: 'not-an-email', password: 'a-real-password-123' });
    ok('signup rejects a malformed email (400)', r.status === 400, r);
  }
  {
    const r = await u1.req('POST', '/api/auth/signup', { email: email1, password: 'short' });
    ok('signup rejects short password', r.status === 400, r);
  }
  {
    const r = await u1.req('POST', '/api/auth/signup', { email: email1, password: 'a-real-password-123' });
    ok('signup succeeds with valid creds', r.status === 200 && r.data.user && r.data.user.email === email1, r);
  }
  {
    const r = await u1.req('POST', '/api/auth/signup', { email: email1, password: 'a-real-password-123' });
    ok('signup rejects duplicate email', r.status === 409, r);
  }
  {
    const r = await u1.req('GET', '/api/auth/me');
    ok('me() reflects logged-in user after signup', r.status === 200 && r.data.user && r.data.user.email === email1, r);
    ok('new account starts unverified', r.data.user.emailVerified === false, r.data.user);
  }
  {
    const blocked = await u1.req('POST', '/api/sprint', { track: 'pm', duration: '2w', paceMode: 'self_paced' });
    ok('starting a job is blocked until email is verified (403)', blocked.status === 403, blocked);
  }
  let verify1Token;
  {
    const r = await dbPool.query('SELECT verify_token FROM users WHERE email=$1', [email1]);
    verify1Token = r.rows[0].verify_token;
    const status = await verifyEmailDirectly(email1);
    ok('clicking the verify link redirects (302)', status === 302, status);
    const me = await u1.req('GET', '/api/auth/me');
    ok('account shows verified after clicking the link', me.data.user.emailVerified === true, me.data);
  }
  {
    // Same token, clicked again — should be told apart from a genuinely
    // invalid/expired link rather than both looking like "expired."
    const res = await fetch(BASE + '/api/auth/verify?token=' + encodeURIComponent(verify1Token), { redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    ok('re-clicking an already-used verify link says "already", not "expired"', res.status === 302 && /verify=already/.test(loc), loc);
  }
  {
    const res = await fetch(BASE + '/api/auth/verify?token=totally-made-up-token', { redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    ok('a bogus verify token says "expired"', res.status === 302 && /verify=expired/.test(loc), loc);
  }

  // ── login flow (separate jar, same account) ──
  {
    const jar = makeJar();
    const bad = await jar.req('POST', '/api/auth/login', { email: email1, password: 'wrong-password' });
    ok('login rejects wrong password', bad.status === 401, bad);
    const good = await jar.req('POST', '/api/auth/login', { email: email1, password: 'a-real-password-123' });
    ok('login succeeds with right password', good.status === 200, good);
  }

  // ── sprint lifecycle: self-paced ──
  {
    const r = await u1.req('GET', '/api/sprint/current');
    ok('no sprint yet', r.status === 200 && r.data.sprint === null, r);
  }
  {
    const r = await u1.req('POST', '/api/sprint', { track: 'qa', duration: '2w', paceMode: 'self_paced' });
    ok('creating a non-live track is rejected', r.status === 400, r);
  }
  {
    const r = await u1.req('POST', '/api/sprint', { track: 'pm', duration: '2w', paceMode: 'self_paced' });
    ok('sprint created for pm/2w/self_paced', r.status === 200 && r.data.sprint.total_work_days === 10, r.data);
  }
  {
    const r = await u1.req('POST', '/api/sprint', { track: 'pm', duration: '1m', paceMode: 'calendar' });
    ok('creating a 2nd sprint while one is active is idempotent (returns existing)', r.status === 200 && r.data.sprint.duration === '2w', r.data);
  }
  {
    const r = await u1.req('GET', '/api/workspace');
    ok('workspace blocked before check-in (403)', r.status === 403, r);
  }
  {
    const r = await u1.req('POST', '/api/sprint/checkin', {});
    ok('check-in succeeds', r.status === 200 && r.data.status.checkedIn === true, r.data);
    ok('day budget is 4 hours', r.data.status.remainingSeconds > 14390 && r.data.status.remainingSeconds <= 14400, r.data.status);
  }
  {
    const r = await u1.req('POST', '/api/sprint/checkin', {});
    ok('double check-in rejected (409)', r.status === 409, r);
  }
  {
    const r = await u1.req('POST', '/api/messages/dm-nope', { text: 'hi' });
    ok('messaging an unknown teammate is rejected (400) once checked in', r.status === 400, r);
  }
  {
    const r = await u1.req('POST', '/api/messages/general', { text: 'x'.repeat(6001) });
    ok('an oversized chat message is rejected (400) rather than sent to the model', r.status === 400, r);
  }
  {
    // The real Anthropic call fails against the fake key in this sandbox,
    // so ensureDayContent never gets to populate ticket_state — exactly the
    // "workspace not loaded yet" case these routes should fail cleanly on
    // (400) instead of crashing with a raw 500 from a null dereference.
    const accept = await u1.req('POST', '/api/ticket/accept', {});
    ok('accepting a ticket before the workspace has ever loaded fails cleanly (400, not 500)', accept.status === 400, accept);
    const submit = await u1.req('POST', '/api/ticket/submit', { text: 'anything' });
    ok('submitting a ticket before the workspace has ever loaded fails cleanly (400, not 500)', submit.status === 400, submit);
  }
  {
    // Real Anthropic call will fail against a fake key in this sandbox —
    // what matters is that auth+check-in gating let the request all the way
    // through to the content engine (which calls the model to assign the
    // first ticket) instead of stopping it, and it failed cleanly rather
    // than crashing the process. content_test.js covers the actual content
    // logic with a mocked model instead.
    const r = await u1.req('GET', '/api/workspace');
    ok('workspace reaches the content engine once checked in (not a 401/403)', r.status !== 401 && r.status !== 403, r);
  }
  {
    const r = await u1.req('GET', '/api/messages/general');
    ok('reading channel history does not require the model (pure DB read)', r.status === 200 && Array.isArray(r.data.messages), r.data);
  }
  {
    const r = await u1.req('POST', '/api/sprint/checkout', {});
    ok('check-out succeeds and advances day_index to 1', r.status === 200 && r.data.sprint.day_index === 1, r.data);
  }
  {
    const r = await u1.req('GET', '/api/workspace');
    ok('workspace blocked again after check-out (403)', r.status === 403, r);
  }
  {
    const r = await u1.req('POST', '/api/sprint/checkin', {});
    ok('self-paced mode allows immediate re-check-in for next day', r.status === 200 && r.data.status.dayIndex === 1, r.data);
  }
  {
    const r = await u1.req('POST', '/api/sprint/checkout', {});
    ok('second check-out advances to day_index 2', r.status === 200 && r.data.sprint.day_index === 2, r.data);
  }

  // ── sprint lifecycle: calendar pace gating ──
  {
    await u2.req('POST', '/api/auth/signup', { email: email2, password: 'a-real-password-123' });
    await verifyEmailDirectly(email2);
    const created = await u2.req('POST', '/api/sprint', { track: 'pm', duration: '2w', paceMode: 'calendar' });
    ok('calendar-mode sprint created', created.status === 200, created.data);
    const day = new Date().getUTCDay();
    const isWeekend = day === 0 || day === 6;
    const checkin1 = await u2.req('POST', '/api/sprint/checkin', {});
    if (isWeekend) {
      ok('calendar check-in blocked on a weekend', checkin1.status === 409 && checkin1.data.error && /weekend/i.test(checkin1.data.error), checkin1.data);
    } else {
      ok('calendar check-in allowed on a business day', checkin1.status === 200, checkin1.data);
      const checkout1 = await u2.req('POST', '/api/sprint/checkout', {});
      ok('calendar check-out advances a day', checkout1.status === 200 && checkout1.data.sprint.day_index === 1, checkout1.data);
      const checkin2 = await u2.req('POST', '/api/sprint/checkin', {});
      ok('calendar mode blocks a second check-in the same real day', checkin2.status === 409 && /already worked today|already_worked_today/i.test(JSON.stringify(checkin2.data)), checkin2.data);
    }
  }

  // ── logout ──
  {
    const r = await u1.req('POST', '/api/auth/logout', {});
    ok('logout succeeds', r.status === 200, r);
    const after = await u1.req('GET', '/api/sprint/current');
    ok('session is actually invalidated after logout', after.status === 401, after);
  }

  // ── password reset ──
  {
    const r = await u1.req('POST', '/api/auth/request-reset', { email: 'nobody-registered@example.com' });
    ok('reset request for an unknown email still returns ok (no enumeration)', r.status === 200 && r.data.ok === true, r);
  }
  {
    await u1.req('POST', '/api/auth/request-reset', { email: email1 });
    const tokenRes = await dbPool.query('SELECT reset_token FROM users WHERE email=$1', [email1]);
    const resetToken = tokenRes.rows[0].reset_token;
    ok('reset request generates a token', !!resetToken);

    const badReset = await u1.req('POST', '/api/auth/reset-password', { token: 'not-a-real-token', password: 'irrelevant-but-8-chars' });
    ok('reset rejects an invalid token', badReset.status === 400, badReset);

    const goodReset = await u1.req('POST', '/api/auth/reset-password', { token: resetToken, password: 'a-brand-new-password-456' });
    ok('reset succeeds with a valid token', goodReset.status === 200 && goodReset.data.ok === true, goodReset);

    const oldLogin = await u1.req('POST', '/api/auth/login', { email: email1, password: 'a-real-password-123' });
    ok('old password no longer works after reset', oldLogin.status === 401, oldLogin);
    const newLogin = await u1.req('POST', '/api/auth/login', { email: email1, password: 'a-brand-new-password-456' });
    ok('new password works after reset', newLogin.status === 200, newLogin);
  }

  // ── admin view ──
  {
    const adminEmail = process.env.SMOKE_ADMIN_EMAIL || 'admin@example.com';
    const admin = makeJar();
    await admin.req('POST', '/api/auth/signup', { email: adminEmail, password: 'a-real-password-123' });
    await verifyEmailDirectly(adminEmail);
    const me = await admin.req('GET', '/api/auth/me');
    ok('account matching ADMIN_EMAILS is flagged admin', me.data.user && me.data.user.isAdmin === true, me.data);

    const forbidden = await u2.req('GET', '/api/admin/users');
    ok('non-admin is rejected from admin routes (403)', forbidden.status === 403, forbidden);

    const users = await admin.req('GET', '/api/admin/users');
    ok('admin can list users', users.status === 200 && Array.isArray(users.data.users) && users.data.users.length > 0, users.data);

    const stats = await admin.req('GET', '/api/admin/stats');
    ok('admin can read stats', stats.status === 200 && typeof stats.data.totalUsers === 'number', stats.data);
  }

  // ── closing report ──
  {
    const u3 = makeJar();
    const email3 = 'carol+' + Date.now() + '@example.com';
    await u3.req('POST', '/api/auth/signup', { email: email3, password: 'a-real-password-123' });
    await verifyEmailDirectly(email3);

    const noReportYet = await u3.req('GET', '/api/sprint/report');
    ok('report 404s before any run is completed', noReportYet.status === 404, noReportYet);

    await u3.req('POST', '/api/sprint', { track: 'pm', duration: '2w', paceMode: 'self_paced' });
    // Burn through all 10 work days via check-in/check-out only — never hits
    // GET /api/workspace, so this never calls the (fake-keyed) model.
    let lastCheckout;
    for (let i = 0; i < 10; i++) {
      await u3.req('POST', '/api/sprint/checkin', {});
      lastCheckout = await u3.req('POST', '/api/sprint/checkout', {});
    }
    ok('10th check-out completes a 2-week self-paced run', lastCheckout.data.completed === true, lastCheckout.data);

    const report = await u3.req('GET', '/api/sprint/report');
    ok('completed run has a closing report', report.status === 200 && report.data.report && typeof report.data.report.overall !== 'undefined', report.data);
    ok('closing report on a run with no completed tickets has 0 tickets and still has a narrative', report.data.report.totalTickets === 0 && typeof report.data.report.narrative === 'string', report.data.report);

    // ── public portfolio sharing ──
    const shareOff = await u3.req('GET', '/api/sprint/share');
    ok('sharing is off by default', shareOff.data.enabled === false && shareOff.data.token === null, shareOff.data);

    const notPublicYet = await fetch(BASE + '/api/public/portfolio/not-a-real-token');
    ok('an unshared/unknown token 404s on the public route', notPublicYet.status === 404, notPublicYet.status);

    const shareOn = await u3.req('POST', '/api/sprint/share', { enabled: true });
    ok('enabling sharing returns a token and url', shareOn.status === 200 && shareOn.data.enabled === true && !!shareOn.data.token, shareOn.data);

    const publicView = await fetch(BASE + '/api/public/portfolio/' + shareOn.data.token);
    const publicData = await publicView.json();
    ok('a shared token is publicly readable with no auth/cookies', publicView.status === 200 && publicData.report && publicData.displayName, publicData);
    ok('the public view masks the email to an initial + domain, not the full address', /^.\. — /.test(publicData.displayName) && !publicData.displayName.includes('@'), publicData.displayName);

    const shareOff2 = await u3.req('POST', '/api/sprint/share', { enabled: false });
    ok('disabling sharing keeps the same token but flips enabled off', shareOff2.data.enabled === false, shareOff2.data);

    const goneNow = await fetch(BASE + '/api/public/portfolio/' + shareOn.data.token);
    ok('the public route 404s once sharing is turned back off, even with the same token', goneNow.status === 404, goneNow.status);

    const shareOnAgain = await u3.req('POST', '/api/sprint/share', { enabled: true });
    ok('re-enabling sharing reuses the original token instead of minting a new one', shareOnAgain.data.token === shareOn.data.token, { before: shareOn.data.token, after: shareOnAgain.data.token });
  }

  // ── daily huddle + voice (gating + graceful degradation) ──
  // This sandbox has no real ELEVENLABS_API_KEY/OPENAI_API_KEY or working
  // ANTHROPIC_API_KEY, so this only exercises what's model/provider-
  // independent: auth/check-in gating, input validation, and voice routes
  // failing cleanly (501) instead of crashing when unconfigured. Actual
  // huddle content generation is covered against a mocked model in
  // content_test.js instead.
  {
    const emailH = 'huddlesmoke+' + Date.now() + '@example.com';
    const uh = makeJar();
    await uh.req('POST', '/api/auth/signup', { email: emailH, password: 'a-real-password-123' });
    await verifyEmailDirectly(emailH);
    await uh.req('POST', '/api/sprint', { track: 'pm', duration: '2w', paceMode: 'self_paced' });

    const blockedHuddle = await uh.req('GET', '/api/huddle/today');
    ok('huddle route requires check-in like the rest of the workspace (403)', blockedHuddle.status === 403, blockedHuddle);

    await uh.req('POST', '/api/sprint/checkin', {});

    const reachedHuddle = await uh.req('GET', '/api/huddle/today');
    ok('huddle route reaches the content engine once checked in (not a 401/403)', reachedHuddle.status !== 401 && reachedHuddle.status !== 403, reachedHuddle);

    const ttsMissingFields = await uh.req('POST', '/api/huddle/tts', { text: 'hello' });
    ok('TTS requires an agentKey', ttsMissingFields.status === 400, ttsMissingFields);

    const ttsResult = await uh.req('POST', '/api/huddle/tts', { agentKey: 'pm', text: 'hello' });
    ok('TTS returns a clean 501 when ELEVENLABS_API_KEY is not configured', ttsResult.status === 501, ttsResult);

    const sttResult = await uh.req('POST', '/api/huddle/transcribe', { audioBase64: 'AAAA', mimeType: 'audio/webm' });
    ok('transcription returns a clean 501 when OPENAI_API_KEY is not configured', sttResult.status === 501, sttResult);

    const speakMissingText = await uh.req('POST', '/api/huddle/speak', {});
    ok('huddle/speak requires text', speakMissingText.status === 400, speakMissingText);
  }

  // ── design and frontend tracks are live too, not just PM ──
  for (const track of ['design', 'fe']) {
    const emailT = track + '+' + Date.now() + '@example.com';
    const ut = makeJar();
    await ut.req('POST', '/api/auth/signup', { email: emailT, password: 'a-real-password-123' });
    await verifyEmailDirectly(emailT);
    const created = await ut.req('POST', '/api/sprint', { track, duration: '2w', paceMode: 'self_paced' });
    ok(`${track} track sprint creation succeeds`, created.status === 200 && created.data.sprint.track === track, created.data);
    await ut.req('POST', '/api/sprint/checkin', {});
    const ws = await ut.req('GET', '/api/workspace');
    ok(`${track} track reaches the content engine once checked in (not a 401/403)`, ws.status !== 401 && ws.status !== 403, ws);
  }

  // ── account settings: preferences, change password, export, delete ──
  {
    const emailS = 'settings+' + Date.now() + '@example.com';
    const us = makeJar();
    await us.req('POST', '/api/auth/signup', { email: emailS, password: 'first-password-123' });

    const meDefaults = await us.req('GET', '/api/auth/me');
    ok('new accounts default to voice and email notifications on', meDefaults.data.user.voiceEnabled === true && meDefaults.data.user.notifyEmail === true, meDefaults.data);
    ok('new accounts have not seen the onboarding tour yet', meDefaults.data.user.onboardingSeen === false, meDefaults.data);

    const seen = await us.req('POST', '/api/account/onboarding-seen', {});
    ok('marking onboarding seen succeeds', seen.status === 200, seen);
    const meAfterSeen = await us.req('GET', '/api/auth/me');
    ok('onboardingSeen sticks after being marked', meAfterSeen.data.user.onboardingSeen === true, meAfterSeen.data);

    const badPrefs = await us.req('POST', '/api/account/preferences', {});
    ok('preferences update rejects an empty body', badPrefs.status === 400, badPrefs);
    const prefsOff = await us.req('POST', '/api/account/preferences', { voiceEnabled: false, notifyEmail: false });
    ok('preferences update succeeds', prefsOff.status === 200, prefsOff);
    const meAfterPrefs = await us.req('GET', '/api/auth/me');
    ok('voice/notify preferences persist', meAfterPrefs.data.user.voiceEnabled === false && meAfterPrefs.data.user.notifyEmail === false, meAfterPrefs.data);

    const wrongCurrent = await us.req('POST', '/api/account/change-password', { currentPassword: 'not-it', newPassword: 'second-password-456' });
    ok('change-password rejects the wrong current password (401)', wrongCurrent.status === 401, wrongCurrent);
    const shortNew = await us.req('POST', '/api/account/change-password', { currentPassword: 'first-password-123', newPassword: 'short' });
    ok('change-password rejects a too-short new password', shortNew.status === 400, shortNew);
    const changed = await us.req('POST', '/api/account/change-password', { currentPassword: 'first-password-123', newPassword: 'second-password-456' });
    ok('change-password succeeds with the right current password', changed.status === 200, changed);

    const loginOldFails = await makeJar().req('POST', '/api/auth/login', { email: emailS, password: 'first-password-123' });
    ok('old password no longer works after change-password', loginOldFails.status === 401, loginOldFails);
    const loginNewWorks = await makeJar().req('POST', '/api/auth/login', { email: emailS, password: 'second-password-456' });
    ok('new password works after change-password', loginNewWorks.status === 200, loginNewWorks);

    const exportRes = await us.req('GET', '/api/account/export');
    ok('account export returns the account + sprints + dayLogs + messages shape', exportRes.status === 200 && exportRes.data.account && Array.isArray(exportRes.data.sprints) && Array.isArray(exportRes.data.dayLogs) && Array.isArray(exportRes.data.messages), exportRes.data);

    const deleteWrongPassword = await us.req('POST', '/api/account/delete', { password: 'nope' });
    ok('account delete rejects the wrong password (401)', deleteWrongPassword.status === 401, deleteWrongPassword);
    const deleteOk = await us.req('POST', '/api/account/delete', { password: 'second-password-456' });
    ok('account delete succeeds with the right password', deleteOk.status === 200, deleteOk);
    const meAfterDelete = await us.req('GET', '/api/auth/me');
    ok('session is invalidated after self-deletion', meAfterDelete.data.user === null, meAfterDelete.data);
    const loginAfterDelete = await makeJar().req('POST', '/api/auth/login', { email: emailS, password: 'second-password-456' });
    ok('deleted account can no longer log in', loginAfterDelete.status === 401, loginAfterDelete);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await dbPool.end().catch(() => {});
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('SMOKE TEST CRASHED', e); process.exit(1); });
