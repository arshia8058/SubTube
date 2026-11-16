#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
نصب‌کننده خودکار SubTube — ربات تلگرام ترجمه زیرنویس یوتیوب به فارسی

این اسکریپت روی کامپیوتر خودتان اجرا می‌شود و با یک توکن API کلادفلر، همه‌چیز
را خودش می‌سازد و راه می‌اندازد:

    ۱) دیتابیس D1 و جدول‌هایش        ۴) استقرار Worker با همه Bindingها
    ۲) فضای KV                       ۵) تنظیم سکرت‌ها (از جمله ساخت خودکار
    ۳) صف پردازش (Queue)                سکرت وبهوک و توکن دیاگ)
                                     ۶) ثبت وبهوک و منوی دستورات تلگرام
                                     ۷) تست سلامت نهایی

امنیت:
- توکن کلادفلر و بقیه کلیدها فقط در حافظه همین اجرا هستند؛ هیچ‌جا ذخیره،
  لاگ یا ارسال نمی‌شوند (تنها مقصدها: api.cloudflare.com و api.telegram.org).
- ورودی کلیدها با getpass گرفته می‌شود تا روی صفحه دیده نشوند.
- سورس همین فایل باز است؛ قبل از اجرا می‌توانید همه‌اش را بخوانید.

اجرا:
    python3 installer/install.py            # نصب کامل، قدم‌به‌قدم
    python3 installer/install.py --dry-run  # فقط نمایش نقشه نصب، بدون هیچ تغییری
    python3 installer/install.py --self-test# تست آفلاین بخش‌های داخلی اسکریپت

نیازمندی: فقط پایتون ۳٫۸ یا بالاتر؛ هیچ کتابخانه‌ای لازم نیست.
"""

import getpass
import json
import os
import secrets as secrets_module
import sys
import urllib.error
import urllib.request

CF_BASE = "https://api.cloudflare.com/client/v4"
TG_BASE = "https://api.telegram.org"

SCRIPT_NAME = "subtube-bot"
DB_NAME = "subtube-db"
KV_TITLE = "SUBTITLE_CACHE"
QUEUE_NAME = "subtube-jobs"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_PATH = os.path.join(ROOT, "src", "index.js")
SCHEMA_PATH = os.path.join(ROOT, "migrations", "schema.sql")

# آدرس عمومی نسخه مرجع داخل سورس؛ هنگام نصب با آدرس Worker کاربر جایگزین می‌شود
REFERENCE_BASE_URL = "https://subtube-bot.hsdoebc.workers.dev"

PLAIN_VARS = {
    "MAX_CUE_COUNT": "1200",
    "MAX_TOTAL_CHARS": "45000",
    "RATE_LIMIT_MAX_PER_HOUR": "10",
}

DRY_RUN = "--dry-run" in sys.argv


# ---------------------------------------------------------------- ابزار پایه
def say(msg=""):
    print(msg)


def step(n, title):
    say(f"\n── قدم {n}: {title}")


def fail(msg):
    say(f"\n❌ {msg}")
    sys.exit(1)


def http_json(method, url, token=None, body=None, timeout=60):
    """یک درخواست JSON می‌فرستد و پاسخ را به‌صورت دیکشنری برمی‌گرداند."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            return {"success": False, "errors": [{"message": f"HTTP {e.code}"}]}
    except Exception as e:  # خطای شبکه
        return {"success": False, "errors": [{"message": str(e)}]}


def cf(token, method, path, body=None):
    return http_json(method, CF_BASE + path, token=token, body=body)


def errors_text(res):
    errs = res.get("errors") or []
    return "; ".join(str(e.get("message", e)) for e in errs) or "خطای نامشخص"


def token_create_link():
    """لینک آماده ساخت توکن کلادفلر با دسترسی‌های لازم (فقط ویرایشی، محدود)."""
    groups = [
        {"key": "workers_scripts", "type": "edit"},
        {"key": "workers_kv_storage", "type": "edit"},
        {"key": "d1", "type": "edit"},
        {"key": "queues", "type": "edit"},
        {"key": "account_settings", "type": "read"},
    ]
    from urllib.parse import quote
    return ("https://dash.cloudflare.com/profile/api-tokens"
            f"?permissionGroupKeys={quote(json.dumps(groups))}"
            "&name=SubTube%20Installer")


# ------------------------------------------------------- قطعه‌های قابل تست
def split_sql(sql_text):
    """فایل schema.sql را به دستورهای جدا تقسیم می‌کند (کامنت‌ها حذف می‌شوند)."""
    lines = []
    for line in sql_text.splitlines():
        if line.strip().startswith("--"):
            continue
        lines.append(line)
    joined = "\n".join(lines)
    return [s.strip() for s in joined.split(";") if s.strip()]


def patch_worker_code(code, worker_base_url):
    """آدرس عمومی نسخه مرجع را با آدرس Worker کاربر جایگزین می‌کند."""
    return code.replace(REFERENCE_BASE_URL, worker_base_url)


def build_bindings(db_id, kv_id):
    bindings = [
        {"name": "DB", "type": "d1", "database_id": db_id},
        {"name": "SUBTITLE_CACHE", "type": "kv_namespace", "namespace_id": kv_id},
        {"name": "JOB_QUEUE", "type": "queue", "queue_name": QUEUE_NAME},
    ]
    for name, text in PLAIN_VARS.items():
        bindings.append({"name": name, "type": "plain_text", "text": text})
    return bindings


# ------------------------------------------------------------------ مراحل نصب
def choose_account(token):
    res = cf(token, "GET", "/accounts?per_page=50")
    if not res.get("success") or not res.get("result"):
        fail(f"خواندن حساب‌های کلادفلر نشد: {errors_text(res)}\n"
             "مطمئن شوید توکن دسترسی Account Settings (خواندن) دارد.")
    accounts = res["result"]
    if len(accounts) == 1:
        say(f"حساب: {accounts[0]['name']}")
        return accounts[0]["id"]
    say("چند حساب پیدا شد؛ شماره حساب موردنظر را انتخاب کنید:")
    for i, acc in enumerate(accounts, 1):
        say(f"  {i}) {acc['name']}")
    while True:
        raw = input("شماره: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(accounts):
            return accounts[int(raw) - 1]["id"]


def ensure_d1(token, account):
    res = cf(token, "GET", f"/accounts/{account}/d1/database?per_page=100")
    for db in (res.get("result") or []):
        if db.get("name") == DB_NAME:
            say(f"دیتابیس {DB_NAME} از قبل هست؛ همان استفاده می‌شود.")
            return db["uuid"]
    if DRY_RUN:
        say(f"[dry-run] دیتابیس {DB_NAME} ساخته می‌شد.")
        return "DRY-RUN-DB-ID"
    res = cf(token, "POST", f"/accounts/{account}/d1/database", {"name": DB_NAME})
    if not res.get("success"):
        fail(f"ساخت دیتابیس نشد: {errors_text(res)}")
    say(f"دیتابیس {DB_NAME} ساخته شد.")
    return res["result"]["uuid"]


def run_schema(token, account, db_id):
    sql = open(SCHEMA_PATH, encoding="utf-8").read()
    statements = split_sql(sql)
    if DRY_RUN:
        say(f"[dry-run] {len(statements)} دستور SQL روی دیتابیس اجرا می‌شد.")
        return
    for stmt in statements:
        res = cf(token, "POST", f"/accounts/{account}/d1/database/{db_id}/query",
                 {"sql": stmt})
        if not res.get("success"):
            fail(f"اجرای SQL نشد: {errors_text(res)}\nدستور: {stmt[:80]}…")
    say(f"جدول‌های دیتابیس آماده شدند ({len(statements)} دستور).")


def ensure_kv(token, account):
    res = cf(token, "GET", f"/accounts/{account}/storage/kv/namespaces?per_page=100")
    for ns in (res.get("result") or []):
        if ns.get("title") == KV_TITLE:
            say(f"فضای KV به نام {KV_TITLE} از قبل هست؛ همان استفاده می‌شود.")
            return ns["id"]
    if DRY_RUN:
        say(f"[dry-run] فضای KV به نام {KV_TITLE} ساخته می‌شد.")
        return "DRY-RUN-KV-ID"
    res = cf(token, "POST", f"/accounts/{account}/storage/kv/namespaces",
             {"title": KV_TITLE})
    if not res.get("success"):
        fail(f"ساخت KV نشد: {errors_text(res)}")
    say(f"فضای KV ساخته شد.")
    return res["result"]["id"]


def ensure_queue(token, account):
    res = cf(token, "GET", f"/accounts/{account}/queues?per_page=100")
    for q in (res.get("result") or []):
        if q.get("queue_name") == QUEUE_NAME:
            say(f"صف {QUEUE_NAME} از قبل هست؛ همان استفاده می‌شود.")
            return q["queue_id"]
    if DRY_RUN:
        say(f"[dry-run] صف {QUEUE_NAME} ساخته می‌شد.")
        return "DRY-RUN-QUEUE-ID"
    res = cf(token, "POST", f"/accounts/{account}/queues", {"queue_name": QUEUE_NAME})
    if not res.get("success"):
        fail(f"ساخت صف نشد: {errors_text(res)}")
    say("صف پردازش ساخته شد.")
    return res["result"]["queue_id"]


def ensure_subdomain(token, account):
    res = cf(token, "GET", f"/accounts/{account}/workers/subdomain")
    sub = (res.get("result") or {}).get("subdomain")
    if sub:
        return sub
    say("این حساب هنوز زیردامنه workers.dev ندارد.")
    name = input("یک نام برای زیردامنه انتخاب کنید (فقط حروف، عدد و خط تیره): ").strip()
    if not name:
        fail("بدون زیردامنه نمی‌شود ادامه داد.")
    if DRY_RUN:
        return name
    res = cf(token, "POST", f"/accounts/{account}/workers/subdomain",
             {"subdomain": name})
    if not res.get("success"):
        fail(f"ثبت زیردامنه نشد: {errors_text(res)}")
    return name


def deploy_worker(token, account, db_id, kv_id, worker_base_url):
    code = open(SRC_PATH, encoding="utf-8").read()
    code = patch_worker_code(code, worker_base_url)
    metadata = {
        "main_module": "index.js",
        "compatibility_date": "2024-11-01",
        "usage_model": "standard",
        "bindings": build_bindings(db_id, kv_id),
    }
    if DRY_RUN:
        say(f"[dry-run] Worker روی {worker_base_url} نصب می‌شد "
            f"({len(code)} کاراکتر، {len(metadata['bindings'])} binding).")
        return
    boundary = "----subtube-installer"
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\n"
                 f"Content-Type: application/json\r\n\r\n".encode()
                 + json.dumps(metadata).encode() + b"\r\n")
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"index.js\"; "
                 f"filename=\"index.js\"\r\nContent-Type: "
                 f"application/javascript+module\r\n\r\n".encode()
                 + code.encode() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    url = f"{CF_BASE}/accounts/{account}/workers/scripts/{SCRIPT_NAME}"
    req = urllib.request.Request(url, data=b"".join(parts), method="PUT")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            out = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        out = json.loads(e.read().decode("utf-8", "replace"))
    if not out.get("success"):
        fail(f"نصب Worker نشد: {errors_text(out)}")
    say("Worker نصب شد.")


def attach_queue_consumer(token, account, queue_id):
    if DRY_RUN:
        say("[dry-run] مصرف‌کننده صف به Worker وصل می‌شد.")
        return
    res = cf(token, "POST", f"/accounts/{account}/queues/{queue_id}/consumers",
             {"script": SCRIPT_NAME,
              "settings": {"batch_size": 1, "max_retries": 2}})
    if res.get("success"):
        say("مصرف‌کننده صف وصل شد.")
    else:
        say("⚠️ وصل‌کردن خودکار مصرف‌کننده صف نشد؛ دستی انجامش دهید:")
        say("   داشبورد Cloudflare → Queues → subtube-jobs → Consumers → "
            "Add consumer → انتخاب subtube-bot")
        say(f"   (دلیل: {errors_text(res)})")


def put_secret(token, account, name, value):
    if DRY_RUN:
        say(f"[dry-run] سکرت {name} تنظیم می‌شد.")
        return
    res = cf(token, "PUT",
             f"/accounts/{account}/workers/scripts/{SCRIPT_NAME}/secrets",
             {"name": name, "text": value, "type": "secret_text"})
    if not res.get("success"):
        fail(f"تنظیم سکرت {name} نشد: {errors_text(res)}")


def telegram(method, bot_token, payload):
    return http_json("POST", f"{TG_BASE}/bot{bot_token}/{method}", body=payload)


# -------------------------------------------------------------------- اصلی
def ask_secret(label, required=True):
    while True:
        value = getpass.getpass(f"{label}: ").strip()
        if value or not required:
            return value
        say("این مورد اجباری است؛ خالی نمی‌شود ردش کرد.")


def main():
    say("🤖 نصب‌کننده خودکار SubTube")
    say("این برنامه روی کامپیوتر خودتان اجرا می‌شود؛ هیچ کلیدی جایی ذخیره نمی‌شود.")
    if DRY_RUN:
        say("حالت dry-run: هیچ تغییری در هیچ حسابی ساخته نمی‌شود.")

    step(1, "توکن API کلادفلر")
    say("اگر توکن ندارید، با این لینک آماده بسازید (دسترسی‌ها محدود و دقیق‌اند):")
    say(f"  {token_create_link()}")
    say("اگر لینک باز نشد، دستی یک توکن بسازید با این دسترسی‌های ویرایشی:")
    say("  Workers Scripts ،Workers KV Storage ،D1 ،Queues + خواندن Account Settings")
    cf_token = ask_secret("توکن کلادفلر را وارد کنید (دیده نمی‌شود)")
    verify = cf(cf_token, "GET", "/user/tokens/verify")
    if not verify.get("success"):
        fail(f"توکن معتبر نیست: {errors_text(verify)}")
    say("توکن تأیید شد ✅")
    account = choose_account(cf_token)

    step(2, "توکن ربات تلگرام و کلیدهای سرویس‌ها")
    bot_token = ask_secret("توکن ربات تلگرام (از BotFather)")
    me = telegram("getMe", bot_token, {})
    if not me.get("ok"):
        fail("توکن ربات تلگرام جواب نداد؛ دوباره بررسی کنید.")
    say(f"ربات تأیید شد: @{me['result'].get('username', '')} ✅")
    supadata = ask_secret("کلید Supadata (خالی = رد شدن، ولی استخراج سخت می‌شود)",
                          required=False)
    coarena = ask_secret("کلید Coarena (خالی = رد شدن)", required=False)
    coarena2 = ask_secret("کلید دوم Coarena (اختیاری)", required=False)
    gemini = ask_secret("کلید Gemini (اختیاری)", required=False)
    if not (supadata or coarena or gemini):
        say("⚠️ هیچ کلید استخراج/ترجمه‌ای ندادید؛ ربات بالا می‌آید ولی عملاً "
            "زیرنویس و ترجمه‌ای انجام نمی‌شود.")

    webhook_secret = secrets_module.token_hex(24)
    diag_token = secrets_module.token_hex(24)
    say("سکرت وبهوک و توکن دیاگ به‌صورت تصادفی ساخته شدند (لازم نیست جایی بنویسید).")

    step(3, "ساخت دیتابیس و جدول‌ها")
    db_id = ensure_d1(cf_token, account)
    run_schema(cf_token, account, db_id)

    step(4, "ساخت KV و صف")
    kv_id = ensure_kv(cf_token, account)
    queue_id = ensure_queue(cf_token, account)

    step(5, "نصب Worker و تنظیم سکرت‌ها")
    subdomain = ensure_subdomain(cf_token, account)
    worker_base = f"https://{SCRIPT_NAME}.{subdomain}.workers.dev"
    deploy_worker(cf_token, account, db_id, kv_id, worker_base)
    attach_queue_consumer(cf_token, account, queue_id)
    all_secrets = {
        "TELEGRAM_BOT_TOKEN": bot_token,
        "TELEGRAM_WEBHOOK_SECRET": webhook_secret,
        "DIAG_TOKEN": diag_token,
    }
    if supadata:
        all_secrets["SUPADATA_API_KEY"] = supadata
    if coarena:
        all_secrets["COARENA_API_KEY"] = coarena
    if coarena2:
        all_secrets["COARENA_API_KEY_2"] = coarena2
    if gemini:
        all_secrets["GEMINI_API_KEY"] = gemini
    for name, value in all_secrets.items():
        put_secret(cf_token, account, name, value)
    say(f"{len(all_secrets)} سکرت تنظیم شد.")

    step(6, "ثبت وبهوک و منوی دستورات تلگرام")
    if DRY_RUN:
        say(f"[dry-run] وبهوک روی {worker_base}/webhook ثبت می‌شد.")
    else:
        hook = telegram("setWebhook", bot_token, {
            "url": f"{worker_base}/webhook",
            "secret_token": webhook_secret,
            "allowed_updates": ["message", "callback_query"],
        })
        if not hook.get("ok"):
            fail(f"ثبت وبهوک نشد: {hook.get('description', hook)}")
        say("وبهوک ثبت شد ✅")
        diag = http_json("GET", f"{worker_base}/_diag?token={diag_token}"
                                "&v=jNQXAC9IVRw&mode=setcommands")
        if diag.get("ok"):
            say("منوی دستورات تلگرام ثبت شد ✅")
        else:
            say("⚠️ ثبت منوی دستورات نشد (ربات بدون منو هم کامل کار می‌کند).")

    step(7, "تست سلامت")
    if DRY_RUN:
        say("[dry-run] تمام شد؛ هیچ تغییری ساخته نشد.")
        return
    health = http_json("GET", worker_base + "/health")
    if health.get("ok"):
        say("\n🎉 تمام شد! SubTube شما آماده است.")
        say(f"   آدرس Worker: {worker_base}")
        say("   حالا در تلگرام رباتتان را باز کنید، /start بفرستید "
            "و یک لینک یوتیوب تست کنید.")
    else:
        say("\n⚠️ Worker نصب شد ولی تست سلامت جواب نداد؛ چند دقیقه دیگر "
            f"این آدرس را در مرورگر چک کنید: {worker_base}/health")


def self_test():
    sql = ("-- comment\nCREATE TABLE a (id INTEGER);\n"
           "CREATE INDEX i ON a(id);\n\nINSERT INTO a VALUES (1);")
    stmts = split_sql(sql)
    assert len(stmts) == 3 and stmts[0].startswith("CREATE TABLE"), stmts
    patched = patch_worker_code(f"x {REFERENCE_BASE_URL}/webhook y",
                                 "https://w.example.workers.dev")
    assert patched == "x https://w.example.workers.dev/webhook y", patched
    bindings = build_bindings("db", "kv")
    names = [b["name"] for b in bindings]
    assert names == ["DB", "SUBTITLE_CACHE", "JOB_QUEUE",
                     "MAX_CUE_COUNT", "MAX_TOTAL_CHARS",
                     "RATE_LIMIT_MAX_PER_HOUR"], names
    link = token_create_link()
    assert link.startswith("https://dash.cloudflare.com/profile/api-tokens"), link
    schema = open(SCHEMA_PATH, encoding="utf-8").read()
    schema_stmts = split_sql(schema)
    assert len(schema_stmts) >= 6, len(schema_stmts)
    src = open(SRC_PATH, encoding="utf-8").read()
    assert REFERENCE_BASE_URL in src, "reference URL missing from source"
    print(f"self-test OK ✅  (schema statements: {len(schema_stmts)})")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        main()
