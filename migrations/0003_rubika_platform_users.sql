-- 0003_rubika_platform_users.sql
-- Rubika front-end identity mapping (RUBIKA_PLAN.md).
--
-- All pre-existing tables key users by telegram_id INTEGER, and the
-- data layer coerces ids with Number(...). Rubika chat ids are strings,
-- so each external platform identity is mapped once to a synthetic
-- numeric uid allocated from the reserved range starting at
-- 900000000000000 (PLATFORM_UID_BASE in index.js) — far above any real
-- Telegram id and exactly representable as a JS number and a SQLite
-- INTEGER. The Worker also creates this table IF NOT EXISTS at runtime
-- (ensurePlatformUsersTable); this file is the migration of record.
CREATE TABLE IF NOT EXISTS platform_users (
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  uid INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (platform, external_id)
);
