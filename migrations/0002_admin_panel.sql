-- 0002_admin_panel.sql
-- Web admin panel + link analytics (2026-11-18).
--
-- Adds the admin panel's session/login-attempt tables, user blocking
-- columns on users, job provenance columns (provider/model/cue_count)
-- and the link_events analytics table. The Worker also self-heals the
-- blocking columns at runtime; this file is the migration of record.

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  username TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  attempted_at INTEGER NOT NULL
);

ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN blocked_at TEXT;

ALTER TABLE jobs ADD COLUMN provider TEXT;
ALTER TABLE jobs ADD COLUMN model TEXT;
ALTER TABLE jobs ADD COLUMN cue_count INTEGER;

CREATE TABLE IF NOT EXISTS link_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  url TEXT NOT NULL,
  domain TEXT,
  source TEXT,
  outcome TEXT NOT NULL DEFAULT 'received',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
