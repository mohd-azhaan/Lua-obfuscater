-- ================================================================
--  LuaObf API  –  PostgreSQL Schema
--  Run: node src/db/migrate.js
-- ================================================================

BEGIN;

-- ── Extensions ──────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── ENUM types ───────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE plan_type AS ENUM ('free', 'basic');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sub_status AS ENUM ('active', 'past_due', 'canceled', 'trialing');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── users ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  email             TEXT        NOT NULL UNIQUE,
  password_hash     TEXT        NOT NULL,
  plan              plan_type   NOT NULL DEFAULT 'free',
  plan_expires_at   TIMESTAMPTZ,                          -- NULL = free forever
  stripe_customer_id TEXT       UNIQUE,
  stripe_sub_id     TEXT       UNIQUE,
  sub_status        sub_status,
  is_banned         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);

-- ── api_keys ─────────────────────────────────────────────────────
-- We store only the SHA-256 hash; the raw key is shown once to the user.
CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash      TEXT        NOT NULL UNIQUE,              -- SHA-256(raw_key)
  key_prefix    CHAR(8)     NOT NULL,                     -- first 8 chars for display
  label         TEXT,
  is_revoked    BOOLEAN     NOT NULL DEFAULT FALSE,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user    ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash    ON api_keys(key_hash) WHERE NOT is_revoked;

-- ── usage_log ────────────────────────────────────────────────────
-- One row per successful obfuscate call (no code stored, only metadata).
CREATE TABLE IF NOT EXISTS usage_log (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id    UUID        NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  ip_address    INET        NOT NULL,
  code_size_bytes INT       NOT NULL,
  duration_ms   INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_user_day ON usage_log(user_id, created_at);

-- ── daily_usage ──────────────────────────────────────────────────
-- Materialised counter (upserted on each request) – fast limit checks.
CREATE TABLE IF NOT EXISTS daily_usage (
  user_id     UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_date  DATE    NOT NULL DEFAULT CURRENT_DATE,
  request_count INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

-- ── abuse_flags ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS abuse_flags (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     UUID        REFERENCES users(id) ON DELETE SET NULL,
  ip_address  INET,
  reason      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_abuse_ip ON abuse_flags(ip_address);
CREATE INDEX IF NOT EXISTS idx_abuse_user ON abuse_flags(user_id);

-- ── webhook_events ───────────────────────────────────────────────
-- Idempotency: track processed Stripe events to avoid double-processing.
CREATE TABLE IF NOT EXISTS webhook_events (
  stripe_event_id TEXT    PRIMARY KEY,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── updated_at trigger ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
