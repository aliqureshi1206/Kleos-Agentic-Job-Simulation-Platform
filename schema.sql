-- Kleos schema — Postgres
-- Run once against your database before starting the server (see README).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Email verification, password reset, and a lightweight admin flag. Added
-- via ALTER so upgrading an existing database doesn't lose users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_verify_token ON users(verify_token) WHERE verify_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token) WHERE reset_token IS NOT NULL;
-- Per-user preferences (settings.html). Verification/reset emails always
-- send regardless of notify_email — this only gates the non-critical ones
-- (huddle reminders, review verdicts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT true;
-- Whether this account has dismissed the first-visit workspace tour.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_seen BOOLEAN NOT NULL DEFAULT false;

-- One "sprint" = one user's run through a track (currently only Product
-- Management is live). Duration + pace_mode control the work-day calendar;
-- day_index advances by one each time the user checks out.
CREATE TABLE IF NOT EXISTS sprints (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track            TEXT NOT NULL DEFAULT 'pm',       -- pm | design | fe | qa
  duration         TEXT NOT NULL,                     -- 2w | 1m | 3m
  pace_mode        TEXT NOT NULL,                     -- calendar | self_paced
  total_work_days  INT NOT NULL,
  day_index        INT NOT NULL DEFAULT 0,
  checked_in_at    TIMESTAMPTZ,
  last_checkout_at TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'active',    -- active | completed
  -- Legacy per-agent chat memory columns from when there were only 4
  -- agents — superseded by agent_memory below, kept only so old rows don't
  -- break. Nothing reads or writes these anymore.
  agent_pm         JSONB NOT NULL DEFAULT '[]',
  agent_stake      JSONB NOT NULL DEFAULT '[]',
  agent_qa         JSONB NOT NULL DEFAULT '[]',
  agent_tlead      JSONB NOT NULL DEFAULT '[]',
  review_history   JSONB NOT NULL DEFAULT '[]',
  -- snapshot of client-side workspace UI state — superseded by ticket_state
  -- + the messages table below, kept only so older rows don't break.
  workspace_state  JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sprints_user_status ON sprints(user_id, status);

-- Content-engine state (content.js). Added via ALTER so this also upgrades
-- a database created by an earlier version of Kleos without losing data.
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS ticket_idx INT NOT NULL DEFAULT 0;
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS ticket_state JSONB NOT NULL DEFAULT '{}';
-- Which day_index content.js has already generated content for, so a check-in
-- or a page refresh never double-fires a ticket assignment or a hiccup.
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS last_generated_day INT NOT NULL DEFAULT -1;
-- { "<channel-key>": "<ISO timestamp of last read>" } — drives unread badges.
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS channel_reads JSONB NOT NULL DEFAULT '{}';
-- The closing competency report (see content.js#buildClosingReport), built
-- once when a run completes and cached here so revisiting the report page
-- doesn't re-call the model or drift between visits.
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS closing_report JSONB;
-- Daily-huddle tracking: { lastHuddleDay, attendees: [...agentKeys], userSpoke }.
-- The huddle transcript itself lives in the messages table like any other
-- channel (channel='huddle') — this column only tracks "did today's huddle
-- already run, who showed up, and has the user given their turn yet."
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS huddle_state JSONB NOT NULL DEFAULT '{}';
-- Generalized per-agent chat memory: { "<agentKey>": [...history] }. One
-- column for every agent (now ten: pm/stake/qa/tlead plus ceo/cto/
-- dirproduct/design/marketing/sales) instead of one hardcoded column per
-- agent, so adding another character later doesn't need a schema change.
-- Replaces the legacy agent_pm/agent_stake/agent_qa/agent_tlead columns
-- above.
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS agent_memory JSONB NOT NULL DEFAULT '{}';
-- Public portfolio link (report.html "Copy public link"): a random token
-- that resolves to a read-only view of a completed run's closing report,
-- with no auth required — the point is a shareable proof-of-work link.
-- Only set once the user explicitly opts in; NULL/false means not shared.
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS public_share_token TEXT;
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS public_share_enabled BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_public_share_token ON sprints(public_share_token) WHERE public_share_token IS NOT NULL;
-- "Career memory" (content.js#getCareerMemory): a small, structured record of
-- this teammate's track record — pass/fail streaks, total tickets completed,
-- and a rolling list of notable moments (clean passes, hard-won passes,
-- pivots survived, rough patches). Deliberately separate from agent_memory
-- (raw chat transcripts): this is a compact, deterministic summary that gets
-- folded into every agent's system prompt so teammates react like they
-- actually remember working with this person, instead of starting fresh on
-- every message. It also drives proactive, performance-triggered messages
-- (a manager check-in after a rough patch, a teammate's pairing offer after
-- repeated revisions, a milestone shout-out) instead of everything being
-- purely random flavor.
ALTER TABLE sprints ADD COLUMN IF NOT EXISTS career_memory JSONB NOT NULL DEFAULT '{}';

-- One row per work-day session, for the record (and so users/admins can see
-- real hours logged). Purely historical — sprints table is the live state.
CREATE TABLE IF NOT EXISTS day_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sprint_id      UUID NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  day_index      INT NOT NULL,
  checked_in_at  TIMESTAMPTZ NOT NULL,
  checked_out_at TIMESTAMPTZ,
  seconds_used   INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_day_logs_sprint ON day_logs(sprint_id);
-- Set true when the server's stale-session sweep closed this day out
-- instead of the user clicking "Check out" themselves (closed laptop,
-- crashed tab, etc). See sprint.js#autoCheckoutStale.
ALTER TABLE day_logs ADD COLUMN IF NOT EXISTS auto_checkout BOOLEAN NOT NULL DEFAULT false;

-- The Slack-like display layer: every message a user or agent posts, tagged
-- with the channel it appeared in. This is purely for rendering the
-- workspace UI (history, unread badges) — it is NOT what the model reads as
-- memory. Each agent's actual conversation memory is still the independent
-- agent_pm/agent_stake/agent_qa/agent_tlead columns above, exactly like a
-- real teammate remembers your relationship with them regardless of which
-- channel you happened to be talking in.
CREATE TABLE IF NOT EXISTS messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sprint_id   UUID NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,          -- 'general' | 'incidents' | 'qe-402' | 'dm-pm' | 'dm-stake' | 'dm-qa' | 'dm-tlead'
  author_key  TEXT NOT NULL,          -- 'pm' | 'stake' | 'qa' | 'tlead' | 'sys' | 'user'
  body        TEXT NOT NULL,
  day_index   INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_sprint_channel ON messages(sprint_id, channel, created_at);

-- express-session (connect-pg-simple) creates and manages its own "session"
-- table automatically on boot — nothing to do here.
