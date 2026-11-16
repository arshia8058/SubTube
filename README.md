<div dir="rtl">

# SubTube — ربات تلگرام ترجمه زیرنویس یوتیوب به فارسی

**SubTube** یک ربات تلگرام متن‌باز است: لینک یک ویدیوی یوتیوب را می‌فرستید،
زیرنویسش استخراج می‌شود، به فارسی ترجمه می‌شود و فایل **SRT** آماده به دستتان می‌رسد —
همراه با امکان دریافت **خلاصه فارسی** ویدیو. همه‌چیز روی **Cloudflare Workers**
اجرا می‌شود؛ بدون سرور، بدون هزینه نگه‌داری دائمی.

[English README](README_EN.md) · [راهنمای نصب](docs/INSTALL_FA.md) · [معماری](docs/ARCHITECTURE_FA.md) · [تنظیمات](docs/CONFIG_FA.md) · [APIها](docs/API_FA.md) · [رفع اشکال](docs/TROUBLESHOOTING_FA.md)

## چطور کار می‌کند؟

1. لینک یوتیوب را برای ربات می‌فرستید (تا ۳ لینک در یک پیام).
2. ربات با دکمه می‌پرسد: **فقط زیرنویس**، **فقط خلاصه** یا **هر دو**.
3. پردازش داخل صف Cloudflare انجام می‌شود و درصد پیشرفت زنده در همان پیام دیده می‌شود.
4. زیرنویس استخراج و به فارسی ترجمه می‌شود و فایل `.srt` تحویلتان داده می‌شود.

## امکانات

- 🎬 استخراج زیرنویس با چند مسیر (Supadata + مسیرهای مستقیم یوتیوب و Invidious)
- 🌍 تشخیص زبان مبدأ؛ پشتیبانی از ویدیوهای غیرانگلیسی و عبور مستقیم زیرنویس فارسی آماده
- 🧠 سه موتور ترجمه با جایگزینی خودکار: **Coarena** ← **Gemini** ← **Google Translate**
- 🔑 استخر دو کلید Coarena با تعویض خودکار هنگام اتمام سهمیه
- 🧩 ترجمه شناسه‌محور: هر خط با شناسه خودش ترجمه می‌شود تا ترتیب و زمان‌بندی هرگز به‌هم نریزد
- 📝 خلاصه فارسی ویدیو (اختیاری، کنار زیرنویس یا به‌تنهایی)
- 📊 پیشرفت زنده در تلگرام + صفحه وب اختصاصی برای هر پردازش
- ⚡ کش ۴۸ ساعته: درخواست تکراری یک ویدیو فوری جواب می‌گیرد
- 📨 تحویل سه‌پله‌ای فایل (لینک دانلود ← آپلود ← متن تکه‌تکه) برای روزهای اختلال تلگرام
- 🛡️ سقف ساعتی هر کاربر، جلوگیری از پردازش تکراری هم‌زمان، لغو با `/cancel`
- 📋 دستورات کامل: `/start` `/translate` `/status` `/history` `/usage` `/stats` `/help` `/about` `/cancel`

## تکنولوژی‌ها

| بخش | فناوری |
|---|---|
| اجرا | Cloudflare Workers (JavaScript, ES Modules) |
| صف پردازش | Cloudflare Queues |
| دیتابیس | Cloudflare D1 (SQLite) |
| کش و وضعیت | Cloudflare KV |
| استخراج زیرنویس | Supadata API + YouTube Innertube / Timedtext / Invidious |
| ترجمه | Coarena (OpenAI-compatible) · Google Gemini · Google Translate |
| رابط کاربر | Telegram Bot API |

## شروع سریع — نصب خودکار (پیشنهادی)

یک اسکریپت پایتونی روی کامپیوتر خودتان اجرا می‌شود، توکن کلادفلر را می‌گیرد و
همه‌چیز (دیتابیس، KV، صف، Worker، سکرت‌ها، وبهوک تلگرام) را خودش می‌سازد:

```bash
git clone https://github.com/arshia8058/SubTube.git
cd SubTube
python3 installer/install.py
```

جزئیات و نکات امنیتی: [installer/README_FA.md](installer/README_FA.md)

## شروع سریع — نصب دستی با Wrangler

```bash
git clone https://github.com/arshia8058/SubTube.git
cd SubTube
npm install
npx wrangler login
npx wrangler d1 create subtube-db
npx wrangler kv namespace create SUBTITLE_CACHE
npx wrangler queues create subtube-jobs
npx wrangler d1 execute subtube-db --remote --file=migrations/schema.sql
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler deploy
```

بعد وبهوک تلگرام را ثبت کنید و تست بگیرید — آموزش کامل و قدم‌به‌قدم در
[docs/INSTALL_FA.md](docs/INSTALL_FA.md) است.

## ساختار مخزن

```
SubTube/
├── src/
│   └── index.js          # سورس کامل Worker (باندل‌شده، همان نسخه در حال اجرا)
├── migrations/
│   └── schema.sql        # ساختار دیتابیس D1، بازسازی‌شده از روی کوئری‌های واقعی کد
├── tests/                # ۱۲ سوئیت تست آفلاین + سازنده باندل تست
├── tools/
│   └── deploy.py         # ابزار جایگزین استقرار با API کلادفلر (پاک‌سازی‌شده)
├── docs/                 # مستندات فارسی کامل
├── wrangler.toml         # تنظیمات استقرار (با شناسه‌های نمونه)
├── .env.example          # فهرست متغیرها با مقادیر ساختگی
└── DEVELOPMENT_POLICY.md # سیاست «بدون پسرفت» پروژه
```

نکته شفافیت: سورس SubTube در نسخه زنده به‌صورت یک فایل باندل‌شده اجرا می‌شود و
داخل خودش بخش‌های ماژول اصلی با نشانگر `// src/...` مشخص‌اند. برای وفاداری به
نسخه واقعی، همان فایل بدون بازنویسی منتشر شده است؛ نقشه کامل بخش‌ها و توابع در
[docs/ARCHITECTURE_FA.md](docs/ARCHITECTURE_FA.md) آمده است.

## امنیت

هیچ کلید یا توکن واقعی در این مخزن نیست و نباید باشد. سکرت‌ها فقط از راه
Cloudflare Secrets تنظیم می‌شوند. جزئیات در [SECURITY.md](SECURITY.md) و
[docs/CONFIG_FA.md](docs/CONFIG_FA.md).

## مشارکت

از مشارکت استقبال می‌شود! اول [CONTRIBUTING.md](CONTRIBUTING.md) را بخوانید؛
مهم‌ترین قانون پروژه: **همه تست‌ها، قبل و بعد از تغییر، سبز.**

## مجوز

منتشرشده تحت مجوز [MIT](LICENSE).

</div>
