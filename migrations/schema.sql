-- SubTube — طرح کامل فعلی دیتابیس D1 (برای نصب تازه)
-- این فایل وضعیت نهایی همه مهاجرت‌ها (0001 تا 0004) است؛ نصب‌کننده
-- (installer/install.py) همین فایل را اجرا می‌کند. برای دیتابیس‌های
-- موجود، مهاجرت‌های شماره‌دار را به ترتیب اجرا کنید.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  language TEXT DEFAULT 'fa',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  is_blocked INTEGER NOT NULL DEFAULT 0,
  blocked_at TEXT,
  subtitle_lang TEXT NOT NULL DEFAULT 'fa'
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  video_id TEXT NOT NULL,
  video_url TEXT NOT NULL,
  source_language TEXT NOT NULL DEFAULT 'en',
  target_language TEXT NOT NULL DEFAULT 'fa',
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  completed_at TEXT,
  provider TEXT,
  model TEXT,
  cue_count INTEGER
);

CREATE TABLE IF NOT EXISTS user_stats (
  telegram_id INTEGER PRIMARY KEY,
  total_jobs INTEGER NOT NULL DEFAULT 0,
  successful_jobs INTEGER NOT NULL DEFAULT 0,
  failed_jobs INTEGER NOT NULL DEFAULT 0,
  last_job_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

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

CREATE TABLE IF NOT EXISTS platform_users (
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  uid INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (platform, external_id)
);
