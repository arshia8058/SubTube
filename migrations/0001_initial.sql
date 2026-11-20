-- SubTube — ساختار دیتابیس D1 (SQLite)
-- =====================================================
-- این فایل از روی کوئری‌های واقعی داخل سورس (src/index.js) بازسازی شده است؛
-- یعنی دقیقاً همان جدول‌ها و ستون‌هایی که کد استفاده می‌کند.
-- اجرا:  wrangler d1 execute <DB_NAME> --remote --file=migrations/schema.sql
-- یا در داشبورد Cloudflare: D1 → دیتابیس شما → Console → چسباندن همین متن.

-- کاربران ربات
CREATE TABLE IF NOT EXISTS users (
  telegram_id    INTEGER PRIMARY KEY,          -- شناسه عددی کاربر در تلگرام
  username       TEXT,                          -- نام کاربری تلگرام (ممکن است خالی باشد)
  first_name     TEXT,                          -- نام نمایشی کاربر
  language       TEXT DEFAULT 'fa',             -- زبان کاربر در تلگرام
  created_at     TEXT,                          -- زمان اولین استفاده (ISO, UTC)
  last_active_at TEXT                           -- زمان آخرین فعالیت (ISO, UTC)
);

-- پردازش‌ها (هر ردیف = یک درخواست ترجمه زیرنویس)
CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id     INTEGER NOT NULL,             -- صاحب درخواست
  video_id        TEXT NOT NULL,                -- شناسه ۱۱کاراکتری ویدیوی یوتیوب
  video_url       TEXT,                         -- لینک استاندارد ویدیو
  source_language TEXT DEFAULT 'en',            -- زبان زیرنویس مبدأ
  target_language TEXT DEFAULT 'fa',            -- زبان مقصد (فارسی)
  status          TEXT NOT NULL DEFAULT 'processing',  -- processing | completed | failed
  error_message   TEXT,                         -- دلیل خطا (کوتاه و پاک‌سازی‌شده)
  created_at      TEXT,                         -- زمان ساخت (ISO, UTC)
  completed_at    TEXT                          -- زمان پایان (ISO, UTC)
);
CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs (telegram_id, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user_video_status ON jobs (telegram_id, video_id, status);

-- آمار تجمیعی هر کاربر
CREATE TABLE IF NOT EXISTS user_stats (
  telegram_id     INTEGER PRIMARY KEY,
  total_jobs      INTEGER NOT NULL DEFAULT 0,   -- کل درخواست‌ها
  successful_jobs INTEGER NOT NULL DEFAULT 0,   -- موفق‌ها
  failed_jobs     INTEGER NOT NULL DEFAULT 0,   -- ناموفق‌ها
  last_job_at     TEXT                          -- زمان آخرین درخواست (ISO, UTC)
);

-- تنظیمات کلیدی ربات (key/value) — کد این کلیدها را می‌خواند:
--   translation_provider : ارائه‌دهنده ترجمه (مثلاً coarena یا gemini)
--   translation_model    : مدل ترجمه (مثلاً gemini-4-argon)
--   bot_enabled          : روشن/خاموش بودن ربات ('true' / 'false')
--   rate_limit_per_hour  : سقف درخواست ساعتی هر کاربر (عدد)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- نمونه تنظیمات اولیه (اختیاری — مقادیر پیش‌فرض کد هم بدون این ردیف‌ها کار می‌کند):
-- INSERT OR IGNORE INTO settings (key, value) VALUES ('bot_enabled', 'true');
-- INSERT OR IGNORE INTO settings (key, value) VALUES ('translation_provider', 'coarena');
-- INSERT OR IGNORE INTO settings (key, value) VALUES ('translation_model', 'gemini-4-argon');
