-- Harbor state store.
--
-- The full history of a run must be reconstructable from these tables alone
-- (SOW §8.7): what was planned, what was called, what failed, what was fixed.
-- Everything stored here has already passed through redaction — the store must
-- never be the place a secret comes to rest.
--
-- Idempotent: safe to run repeatedly against the same database.

CREATE TABLE IF NOT EXISTS deployments (
  id              text PRIMARY KEY,
  repo_url        text        NOT NULL,
  branch          text        NOT NULL DEFAULT 'main',
  -- running | succeeded | failed | escalated
  status          text        NOT NULL DEFAULT 'running',
  service_url     text,
  framework       text,
  -- Whole RepoProfile, for reproducing a diagnosis after the fact.
  repo_profile    jsonb,
  -- Budget snapshot at completion: turns, tokens, estimated cost.
  budget          jsonb,
  issues_resolved integer     NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  CONSTRAINT deployments_status_valid
    CHECK (status IN ('running', 'succeeded', 'failed', 'escalated'))
);

CREATE TABLE IF NOT EXISTS plan_steps (
  id            bigserial PRIMARY KEY,
  deployment_id text        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  ordinal       integer     NOT NULL,
  label         text        NOT NULL,
  -- pending | running | succeeded | failed | skipped
  status        text        NOT NULL DEFAULT 'pending',
  duration_ms   integer,
  detail        jsonb,
  started_at    timestamptz,
  ended_at      timestamptz,
  CONSTRAINT plan_steps_status_valid
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  CONSTRAINT plan_steps_unique_ordinal UNIQUE (deployment_id, ordinal)
);

-- Every tool invocation, including denials. An empty tool_calls row set for a
-- run that claims success means something bypassed the registry.
CREATE TABLE IF NOT EXISTS tool_calls (
  id            bigserial PRIMARY KEY,
  deployment_id text        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  step_id       bigint      REFERENCES plan_steps(id) ON DELETE SET NULL,
  tool_name     text        NOT NULL,
  input         jsonb,
  output        jsonb,
  -- ok | error | denied
  outcome       text        NOT NULL,
  error_message text,
  duration_ms   integer,
  called_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_calls_outcome_valid
    CHECK (outcome IN ('ok', 'error', 'denied'))
);

-- One row per self-heal cycle: what broke, what Harbor concluded, what it did.
CREATE TABLE IF NOT EXISTS incidents (
  id             bigserial PRIMARY KEY,
  deployment_id  text        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  attempt        integer     NOT NULL,
  -- port_mismatch | missing_dependency | missing_env_var | bad_start_command | unknown
  failure_class  text        NOT NULL DEFAULT 'unknown',
  symptom        text        NOT NULL,
  diagnosis      text,
  fix_applied    text,
  -- open | resolved | escalated
  outcome        text        NOT NULL DEFAULT 'open',
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  CONSTRAINT incidents_outcome_valid
    CHECK (outcome IN ('open', 'resolved', 'escalated')),
  CONSTRAINT incidents_unique_attempt UNIQUE (deployment_id, attempt)
);

-- The activity stream. seq is the SSE resume cursor, so it must be unique and
-- monotonic per deployment.
CREATE TABLE IF NOT EXISTS activity_events (
  id            bigserial PRIMARY KEY,
  deployment_id text        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  seq           integer     NOT NULL,
  event_type    text        NOT NULL,
  message       text        NOT NULL,
  detail        jsonb,
  duration_ms   integer,
  at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_events_unique_seq UNIQUE (deployment_id, seq)
);

CREATE INDEX IF NOT EXISTS plan_steps_deployment_idx
  ON plan_steps (deployment_id, ordinal);
CREATE INDEX IF NOT EXISTS tool_calls_deployment_idx
  ON tool_calls (deployment_id, called_at);
CREATE INDEX IF NOT EXISTS incidents_deployment_idx
  ON incidents (deployment_id, attempt);
CREATE INDEX IF NOT EXISTS activity_events_resume_idx
  ON activity_events (deployment_id, seq);
CREATE INDEX IF NOT EXISTS deployments_started_idx
  ON deployments (started_at DESC);
