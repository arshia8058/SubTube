# راهنمای نصب و راه‌اندازی SubTube

> راه سریع‌تر: نصب‌کننده خودکار در [../installer/README_FA.md](../installer/README_FA.md)
> همه قدم‌های همین راهنما را خودش انجام می‌دهد؛ فقط توکن‌ها را از شما می‌گیرد.
> این سند، راه دستی کامل با Wrangler است.

از صفر تا یک ربات فعال، قدم‌به‌قدم. زمان تقریبی: ۱۵ تا ۲۵ دقیقه.

## پیش‌نیازها

- حساب تلگرام
- حساب Cloudflare (رایگان کافی است)
- Node.js نسخه ۱۸ یا بالاتر روی کامپیوتر شما
- (اختیاری ولی پیشنهادی) کلید Supadata و Coarena — در قدم ۷ توضیح داده شده‌اند

## قدم ۱ — ساخت ربات تلگرام

1. در تلگرام به [@BotFather](https://t.me/BotFather) پیام دهید.
2. دستور `/newbot` را بفرستید، یک نام و یک نام کاربری (تمام‌شونده با `bot`) انتخاب کنید.
3. BotFather یک **توکن** می‌دهد؛ آن را مثل رمز نگه دارید. این همان `TELEGRAM_BOT_TOKEN` است.

## قدم ۲ — گرفتن سورس

```bash
git clone https://github.com/arshia8058/SubTube.git
cd SubTube
npm install
```

## قدم ۳ — ورود به Cloudflare و ساخت منابع

```bash
npx wrangler login

# دیتابیس
npx wrangler d1 create subtube-db

# کش
npx wrangler kv namespace create SUBTITLE_CACHE

# صف پردازش
npx wrangler queues create subtube-jobs
```

از خروجی هر دستور، شناسه‌ها را بردارید و در `wrangler.toml` جای مقادیر
`YOUR_D1_DATABASE_ID` و `YOUR_KV_NAMESPACE_ID` بگذارید.

## قدم ۴ — ساخت جدول‌های دیتابیس

```bash
npx wrangler d1 execute subtube-db --remote --file=migrations/schema.sql
```

توضیح جدول‌ها در [CONFIG_FA.md](CONFIG_FA.md) و خود فایل SQL آمده است.

## قدم ۵ — تنظیم سکرت‌ها

حداقل این دو سکرت اجباری‌اند:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

برای `TELEGRAM_WEBHOOK_SECRET` یک رشته تصادفی بلند بسازید (مثلاً ۳۲ کاراکتر)؛
در قدم ۸ دقیقاً همان را به تلگرام می‌دهیم.

سکرت‌های سرویس‌های ترجمه و استخراج (بسته به نیاز — جدول کامل در [CONFIG_FA.md](CONFIG_FA.md)):

```bash
npx wrangler secret put SUPADATA_API_KEY
npx wrangler secret put COARENA_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put DIAG_TOKEN
```

متغیرهای ساده (`MAX_CUE_COUNT` و…) از قبل در بخش `[vars]` فایل `wrangler.toml` هستند.

## قدم ۶ — استقرار Worker

```bash
npx wrangler deploy
```

خروجی، آدرس Worker شما را می‌دهد؛ چیزی شبیه:

```
https://subtube-bot.<your-subdomain>.workers.dev
```

سلامت سرویس را چک کنید: باز کردن همان آدرس در مرورگر باید پاسخ
`{"ok": true, "service": "SubTube Bot", "status": "running"}` بدهد.

> توجه: داخل سورس، یک ثابت برای آدرس عمومی Worker هست (`PROGRESS_BASE_URL`) که
> برای ساخت لینک صفحه پیشرفت استفاده می‌شود. اگر نام Worker یا زیردامنه شما فرق
> دارد، آن را در `src/index.js` با آدرس خودتان عوض کنید و دوباره Deploy کنید.

## قدم ۷ — کلید سرویس‌ها را از کجا بگیرید؟

- **Supadata** — ثبت‌نام در supadata.ai؛ پلن رایگان دارد. کلید از داشبورد گرفته می‌شود.
- **Coarena** — ثبت‌نام در coarena.ai؛ کلید API از پنل کاربری. سهمیه و مدل‌ها در [API_FA.md](API_FA.md).
- **Gemini** — از Google AI Studio یک API Key بسازید (aistudio.google.com/apikey).

بدون این کلیدها هم ربات بالا می‌آید، اما مسیرهای ترجمه/استخراج مربوط به همان سرویس کار نمی‌کنند.

## قدم ۸ — اتصال وبهوک تلگرام

این دستور را با توکن ربات و سکرت قدم ۵ اجرا کنید (آدرس را با آدرس Worker خودتان عوض کنید):

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://subtube-bot.<your-subdomain>.workers.dev/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message", "callback_query"]
  }'
```

پاسخ باید `{"ok": true, "result": true}` باشد.
نکته مهم: `callback_query` حتماً باید در `allowed_updates` باشد، وگرنه دکمه‌های
انتخاب حالت ربات کار نمی‌کنند.

## قدم ۹ — ثبت منوی دستورات (اختیاری اما خوش‌دست)

بعد از اولین Deploy، این آدرس را با توکن عیب‌یابی خودتان باز کنید تا منوی
دستورات تلگرام (دکمه Menu) ثبت شود:

```
https://subtube-bot.<your-subdomain>.workers.dev/_diag?token=<DIAG_TOKEN>&v=jNQXAC9IVRw&mode=setcommands
```

## قدم ۱۰ — آزمایش

1. در تلگرام ربات خودتان را باز کنید و `/start` بفرستید؛ پیام خوش‌آمد فارسی می‌آید.
2. یک لینک یوتیوب کوتاه بفرستید.
3. دکمه‌های انتخاب می‌آیند: «فقط زیرنویس»، «فقط خلاصه» یا «هر دو».
4. پیام پیشرفت زنده به‌روز می‌شود و در پایان فایل `.srt` فارسی می‌رسد.

اگر چیزی کار نکرد، [TROUBLESHOOTING_FA.md](TROUBLESHOOTING_FA.md) را ببینید.

## به‌روزرسانی نسخه

```bash
git pull
npx wrangler deploy
```

قبل از هر Deploy روی نسخه زنده، سیاست بدون پسرفت را رعایت کنید:
[../CONTRIBUTING.md](../CONTRIBUTING.md) و [../DEVELOPMENT_POLICY.md](../DEVELOPMENT_POLICY.md).
