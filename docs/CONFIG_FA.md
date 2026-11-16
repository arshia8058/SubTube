# تنظیمات SubTube

همه تنظیمات SubTube از سه جا خوانده می‌شود:

1. **Cloudflare Secrets** — برای کلیدها و توکن‌ها (امن، رمزنگاری‌شده).
2. **متغیرهای ساده (Vars)** — در `wrangler.toml` بخش `[vars]`.
3. **جدول `settings` در دیتابیس D1** — تنظیم‌هایی که بدون Deploy عوض می‌شوند و بر Vars اولویت دارند.

## جدول کامل متغیرها

| نام متغیر | توضیح فارسی | اجباری | نوع |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | توکن ربات تلگرام از BotFather | بله | Secret |
| `TELEGRAM_WEBHOOK_SECRET` | سکرت مشترک با تلگرام برای اعتبارسنجی وبهوک | بله | Secret |
| `SUPADATA_API_KEY` | کلید Supadata؛ مسیر اصلی استخراج زیرنویس | عملاً بله (بدون آن استخراج سخت و کند می‌شود) | Secret |
| `COARENA_API_KEY` | کلید حساب اول Coarena؛ موتور ترجمه پیش‌فرض | اگر ارائه‌دهنده coarena است: بله | Secret |
| `COARENA_API_KEY_2` | کلید حساب دوم Coarena؛ تعویض خودکار هنگام اتمام سهمیه/خطای احراز کلید اول | نه | Secret |
| `GEMINI_API_KEY` | کلید Google Gemini؛ موتور ترجمه دوم و مسیر پشتیبان خلاصه | نه (پیشنهادی) | Secret |
| `DIAG_TOKEN` | توکن مسیر عیب‌یابی `/_diag` | نه (پیشنهادی؛ بدون آن، در سورس فعلی درِ دیاگ برای همه باز نیست ولی بی‌توکن هم صدا زده می‌شود — حتماً بگذارید) | Secret |
| `MAX_CUE_COUNT` | حداکثر تعداد خط زیرنویس قابل پردازش (پیش‌فرض کد: ۱۲۰۰) | نه | Var |
| `MAX_TOTAL_CHARS` | حداکثر مجموع کاراکتر متن زیرنویس (پیش‌فرض کد: ۴۵۰۰۰) | نه | Var |
| `RATE_LIMIT_MAX_PER_HOUR` | سقف پیش‌فرض درخواست ساعتی هر کاربر (پیش‌فرض کد: ۱۰)؛ تنظیم دیتابیس اولویت دارد | نه | Var |
| `TRANSLATION_PROVIDER` | ارائه‌دهنده پیش‌فرض ترجمه (مثل `coarena`)؛ تنظیم دیتابیس اولویت دارد | نه | Var |
| `TRANSLATION_MODEL` | مدل پیش‌فرض ترجمه؛ تنظیم دیتابیس اولویت دارد | نه | Var |

> سکرت `COARENA_API_KEY_2` در Bindingهای آماده Wrangler دیده نمی‌شود چون سکرت‌ها
> در فایل تنظیمات نوشته نمی‌شوند؛ کافی است با `wrangler secret put COARENA_API_KEY_2`
> یا از داشبورد اضافه شود — کد به‌صورت خودکار آن را از محیط می‌خواند.

## Bindingهای Cloudflare

| Binding | نوع | کاربرد |
|---|---|---|
| `DB` | D1 Database | کاربران، پردازش‌ها، آمار و تنظیمات |
| `SUBTITLE_CACHE` | KV Namespace | کش ترجمه (۴۸ ساعت)، وضعیت پیشرفت (۲۴ ساعت)، فایل آماده دانلود، انتخاب‌های در انتظار و پرچم لغو |
| `JOB_QUEUE` | Queue Producer + Consumer | صف `subtube-jobs` برای اجرای پردازش‌های طولانی (batch=1، حداکثر ۲ تلاش مجدد) |

مقادیر نمونه در `wrangler.toml` مخزن آمده است؛ شناسه‌ها را با شناسه‌های حساب خودتان عوض کنید.

## تنظیمات داخل دیتابیس (جدول settings)

| کلید | مقادیر نمونه | اثر |
|---|---|---|
| `translation_provider` | `coarena` / `gemini` | انتخاب موتور ترجمه فعال |
| `translation_model` | `gemini-4-argon` | مدل فعال برای موتور انتخاب‌شده |
| `bot_enabled` | `true` / `false` | خاموش‌کردن فوری ربات بدون Deploy |
| `rate_limit_per_hour` | `10` | سقف ساعتی هر کاربر (بر Var اولویت دارد) |

نمونه تغییر مدل بدون Deploy:

```bash
npx wrangler d1 execute subtube-db --remote \
  --command "INSERT INTO settings (key, value) VALUES ('translation_model','gemini-4-argon') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
```

## کلیدها را از کجا بگیرید؟

| سرویس | راه دریافت |
|---|---|
| تلگرام | ساخت ربات با [@BotFather](https://t.me/BotFather) و دستور `/newbot` |
| Supadata | ثبت‌نام در supadata.ai و ساخت API Key از داشبورد (پلن رایگان دارد) |
| Coarena | ثبت‌نام در coarena.ai و ساخت API Key از پنل |
| Gemini | ساخت کلید در Google AI Studio: aistudio.google.com/apikey |
| Cloudflare | ساخت توکن فقط برای ابزار استقرار جایگزین (`tools/deploy.py`) لازم است: داشبورد → My Profile → API Tokens |

## قوانین امن نگه‌داشتن کلیدها

- کلید واقعی را هرگز در Git، کامنت، Issue یا چت عمومی نگذارید.
- برای هر محیط (تست/اصلی) کلید جدا بسازید.
- اگر کلیدی لو رفت، همان لحظه باطلش کنید و تازه بسازید؛ پاک‌کردن از فایل کافی نیست
  چون در تاریخچه Git می‌ماند.
- فایل `.env.example` مخزن فقط اسم‌ها و مقادیر ساختگی دارد.
