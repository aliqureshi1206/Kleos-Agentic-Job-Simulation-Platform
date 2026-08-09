# Kleos

A workplace simulator where you're handed a real ticket, a contradictory
stakeholder, and a demanding reviewer — none of them scripted. Ten
independent AI agents, each with their own persona and their own memory,
read what you actually write and respond to it, in a real Slack-like
multi-channel workspace and a spoken team huddle, over a real multi-month
job.

Kleos has real accounts, a real work-day calendar, Postgres-backed
persistence, and a curated ~20-ticket content bank with a model-driven "day
director" that assigns new work, improvises pivots/incidents/deadline
shifts, runs a standup-style huddle a few times a week, and has
cross-functional teammates ping you directly — so a 3-month duration is
actually filled with 3 months of a real job, not one ticket followed by
empty days. Three tracks are live: **Product Management**, **UI/UX
Design**, and **Frontend Engineering** — each with its own curated ticket
bank, reviewed by the right person (Daniyal for Product and Frontend, Emma
for Design). See "Extending this" below for what's involved in adding a
fourth.

## The team

Everyone below is an independent agent — its own persona, its own
persistent memory per sprint, called with a real Anthropic API request:

- **Yusra Kamal** — Senior PM, your direct manager. Guides you, reviews
  nothing herself (that's Daniyal's job), sends a private "pulse" DM after
  every ticket resolves, facilitates the huddle.
- **Omar Farouk** — VP of Growth, the stakeholder who kicked off this run
  with a contradictory brief and keeps shifting priorities without quite
  admitting it.
- **Daniyal Rehman** — Engineering Lead. Casual chat persona and a
  completely separate *formal reviewer* persona/memory — same character,
  different mode. Formally reviews the Product and Frontend tracks.
- **Sentinel** — automated QA bot. Terse, technical, no opinions.
- **Rania Aboud** — CEO. Rare DMs, occasional huddle guest, big-picture and
  mission-focused.
- **Nathan Reeves** — CTO, a Series B hire from outside the region. Cares
  about scale and technical debt, not any one ticket.
- **Claire Bennett** — Director of Product, Yusra's boss. Connects your work
  to quarterly product goals.
- **Emma Sullivan** — Design Director. Pings you directly about flows,
  specs, and design decisions.
- **Grace Mitchell** — Head of Marketing. Pings you about launch timing and
  what's safe to promise externally.
- **Ryan Coleman** — Regional Sales Lead (Karachi). Pings you with
  specific (fictional) client asks tied to real deals.

## How it works, for a new user

1. **Sign up / sign in** (`/signup.html`, `/login.html`) — email + password.
2. **Start a job** (`/dashboard.html`) — pick a role (Product Management,
   UI/UX Design, or Frontend Engineering — all three live), a duration
   (2 weeks / 1 month / 3 months, converted to a fixed number of
   business-day "work days"), and a pace: real calendar (one work day per
   real business day, weekends and any configured holidays off) or
   self-paced (same total work days, check in again immediately).
3. **Check in** — starts a work day and a 4-hour countdown. Still checked in
   past 4 hours? The timer flips to a red **OVERTIME** counter rather than
   cutting you off.
4. **Work** (`/index.html`) — a Slack-like workspace: channels down the left
   (`#general`, `#incidents`, one per ticket you've been assigned), direct
   messages with each teammate (including design/marketing/sales, who ping
   you unprompted with real cross-functional asks), a ticket panel on the
   right with the brief and a submission sandbox in the middle.
5. **Join the huddle** (`/huddle.html`) — a few times a week, a banner
   appears in the workspace sidebar. Each attendee (Yusra and Daniyal always,
   plus 2-3 rotating guests from the wider team) gives a short spoken status
   update — played back sequentially with the speaking person highlighted —
   then you're prompted to record (or type) your own update, which is
   transcribed, shown to you to confirm/edit, and only then submitted.
6. **Check out** — ends the work day, logs how long you actually worked, and
   advances to the next day. Everything (chat history, ticket state,
   channels, huddle transcripts) is saved server-side, so checking back in
   resumes exactly where you left off, even mid-ticket.

Each work day, the server decides what's new — a fresh ticket if the last
one closed, or (about 40% of the time, while a ticket is in flight) a
hiccup: the stakeholder pivots the requirements, QA reports a production
incident, or a deadline moves. Independently, there's a small daily chance
a cross-functional teammate DMs you with a design/marketing/sales ask, and
on a Mon/Wed/Fri-equivalent cadence, a huddle happens. All of it is
generated in-character by the relevant agent, not pre-scripted, so no two
runs play out identically.

## Architecture

```
kleos-app/
├── server.js        Express server — routes, sessions, rate limiting,
│                    the auto-checkout sweep
├── db.js            Postgres pool + schema migration runner
├── schema.sql       Table definitions (users, sprints, day_logs, messages)
├── auth.js          Signup / login / logout / session middleware, email
│                    verification, password reset, admin-flag gating
├── mailer.js        Pluggable email sending (Resend, or console-log in dev)
├── voice.js         Pluggable TTS (ElevenLabs) + STT (OpenAI Whisper) for
│                    the daily huddle — both optional, degrade to text
├── logger.js        Structured (JSON) logging with an optional Sentry hook
├── sprint.js        Sprint lifecycle: duration → business-day calendar,
│                    check-in/check-out, the work-day timer, the stale-
│                    session auto-checkout sweep
├── tickets.js       The curated ~20-ticket PM content bank (what the work is)
├── agents.js        All ten agent personas, the Anthropic API call, and the
│                    review/hiccup/huddle prompt builders (who says it, how)
├── content.js       The "day director" — when things happen and where they
│                    get posted (ticket assignment/rotation, hiccups, the
│                    huddle, cross-functional pings, channels, messaging,
│                    the closing report)
├── public/
│   ├── login.html            "Forgot password?" link, verify-link banner
│   ├── signup.html
│   ├── forgot-password.html  Request a reset link
│   ├── reset-password.html   Set a new password from an emailed token
│   ├── dashboard.html        Role/duration/pace picker, check-in/out, timer,
│   │                         verification banner, admin link (if is_admin)
│   ├── report.html           Closing competency report for a finished run
│   ├── admin.html            Read-only user/run list (is_admin only)
│   ├── huddle.html           The daily voice huddle — playback + mic capture
│   └── index.html            The workspace itself. Talks only to /api/*.
├── Dockerfile
├── .dockerignore
├── .env.example
└── package.json
```

**Three kinds of "memory," on purpose.** Each agent's actual conversation
memory (one `agent_memory` JSONB column on `sprints`, keyed by agent —
`{pm: [...], stake: [...], ...}`, one entry per agent rather than a
hardcoded column each) is independent per agent, regardless of which channel
you talk to them in — exactly like a real coworker remembers their
relationship with you, not a transcript scoped to one Slack channel.
Separately, the `messages` table is purely a **display log** for the
Slack-like UI (which channel a message appeared in, read/unread, history on
reload). A hiccup message posted in `#qe-410` both appears in that channel
*and* becomes part of Omar's ongoing memory, the same call, the same way a
real message would. The third kind, `career_memory`, is described just
below.

**The day director (`content.js`)** runs once per work day
(`ensureDayContent`, called from `GET /api/workspace`, idempotent via
`last_generated_day`), and does one of: assign the first ticket, assign the
next ticket from `tickets.js` once the current one is `DONE` (or ask the
model to invent one more once the curated bank of ~20 is exhausted, so a
long duration never runs dry), or roll a seeded chance of a hiccup on the
ticket in flight. The roll is deterministic per `(sprint id, day index)`, so
refreshing the page never re-rolls and gets a different outcome.

**Career memory (`content.js#getCareerMemory`)** is the third kind, and by
far the smallest — not a chat transcript, but a compact running summary of
this run's track record: pass/fail streaks, total
tickets completed, and a capped rolling list of notable moments (a clean
first-try pass, a hard-won pass after several revisions, a pivot survived
mid-ticket). `buildMemoryDigest` turns that state into a short paragraph
folded into *every* agent's system prompt (`agentSpeak`) and the formal
reviewer's prompt (`buildReviewSystem`), framed explicitly as private
awareness rather than a script — so a teammate who's never reviewed your
work can still react like they've heard you're on a roll, and the reviewer's
tone can shift from patient-and-explicit to surgical-and-trusting as your
track record does, without the rubric itself ever moving. On top of that,
`updateCareerMemory` fires a handful of deterministic (not random) events the
first time a threshold is actually crossed: a manager's private check-in
after two rough submissions in a row, a teammate's pairing offer once one
ticket needs a third attempt, a private note of growing trust after three
clean passes, and a public `#general` shout-out every 5 completed tickets.
Each one is an equality check on a counter, so a long streak doesn't spam the
same message every day — it fires once per crossing, the way a real manager
notices a pattern once and says something, not every single day it continues.

**Auth boundary:** every route that talks to the model
(`/api/workspace`, `/api/messages/:channel`, `/api/ticket/accept`,
`/api/ticket/submit`, `/api/narrative`) requires both a logged-in session
and an active, checked-in sprint — enforced server-side
(`requireAuth` + `requireCheckedIn` in `server.js`), not just by the
dashboard/timer UI.

**Business days** are computed in UTC (Mon–Fri) — a known simplification
that doesn't account for the user's timezone or public holidays.

## Run it locally

Requires Node 18+ and a Postgres database (local or hosted).

```bash
npm install
cp .env.example .env
# edit .env: paste in a real Anthropic key, a DATABASE_URL, and a SESSION_SECRET
npm start
```

The server runs `schema.sql` against your database automatically on boot
(safe to run repeatedly — every statement is `CREATE ... IF NOT EXISTS` or
`ADD COLUMN IF NOT EXISTS`), so there's no separate migration step, and
upgrading from an older Kleos database won't lose existing users/sprints.

Open **http://localhost:3000** — you'll land on `/login.html` if you're not
signed in.

`npm run dev` restarts the server automatically on file changes.

### Getting a local Postgres quickly

```bash
# with Docker
docker run --name kleos-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16
# then in .env:
# DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
# DATABASE_SSL=false
```

Or use a free managed instance (Neon, Supabase, Railway) and skip Docker
entirely — paste their connection string into `DATABASE_URL` and leave
`DATABASE_SSL=true`.

## Deploying it somewhere real

Still a standard Node + Express app — no special build step.

- **Railway / Render / Fly.io** — connect the repo, add a Postgres instance,
  set `ANTHROPIC_API_KEY`, `DATABASE_URL`, `SESSION_SECRET`, and the email/
  admin vars below as environment variables, deploy. Set
  `NODE_ENV=production` so session cookies are marked `secure` (requires
  HTTPS, provided by default on all three).
- **Docker** — a `Dockerfile` and `.dockerignore` are included:
  ```bash
  docker build -t kleos .
  docker run -p 3000:3000 --env-file .env kleos
  ```
  The image is stateless; point `DATABASE_URL` at a managed Postgres or a
  separate Postgres container. Works as-is on any host that runs containers
  (Railway, Render, Fly, ECS, a VPS with Docker installed).
- **A VPS without Docker** — `git clone`, `npm install`, run Postgres
  alongside it or point at a managed one, set the env vars, run behind `pm2`
  or `systemd`, put nginx in front for TLS.

Wherever you deploy, **never commit your `.env` file** — `.gitignore`
already excludes it. Set secrets through your host's environment variable
settings instead.

**Email delivery.** Without `RESEND_API_KEY` set, verification and
password-reset links are only logged to the server console (`mailer.js`) —
fine for local dev or a small invite-only cohort you onboard by hand, but
real public signup needs a real provider. Set `RESEND_API_KEY`, `MAIL_FROM`,
and `APP_URL` (see `.env.example`) before opening signup to strangers.

**Promoting an admin.** `ADMIN_EMAILS` only applies at signup time. To grant
an existing account admin access (visibility into `/admin.html`), run:
```sql
UPDATE users SET is_admin = true WHERE email = 'you@example.com';
```

**Backups.** There's no automated backup job — set one up on whatever
schedule your cohort's size warrants. A daily cron calling `pg_dump` covers
most cases:
```bash
pg_dump "$DATABASE_URL" -F c -f "kleos-$(date +%F).dump"
# restore into a fresh database with:
pg_restore -d "$NEW_DATABASE_URL" --clean --if-exists kleos-2026-08-08.dump
```
Managed Postgres hosts (Neon, Supabase, Railway, RDS) also offer automatic
point-in-time backups in their dashboard — if you're on one of those,
enabling that is usually less to maintain than a cron job.

**A note on model cost at scale.** Each work day that assigns a ticket or
fires a hiccup makes one Anthropic API call; each chat message, one more.
This scales with real usage (checked-in users actually working), not with
duration length sitting idle, so it's bounded and predictable. Filler
tickets (once the curated ~20-ticket bank is exhausted) cap out at 6
AI-generated ones per sprint before falling back to a small hand-written
evergreen set, so even an extremely fast user on a 3-month run can't spin up
unbounded model calls just from ticket generation.

**Voice adds two more paid providers, both optional.** ElevenLabs (TTS) is
called once per huddle attendee per huddle — a few times a week, a handful
of short lines each time. OpenAI Whisper (STT) is called once per user
huddle turn. Neither is required: leave `ELEVENLABS_API_KEY` /
`OPENAI_API_KEY` unset and the huddle still runs, just as text with a typed
update box instead of spoken audio. Budget separately from your Anthropic
spend if you turn both on for a real cohort.

**Error visibility.** All 500-level errors, the auto-checkout sweep, and
migration failures go through `logger.js` as structured JSON on
stdout/stderr — pipe that into whatever your host already collects (Railway/
Render both capture stdout automatically). To also forward errors to
[Sentry](https://sentry.io), run `npm install @sentry/node` and set
`SENTRY_DSN`; `logger.js` picks it up automatically, with no code changes.

## Before real users touch this

What's already handled, so this list stays honest:

- ✅ **Accounts, persistence, rate limiting** — see the architecture section
  above. Sessions and all sprint/message state live in Postgres, not memory.
- ✅ **Email verification + password reset.** New accounts must verify
  before starting a job (`POST /api/sprint` checks `email_verified`);
  `forgot-password.html` / `reset-password.html` cover the reset flow.
  Delivery is pluggable (`mailer.js`) — real email via Resend, or a
  console-logged link for local/invite-only use.
- ✅ **Server-side auto-checkout.** A closed laptop or crashed tab no longer
  leaves a sprint checked in forever racking up phantom OVERTIME — a sweep
  in `server.js` force-closes any sprint checked in past 8 hours, logging
  real seconds worked exactly like a normal checkout would.
- ✅ **Filler tickets are bounded and validated**, not an open-ended trust of
  raw model output. `content.js#validateFillerTicket` enforces field types,
  length caps, and an HTML allowlist (`sanitizeLimitedHtml`) before anything
  generated reaches the database or the client; a hardcoded ticket is used
  if generation or validation ever fails; and after 6 AI-generated fillers
  in one sprint, a small hand-written evergreen set takes over instead of
  calling the model indefinitely.
- ✅ **A real closing report.** When a run completes (whether via a normal
  checkout or the auto-checkout sweep), `content.js#buildClosingReport`
  aggregates every ticket's rubric scores into a competency breakdown plus a
  manager-voiced closing note, cached on the sprint and viewable at
  `/report.html` (linked from the dashboard's "Job complete" card).
- ✅ **A basic admin view.** Accounts flagged `is_admin` (via `ADMIN_EMAILS`
  at signup) can see every user, their verification status, and their run
  progress at `/admin.html`, backed by `GET /api/admin/users` and
  `GET /api/admin/stats` — no more querying Postgres by hand to see how a
  cohort is doing.
- ✅ **Ops basics.** A `Dockerfile`/`.dockerignore` for container deploys,
  structured JSON error logging with an optional Sentry hook (`logger.js`),
  and backup guidance (above) are all in place.
- ✅ **A full run's worth of content.** ~20 curated PM tickets (plus their
  own smaller banks for Design and Frontend) plus bounded AI-generated filler
  once exhausted, AI-generated pivots/incidents/deadline shifts spread across
  the run — a 3-month duration has 3 months of
  plausible work in it, not one ticket and then silence.
- ✅ **Real multi-channel messaging**, not a single feed: channels persist
  and accumulate per ticket, plus a private DM with each teammate.
- ✅ **Mic consent + missed-huddle visibility.** `huddle.html` explicitly
  explains that recording is sent to OpenAI for transcription and discarded
  afterward, and requires an explicit "Continue with voice" click before
  ever touching the microphone — never opts you into recording silently. A
  cumulative `missedCount` (in `huddle_state`) surfaces in both the
  workspace sidebar banner and on the huddle page itself if a previous
  huddle went by without an update — visible, not enforced, same philosophy
  as OVERTIME.
- ✅ **Email notifications.** A review verdict (pass or fail) and a huddle
  starting each send a short email through the same pluggable `mailer.js`
  used for verification/reset — gated per-user by the `notify_email`
  preference in `/settings.html` (account-critical mail ignores that flag).
- ✅ **Public portfolio links.** From `/report.html`, flip on a shareable,
  unauthenticated read-only view of a completed run's closing report
  (`/portfolio.html?token=...`) — a real proof-of-work link, with the
  account's email masked down to an initial + domain rather than published
  outright. Turning sharing off immediately 404s the old link; turning it
  back on reuses the same token instead of minting a new one.
- ✅ **Account settings.** `/settings.html` covers changing your password,
  toggling huddle voice and email notifications, exporting every run/message
  on your account as JSON, and deleting your account outright.
- ✅ **CSRF protection.** A double-submit cookie (`kleos.csrf`) is required,
  as a matching `X-CSRF-Token` header, on every mutating `/api/*` request —
  on top of the `SameSite=Lax` session cookie, not instead of it.
- ✅ **Product Management, Design, and Frontend are all live tracks now** —
  see "Extending this" below for how another track gets added.
- ✅ **Agents act on a real track record, not just a script.** A compact
  `career_memory` per sprint (`content.js#getCareerMemory`) tracks pass/fail
  streaks, tickets completed, and notable moments, and is folded into every
  agent's system prompt so teammates react like they remember working with
  you. It also drives deterministic events a random hiccup roll never would:
  a manager's private check-in after two rough submissions in a row, a
  teammate's pairing offer once a ticket needs a third attempt, growing trust
  after three clean passes, and a public shout-out every 5 tickets completed.

What's still worth doing before this is fully "enterprise-grade":

- **Business-day calendar is UTC-only.** An optional holiday calendar exists
  (`KLEOS_HOLIDAYS` in `.env.example`) for calendar-pace sprints, but there's
  still no per-user timezone handling — "business day" means Mon-Fri UTC
  plus whatever's in that list.
- **Automated tests don't use a real Anthropic key.** `content.js` is
  covered by a mocked-model unit test suite (ticket rotation, hiccups,
  filler generation + validation, message routing, onboarding, the closing
  report, all verified deterministically); the HTTP layer is covered
  end-to-end against a real Postgres instance, including the full email
  verification and password-reset flows. Neither calls the real Anthropic
  API, so actual model output quality (tone, in-character consistency, JSON
  well-formedness in practice under real load) still needs periodic manual
  spot-checks — see the checklist below.

### Manual test checklist (needs a real `ANTHROPIC_API_KEY`)

The automated suite (`verify/run_smoke.sh`) deliberately runs against a fake
key so it's free and fast to run repeatedly — it verifies every code path
except "does the model actually say something good." Before a real cohort
starts, spot-check with a real key:

- [ ] Sign up, verify via the real emailed link (or console-logged link if
      `RESEND_API_KEY` isn't set yet), start a PM job.
- [ ] Check in — confirm the onboarding messages (company context, manager
      welcome, eng-lead guidelines, QA intro) read naturally and arrive in
      the right voices.
- [ ] Accept the first ticket, submit something deliberately weak — confirm
      the reviewer's rubric feedback is specific to what you actually wrote,
      not generic, and that a genuinely strong resubmission passes.
- [ ] Chat in `#general` and in a ticket channel — confirm messages route to
      the right teammate (stakeholder keywords → Omar, otherwise → Yusra)
      and that each agent stays in character and remembers earlier context.
- [ ] Run enough work days to trigger a hiccup (pivot / incident / deadline
      shift) — confirm it reads as a plausible in-character event, not
      garbled JSON leaking into chat.
- [ ] Burn through the curated ~20 tickets to trigger AI-generated filler —
      confirm a filler ticket's brief/rubric are coherent and consistent
      with Meridian's world.
- [ ] Complete a full run (or force day_index near the end) and check
      `/report.html` — confirm the competency scores look reasonable and
      the closing note references real specifics from the run.
- [ ] Check `/admin.html` as an `ADMIN_EMAILS` account — confirm the user
      list and stats match what you just did above.
- [ ] With `ELEVENLABS_API_KEY` and `OPENAI_API_KEY` set, reach a huddle day
      on `/huddle.html` — confirm each attendee's audio actually plays, the
      speaking tile highlights correctly, your recorded update transcribes
      accurately, and the facilitator's ack references what you actually
      said. Then unset both keys and confirm the huddle still works as a
      text-only meeting with a typed update box — the degraded path matters
      as much as the happy path here.
- [ ] Ping cross-functional DMs (`dm-design`, `dm-marketing`, `dm-sales`) —
      confirm each stays in character and the asks feel like real product
      management work, not generic filler.
- [ ] Start a Design track run — confirm the first ticket (`QD-401`) is
      reviewed by Emma Sullivan in her own voice, not Daniyal's, and that
      the onboarding message says "Product Designer," not "Associate
      Product Manager."
- [ ] Start a Frontend Engineering track run — confirm the first ticket
      (`QF-401`) plays out end to end and the onboarding message says
      "Frontend Engineer."
- [ ] Toggle sharing on from `/report.html` after completing a run, open the
      resulting `/portfolio.html?token=...` link in a private/incognito
      window — confirm it renders with no login, then confirm it 404s once
      sharing is turned back off.
- [ ] In `/settings.html`, change your password, then log out and back in
      with the new one; toggle email notifications off and confirm a
      review-verdict email stops arriving; export your data and confirm the
      JSON contains your actual sprints/messages.
- [ ] Deliberately submit two weak drafts in a row on the same ticket —
      confirm Yusra sends a proactive, genuinely supportive check-in DM (not
      just the usual pulse note), and that a third attempt gets a casual
      pairing-offer message from the ticket's reviewer in the ticket channel
      itself. Then land three clean passes in a row and confirm a private
      "I trust you more now" note shows up, distinct in tone from the routine
      pulse notes.

## Extending this

- **Adding a fourth live track**: `tickets.js` now holds one ticket bank per
  track (`TICKETS_PM`, `TICKETS_DESIGN`, `TICKETS_FE`, looked up via
  `getTicket(track, idx)` / `totalTickets(track)`) — add a new bank there
  following the existing shape, add a persona for its reviewer in
  `agents.js` if it doesn't already exist, add a `TRACK_FILLER_CONFIG` /
  `EVERGREEN_FILLERS` entry in `content.js` for when the curated bank runs
  out, allow the track in `sprint.js`'s `LIVE_TRACKS`, and flip it to
  `live: true` in `dashboard.html`'s `ROLES` array. The scripted, no-account
  demo (`/index.html?preview=1`) is unrelated to this and still shows all
  three tracks' flavor text for anyone without logging in.
- **Streaming responses**: agent replies arrive all at once. The Anthropic
  API supports streaming; wiring that through `/api/messages/:channel` would
  make replies feel faster.
- **Tune the hiccup rate/mix**: `HICCUP_CHANCE` and the pivot/incident/
  deadline-shift split live at the top of `content.js`.
