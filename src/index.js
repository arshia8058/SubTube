/*
 * SubTube — ربات تلگرام ترجمه زیرنویس یوتیوب به فارسی
 * =====================================================
 * این فایل، نسخه کامل و واقعی Worker در حال اجرای SubTube روی Cloudflare Workers است.
 * سورس به‌صورت یک فایل باندل‌شده (bundled) منتشر می‌شود؛ دقیقاً همان‌طور که روی
 * Cloudflare اجرا می‌شود. بخش‌های داخلی با نشانگرهای «// src/...» از هم جدا شده‌اند
 * که نقشه ماژول‌های اصلی پروژه را نشان می‌دهند:
 *
 *   src/utils/validation.js      اعتبارسنجی و استخراج شناسه ویدیو از لینک یوتیوب
 *   src/telegram/webhook.js      بررسی سکرت وبهوک تلگرام و ساخت کلاینت تلگرام
 *   src/telegram/messages.js     متن پیام‌های فارسی ربات
 *   src/utils/errors.js          پاک‌سازی پیام خطا برای نمایش امن
 *   src/database/users.js        کاربران و تنظیمات (D1)
 *   src/database/jobs.js         چرخه عمر پردازش‌ها (D1)
 *   src/database/stats.js        آمار هر کاربر (D1)
 *   src/youtube/parser.js        تجزیه فرمت‌های زیرنویس (VTT / JSON3 / XML)
 *   src/youtube/extractor.js     استخراج زیرنویس از یوتیوب و سرویس‌های جایگزین
 *   src/translator/...           موتورهای ترجمه: Coarena ،Gemini و Google Translate
 *   src/subtitle/srt-generator.js ساخت فایل SRT استاندارد
 *   src/telegram/handlers.js     منطق اصلی ربات، دستورات، صف پردازش و پیشرفت کار
 *   src/index.js                 نقطه ورود Worker (fetch + queue)
 *
 * هیچ کلید یا سکرت واقعی در این فایل وجود ندارد؛ همه از متغیرهای محیطی /
 * Cloudflare Secrets خوانده می‌شوند (فایل .env.example و docs/CONFIG_FA.md).
 */

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/utils/validation.js
var VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
var YOUTUBE_HOSTS = /* @__PURE__ */ new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be"
]);
// فارسی: لینک یوتیوب را از متن کاربر پیدا می‌کند و شناسه ۱۱کاراکتری ویدیو را برمی‌گرداند.
function parseYouTubeUrl(inputText) {
  if (!inputText || typeof inputText !== "string") {
    return null;
  }
  const trimmed = inputText.trim();
  const urlMatch = trimmed.match(/https?:\/\/[^\s<>"]+|(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s<>"]+/i);
  const candidate = urlMatch ? urlMatch[0] : trimmed;
  const normalized = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  let url;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    return null;
  }
  let videoId = null;
  if (host === "youtu.be" || host === "www.youtu.be") {
    const seg = url.pathname.split("/").filter(Boolean)[0];
    if (seg) videoId = seg;
  } else {
    const vParam = url.searchParams.get("v");
    if (vParam) {
      videoId = vParam;
    } else {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && ["shorts", "embed", "live", "v"].includes(parts[0])) {
        videoId = parts[1];
      }
    }
  }
  if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
    return null;
  }
  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`
  };
}
__name(parseYouTubeUrl, "parseYouTubeUrl");
// فارسی: حداکثر ۳ لینک یکتای یوتیوب را از یک پیام استخراج می‌کند.
function parseAllYouTubeUrls(inputText, maxLinks = 3) {
  if (!inputText || typeof inputText !== "string") return { links: [], truncated: false };
  const candidates = inputText.match(/https?:\/\/[^\s<>"]+|(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s<>"]+/gi) || [];
  const seen = new Set();
  const links = [];
  let total = 0;
  for (const cand of candidates) {
    const parsed = parseYouTubeUrl(cand);
    if (!parsed || seen.has(parsed.videoId)) continue;
    seen.add(parsed.videoId);
    total++;
    if (links.length < maxLinks) links.push(parsed);
  }
  if (!links.length) {
    const single = parseYouTubeUrl(inputText);
    if (single) return { links: [single], truncated: false };
  }
  return { links, truncated: total > maxLinks };
}
__name(parseAllYouTubeUrls, "parseAllYouTubeUrls");
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}
__name(timingSafeEqualStr, "timingSafeEqualStr");

// src/telegram/webhook.js
function verifyTelegramSecret(request, expectedSecret) {
  if (!expectedSecret) {
    return false;
  }
  const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  return timingSafeEqualStr(headerSecret, expectedSecret);
}
__name(verifyTelegramSecret, "verifyTelegramSecret");
// فارسی: کلاینت ساده تلگرام؛ همه فراخوانی‌های Bot API از همین‌جا انجام می‌شود.
function createTelegramClient(botToken) {
  const apiBase = `https://api.telegram.org/bot${botToken}`;
  async function callApi(method, payload) {
    try {
      const res = await fetchWithTimeout(`${apiBase}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }, 15e3);
      const data = await res.json().catch(() => null);
      return { ok: res.ok && data?.ok, result: data?.result, description: data?.description };
    } catch (err) {
      console.error(`[telegram] ${method} failed: ${errName(err)}`);
      return { ok: false, result: null, description: "network_timeout" };
    }
  }
  __name(callApi, "callApi");
  return {
    async sendMessage(chatId, text, extra = {}) {
      return callApi("sendMessage", {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...extra
      });
    },
    async editMessageText(chatId, messageId, text, extra = {}) {
      if (!messageId) return { ok: false };
      return callApi("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
        ...extra
      });
    },
    async deleteMessage(chatId, messageId) {
      if (!messageId) return { ok: false };
      return callApi("deleteMessage", {
        chat_id: chatId,
        message_id: messageId
      });
    },
    async answerCallbackQuery(callbackQueryId, text = "") {
      return callApi("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: text || void 0
      });
    },
    async sendSrtDocument(chatId, srtContent, caption, replyToMessageId = null, timeoutMs = 45e3) {
      const formData = new FormData();
      formData.append("chat_id", String(chatId));
      if (caption) {
        formData.append("caption", caption);
      }
      if (replyToMessageId) {
        formData.append("reply_to_message_id", String(replyToMessageId));
      }
      const blob = new Blob([srtContent], { type: "application/x-subrip; charset=utf-8" });
      formData.append("document", blob, "subtitle.fa.srt");
      const res = await fetchWithTimeout(`${apiBase}/sendDocument`, {
        method: "POST",
        body: formData
      }, timeoutMs);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(`TELEGRAM_SEND_DOC_FAILED: ${data?.description || res.status}`);
      }
      return data.result;
    },
    async sendDocumentByUrl(chatId, url, caption, replyToMessageId = null) {
      const payload = { chat_id: chatId, document: url };
      if (caption) {
        payload.caption = caption;
      }
      if (replyToMessageId) {
        payload.reply_to_message_id = replyToMessageId;
      }
      const res = await fetchWithTimeout(`${apiBase}/sendDocument`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }, 2e4);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(`TELEGRAM_SEND_DOC_URL_FAILED: ${data?.description || res.status}`);
      }
      return data.result;
    }
  };
}
__name(createTelegramClient, "createTelegramClient");

// src/telegram/messages.js
var MESSAGES = {
  welcome: /* @__PURE__ */ __name((firstName) => `\u0633\u0644\u0627\u0645${firstName ? ` ${firstName}` : ""}! \u0628\u0647 SubTube \u062E\u0648\u0634 \u0622\u0645\u062F\u06CC.

\u0628\u0627 \u0627\u0631\u0633\u0627\u0644 \u0644\u06CC\u0646\u06A9 \u0648\u06CC\u062F\u06CC\u0648\u06CC \u06CC\u0648\u062A\u06CC\u0648\u0628\u060C \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0627\u0646\u06AF\u0644\u06CC\u0633\u06CC \u0622\u0646 \u0631\u0627 \u0628\u0647 \u0641\u0627\u0631\u0633\u06CC \u062A\u0631\u062C\u0645\u0647 \u0645\u06CC\u200C\u06A9\u0646\u0645 \u0648 \u0641\u0627\u06CC\u0644 SRT \u0631\u0627 \u0628\u0631\u0627\u06CC\u062A \u0645\u06CC\u200C\u0641\u0631\u0633\u062A\u0645.

\u{1F4CC} \u0628\u0631\u0627\u06CC \u0645\u0634\u0627\u0647\u062F\u0647 \u0631\u0627\u0647\u0646\u0645\u0627 \u062F\u0633\u062A\u0648\u0631 /help \u0631\u0627 \u0628\u0641\u0631\u0633\u062A.`, "welcome"),
  help: `\u{1F4D6} \u0631\u0627\u0647\u0646\u0645\u0627\u06CC \u0627\u0633\u062A\u0641\u0627\u062F\u0647 \u0627\u0632 SubTube

\u06A9\u0627\u0641\u06CC\u0633\u062A \u0644\u06CC\u0646\u06A9 \u06CC\u06A9 \u0648\u06CC\u062F\u06CC\u0648\u06CC \u06CC\u0648\u062A\u06CC\u0648\u0628 \u0631\u0627 \u0627\u0631\u0633\u0627\u0644 \u06A9\u0646\u06CC:
\u2022 \u0644\u06CC\u0646\u06A9\u200C\u0647\u0627\u06CC \u0645\u0639\u0645\u0648\u0644\u06CC (youtube.com/watch?v=...)
\u2022 \u0644\u06CC\u0646\u06A9\u200C\u0647\u0627\u06CC \u06A9\u0648\u062A\u0627\u0647 (youtu.be/...)
\u2022 \u0648\u06CC\u062F\u06CC\u0648\u0647\u0627\u06CC \u06A9\u0648\u062A\u0627\u0647 (youtube.com/shorts/...)

\u2699\uFE0F \u0646\u062D\u0648\u0647 \u0639\u0645\u0644\u06A9\u0631\u062F:
\u06F1. \u0628\u0631\u0631\u0633\u06CC \u0648\u06CC\u062F\u06CC\u0648 \u0648 \u0627\u0648\u0644\u0648\u06CC\u062A \u0628\u0627 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u062F\u0633\u062A\u06CC \u0627\u0646\u06AF\u0644\u06CC\u0633\u06CC (\u062F\u0631 \u0635\u0648\u0631\u062A \u0646\u0628\u0648\u062F\u060C \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u062E\u0648\u062F\u06A9\u0627\u0631)
\u06F2. \u0627\u0633\u062A\u062E\u0631\u0627\u062C \u062F\u0642\u06CC\u0642 \u0632\u0645\u0627\u0646\u200C\u0628\u0646\u062F\u06CC\u200C\u0647\u0627
\u06F3. \u062A\u0631\u062C\u0645\u0647 \u0631\u0648\u0627\u0646 \u0628\u0647 \u0641\u0627\u0631\u0633\u06CC
\u06F4. \u0627\u0631\u0633\u0627\u0644 \u0645\u0633\u062A\u0642\u06CC\u0645 \u0641\u0627\u06CC\u0644 subtitle.fa.srt

\u062F\u0633\u062A\u0648\u0631\u0627\u062A \u0631\u0628\u0627\u062A:
/start - \u0634\u0631\u0648\u0639 \u0645\u062C\u062F\u062F
/help - \u0631\u0627\u0647\u0646\u0645\u0627\u06CC \u0627\u0633\u062A\u0641\u0627\u062F\u0647
/translate - \u062A\u0631\u062C\u0645\u0647 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u06CC\u06A9 \u0648\u06CC\u062F\u06CC\u0648
/status - \u0648\u0636\u0639\u06CC\u062A \u067E\u0631\u062F\u0627\u0632\u0634 \u062C\u0627\u0631\u06CC
/cancel - \u0644\u063A\u0648 \u067E\u0631\u062F\u0627\u0632\u0634 \u062C\u0627\u0631\u06CC
/history - \u062A\u0627\u0631\u06CC\u062E\u0686\u0647 \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627
/usage - \u0645\u0635\u0631\u0641 \u0648 \u0633\u0647\u0645\u06CC\u0647
/stats - \u0622\u0645\u0627\u0631 \u067E\u0631\u062F\u0627\u0632\u0634\u200C\u0647\u0627\u06CC \u0634\u0645\u0627
/about - \u062F\u0631\u0628\u0627\u0631\u0647 \u0631\u0628\u0627\u062A
/usage - \u0645\u0635\u0631\u0641 \u0648 \u0633\u0647\u0645\u06CC\u0647 \u0627\u0645\u0631\u0648\u0632
\u0648\u0642\u062A\u06CC \u0644\u06CC\u0646\u06A9 \u0645\u06CC\u200C\u0641\u0631\u0633\u062A\u06CC\u060C \u0628\u0627 \u062F\u06A9\u0645\u0647\u200C\u0647\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u0645\u06CC\u200C\u06A9\u0646\u06CC: \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633\u060C \u062E\u0644\u0627\u0635\u0647 \u06CC\u0627 \u0647\u0631 \u062F\u0648`,
  about: `\u{1F3AC} \u062F\u0631\u0628\u0627\u0631\u0647 SubTube

SubTube \u06CC\u06A9 \u0631\u0628\u0627\u062A \u0633\u0628\u06A9\u060C \u0633\u0631\u06CC\u0639 \u0648 \u0631\u0627\u06CC\u06AF\u0627\u0646 \u0628\u0631\u0627\u06CC \u062F\u0631\u06CC\u0627\u0641\u062A \u0648 \u062A\u0631\u062C\u0645\u0647 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0648\u06CC\u062F\u06CC\u0648\u0647\u0627\u06CC \u06CC\u0648\u062A\u06CC\u0648\u0628 \u0628\u0647 \u0632\u0628\u0627\u0646 \u0641\u0627\u0631\u0633\u06CC \u062F\u0631 \u0642\u0627\u0644\u0628 \u0627\u0633\u062A\u0627\u0646\u062F\u0627\u0631\u062F SRT \u0627\u0633\u062A.

\u26A1 \u0627\u062C\u0631\u0627 \u0634\u062F\u0647 \u0631\u0648\u06CC \u0632\u06CC\u0631\u0633\u0627\u062E\u062A \u0627\u0628\u0631\u06CC Cloudflare Workers \u0648 \u062F\u06CC\u062A\u0627\u0628\u06CC\u0633 D1 \u0628\u062F\u0648\u0646 \u0630\u062E\u06CC\u0631\u0647\u200C\u0633\u0627\u0632\u06CC \u062F\u0627\u0626\u0645\u06CC \u0641\u0627\u06CC\u0644\u200C\u0647\u0627\u06CC \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0628\u0631\u0627\u06CC \u062D\u0641\u0638 \u062D\u0631\u06CC\u0645 \u062E\u0635\u0648\u0635\u06CC \u0634\u0645\u0627.`,
  stats: /* @__PURE__ */ __name(({ totalJobs, successfulJobs, failedJobs, lastJobAt }) => `\u{1F4CA} \u0622\u0645\u0627\u0631 \u06A9\u0627\u0631\u0628\u0631\u06CC \u0634\u0645\u0627 \u062F\u0631 SubTube

\u2022 \u06A9\u0644 \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627: ${totalJobs}
\u2022 \u0645\u0648\u0641\u0642: ${successfulJobs} \u2705
\u2022 \u0646\u0627\u0645\u0648\u0641\u0642: ${failedJobs} \u274C
\u2022 \u0622\u062E\u0631\u06CC\u0646 \u062F\u0631\u062E\u0648\u0627\u0633\u062A: ${lastJobAt ? lastJobAt.replace("T", " ").replace("Z", " UTC") : "\u062B\u0628\u062A \u0646\u0634\u062F\u0647"}`, "stats"),
  invalidLink: `\u26A0\uFE0F \u0644\u0637\u0641\u0627\u064B \u06CC\u06A9 \u0644\u06CC\u0646\u06A9 \u0645\u0639\u062A\u0628\u0631 \u06CC\u0648\u062A\u06CC\u0648\u0628 \u0627\u0631\u0633\u0627\u0644 \u06A9\u0646\u06CC\u062F.

\u0646\u0645\u0648\u0646\u0647\u200C\u0647\u0627\u06CC \u0645\u0639\u062A\u0628\u0631:
https://www.youtube.com/watch?v=jNQXAC9IVRw
https://youtu.be/jNQXAC9IVRw
https://www.youtube.com/shorts/VIDEO_ID`,
  statusChecking: "\u{1F50D} \u062F\u0631 \u062D\u0627\u0644 \u0628\u0631\u0631\u0633\u06CC \u0648\u06CC\u062F\u06CC\u0648...",
  statusExtracting: "\u{1F4DD} \u062F\u0631 \u062D\u0627\u0644 \u0627\u0633\u062A\u062E\u0631\u0627\u062C \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633...",
  statusTranslating: /* @__PURE__ */ __name((done, total) => total > 1 ? `\u{1F310} \u062F\u0631 \u062D\u0627\u0644 \u062A\u0631\u062C\u0645\u0647 \u0628\u0647 \u0641\u0627\u0631\u0633\u06CC... (${done}/${total})` : "\u{1F310} \u062F\u0631 \u062D\u0627\u0644 \u062A\u0631\u062C\u0645\u0647 \u0628\u0647 \u0641\u0627\u0631\u0633\u06CC...", "statusTranslating"),
  statusBuildingSrt: "\u{1F4E6} \u062F\u0631 \u062D\u0627\u0644 \u0633\u0627\u062E\u062A \u0641\u0627\u06CC\u0644 SRT...",
  statusDoneCaption: /* @__PURE__ */ __name(({ videoId, cueCount, isAuto }) => `\u2705 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0641\u0627\u0631\u0633\u06CC \u0622\u0645\u0627\u062F\u0647 \u0634\u062F.

\u{1F39E} \u0634\u0646\u0627\u0633\u0647 \u0648\u06CC\u062F\u06CC\u0648: ${videoId}
\u{1F4DD} \u0646\u0648\u0639 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0645\u0628\u062F\u0623: ${isAuto ? "\u062E\u0648\u062F\u06A9\u0627\u0631 (Auto-generated)" : "\u062F\u0633\u062A\u06CC (Manual)"}
\u{1F522} \u062A\u0639\u062F\u0627\u062F \u062E\u0637\u0648\u0637: ${cueCount}`, "statusDoneCaption"),
  duplicateJob: "\u23F3 \u0627\u06CC\u0646 \u0648\u06CC\u062F\u06CC\u0648 \u0647\u0645\u06CC\u0646 \u0627\u0644\u0627\u0646 \u0628\u0631\u0627\u06CC \u0634\u0645\u0627 \u062F\u0631 \u062D\u0627\u0644 \u067E\u0631\u062F\u0627\u0632\u0634 \u0627\u0633\u062A. \u0644\u0637\u0641\u0627\u064B \u062A\u0627 \u067E\u0627\u06CC\u0627\u0646 \u0639\u0645\u0644\u06CC\u0627\u062A \u0635\u0628\u0631 \u06A9\u0646\u06CC\u062F.",
  rateLimited: /* @__PURE__ */ __name((limit) => `\u23F1 \u0634\u0645\u0627 \u0628\u0647 \u0633\u0642\u0641 \u0645\u062C\u0627\u0632 ${limit} \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062F\u0631 \u0633\u0627\u0639\u062A \u0631\u0633\u06CC\u062F\u0647\u200C\u0627\u06CC\u062F. \u0644\u0637\u0641\u0627\u064B \u06A9\u0645\u06CC \u0628\u0639\u062F \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0645\u062A\u062D\u0627\u0646 \u06A9\u0646\u06CC\u062F.`, "rateLimited"),
  videoTooLong: /* @__PURE__ */ __name((maxCues) => `\u26A0\uFE0F \u0627\u06CC\u0646 \u0648\u06CC\u062F\u06CC\u0648 \u0628\u0633\u06CC\u0627\u0631 \u0637\u0648\u0644\u0627\u0646\u06CC \u0627\u0633\u062A (\u0628\u06CC\u0634 \u0627\u0632 ${maxCues} \u062E\u0637 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633) \u0648 \u067E\u0631\u062F\u0627\u0632\u0634 \u0622\u0646 \u0641\u0631\u0627\u062A\u0631 \u0627\u0632 \u0645\u062D\u062F\u0648\u062F\u06CC\u062A \u067E\u0644\u0646 \u0631\u0627\u06CC\u06AF\u0627\u0646 \u0633\u0631\u0648\u0631 \u0627\u0633\u062A. \u0644\u0637\u0641\u0627\u064B \u0648\u06CC\u062F\u06CC\u0648\u06CC \u06A9\u0648\u062A\u0627\u0647\u200C\u062A\u0631\u06CC \u0627\u0631\u0633\u0627\u0644 \u06A9\u0646\u06CC\u062F.`, "videoTooLong"),
  botDisabled: "\u{1F527} \u0631\u0628\u0627\u062A \u0645\u0648\u0642\u062A\u0627\u064B \u062F\u0631 \u062D\u0627\u0644 \u0628\u0631\u0648\u0632\u0631\u0633\u0627\u0646\u06CC \u0627\u0633\u062A. \u0644\u0637\u0641\u0627\u064B \u0628\u0639\u062F\u0627\u064B \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F.",
  genericError: "\u274C \u062E\u0637\u0627\u06CC\u06CC \u062F\u0631 \u067E\u0631\u062F\u0627\u0632\u0634 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0631\u062E \u062F\u0627\u062F. \u0644\u0637\u0641\u0627\u064B \u0627\u0632 \u0635\u062D\u062A \u0644\u06CC\u0646\u06A9 \u0627\u0637\u0645\u06CC\u0646\u0627\u0646 \u062D\u0627\u0635\u0644 \u06A9\u0631\u062F\u0647 \u0648 \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0644\u0627\u0634 \u06A9\u0646\u06CC\u062F."
};

// src/utils/errors.js
var AppError = class extends Error {
  static {
    __name(this, "AppError");
  }
  constructor(code, userMessage, internalMessage = "") {
    super(internalMessage || userMessage);
    this.name = "AppError";
    this.code = code;
    this.userMessage = userMessage;
  }
};
var ERROR_CODES = {
  INVALID_URL: "INVALID_URL",
  NO_CAPTIONS: "NO_CAPTIONS",
  NO_ENGLISH_CAPTIONS: "NO_ENGLISH_CAPTIONS",
  EXTRACTION_FAILED: "EXTRACTION_FAILED",
  VIDEO_TOO_LONG: "VIDEO_TOO_LONG",
  TRANSLATION_FAILED: "TRANSLATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  DUPLICATE_JOB: "DUPLICATE_JOB",
  BOT_DISABLED: "BOT_DISABLED",
  JOB_CANCELLED: "JOB_CANCELLED"
};
function sanitizeErrorMessage(error) {
  if (!error) return "unknown_error";
  const msg = String(error.message || error);
  return msg.replace(/(?:bot)?\d{7,15}:[A-Za-z0-9_-]{25,60}/g, "[REDACTED_TOKEN]").slice(0, 500);
}
__name(sanitizeErrorMessage, "sanitizeErrorMessage");

// src/database/users.js
// فارسی: کاربر تلگرام را در دیتابیس D1 ثبت یا آخرین فعالیتش را به‌روز می‌کند.
async function upsertUser(db, telegramUser) {
  if (!db || !telegramUser?.id) return;
  const telegramId = Number(telegramUser.id);
  const username = telegramUser.username || null;
  const firstName = telegramUser.first_name || null;
  const language = telegramUser.language_code || "fa";
  await db.prepare(
    `INSERT INTO users (telegram_id, username, first_name, language, created_at, last_active_at)
       VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(telegram_id) DO UPDATE SET
         username = excluded.username,
         first_name = excluded.first_name,
         last_active_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
  ).bind(telegramId, username, firstName, language).run();
  await db.prepare(
    `INSERT OR IGNORE INTO user_stats (telegram_id, total_jobs, successful_jobs, failed_jobs)
       VALUES (?1, 0, 0, 0)`
  ).bind(telegramId).run();
}
__name(upsertUser, "upsertUser");
// فارسی: یک تنظیم را از جدول settings دیتابیس می‌خواند (مثل ارائه‌دهنده ترجمه).
async function getSetting(db, key, fallbackValue = null) {
  if (!db) return fallbackValue;
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?1 LIMIT 1`).bind(key).first();
  return row ? row.value : fallbackValue;
}
__name(getSetting, "getSetting");

// src/database/jobs.js
async function sweepStaleJobs(db, telegramId) {
  if (!db) return [];
  let rows = [];
  try {
    const found = await db.prepare(
      `SELECT id, video_id FROM jobs
       WHERE telegram_id = ?1
         AND status = 'processing'
         AND created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-10 minutes')`
    ).bind(Number(telegramId)).all();
    rows = found?.results || [];
  } catch {
    return [];
  }
  if (!rows.length) return [];
  await db.prepare(
    `UPDATE jobs
       SET status = 'failed',
           error_message = 'timeout_stale_job',
           completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE telegram_id = ?1
         AND status = 'processing'
         AND created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-10 minutes')`
  ).bind(Number(telegramId)).run();
  return rows.map((r) => ({ id: r.id, videoId: r.video_id }));
}
__name(sweepStaleJobs, "sweepStaleJobs");
async function hasActiveJobForVideo(db, telegramId, videoId) {
  if (!db) return false;
  const existing = await db.prepare(
    `SELECT id FROM jobs
       WHERE telegram_id = ?1 AND video_id = ?2 AND status = 'processing'
       LIMIT 1`
  ).bind(Number(telegramId), String(videoId)).first();
  return Boolean(existing);
}
__name(hasActiveJobForVideo, "hasActiveJobForVideo");
async function countRecentUserJobs(db, telegramId, windowMinutes = 60) {
  if (!db) return 0;
  const modifier = `-${Math.max(1, Number(windowMinutes))} minutes`;
  const row = await db.prepare(
    `SELECT COUNT(*) AS cnt FROM jobs
       WHERE telegram_id = ?1
         AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?2)`
  ).bind(Number(telegramId), modifier).first();
  return Number(row?.cnt || 0);
}
__name(countRecentUserJobs, "countRecentUserJobs");
async function createJob(db, { telegramId, videoId, videoUrl, sourceLanguage = "en", targetLanguage = "fa" }) {
  const res = await db.prepare(
    `INSERT INTO jobs (telegram_id, video_id, video_url, source_language, target_language, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'processing', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
  ).bind(Number(telegramId), String(videoId), String(videoUrl), String(sourceLanguage), String(targetLanguage)).run();
  return res?.meta?.last_row_id;
}
__name(createJob, "createJob");
// فارسی: ساخت اتمیک یک پردازش؛ جلوی پردازش تکراری هم‌زمان و عبور از سقف ساعتی را می‌گیرد.
async function createJobAtomic(db, { telegramId, videoId, videoUrl, sourceLanguage = "en", targetLanguage = "fa", maxPerHour = 0 }) {
  // Single-statement guarded insert: the duplicate check and the hourly cap
  // are evaluated by SQLite inside the same statement that creates the row,
  // so two updates processed concurrently can no longer both pass a
  // check-then-create sequence (the old race).
  const cap = Math.max(0, Number(maxPerHour) || 0);
  const res = await db.prepare(
    `INSERT INTO jobs (telegram_id, video_id, video_url, source_language, target_language, status, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, 'processing', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
     WHERE NOT EXISTS (
       SELECT 1 FROM jobs WHERE telegram_id = ?1 AND video_id = ?2 AND status = 'processing'
     )
     AND (
       ?6 = 0
       OR (SELECT COUNT(*) FROM jobs WHERE telegram_id = ?1 AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-60 minutes')) < ?6
     )`
  ).bind(Number(telegramId), String(videoId), String(videoUrl), String(sourceLanguage), String(targetLanguage), cap).run();
  if (Number(res?.meta?.changes || 0) > 0) {
    return { jobId: res?.meta?.last_row_id };
  }
  const dup = await db.prepare(
    `SELECT id FROM jobs WHERE telegram_id = ?1 AND video_id = ?2 AND status = 'processing' LIMIT 1`
  ).bind(Number(telegramId), String(videoId)).first();
  return { blocked: dup ? "duplicate" : "ratelimited" };
}
__name(createJobAtomic, "createJobAtomic");
async function completeJob(db, jobId, telegramId) {
  await db.batch([
    db.prepare(
      `UPDATE jobs
         SET status = 'completed',
             completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?1`
    ).bind(Number(jobId)),
    db.prepare(
      `INSERT INTO user_stats (telegram_id, total_jobs, successful_jobs, failed_jobs, last_job_at)
         VALUES (?1, 1, 1, 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(telegram_id) DO UPDATE SET
           total_jobs = user_stats.total_jobs + 1,
           successful_jobs = user_stats.successful_jobs + 1,
           last_job_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
    ).bind(Number(telegramId))
  ]);
}
__name(completeJob, "completeJob");
async function failJob(db, jobId, telegramId, errorMessage) {
  const safeMsg = String(errorMessage || "unknown_error").slice(0, 500);
  await db.batch([
    db.prepare(
      `UPDATE jobs
         SET status = 'failed',
             error_message = ?2,
             completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?1`
    ).bind(Number(jobId), safeMsg),
    db.prepare(
      `INSERT INTO user_stats (telegram_id, total_jobs, successful_jobs, failed_jobs, last_job_at)
         VALUES (?1, 1, 0, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(telegram_id) DO UPDATE SET
           total_jobs = user_stats.total_jobs + 1,
           failed_jobs = user_stats.failed_jobs + 1,
           last_job_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
    ).bind(Number(telegramId))
  ]);
}
__name(failJob, "failJob");

// src/database/stats.js
async function getUserStats(db, telegramId) {
  const uid = Number(telegramId);
  const statsRow = await db.prepare(
    `SELECT total_jobs, successful_jobs, failed_jobs, last_job_at
       FROM user_stats
       WHERE telegram_id = ?1`
  ).bind(uid).first();
  const userRow = await db.prepare(
    `SELECT created_at, last_active_at
       FROM users
       WHERE telegram_id = ?1`
  ).bind(uid).first();
  return {
    totalJobs: Number(statsRow?.total_jobs || 0),
    successfulJobs: Number(statsRow?.successful_jobs || 0),
    failedJobs: Number(statsRow?.failed_jobs || 0),
    lastJobAt: statsRow?.last_job_at || null,
    joinedAt: userRow?.created_at || null,
    lastActiveAt: userRow?.last_active_at || null
  };
}
__name(getUserStats, "getUserStats");

// src/youtube/parser.js
var HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " "
};
function decodeHtmlEntities(str) {
  if (!str) return "";
  return str.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m).replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec))).replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}
__name(decodeHtmlEntities, "decodeHtmlEntities");
function timeToMs(ts) {
  const parts = ts.trim().replace(",", ".").split(":");
  let h = 0, m = 0, sMs = "0";
  if (parts.length === 3) {
    [h, m, sMs] = parts;
  } else if (parts.length === 2) {
    [m, sMs] = parts;
  } else {
    return 0;
  }
  const [secStr, msStr = "0"] = sMs.split(".");
  const ms = Number(msStr.padEnd(3, "0").slice(0, 3));
  return (Number(h) * 3600 + Number(m) * 60 + Number(secStr)) * 1e3 + ms;
}
__name(timeToMs, "timeToMs");
function msToSrtTime(totalMs) {
  const safe = Math.max(0, Math.round(totalMs));
  const ms = safe % 1e3;
  const totalSec = Math.floor(safe / 1e3);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);
  return String(hr).padStart(2, "0") + ":" + String(min).padStart(2, "0") + ":" + String(sec).padStart(2, "0") + "," + String(ms).padStart(3, "0");
}
__name(msToSrtTime, "msToSrtTime");
function cleanCueText(rawText) {
  const withoutTags = rawText.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, "").replace(/<\/?[A-Za-z0-9._-]+(?:\s[^>]*)?>/g, "");
  return decodeHtmlEntities(withoutTags).split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n").trim();
}
__name(cleanCueText, "cleanCueText");
function analyzeCues(cues) {
  const list = Array.isArray(cues) ? cues : [];
  const stats = {
    count: list.length,
    unsortedPairs: 0,
    overlapPairs: 0,
    maxOverlapMs: 0,
    duplicateCues: 0,
    sameStartPairs: 0,
    over7s: 0,
    under300ms: 0,
    multiLineCues: 0,
    over2LineCues: 0,
    maxLines: 0,
    maxLineChars: 0,
    maxCueChars: 0,
    totalChars: 0,
    rollupSuspects: 0,
    overCps17: 0,
    firstDefects: []
  };
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const dur = c.endMs - c.startMs;
    const lines = String(c.text || "").split("\n");
    const chars = [...String(c.text || "").replace(/\n/g, "")].length;
    stats.maxLines = Math.max(stats.maxLines, lines.length);
    if (lines.length > 1) stats.multiLineCues++;
    if (lines.length > 2) stats.over2LineCues++;
    for (const ln of lines) stats.maxLineChars = Math.max(stats.maxLineChars, [...ln].length);
    stats.maxCueChars = Math.max(stats.maxCueChars, chars);
    stats.totalChars += chars;
    if (dur > 7e3) stats.over7s++;
    if (dur > 0 && dur < 300) stats.under300ms++;
    if (dur > 0 && chars / (dur / 1e3) > 17) stats.overCps17++;
    const key = `${c.startMs}|${c.text}`;
    if (seen.has(key)) stats.duplicateCues++;
    seen.add(key);
    if (i > 0) {
      const p = list[i - 1];
      if (c.startMs < p.startMs) {
        stats.unsortedPairs++;
        if (stats.firstDefects.length < 5) stats.firstDefects.push(`unsorted at ${i}: ${p.startMs} -> ${c.startMs}`);
      }
      if (c.startMs === p.startMs) stats.sameStartPairs++;
      if (c.startMs < p.endMs) {
        stats.overlapPairs++;
        stats.maxOverlapMs = Math.max(stats.maxOverlapMs, p.endMs - c.startMs);
        if (stats.firstDefects.length < 5) stats.firstDefects.push(`overlap at ${i}: prev ends ${p.endMs}, next starts ${c.startMs}`);
      }
      const pLines = String(p.text || "").split("\n");
      const cLines = String(c.text || "").split("\n");
      const rollup = cLines.length >= 2 && (cLines[0] === p.text || cLines[0] === pLines[pLines.length - 1]) || String(p.text || "").length >= 8 && String(c.text || "").startsWith(String(p.text || "") + " ");
      if (rollup) stats.rollupSuspects++;
    }
  }
  return stats;
}
__name(analyzeCues, "analyzeCues");
// فارسی: مرتب‌سازی و اصلاح زمان‌بندی خط‌های زیرنویس (حذف هم‌پوشانی و سقف ۷ ثانیه).
function normalizeCues(input) {
  if (!Array.isArray(input)) return [];
  const sanitized = [];
  for (const c of input) {
    const text = String(c?.text || "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n").trim();
    if (!text) continue;
    const startMs = Math.max(0, Math.round(Number(c?.startMs) || 0));
    let endMs = Math.round(Number(c?.endMs) || 0);
    if (endMs <= startMs) endMs = startMs + 1e3;
    sanitized.push({ startMs, endMs, text });
  }
  sanitized.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out = [];
  for (const cue of sanitized) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...cue });
      continue;
    }
    if (cue.startMs === prev.startMs) {
      if (cue.text === prev.text || cue.text.length > prev.text.length) {
        if (cue.text !== prev.text) prev.text = cue.text;
        prev.endMs = Math.max(prev.endMs, cue.endMs);
      }
      continue;
    }
    if (cue.text === prev.text) {
      if (cue.startMs <= prev.endMs + 300) {
        prev.endMs = Math.max(prev.endMs, cue.endMs);
      }
      continue;
    }
    let text = cue.text;
    const cueLines = text.split("\n");
    if (cueLines.length >= 2) {
      const prevLines = prev.text.split("\n");
      const first = cueLines[0].trim();
      if (first === prev.text.trim() || first === prevLines[prevLines.length - 1].trim()) {
        text = cueLines.slice(1).join("\n").trim();
        if (!text) continue;
      }
    } else if (prev.text.length >= 8 && text.startsWith(prev.text + " ")) {
      text = text.slice(prev.text.length + 1).trim();
      if (!text) continue;
    }
    out.push({ startMs: cue.startMs, endMs: cue.endMs, text });
  }
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    const next = out[i + 1];
    if (next && c.endMs > next.startMs) c.endMs = next.startMs;
    if (c.endMs - c.startMs > 7e3) c.endMs = c.startMs + 7e3;
  }
  return out.filter((c) => c.endMs > c.startMs && c.text.trim().length > 0);
}
__name(normalizeCues, "normalizeCues");
function analyzeSrt(srt) {
  const stats = { blocks: 0, seqOk: true, overlaps: 0, nonMonotonic: 0, over2Lines: 0, maxLines: 0, maxLineChars: 0, over7s: 0, badTiming: 0 };
  if (!srt) return stats;
  const blocks = String(srt).replace(/^\uFEFF/, "").trim().split(/\n\n+/);
  let prevEnd = -1;
  let prevStart = -1;
  blocks.forEach((block, idx) => {
    const lines = block.split("\n");
    if (lines.length < 2) return;
    stats.blocks++;
    if (Number(lines[0]) !== idx + 1) stats.seqOk = false;
    const m = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!m) {
      stats.badTiming++;
      return;
    }
    const toMs = (h, mi, s, ms) => ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1e3 + Number(ms);
    const start = toMs(m[1], m[2], m[3], m[4]);
    const end = toMs(m[5], m[6], m[7], m[8]);
    if (end <= start) stats.badTiming++;
    if (start < prevStart) stats.nonMonotonic++;
    if (prevEnd >= 0 && start < prevEnd) stats.overlaps++;
    if (end - start > 7e3) stats.over7s++;
    prevStart = start;
    prevEnd = end;
    const textLines = lines.slice(2);
    stats.maxLines = Math.max(stats.maxLines, textLines.length);
    if (textLines.length > 2) stats.over2Lines++;
    for (const ln of textLines) stats.maxLineChars = Math.max(stats.maxLineChars, [...ln].length);
  });
  return stats;
}
__name(analyzeSrt, "analyzeSrt");
function parseVtt(vttContent, { isAuto = false } = {}) {
  if (!vttContent || typeof vttContent !== "string") return [];
  const normalized = vttContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n\n+/);
  const rawCues = [];
  const arrowRegex = /^((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})/;
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd());
    if (!lines.length) continue;
    if (lines[0].startsWith("WEBVTT") || lines[0].startsWith("NOTE") || lines[0].startsWith("STYLE")) {
      continue;
    }
    let timingLineIdx = -1;
    let match = null;
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      const m = lines[i].match(arrowRegex);
      if (m) {
        timingLineIdx = i;
        match = m;
        break;
      }
    }
    if (timingLineIdx === -1 || !match) continue;
    const startMs = timeToMs(match[1]);
    const endMs = timeToMs(match[2]);
    if (endMs <= startMs) continue;
    const bodyLines = lines.slice(timingLineIdx + 1);
    const rawBody = bodyLines.join("\n");
    const text = cleanCueText(rawBody);
    if (!text) continue;
    rawCues.push({ startMs, endMs, text });
  }
  if (!rawCues.length) return [];
  const cleaned = [];
  for (const cue of rawCues) {
    const duration = cue.endMs - cue.startMs;
    if (isAuto && duration <= 40) {
      continue;
    }
    const prev = cleaned[cleaned.length - 1];
    if (!prev) {
      cleaned.push({ ...cue });
      continue;
    }
    if (cue.text === prev.text) {
      if (cue.endMs > prev.endMs && cue.startMs - prev.endMs <= 200) {
        prev.endMs = cue.endMs;
      }
      continue;
    }
    const cueLines = cue.text.split("\n");
    const prevLines = prev.text.split("\n");
    const prevLastLine = prevLines[prevLines.length - 1];
    if (cueLines.length >= 2 && (cueLines[0] === prev.text || cueLines[0] === prevLastLine)) {
      const stripped = cueLines.slice(1).join("\n").trim();
      if (!stripped) continue;
      if (prev.endMs > cue.startMs) {
        prev.endMs = cue.startMs;
      }
      cleaned.push({ startMs: cue.startMs, endMs: cue.endMs, text: stripped });
      continue;
    }
    if (prev.endMs > cue.startMs) {
      prev.endMs = cue.startMs;
    }
    cleaned.push({ ...cue });
  }
  return cleaned.filter((c) => c.endMs > c.startMs && c.text.trim().length > 0);
}
__name(parseVtt, "parseVtt");
function parseJson3(input) {
  if (!input) return [];
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch {
      return [];
    }
  }
  const events = Array.isArray(data?.events) ? data.events : [];
  const cues = [];
  for (const ev of events) {
    if (!ev || !Array.isArray(ev.segs)) continue;
    const text = cleanCueText(ev.segs.map((s) => s?.utf8 || "").join(""));
    if (!text) continue;
    const startMs = Math.max(0, Math.round(Number(ev.tStartMs) || 0));
    const durMs = Math.round(Number(ev.dDurationMs) || 0);
    const endMs = startMs + (durMs > 0 ? Math.max(200, durMs) : 2e3);
    if (cues.length) {
      const prev = cues[cues.length - 1];
      if (prev.startMs === startMs && prev.text === text) continue;
      if (prev.text === text && startMs - prev.endMs <= 300) {
        prev.endMs = Math.max(prev.endMs, endMs);
        continue;
      }
      if (prev.endMs > startMs && startMs > prev.startMs) {
        prev.endMs = startMs;
      }
    }
    cues.push({ startMs, endMs, text });
  }
  return cues.filter((c) => c.endMs > c.startMs && c.text.length > 0);
}
__name(parseJson3, "parseJson3");
function parseTimedTextXml(xmlText) {
  if (!xmlText || typeof xmlText !== "string") return [];
  const cues = [];
  const tagRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = tagRegex.exec(xmlText)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const startMatch = attrs.match(/\bstart="([\d.]+)"/i);
    const durMatch = attrs.match(/\bdur="([\d.]+)"/i);
    if (!startMatch) continue;
    const startMs = Math.round(parseFloat(startMatch[1]) * 1e3);
    const durMs = durMatch ? Math.round(parseFloat(durMatch[1]) * 1e3) : 2e3;
    const endMs = startMs + Math.max(200, durMs);
    const text = cleanCueText(body);
    if (text) {
      cues.push({ startMs, endMs, text });
    }
  }
  return cues;
}
__name(parseTimedTextXml, "parseTimedTextXml");

// src/youtube/extractor.js
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var ANDROID_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";
var IOS_UA = "com.google.ios.youtube/20.03.2 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)";
var INVIDIOUS_HOSTS = [
  "https://yt.chocolatemoo53.com",
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://invidious.tiekoetter.com"
];
var CANDIDATE_HOSTS = [
  ...INVIDIOUS_HOSTS,
  "https://yewtu.be",
  "https://invidious.jing.rocks",
  "https://iv.melmac.space",
  "https://invidious.materialio.us",
  "https://inv.tux.pizza",
  "https://invidious.protokolla.fi",
  "https://invidious.reallyaweso.me",
  "https://invidious.perennialte.ch",
  "https://invidious.f5.si",
  "https://invidious.private.coffee",
  "https://invidious.lunar.icu",
  "https://invidious.privacyredirect.com"
];
var TIMEOUTS = { list: 4500, media: 7e3, player: 6e3 };
var TOTAL_BUDGET_MS = 18e3;
var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
var CACHE_TTL_SECONDS = 60 * 60 * 48;
var COOLDOWN_SECONDS = 180;
var MAX_ATTEMPTS = 2;
var sleep = /* @__PURE__ */ __name((ms) => new Promise((resolve) => setTimeout(resolve, ms)), "sleep");
function errName(err) {
  if (!err) return "unknown";
  return err.name === "AbortError" ? "timeout" : `${err.name}:${err.message}`.slice(0, 90);
}
__name(errName, "errName");
async function timedFetch(url, init = {}, ms = 6e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(150, ms));
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (typeof Response !== "undefined" && res instanceof Response) {
      // Buffer the body while the deadline timer is still armed: a fetch
      // promise resolves at headers, and without this a stalled body would
      // hang the caller's res.json()/res.text() forever (the same flaw that
      // froze jobs in the 2026-11-15 stuck-job incident).
      const body = await res.arrayBuffer();
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}
__name(timedFetch, "timedFetch");
function remaining(deadline) {
  return deadline - Date.now();
}
__name(remaining, "remaining");
function selectEnglishTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const normalized = tracks.map((t) => {
    const lang = String(t.languageCode || t.language_code || "").toLowerCase();
    const label = String(t.label || t.name?.simpleText || "").toLowerCase();
    const kind = String(t.kind || "").toLowerCase();
    const isAuto = kind === "asr" || label.includes("auto-generated") || label.includes("auto generated") || Boolean(t.isAuto);
    return {
      raw: t,
      lang,
      isEnglish: lang === "en" || lang.startsWith("en-"),
      isExactEn: lang === "en",
      isAuto
    };
  });
  const englishTracks = normalized.filter((t) => t.isEnglish);
  if (englishTracks.length === 0) return null;
  englishTracks.sort((a, b) => {
    if (a.isAuto !== b.isAuto) return a.isAuto ? 1 : -1;
    if (a.isExactEn !== b.isExactEn) return a.isExactEn ? -1 : 1;
    return 0;
  });
  return englishTracks[0];
}
__name(selectEnglishTrack, "selectEnglishTrack");
function selectPreferredTrack(tracks) {
  const english = selectEnglishTrack(tracks);
  if (english) return english;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const isAutoLabel = /* @__PURE__ */ __name((t) => {
    const label = String(t?.label || t?.name?.simpleText || "").toLowerCase();
    return String(t?.kind || "").toLowerCase() === "asr" || label.includes("auto");
  }, "isAutoLabel");
  const manual = tracks.find((t) => !isAutoLabel(t) && (t.url || t.baseUrl));
  const chosen = manual || tracks.find((t) => t.url || t.baseUrl) || tracks[0];
  if (!chosen) return null;
  return {
    raw: chosen,
    lang: String(chosen.languageCode || chosen.language_code || "").toLowerCase(),
    isEnglish: false,
    isExactEn: false,
    isAuto: isAutoLabel(chosen)
  };
}
__name(selectPreferredTrack, "selectPreferredTrack");
function withFormat(baseUrl, fmt) {
  try {
    const u = new URL(baseUrl);
    u.searchParams.delete("fmt");
    u.searchParams.set("fmt", fmt);
    return u.toString();
  } catch {
    return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}fmt=${fmt}`;
  }
}
__name(withFormat, "withFormat");
function cuesFromBody(body, isAuto) {
  if (!body || body.length < 16) return [];
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) return parseJson3(body);
  if (trimmed.startsWith("<?xml") || trimmed.includes("<transcript")) return parseTimedTextXml(body);
  if (body.includes("WEBVTT") || body.includes("-->")) return parseVtt(body, { isAuto });
  return [];
}
__name(cuesFromBody, "cuesFromBody");
async function downloadCues(url, { isAuto, deadline, timeoutMs, ua = UA }) {
  const budget = Math.min(timeoutMs, remaining(deadline));
  if (budget < 500) return { cues: null, detail: "deadline" };
  let res;
  try {
    res = await timedFetch(url, { headers: { "User-Agent": ua, Accept: "*/*" } }, budget);
  } catch (err) {
    return { cues: null, detail: errName(err) };
  }
  if (!res.ok) return { cues: null, detail: `http ${res.status}` };
  let body;
  try {
    const ab = await res.arrayBuffer();
    body = new TextDecoder().decode(ab);
  } catch (err) {
    return { cues: null, detail: errName(err) };
  }
  const cues = cuesFromBody(body, isAuto);
  if (!cues.length) return { cues: null, detail: `body ${body.length}b no cues` };
  return { cues, detail: `cues ${cues.length}` };
}
__name(downloadCues, "downloadCues");
async function playerToResult(player, { source, deadline, ua = UA, pageStatus = 0 }) {
  const playability = player?.playabilityStatus || {};
  const pstatus = String(playability.status || "");
  const reason = String(playability.reason || "");
  const details = player?.videoDetails || null;
  const tracklist = player?.captions?.playerCaptionsTracklistRenderer || {};
  const tracks = Array.isArray(tracklist.captionTracks) ? tracklist.captionTracks : [];
  if (tracks.length > 0) {
    const selected = selectPreferredTrack(tracks);
    if (selected && selected.raw.baseUrl) {
      const url = withFormat(selected.raw.baseUrl, "json3");
      const dl = await downloadCues(url, { isAuto: selected.isAuto, deadline, timeoutMs: TIMEOUTS.media, ua });
      if (dl.cues) {
        return {
          status: "ok",
          cues: dl.cues,
          isAuto: selected.isAuto,
          lang: selected.lang,
          source,
          detail: `${source} ${dl.detail}`
        };
      }
      return { status: "fail", detail: `${source} caption download: ${dl.detail}`, hasCaptionList: true };
    }
  }
  if (pstatus === "OK" && (details?.videoId || details?.title)) {
    return { status: "empty", definitive: true, detail: `${source} ok, 0 tracks` };
  }
  const botWallText = /sign in to confirm|are you a bot|unusual traffic|reload the page|reload/i.test(reason);
  if (pstatus === "LOGIN_REQUIRED" || botWallText) {
    return { status: "fail", botWall: true, detail: `${source} bot_wall ${reason}`.slice(0, 120) };
  }
  if (playability.errorScreen) {
    return { status: "fail", detail: `${source} ${reason || "error screen"}`.slice(0, 120) };
  }
  if (pstatus === "UNPLAYABLE") {
    return { status: "fail", detail: `${source} unplayable ${reason}`.slice(0, 120) };
  }
  if (pageStatus && pageStatus !== 200) {
    return { status: "fail", detail: `${source} http ${pageStatus}` };
  }
  return { status: "fail", detail: `${source} ${pstatus || "no playability"}`.slice(0, 120) };
}
__name(playerToResult, "playerToResult");
function extractBalancedJson(html, marker) {
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;
  const start = html.indexOf("{", markerIdx + marker.length);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
__name(extractBalancedJson, "extractBalancedJson");
function readVisitorData(html) {
  const m = String(html).match(/"visitorData":"([^"]{5,200})"/);
  return m ? m[1] : null;
}
__name(readVisitorData, "readVisitorData");
async function extractViaWatchPage(videoId, deadline) {
  const budget = Math.min(TIMEOUTS.player, remaining(deadline));
  if (budget < 800) return { status: "fail", detail: "watch deadline" };
  let res;
  let html;
  try {
    res = await timedFetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US&bpctr=9999999999&has_verified=1`,
      {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+917; SOCS=CAI"
        }
      },
      budget
    );
    const htmlAb = await res.arrayBuffer();
    html = new TextDecoder().decode(htmlAb);
  } catch (err) {
    return { status: "fail", detail: `watch ${errName(err)}` };
  }
  if (!res.ok) return { status: "fail", detail: `watch http ${res.status}` };
  const player = extractBalancedJson(html, "ytInitialPlayerResponse");
  if (!player) {
    return {
      status: "fail",
      detail: html.includes("consent") ? "watch consent wall" : "watch no player response"
    };
  }
  const result = await playerToResult(player, { source: "youtube_page", deadline });
  result.visitorData = readVisitorData(html);
  return result;
}
__name(extractViaWatchPage, "extractViaWatchPage");
async function extractViaInvidious(videoId, deadline) {
  const tasks = INVIDIOUS_HOSTS.map(async (host) => {
    const budget = Math.min(TIMEOUTS.list, remaining(deadline));
    if (budget < 700) return { status: "fail", detail: `${host} deadline` };
    let res;
    let body;
    try {
      res = await timedFetch(
        `${host}/api/v1/captions/${encodeURIComponent(videoId)}`,
        { headers: { "User-Agent": UA, Accept: "application/json" } },
        budget
      );
      const ab = await res.arrayBuffer();
      body = new TextDecoder().decode(ab);
    } catch (err) {
      return { status: "fail", detail: `${host} ${errName(err)}` };
    }
    if (!res.ok) {
      if (res.status === 500) {
        return { status: "notfound", detail: `${host} http 500` };
      }
      return { status: "fail", detail: `${host} http ${res.status}` };
    }
    if (!body || body.trimStart().startsWith("<")) {
      return { status: "fail", detail: `${host} html ${body?.length || 0}b` };
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return { status: "fail", detail: `${host} bad json` };
    }
    const captions = Array.isArray(data?.captions) ? data.captions : null;
    if (!captions) return { status: "fail", detail: `${host} shape` };
    if (captions.length === 0) return { status: "empty", definitive: true, detail: `${host} 0 captions` };
    const selected = selectPreferredTrack(captions);
    if (!selected) {
      return { status: "noenglish", detail: `${host} unusable`, langs: captions.map((c) => c.languageCode) };
    }
    const trackUrl = String(selected.raw.url || "").startsWith("http") ? selected.raw.url : `${host}${selected.raw.url}`;
    const dl = await downloadCues(trackUrl, {
      isAuto: selected.isAuto,
      deadline,
      timeoutMs: TIMEOUTS.media
    });
    if (!dl.cues) {
      return { status: "fail", detail: `${host} vtt download: ${dl.detail}`, hasCaptionList: true };
    }
    return {
      status: "ok",
      cues: dl.cues,
      isAuto: selected.isAuto,
      lang: selected.lang,
      source: "invidious",
      detail: `${host} ${dl.detail}`
    };
  });
  const results = await Promise.all(tasks);
  return pickBest(results, "invidious");
}
__name(extractViaInvidious, "extractViaInvidious");
var INNERTUBE_CLIENTS = [
  {
    name: "ANDROID",
    id: "3",
    ua: ANDROID_UA,
    key: "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
    body: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, hl: "en", gl: "US" }
  },
  {
    name: "IOS",
    id: "5",
    ua: IOS_UA,
    key: "AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc",
    body: {
      clientName: "IOS",
      clientVersion: "20.03.2",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.0.22D63",
      hl: "en",
      gl: "US"
    }
  },
  {
    name: "WEB_EMBEDDED",
    id: "56",
    ua: UA,
    key: "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
    body: {
      clientName: "WEB_EMBEDDED_PLAYER",
      clientVersion: "1.20241126.01.00",
      clientScreen: "EMBED",
      hl: "en",
      gl: "US"
    }
  }
];
async function extractViaInnertube(videoId, deadline, visitorData = null) {
  const results = [];
  for (const client of INNERTUBE_CLIENTS) {
    const budget = Math.min(TIMEOUTS.player, remaining(deadline));
    if (budget < 900) break;
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": client.ua,
      "X-YouTube-Client-Name": client.id,
      "X-YouTube-Client-Version": client.body.clientVersion,
      Origin: "https://www.youtube.com",
      Referer: "https://www.youtube.com/"
    };
    if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;
    try {
      const res = await timedFetch(
        `https://www.youtube.com/youtubei/v1/player?key=${client.key}&prettyPrint=false&hl=en`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            videoId,
            context: { client: client.body },
            playbackContext: { contentPlaybackContext: { vis: 0, splay: false, signatureTimestamp: 20000 } },
            racyCheckOk: true,
            contentCheckOk: true
          })
        },
        budget
      );
      if (!res.ok) {
        results.push({ status: "fail", detail: `innertube_${client.name} http ${res.status}` });
        continue;
      }
      const bodyAb = await res.arrayBuffer();
      const data = (() => {
        try {
          return JSON.parse(new TextDecoder().decode(bodyAb));
        } catch {
          return null;
        }
      })();
      if (!data) {
        results.push({ status: "fail", detail: `innertube_${client.name} bad json` });
        continue;
      }
      const result = await playerToResult(data, {
        source: `innertube_${client.name}`,
        deadline,
        ua: client.ua
      });
      results.push(result);
      if (result.status === "ok") return result;
      if (result.status === "empty") return result;
      if (result.status === "unavailable") return result;
    } catch (err) {
      results.push({ status: "fail", detail: `innertube_${client.name} ${errName(err)}` });
    }
  }
  return pickBest(results, "innertube");
}
__name(extractViaInnertube, "extractViaInnertube");
async function extractViaTimedtext(videoId, deadline) {
  const langs = ["en", "a.en"];
  const details = [];
  for (const lang of langs) {
    const budget = Math.min(5e3, remaining(deadline));
    if (budget < 900) break;
    const kind = lang.startsWith("a.") ? "&kind=asr" : "";
    const url = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${lang}${kind}&fmt=json3`;
    try {
      const res = await timedFetch(url, { headers: { "User-Agent": UA } }, budget);
      let body = "";
      if (res.ok) {
        const ab = await res.arrayBuffer();
        body = new TextDecoder().decode(ab);
      }
      if (body && body.length > 20) {
        const cues = cuesFromBody(body, lang.startsWith("a."));
        if (cues.length) {
          return { status: "ok", cues, isAuto: lang.startsWith("a."), lang, source: "timedtext", detail: lang };
        }
        details.push(`${lang} ${body.length}b no cues`);
      } else {
        details.push(`${lang} http ${res.status}`);
      }
    } catch (err) {
      details.push(`${lang} ${errName(err)}`);
    }
  }
  return { status: "fail", detail: `timedtext ${details.join(", ")}`.slice(0, 140) };
}
__name(extractViaTimedtext, "extractViaTimedtext");
function pickBest(results, source) {
  const ok = results.find((r) => r && r.status === "ok");
  if (ok) return ok;
  const empty = results.find((r) => r && r.status === "empty" && r.definitive);
  if (empty) return empty;
  const notfound = results.find((r) => r && r.status === "notfound");
  if (notfound) return notfound;
  const unavailable = results.find((r) => r && r.status === "unavailable");
  if (unavailable) return unavailable;
  const noEnglish = results.find((r) => r && r.status === "noenglish");
  if (noEnglish) return noEnglish;
  const details = results.map((r) => r && r.detail).filter(Boolean);
  return {
    status: "fail",
    botWall: results.some((r) => r && r.botWall),
    detail: `${source}: ${details.join(" | ")}`.slice(0, 400)
  };
}
__name(pickBest, "pickBest");
function logAttempt(videoId, result) {
  const head = `[extract] ${videoId} ${result.status}`;
  const extra = result.source ? ` src=${result.source}` : "";
  const cues = result.cues ? ` cues=${result.cues.length}` : "";
  const detail = result.detail ? ` :: ${String(result.detail).slice(0, 180)}` : "";
  console.log(`${head}${extra}${cues}${detail}`);
}
__name(logAttempt, "logAttempt");
// فارسی: استخراج زیرنویس از سرویس Supadata (مسیر اصلی و سریع استخراج).
async function extractViaSupadata(videoId, deadline, apiKey, langWanted = "en") {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const langParam = langWanted ? `&lang=${encodeURIComponent(langWanted)}` : "";
  const apiUrl = `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(watchUrl)}${langParam}&mode=native`;
  const budget = Math.min(12e3, remaining(deadline));
  if (budget < 1500) return { status: "fail", detail: "supadata deadline" };
  let res;
  try {
    res = await timedFetch(apiUrl, { headers: { "x-api-key": apiKey, Accept: "application/json" } }, budget);
  } catch (err) {
    return { status: "fail", detail: `supadata ${errName(err)}` };
  }
  if (res.status === 206) {
    return { status: "empty", definitive: true, detail: "supadata no transcript" };
  }
  let data = await res.json().catch(() => null);
  if (res.status === 202 && data?.jobId) {
    let done = null;
    for (let i = 0; i < 5 && !done; i++) {
      const b2 = Math.min(4e3, remaining(deadline));
      if (b2 < 1200) break;
      await sleep(1100);
      try {
        const r2 = await timedFetch(
          `https://api.supadata.ai/v1/transcript/${encodeURIComponent(data.jobId)}`,
          { headers: { "x-api-key": apiKey, Accept: "application/json" } },
          b2
        );
        const d2 = await r2.json().catch(() => null);
        if (d2?.status === "completed") done = d2.result || d2;
        else if (d2?.status === "failed") return { status: "fail", detail: "supadata job failed" };
      } catch {
      }
    }
    if (!done) return { status: "fail", detail: "supadata job pending" };
    data = done;
  }
  if (!data || !Array.isArray(data.content)) {
    return { status: "fail", detail: `supadata http ${res.status}` };
  }
  const lang = String(data.lang || "").toLowerCase();
  const cues = [];
  for (const ch of data.content) {
    const text = cleanCueText(String(ch?.text || ""));
    if (!text) continue;
    const startMs = Math.max(0, Math.round(Number(ch?.offset) || 0));
    const durMs = Math.round(Number(ch?.duration) || 0);
    const endMs = startMs + (durMs > 0 ? Math.max(200, durMs) : 2e3);
    cues.push({ startMs, endMs, text });
  }
  if (!cues.length) return { status: "fail", detail: "supadata 0 cues" };
  if (langWanted === "en" && lang && !lang.startsWith("en")) {
    return { status: "fail", detail: `supadata lang ${lang} not english` };
  }
  return { status: "ok", cues, isAuto: false, lang: lang || langWanted || "en", source: "supadata", detail: `supadata ${cues.length} cues lang=${lang || langWanted || "en"}` };
}
__name(extractViaSupadata, "extractViaSupadata");
var LAST_EXTRACT_ATTEMPTS = [];
// فارسی: مدیر استخراج؛ چند مسیر را به ترتیب امتحان می‌کند تا زیرنویس پیدا شود.
async function extractEnglishSubtitles(videoId, env = {}) {
  if (!videoId || !VIDEO_ID_RE.test(String(videoId))) {
    throw new AppError(ERROR_CODES.INVALID_URL, "\u274C \u0634\u0646\u0627\u0633\u0647 \u0648\u06CC\u062F\u06CC\u0648 \u0645\u0639\u062A\u0628\u0631 \u0646\u06CC\u0633\u062A.");
  }
  const kv = env.SUBTITLE_CACHE;
  const cacheKey = `cap2:${videoId}`;
  const blockKey = `block:${videoId}`;
  if (kv) {
    try {
      const cached = await kv.get(cacheKey, "json");
      if (cached && Array.isArray(cached.cues) && cached.cues.length > 0) {
        console.log(`[extract] ${videoId} CACHE_HIT cues=${cached.cues.length}`);
        return {
          cues: normalizeCues(cached.cues),
          isAuto: Boolean(cached.isAuto),
          languageCode: cached.languageCode || "en",
          source: `${cached.source || "cache"}_cached`
        };
      }
      const blockedUntil = await kv.get(blockKey);
      if (blockedUntil) {
        const waitSec = Math.ceil((Number(blockedUntil) - Date.now()) / 1e3);
        if (waitSec > 0) {
          console.log(`[extract] ${videoId} COOLDOWN ${waitSec}s left`);
          throw new AppError(
            ERROR_CODES.EXTRACTION_FAILED,
            `\u23F3 \u06CC\u0648\u062A\u06CC\u0648\u0628 \u0647\u0645\u06CC\u0646 \u062D\u0627\u0644\u0627 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0627\u06CC\u0646 \u0648\u06CC\u062F\u06CC\u0648 \u0631\u0627 \u0631\u062F \u06A9\u0631\u062F\u0647. \u062D\u062F\u0648\u062F ${waitSec} \u062B\u0627\u0646\u06CC\u0647 \u062F\u06CC\u06AF\u0631 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.`
          );
        }
        await kv.delete(blockKey);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(`[cache] ${videoId} read failed: ${errName(err)}`);
    }
  }
  const started = Date.now();
  const deadline = started + TOTAL_BUDGET_MS;
  const attempts = [];
  LAST_EXTRACT_ATTEMPTS = attempts;
  let hit = null;
  if (env.SUPADATA_API_KEY) {
    const sd = await extractViaSupadata(videoId, deadline, env.SUPADATA_API_KEY).catch((err) => ({
      status: "fail",
      detail: `supadata ${errName(err)}`
    }));
    logAttempt(videoId, sd);
    attempts.push(sd);
    if (sd.status === "ok" && sd.cues?.length) hit = sd;
    if (!hit) {
      const sdAny = await extractViaSupadata(videoId, deadline, env.SUPADATA_API_KEY, null).catch((err) => ({
        status: "fail",
        detail: `supadata-any ${errName(err)}`
      }));
      logAttempt(videoId, sdAny);
      attempts.push(sdAny);
      if (sdAny.status === "ok" && sdAny.cues?.length) hit = sdAny;
      if (!hit && sdAny.status === "empty" && sdAny.definitive) {
        throw new AppError(
          ERROR_CODES.NO_CAPTIONS,
          "\u274C \u0627\u06CC\u0646 \u0648\u06CC\u062F\u06CC\u0648 \u0647\u06CC\u0686 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633\u06CC \u0646\u062F\u0627\u0631\u062F (\u0646\u0647 \u062F\u0633\u062A\u06CC \u0648 \u0646\u0647 \u062E\u0648\u062F\u06A9\u0627\u0631)."
        );
      }
    }
  }
  for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS && !hit; attemptNo += 1) {
    if (attemptNo > 1) {
      const pause = 1200 * attemptNo;
      if (remaining(deadline) < pause + 2500) break;
      console.log(`[extract] ${videoId} retry ${attemptNo} after ${pause}ms`);
      await sleep(pause);
    }
    const [watchResult, invidiousResult] = await Promise.all([
      extractViaWatchPage(videoId, deadline).catch((err) => ({ status: "fail", detail: `watch ${errName(err)}` })),
      extractViaInvidious(videoId, deadline).catch((err) => ({ status: "fail", detail: `invidious ${errName(err)}` }))
    ]);
    const wave = [
      { ...invidiousResult, source: invidiousResult.source || "invidious" },
      { ...watchResult, source: watchResult.source || "youtube_page" }
    ];
    for (const attempt of wave) {
      attempts.push(attempt);
      logAttempt(videoId, attempt);
    }
    hit = wave.find((a) => a.status === "ok" && a.cues?.length) || null;
    if (!hit && (wave.some((a) => a.status === "empty" && a.definitive) || wave.some((a) => a.status === "notfound"))) {
      break;
    }
    if (!hit) {
      const timedtext = await extractViaTimedtext(videoId, deadline).catch((err) => ({
        status: "fail",
        detail: `timedtext ${errName(err)}`
      }));
      logAttempt(videoId, timedtext);
      attempts.push(timedtext);
      if (timedtext.status === "ok" && timedtext.cues?.length) hit = timedtext;
    }
    if (!hit) {
      const innertube = await extractViaInnertube(videoId, deadline, watchResult.visitorData || null).catch((err) => ({
        status: "fail",
        detail: `innertube ${errName(err)}`
      }));
      logAttempt(videoId, innertube);
      attempts.push(innertube);
      if (innertube.status === "ok" && innertube.cues?.length) hit = innertube;
    }
  }
  if (hit) {
    const payload = {
      cues: normalizeCues(hit.cues),
      isAuto: Boolean(hit.isAuto),
      languageCode: hit.lang || "en",
      source: hit.source
    };
    if (kv) {
      try {
        await kv.put(cacheKey, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
        await kv.delete(blockKey);
        console.log(`[extract] ${videoId} CACHED ${payload.cues.length} cues via ${hit.source} (48h)`);
      } catch (err) {
        console.error(`[cache] ${videoId} write failed: ${errName(err)}`);
      }
    }
    console.log(`[extract] ${videoId} OK via ${hit.source} in ${Date.now() - started}ms`);
    return payload;
  }
  const definitiveEmpty = attempts.find((a) => a.status === "empty" && a.definitive);
  const notFound = attempts.find((a) => a.status === "notfound");
  const botWall = attempts.some((a) => a.botWall);
  const anyHadCaptionList = attempts.some((a) => a.hasCaptionList);
  const rateLimited = attempts.some((a) => a.detail && /http 429/i.test(a.detail));
  console.log(
    `[extract] ${videoId} FAILED in ${Date.now() - started}ms empty=${Boolean(definitiveEmpty)} notfound=${Boolean(notFound)} botWall=${botWall} capListed=${anyHadCaptionList} rateLimited=${rateLimited}`
  );
  const markBlocked = /* @__PURE__ */ __name(async () => {
    if (!kv) return;
    try {
      await kv.put(blockKey, String(Date.now() + COOLDOWN_SECONDS * 1e3), {
        expirationTtl: COOLDOWN_SECONDS
      });
      console.log(`[cache] ${videoId} cooldown ${COOLDOWN_SECONDS}s set`);
    } catch (err) {
      console.error(`[cache] ${videoId} cooldown write failed: ${errName(err)}`);
    }
  }, "markBlocked");
  if (definitiveEmpty) {
    throw new AppError(
      ERROR_CODES.NO_CAPTIONS,
      "\u274C \u0627\u06CC\u0646 \u0648\u06CC\u062F\u06CC\u0648 \u0647\u06CC\u0686 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633\u06CC \u0646\u062F\u0627\u0631\u062F (\u0646\u0647 \u062F\u0633\u062A\u06CC \u0648 \u0646\u0647 \u062E\u0648\u062F\u06A9\u0627\u0631)."
    );
  }
  if (notFound) {
    throw new AppError(
      ERROR_CODES.EXTRACTION_FAILED,
      "\u26A0\uFE0F \u062E\u0648\u062F \u0648\u06CC\u062F\u06CC\u0648 \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A: \u062E\u0635\u0648\u0635\u06CC\u060C \u062D\u0630\u0641\u200C\u0634\u062F\u0647 \u06CC\u0627 \u0645\u062D\u062F\u0648\u062F \u0628\u0647 \u06A9\u0634\u0648\u0631 \u062F\u06CC\u06AF\u0631\u06CC \u0627\u0633\u062A."
    );
  }
  if (rateLimited) {
    await markBlocked();
    throw new AppError(
      ERROR_CODES.EXTRACTION_FAILED,
      "\u{1F504} \u06CC\u0648\u062A\u06CC\u0648\u0628 \u0641\u0639\u0644\u0627\u064B \u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627\u06CC \u0632\u06CC\u0627\u062F \u0631\u0627 \u0631\u062F \u0645\u06CC\u200C\u06A9\u0646\u062F. \u06F3 \u062F\u0642\u06CC\u0642\u0647 \u0635\u0628\u0631 \u06A9\u0646\u06CC\u062F \u0648 \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0645\u062A\u062D\u0627\u0646 \u06A9\u0646\u06CC\u062F."
    );
  }
  if (anyHadCaptionList) {
    await markBlocked();
    throw new AppError(
      ERROR_CODES.EXTRACTION_FAILED,
      "\u{1F527} \u0644\u06CC\u0633\u062A \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u062F\u0631\u06CC\u0627\u0641\u062A \u0634\u062F \u0627\u0645\u0627 \u062F\u0627\u0646\u0644\u0648\u062F \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F (\u0634\u0628\u06A9\u0647/\u0633\u0631\u0648\u0631). \u0644\u0637\u0641\u0627\u064B \u06F3\u06F0 \u062B\u0627\u0646\u06CC\u0647 \u0635\u0628\u0631 \u06A9\u0646\u06CC\u062F \u0648 \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0645\u062A\u062D\u0627\u0646 \u06A9\u0646\u06CC\u062F."
    );
  }
  if (botWall) {
    await markBlocked();
    throw new AppError(
      ERROR_CODES.EXTRACTION_FAILED,
      "\u23F3 \u06CC\u0648\u062A\u06CC\u0648\u0628 \u0641\u0639\u0644\u0627\u064B \u0628\u0647 \u0627\u06CC\u0646 \u0633\u0631\u0648\u0631 \u0627\u062C\u0627\u0632\u0647 \u0646\u0645\u06CC\u200C\u062F\u0647\u062F \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0628\u0641\u0631\u0633\u062A\u062F. \u06F2 \u062A\u0627 \u06F3 \u062F\u0642\u06CC\u0642\u0647 \u062F\u06CC\u06AF\u0631 \u0647\u0645\u0627\u0646 \u0644\u06CC\u0646\u06A9 \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F."
    );
  }
  throw new AppError(
    ERROR_CODES.EXTRACTION_FAILED,
    "\u23F3 \u0633\u0631\u0648\u06CC\u0633\u200C\u0647\u0627\u06CC \u062F\u0631\u06CC\u0627\u0641\u062A \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0627\u0644\u0627\u0646 \u062C\u0648\u0627\u0628 \u0646\u0645\u06CC\u200C\u062F\u0647\u0646\u062F (\u0645\u0634\u06A9\u0644 \u0645\u0648\u0642\u062A \u0634\u0628\u06A9\u0647). \u0686\u0646\u062F \u062F\u0642\u06CC\u0642\u0647 \u062F\u06CC\u06AF\u0631 \u062F\u0648\u0628\u0627\u0631\u0647 \u0627\u0645\u062A\u062D\u0627\u0646 \u06A9\u0646\u06CC\u062F."
  );
}
__name(extractEnglishSubtitles, "extractEnglishSubtitles");
async function probeHostList(host, videoId) {
  const started = Date.now();
  try {
    const res = await timedFetch(
      `${host}/api/v1/captions/${encodeURIComponent(videoId)}`,
      { headers: { "User-Agent": UA, Accept: "application/json" } },
      4e3
    );
    const ab = await res.arrayBuffer();
    const body = new TextDecoder().decode(ab);
    let captions = null;
    let note = "";
    try {
      const data = JSON.parse(body);
      if (Array.isArray(data?.captions)) captions = data.captions;
      else if (data?.error) note = String(data.error).slice(0, 80);
    } catch {
      note = body.trimStart().startsWith("<") ? `html ${body.length}b` : "non-json";
    }
    return {
      host,
      http: res.status,
      ms: Date.now() - started,
      captions: captions ? captions.length : null,
      langs: captions ? captions.slice(0, 5).map((c) => c.languageCode) : null,
      note
    };
  } catch (err) {
    return { host, http: 0, ms: Date.now() - started, captions: null, error: errName(err) };
  }
}
__name(probeHostList, "probeHostList");
async function diagnoseExtraction(videoId, mode = "all", env = {}) {
  const started = Date.now();
  const report = { videoId, mode, at: (/* @__PURE__ */ new Date()).toISOString(), ms: 0, hosts: [], stages: [] };
  if (mode === "models" || mode.startsWith("models:")) {
    const DOC_MODELS = ["claude-fable-5", "claude-fable-5-1", "claude-fable-5-2", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "deepseek-v4-1-flash-1017", "gemini-3-8-flash", "gemini-4-argon", "gemini-4-carbon", "glm-5-3-flash", "gpt-6-1-sol", "gpt-6-1-terra", "gpt-6-astra", "gpt-6-luna", "grok-4-7", "hy4", "kimi-k3", "kimi-k3-1-pro", "mimo-v2-6-pro", "minimax-m3-1-flash", "qwen3-8-2-4t-a95b"];
    const wanted = mode.startsWith("models:") ? mode.slice(7).split(",").map((s) => s.trim()).filter(Boolean) : DOC_MODELS;
    const results = [];
    for (const m of wanted) {
      const t0 = Date.now();
      try {
        const res = await fetchWithTimeout(
          `${COARENA_BASE_URL}/chat/completions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${coarenaApiKeys(env)[0] || ""}` },
            body: JSON.stringify({
              model: m,
              temperature: 0.2,
              max_tokens: 200,
              messages: [{ role: "user", content: `Translate this subtitle line into natural Persian (Farsi). Reply with ONLY the Persian translation: "What are you doing here? Get out of my way!"` }]
            })
          },
          3e4
        );
        const data = await res.json().catch(() => null);
        results.push({
          model: m,
          status: res.status,
          ok: res.ok,
          ms: Date.now() - t0,
          reply: (data?.choices?.[0]?.message?.content || "").slice(0, 140),
          error: data?.error?.message ? String(data.error.message).slice(0, 160) : null,
          totalTokens: data?.usage?.total_tokens || null
        });
      } catch (err) {
        results.push({ model: m, status: 0, ok: false, ms: Date.now() - t0, reply: "", error: String(err.message || err).slice(0, 160), totalTokens: null });
      }
    }
    report.result = { tested: results.length, results };
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "gmodels" || mode.startsWith("gmodels:")) {
    const listRes = await fetchWithTimeout(GEMINI_BASE, { headers: { "x-goog-api-key": env.GEMINI_API_KEY || "" } }, 15e3).catch(() => null);
    let listed = [];
    const listStatus = listRes ? listRes.status : 0;
    if (listRes && listRes.ok) {
      const data = await listRes.json().catch(() => null);
      listed = (data?.models || []).map((m) => ({
        id: String(m.name || "").replace(/^models\//, ""),
        methods: m.supportedGenerationMethods || []
      })).filter((m) => m.id);
    }
    const testIds = [];
    if (mode.startsWith("gmodels:")) {
      for (const id of mode.slice(8).split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!testIds.includes(id)) testIds.push(id);
      }
    } else {
      for (const m of listed) {
        if (m.methods.includes("generateContent") && !testIds.includes(m.id)) testIds.push(m.id);
      }
      for (const c of GEMINI_MODEL_CANDIDATES) {
        if (!testIds.includes(c)) testIds.push(c);
      }
    }
    const results = [];
    for (const id of testIds.slice(0, 24)) {
      const t0 = Date.now();
      try {
        const res = await fetchWithTimeout(
          `${GEMINI_BASE}/${id}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: `Translate this subtitle line into natural Persian (Farsi). Reply with ONLY the Persian translation: "What are you doing here? Get out of my way!"` }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 200 }
            })
          },
          3e4
        );
        const data = await res.json().catch(() => null);
        results.push({
          model: id,
          listed: listed.some((m) => m.id === id),
          configured: GEMINI_MODEL_CANDIDATES.includes(id),
          status: res.status,
          ok: res.ok,
          ms: Date.now() - t0,
          reply: (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").slice(0, 140),
          error: data?.error?.message ? String(data.error.message).slice(0, 160) : null
        });
      } catch (err) {
        results.push({ model: id, listed: listed.some((m) => m.id === id), configured: GEMINI_MODEL_CANDIDATES.includes(id), status: 0, ok: false, ms: Date.now() - t0, reply: "", error: String(err.message || err).slice(0, 160) });
      }
    }
    report.result = { listStatus, listedCount: listed.length, listed: listed.map((m) => m.id), tested: results.length, results };
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "fulltest" || mode.startsWith("fulltest:")) {
    try {
      const limit = parseInt(mode.split(":")[1] || "0", 10) || 0;
      const out = await extractEnglishSubtitles(videoId, env);
      const srcLang = normalizeLangCode(out.languageCode);
      const cuesIn = limit > 0 ? out.cues.slice(0, limit) : out.cues;
      const tSettings = await resolveTranslationSettings(env);
      const jobUsageSink = {};
      const t0 = Date.now();
      const translated = await translateCuesToPersian(cuesIn, async () => {
      }, env, jobUsageSink, srcLang);
      const srt = generateSrt(translated);
      report.result = {
        ok: true,
        source: out.source,
        provider: tSettings.provider,
        model: tSettings.model,
        translateMs: Date.now() - t0,
        extractStats: analyzeCues(out.cues),
        translatedStats: analyzeCues(translated),
        srtStats: analyzeSrt(srt),
        usage: jobUsageSink,
        srtHead: srt.slice(0, 700)
      };
    } catch (err) {
      report.result = { ok: false, error: String(err.message || err).slice(0, 200) };
    }
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "cues") {
    try {
      const out = await extractEnglishSubtitles(videoId, env);
      report.result = { ok: true, source: out.source, lang: out.languageCode || null, stats: analyzeCues(out.cues), sample: out.cues.slice(0, 6) };
    } catch (err) {
      report.result = { ok: false, error: String(err.message || err).slice(0, 200) };
    }
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "setcommands") {
    try {
      const res = await fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: BOT_COMMANDS })
      }, 1e4);
      const data = await res.json().catch(() => null);
      let menu = null;
      try {
        const res2 = await fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setChatMenuButton`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ menu_button: { type: "commands" } })
        }, 1e4);
        menu = await res2.json().catch(() => null);
      } catch {
      }
      report.result = { setMyCommands: data, setChatMenuButton: menu };
    } catch (err) {
      report.result = { error: String(err.message || err).slice(0, 160) };
    }
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "getcommands") {
    try {
      const res = await fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMyCommands`, {}, 1e4);
      const data = await res.json().catch(() => null);
      report.result = { tgOk: Boolean(data?.ok), commands: data?.result || null };
    } catch (err) {
      report.result = { error: String(err.message || err).slice(0, 160) };
    }
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "tginfo") {
    try {
      const res = await fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`, {}, 1e4);
      const data = await res.json().catch(() => null);
      report.result = { tgOk: Boolean(data?.ok), webhook: data?.result || null };
    } catch (err) {
      report.result = { error: String(err.message || err).slice(0, 160) };
    }
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "fixwebhook") {
    try {
      const res = await fetchWithTimeout(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://subtube-bot.hsdoebc.workers.dev/webhook",
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: false
        })
      }, 1e4);
      const data = await res.json().catch(() => null);
      report.result = { setWebhook: data };
    } catch (err) {
      report.result = { error: String(err.message || err).slice(0, 160) };
    }
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "cbdbg") {
    let lastcb = null;
    let cberror = null;
    try {
      lastcb = await env.SUBTITLE_CACHE.get("dbg:lastcb", "json");
    } catch {
    }
    try {
      cberror = await env.SUBTITLE_CACHE.get("dbg:cberror", "json");
    } catch {
    }
    report.result = { lastcb, cberror };
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "cacheprobe") {
    const probePayload = { srt: "probe-srt-content", cueCount: 1, isAuto: false };
    await writeTranslationCache(env.SUBTITLE_CACHE, videoId, "probe", "probe", "probe", probePayload);
    const back = await readTranslationCache(env.SUBTITLE_CACHE, videoId, "probe", "probe", "probe");
    let cleaned = false;
    try {
      await env.SUBTITLE_CACHE.delete(translationCacheKey(videoId, "probe", "probe", "probe"));
      cleaned = true;
    } catch {
    }
    report.result = { ok: Boolean(back && back.srt === probePayload.srt), cleaned };
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "limits") {
    const keys = coarenaApiKeys(env);
    report.result = {
      keyCount: keys.length,
      primary: keys.length ? await getCoarenaLimits(env, keys[0]) : null,
      secondary: keys.length > 1 ? await getCoarenaLimits(env, keys[1]) : null
    };
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "translate") {
    const t0 = Date.now();
    try {
      const out = await extractEnglishSubtitles(videoId, env);
      const sample = out.cues.slice(0, 12);
      const usage = {};
      const fa = await translateCuesToPersian(sample, null, env, usage, out.languageCode);
      const validation = validateTranslatedCues(sample, fa);
      const tSettings = await resolveTranslationSettings(env);
      const summary = await summarizeTranscript(sample, env, tSettings);
      report.result = {
        ok: validation.ok,
        problems: validation.problems,
        source: out.source,
        sourceLang: out.languageCode || null,
        sampleSize: sample.length,
        usage,
        summary,
        lines: sample.map((c, i) => ({ startMs: c.startMs, endMs: c.endMs, en: c.text, fa: fa[i]?.text || null })),
        srtPreview: generateSrt(fa).slice(0, 700),
        ms: Date.now() - t0
      };
    } catch (err) {
      report.result = { ok: false, error: String(err.message || err).slice(0, 200), ms: Date.now() - t0 };
    }
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "extract") {
    const t0 = Date.now();
    const attemptView = () => (LAST_EXTRACT_ATTEMPTS || []).map((a) => ({ status: a.status, detail: a.detail || null, source: a.source || null }));
    try {
      const out = await extractEnglishSubtitles(videoId, env);
      report.result = { ok: true, source: out.source, lang: out.languageCode || null, cues: out.cues.length, attempts: attemptView(), ms: Date.now() - t0 };
    } catch (err) {
      report.result = {
        ok: false,
        code: err.code || null,
        error: String(err.message || err).slice(0, 200),
        attempts: attemptView(),
        ms: Date.now() - t0
      };
    }
    report.ms = Date.now() - started;
    return report;
  }
  if (mode === "hosts" || mode === "all") {
    report.hosts = await Promise.all(CANDIDATE_HOSTS.map((h) => probeHostList(h, videoId)));
  }
  if (mode === "youtube" || mode === "all") {
    const deadline = Date.now() + 12e3;
    const watch = await extractViaWatchPage(videoId, deadline).catch((err) => ({
      status: "fail",
      detail: errName(err)
    }));
    report.stages.push({
      name: "watch_page",
      status: watch.status,
      detail: watch.detail || null,
      cues: watch.cues?.length || 0,
      visitorData: watch.visitorData ? "present" : "missing"
    });
    const innertube = await extractViaInnertube(videoId, deadline, watch.visitorData).catch((err) => ({
      status: "fail",
      detail: errName(err)
    }));
    report.stages.push({
      name: "innertube",
      status: innertube.status,
      detail: innertube.detail || null,
      cues: innertube.cues?.length || 0
    });
    const timedtext = await extractViaTimedtext(videoId, deadline).catch((err) => ({
      status: "fail",
      detail: errName(err)
    }));
    report.stages.push({
      name: "timedtext",
      status: timedtext.status,
      detail: timedtext.detail || null,
      cues: timedtext.cues?.length || 0
    });
    const invidious = await extractViaInvidious(videoId, deadline).catch((err) => ({
      status: "fail",
      detail: errName(err)
    }));
    report.stages.push({
      name: "invidious_extract",
      status: invidious.status,
      detail: invidious.detail || null,
      cues: invidious.cues?.length || 0
    });
  }
  report.ms = Date.now() - started;
  return report;
}
__name(diagnoseExtraction, "diagnoseExtraction");

// src/translator/google-translate.js
var GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
var GEMINI_MODEL_CANDIDATES = [
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest"
];
var TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fa&dt=t";
var MAX_CHUNK_CHARS = 6e3;
var MAX_ITEMS_PER_CHUNK = 80;
var CONCURRENCY = 4;
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep2, "sleep");
async function fetchWithTimeout(url, options = {}, timeoutMs = 8e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (typeof Response !== "undefined" && res instanceof Response && typeof res.arrayBuffer === "function") {
      // Buffer the body while the timer is still armed: a plain fetch() resolves
      // when headers arrive, and a stalled body would otherwise hang res.json()
      // forever after the timer was cleared (root cause of jobs freezing at
      // the "building SRT" stage). The returned Response reads from memory.
      const body = await res.arrayBuffer();
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}
__name(fetchWithTimeout, "fetchWithTimeout");
var SOURCE_LANG_NAMES = { en: "English", ar: "Arabic", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", ru: "Russian", tr: "Turkish", fa: "Persian", hi: "Hindi", ur: "Urdu", zh: "Chinese", ja: "Japanese", ko: "Korean", nl: "Dutch", pl: "Polish", uk: "Ukrainian", id: "Indonesian", az: "Azerbaijani", ku: "Kurdish", ps: "Pashto" };
function normalizeLangCode(raw) {
  const c = String(raw || "en").toLowerCase().split("-")[0];
  return /^[a-z]{2,3}$/.test(c) ? c : "en";
}
__name(normalizeLangCode, "normalizeLangCode");
function sourceLangName(code) {
  return SOURCE_LANG_NAMES[code] || code;
}
__name(sourceLangName, "sourceLangName");
// فارسی: ترجمه یک تکه از زیرنویس با Gemini بر اساس شناسه هر خط (جلوگیری از به‌هم‌ریختگی ترتیب).
async function translateChunkViaGeminiById(chunk, apiKey, langName = "English") {
  const items = chunk.map((c) => ({
    id: c.index,
    text: c.text.replace(/\n+/g, " ").replace(/\r/g, "").trim()
  }));
  const expectedIds = new Set(items.map((i) => i.id));
  const prompt = `Translate each ${langName} subtitle item into natural, fluent Persian (Farsi).
You receive a JSON array of items, each with a unique "id" and its "text".
Return ONLY a JSON array with exactly one object per input item, in this shape: {"id": <the same id>, "fa": "<the Persian translation of that item's text>"}.
Rules: never merge two items into one object, never split one item into two, never change an id, never omit an id, never invent new ids. The order of the objects in your answer does not matter, because every translation is matched to its subtitle by id. Preserve all numbers, URLs, and {{{S%}}} placeholder markers. Do not output anything else.

` + JSON.stringify(items);
  for (const model of GEMINI_MODEL_CANDIDATES) {
    let res;
    try {
      res = await fetchWithTimeout(
        `${GEMINI_BASE}/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 8e3,
              responseMimeType: "application/json",
              responseSchema: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: { id: { type: "INTEGER" }, fa: { type: "STRING" } },
                  required: ["id", "fa"]
                }
              }
            }
          })
        },
        8e3
      );
    } catch (err) {
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "auth", status: res.status };
    }
    if (res.status === 400 || res.status === 404 || res.status === 429 || res.status === 503 || res.status === 504) {
      continue;
    }
    if (!res.ok) {
      continue;
    }
    const data = await res.json().catch(() => null);
    if (!data) continue;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.candidates?.[0]?.output || "";
    if (!text) continue;
    const byId = matchTranslationsById(text, expectedIds);
    if (byId) {
      return { ok: true, byId };
    }
  }
  return { ok: false, reason: "unavailable", status: 0 };
}
__name(translateChunkViaGeminiById, "translateChunkViaGeminiById");
function matchTranslationsArray(arr, expectedIds) {
  if (!Array.isArray(arr)) return null;
  const byId = new Map();
  for (const item of arr) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const id = Number(item.id);
    const fa = typeof item.fa === "string" ? item.fa.trim() : "";
    if (!Number.isInteger(id) || !expectedIds.has(id)) return null;
    if (byId.has(id)) return null;
    if (!fa) return null;
    byId.set(id, fa);
  }
  if (byId.size !== expectedIds.size) return null;
  return byId;
}
__name(matchTranslationsArray, "matchTranslationsArray");
function matchTranslationsById(text, expectedIds) {
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    return null;
  }
  return matchTranslationsArray(arr, expectedIds);
}
__name(matchTranslationsById, "matchTranslationsById");
var COARENA_BASE_URL = "https://coarena.ai/api/v1";
var COARENA_DEFAULT_MODEL = "claude-sonnet-5-5";
function coarenaApiKeys(env) {
  const keys = [];
  if (env.COARENA_API_KEY) keys.push(env.COARENA_API_KEY);
  if (env.COARENA_API_KEY_2) keys.push(env.COARENA_API_KEY_2);
  return keys;
}
__name(coarenaApiKeys, "coarenaApiKeys");
async function resolveTranslationSettings(env) {
  let provider = "";
  let model = "";
  try {
    provider = (await getSetting(env.DB, "translation_provider", "")) || "";
    model = (await getSetting(env.DB, "translation_model", "")) || "";
  } catch {
  }
  provider = (provider || env.TRANSLATION_PROVIDER || "coarena").trim().toLowerCase();
  model = (model || env.TRANSLATION_MODEL || COARENA_DEFAULT_MODEL).trim();
  if (!["coarena", "gemini", "google"].includes(provider)) provider = "coarena";
  return { provider, model };
}
__name(resolveTranslationSettings, "resolveTranslationSettings");
// فارسی: ترجمه یک تکه با Coarena (API سازگار با OpenAI) بر اساس شناسه هر خط.
async function translateChunkViaCoarenaById(chunk, apiKey, model, usage, langName = "English", deadlineAt = 0) {
  const items = chunk.map((c) => ({
    id: c.index,
    text: c.text.replace(/\n+/g, " ").replace(/\r/g, "").trim()
  }));
  const expectedIds = new Set(items.map((i) => i.id));
  const systemPrompt = `You are a professional subtitle translator for films and TV series, translating ${langName} dialogue into Persian (Farsi).
Translate naturally and fluently, the way people actually speak in Persian subtitles and dubbing: render idioms, slang, jokes and cultural references by their intended meaning, not word by word. Keep the tone of each line (funny, angry, sad, formal). Preserve names, numbers and any {{{S%}}} placeholders exactly.`;
  const userPrompt = `Translate every item below. Return ONLY a JSON object of this exact shape: {"items": [{"id": <the item's id>, "fa": "<its Persian translation>"}]}.
Rules: exactly one object per input item; never merge two items into one; never split one item into two; never change, omit or invent ids. The order of the objects does not matter, because each translation is matched to its subtitle by id.

` + JSON.stringify(items);
  const backoffsMs = [0, 1200, 3000, 6000];
  let contentFailures = 0;
  for (let attempt = 0; attempt < backoffsMs.length; attempt++) {
    if (attempt > 0) {
      if (usage) usage.retries = (usage.retries || 0) + 1;
      await sleep2(backoffsMs[attempt]);
    }
    let attemptTimeout = 45e3;
    if (deadlineAt) {
      const remaining = deadlineAt - Date.now();
      if (remaining < 3e3) break;
      attemptTimeout = Math.min(45e3, remaining);
    }
    let res;
    try {
      if (usage) usage.requests = (usage.requests || 0) + 1;
      res = await fetchWithTimeout(
        `${COARENA_BASE_URL}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 8e3,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ]
          })
        },
        attemptTimeout
      );
    } catch (err) {
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "auth", status: res.status };
    }
    if (res.status === 429 || res.status >= 500) {
      continue;
    }
    if (!res.ok) {
      return { ok: false, reason: "bad_request", status: res.status };
    }
    const data = await res.json().catch(() => null);
    if (!data) continue;
    if (usage && data.usage) {
      usage.promptTokens = (usage.promptTokens || 0) + (Number(data.usage.prompt_tokens) || 0);
      usage.completionTokens = (usage.completionTokens || 0) + (Number(data.usage.completion_tokens) || 0);
      usage.totalTokens = (usage.totalTokens || 0) + (Number(data.usage.total_tokens) || 0);
    }
    const content = data?.choices?.[0]?.message?.content || "";
    const byId = parseCoarenaContent(content, expectedIds);
    if (byId) return { ok: true, byId };
    contentFailures++;
    if (contentFailures >= 2) {
      return { ok: false, reason: "invalid_output", status: res.status };
    }
  }
  return { ok: false, reason: "unavailable", status: 0 };
}
__name(translateChunkViaCoarenaById, "translateChunkViaCoarenaById");
function parseCoarenaContent(content, expectedIds) {
  if (!content || typeof content !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = void 0;
  }
  if (parsed === void 0) {
    const slices = [];
    const a = content.indexOf("[");
    const b = content.lastIndexOf("]");
    if (a !== -1 && b > a) slices.push(content.slice(a, b + 1));
    const c = content.indexOf("{");
    const d = content.lastIndexOf("}");
    if (c !== -1 && d > c) slices.push(content.slice(c, d + 1));
    for (const s of slices) {
      try {
        parsed = JSON.parse(s);
        break;
      } catch {
      }
    }
  }
  if (parsed === void 0 || parsed === null) return null;
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : null;
  return matchTranslationsArray(arr, expectedIds);
}
__name(parseCoarenaContent, "parseCoarenaContent");
var lastRequestAt = 0;
async function throttle(minGapMs = 400) {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < minGapMs) {
    await sleep2(minGapMs - elapsed);
  }
  lastRequestAt = Date.now();
}
__name(throttle, "throttle");
var UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
];
async function fetchGoogleTranslateRaw(queryText, maxRetries = 2, srcLang = "en") {
  const endpoint = TRANSLATE_ENDPOINT.replace("sl=en", `sl=${srcLang}`);
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const backoffMs = 700 * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
      await sleep2(backoffMs);
    }
    await throttle();
    const res = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": UA_POOL[Math.floor(Math.random() * UA_POOL.length)]
        },
        body: new URLSearchParams({ q: queryText }).toString()
      },
      6e3
    );
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`HTTP_${res.status}`);
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP_${res.status}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      throw new Error("INVALID_TRANSLATE_PAYLOAD");
    }
    return data[0].map((segment) => Array.isArray(segment) && typeof segment[0] === "string" ? segment[0] : "").join("");
  }
  throw lastError || new Error("google_translate_failed");
}
__name(fetchGoogleTranslateRaw, "fetchGoogleTranslateRaw");
function buildTranslationChunks(cues) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (let i = 0; i < cues.length; i++) {
    const text = cues[i].text;
    const itemCost = text.length + 18;
    if (current.length > 0 && (current.length >= MAX_ITEMS_PER_CHUNK || currentLen + itemCost > MAX_CHUNK_CHARS)) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push({ index: i, text });
    currentLen += itemCost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
__name(buildTranslationChunks, "buildTranslationChunks");
async function translateSingleChunkViaGoogle(chunk, srcLang = "en") {
  if (chunk.length === 1) {
    const translated = await fetchGoogleTranslateRaw(chunk[0].text, 2, srcLang);
    return [{ index: chunk[0].index, translatedText: translated.trim() || chunk[0].text }];
  }
  const prepared = chunk.map((item, idx) => {
    const flattened = item.text.replace(/\n+/g, " \u23CE ");
    return idx === 0 ? flattened : `
[[[${idx}]]]
${flattened}`;
  });
  const payload = prepared.join("");
  const rawTranslated = await fetchGoogleTranslateRaw(payload, 2, srcLang);
  const results = new Array(chunk.length);
  const splitRegex = /\s*\[\[\[\s*(\d+)\s*\]\]\]\s*/g;
  let lastPos = 0;
  let expectedMarker = 1;
  let match;
  let aligned = true;
  while ((match = splitRegex.exec(rawTranslated)) !== null) {
    const markerNum = Number(match[1]);
    if (markerNum !== expectedMarker) {
      aligned = false;
      break;
    }
    const piece = rawTranslated.slice(lastPos, match.index);
    results[expectedMarker - 1] = piece;
    lastPos = splitRegex.lastIndex;
    expectedMarker++;
  }
  if (aligned && expectedMarker === chunk.length) {
    results[chunk.length - 1] = rawTranslated.slice(lastPos);
  } else {
    aligned = false;
  }
  if (!aligned || results.some((r) => typeof r !== "string" || !r.trim())) {
    if (chunk.length <= 3) {
      const singleOut = [];
      for (const item of chunk) {
        const t = await fetchGoogleTranslateRaw(item.text, 2, srcLang);
        singleOut.push({ index: item.index, translatedText: t.trim() || item.text });
      }
      return singleOut;
    }
    const mid = Math.ceil(chunk.length / 2);
    const left = await translateSingleChunkViaGoogle(chunk.slice(0, mid), srcLang);
    const right = await translateSingleChunkViaGoogle(chunk.slice(mid), srcLang);
    return [...left, ...right];
  }
  return chunk.map((item, idx) => {
    const restored = results[idx].replace(/\s*⏎\s*/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).join("\n").trim();
    return {
      index: item.index,
      translatedText: restored || item.text
    };
  });
}
__name(translateSingleChunkViaGoogle, "translateSingleChunkViaGoogle");
// فارسی: کنترل نهایی؛ اگر تعداد یا زمان‌بندی خط‌های ترجمه با اصل نخواند، فایل تحویل داده نمی‌شود.
function validateTranslatedCues(original, translated) {
  const problems = [];
  const brokenIndices = [];
  if (!Array.isArray(translated) || translated.length !== original.length) {
    problems.push(`count ${Array.isArray(translated) ? translated.length : "n/a"} != ${original.length}`);
    return { ok: false, problems, brokenIndices };
  }
  for (let i = 0; i < original.length; i++) {
    const o = original[i];
    const t = translated[i];
    if (!t) {
      problems.push(`missing cue ${i}`);
      brokenIndices.push(i);
      continue;
    }
    if (t.startMs !== o.startMs || t.endMs !== o.endMs) {
      problems.push(`timing changed at ${i}`);
    }
    if (typeof t.text !== "string" || !t.text.trim()) {
      problems.push(`empty text at ${i}`);
      brokenIndices.push(i);
    }
  }
  return { ok: problems.length === 0, problems, brokenIndices };
}
__name(validateTranslatedCues, "validateTranslatedCues");
// فارسی: موتور اصلی ترجمه کل زیرنویس به فارسی؛ بین Coarena ،Gemini و Google جابه‌جا می‌شود.
async function translateCuesToPersian(cues, onProgress = null, env = {}, usageSink = null, sourceLang = "en") {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const srcLang = normalizeLangCode(sourceLang);
  const langName = sourceLangName(srcLang);
  const tSettings = await resolveTranslationSettings(env);
  const jobUsage = usageSink || {};
  Object.assign(jobUsage, {
    provider: tSettings.provider,
    model: tSettings.model,
    sourceLang: srcLang,
    requests: jobUsage.requests || 0,
    promptTokens: jobUsage.promptTokens || 0,
    completionTokens: jobUsage.completionTokens || 0,
    totalTokens: jobUsage.totalTokens || 0,
    retries: jobUsage.retries || 0,
    chunksByProvider: jobUsage.chunksByProvider || {}
  });
  const markUsed = /* @__PURE__ */ __name((p) => {
    jobUsage.chunksByProvider[p] = (jobUsage.chunksByProvider[p] || 0) + 1;
  }, "markUsed");
  if (srcLang === "fa") {
    markUsed("passthrough");
    jobUsage.untranslatedCount = 0;
    jobUsage.progress = { total: cues.length, processed: cues.length, succeeded: cues.length, failed: 0, chunksTotal: 1, chunksDone: 1, chunksOk: 1, chunksFailed: 0, phase: "done" };
    console.log(`[translate-usage] ${JSON.stringify(jobUsage)}`);
    return cues.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text }));
  }
  const chunks = buildTranslationChunks(cues);
  jobUsage.progress = {
    total: cues.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    chunksTotal: chunks.length,
    chunksDone: 0,
    chunksOk: 0,
    chunksFailed: 0,
    phase: "chunks"
  };
  const prog = jobUsage.progress;
  const failedIndices = [];
  const translatedByIndex = new Array(cues.length);
  let completedChunks = 0;
  const coarenaKeys = coarenaApiKeys(env);
  const deadCoarenaKeys = /* @__PURE__ */ new Set();
  const coarenaPrimary = tSettings.provider === "coarena" && coarenaKeys.length > 0;
  const overallDeadline = Date.now() + (coarenaPrimary ? 12e4 : 2e4);
  const effectiveConcurrency = coarenaPrimary ? 2 : CONCURRENCY;
  let geminiAvailable = Boolean(env.GEMINI_API_KEY);
  let coarenaAvailable = coarenaKeys.length > 0;
  const candidates = [];
  for (const p of [tSettings.provider, "coarena", "gemini", "google"]) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  async function translateChunk(chunk) {
    for (const p of candidates) {
      if (p === "coarena") {
        if (!coarenaAvailable || overallDeadline - Date.now() < 2e3) continue;
        let res = null;
        let keyIdx = 0;
        while (keyIdx < coarenaKeys.length) {
          if (deadCoarenaKeys.has(keyIdx)) {
            keyIdx++;
            continue;
          }
          try {
            res = await translateChunkViaCoarenaById(chunk, coarenaKeys[keyIdx], tSettings.model, jobUsage, langName, overallDeadline);
          } catch {
            res = null;
          }
          if (res && res.ok) {
            jobUsage.coarenaKeyUsed = keyIdx + 1;
            markUsed("coarena");
            return {
              ok: true,
              items: chunk.map((c) => ({
                index: c.index,
                translatedText: res.byId.get(c.index)
              }))
            };
          }
          if (res && (res.reason === "auth" || res.status === 402)) {
            jobUsage.coarenaError = `key${keyIdx + 1} ${res.reason} http ${res.status || 0}`;
            console.error(`[translate] coarena key ${keyIdx + 1} rejected (${res.reason} http ${res.status || 0}); marked dead for this job`);
            deadCoarenaKeys.add(keyIdx);
            keyIdx++;
            res = null;
            continue;
          }
          break;
        }
        if (deadCoarenaKeys.size >= coarenaKeys.length) {
          coarenaAvailable = false;
        }
        if (res && res.reason === "bad_request") {
          coarenaAvailable = false;
          jobUsage.coarenaError = `${res.reason} http ${res.status || 0}`;
          console.error(`[translate] coarena disabled for this job: ${res.reason} http ${res.status || 0}`);
        }
        if (res && res.reason === "invalid_output") {
          jobUsage.coarenaError = "invalid_output";
        }
        continue;
      }
      if (p === "gemini") {
        if (!geminiAvailable || overallDeadline - Date.now() < 1e3) continue;
        for (let attempt = 0; attempt < 2; attempt++) {
          let gem = null;
          try {
            gem = await translateChunkViaGeminiById(chunk, env.GEMINI_API_KEY, langName);
          } catch {
            gem = null;
          }
          if (gem && gem.ok) {
            markUsed("gemini");
            return {
              ok: true,
              items: chunk.map((c) => ({
                index: c.index,
                translatedText: gem.byId.get(c.index)
              }))
            };
          }
          if (gem && gem.reason === "auth") {
            geminiAvailable = false;
            break;
          }
          if (attempt === 0 && overallDeadline - Date.now() > 3e3) {
            await sleep(700);
          }
        }
        continue;
      }
      if (Date.now() > overallDeadline) break;
      try {
        const g = await translateSingleChunkViaGoogle(chunk, srcLang);
        markUsed("google");
        return { ok: true, items: g };
      } catch {
        continue;
      }
    }
    return { ok: false, items: chunk.map((c) => ({ index: c.index, translatedText: c.text })) };
  }
  __name(translateChunk, "translateChunk");
  for (let i = 0; i < chunks.length && Date.now() < overallDeadline; i += effectiveConcurrency) {
    const batch = chunks.slice(i, i + effectiveConcurrency);
    const batchOutputs = await Promise.all(batch.map((ch) => translateChunk(ch)));
    for (let bi = 0; bi < batchOutputs.length; bi++) {
      const chunkRes = batchOutputs[bi];
      const chunkCues = batch[bi];
      for (const item of chunkRes.items) {
        translatedByIndex[item.index] = item.translatedText;
      }
      prog.chunksDone++;
      prog.processed += chunkCues.length;
      if (chunkRes.ok) {
        prog.chunksOk++;
        prog.succeeded += chunkCues.length;
      } else {
        prog.chunksFailed++;
        prog.failed += chunkCues.length;
        for (const c of chunkCues) failedIndices.push(c.index);
      }
      completedChunks++;
    }
    if (typeof onProgress === "function") {
      await onProgress(completedChunks, chunks.length);
    }
  }
  const out = cues.map((cue, idx) => ({
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: translatedByIndex[idx] || cue.text
  }));
  const holeIndices = [];
  for (let i = 0; i < cues.length; i++) {
    if (translatedByIndex[i] === void 0) holeIndices.push(i);
  }
  let check = validateTranslatedCues(cues, out);
  const repairSet = [...new Set([...check.brokenIndices, ...holeIndices, ...failedIndices])].slice(0, 120);
  if (repairSet.length > 0) prog.phase = "repair";
  const repairedOk = new Set();
  if (!check.ok || repairSet.length > 0) {
    if (!check.ok) {
      console.error(`[translate] validation failed: ${check.problems.slice(0, 8).join("; ")}`);
    }
    for (const idx of repairSet) {
      try {
        const t = await fetchGoogleTranslateRaw(cues[idx].text, 2, srcLang);
        if (t && t.trim()) {
          out[idx] = { startMs: cues[idx].startMs, endMs: cues[idx].endMs, text: t.trim() };
          repairedOk.add(idx);
        }
      } catch {
      }
    }
    check = validateTranslatedCues(cues, out);
    if (!check.ok) {
      throw new Error(`TRANSLATION_VALIDATION_FAILED: ${check.problems.slice(0, 5).join("; ")}`);
    }
  }
  const failedSet = new Set(failedIndices);
  for (const idx of holeIndices) {
    prog.processed++;
    if (repairedOk.has(idx)) prog.succeeded++;
    else prog.failed++;
  }
  for (const idx of failedSet) {
    if (repairedOk.has(idx)) {
      prog.succeeded++;
      prog.failed--;
    }
  }
  prog.phase = "done";
  jobUsage.untranslatedCount = holeIndices.filter((i) => !repairedOk.has(i)).length + [...failedSet].filter((i) => !repairedOk.has(i)).length;
  if (jobUsage.untranslatedCount > 0) {
    console.error(`[translate] ${jobUsage.untranslatedCount} lines left untranslated (deadline)`);
  }
  console.log(`[translate-usage] ${JSON.stringify(jobUsage)}`);
  return out;
}
__name(translateCuesToPersian, "translateCuesToPersian");
// فارسی: ساخت خلاصه فارسی از متن زیرنویس (وقتی کاربر حالت خلاصه را انتخاب کند).
async function summarizeTranscript(cues, env, tSettings) {
  try {
    const text = (cues || []).map((c) => c.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 12e3);
    if (text.length < 200) return null;
    const system = "You are a helpful assistant that summarizes video transcripts in Persian (Farsi).";
    const user = `Here is the transcript of a YouTube video:\n\n${text}\n\nWrite a summary in Persian (Farsi) only: first one sentence saying what the video is about, then 4 to 7 short bullet lines (each starting with \u2022) with the key points. Plain, simple Persian. No English, no preamble, no closing remarks.`;
    for (const key of coarenaApiKeys(env)) {
      try {
        const res = await fetchWithTimeout(
          `${COARENA_BASE_URL}/chat/completions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: tSettings.model,
              temperature: 0.3,
              max_tokens: 700,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user }
              ]
            })
          },
          3e4
        );
        if (res.ok) {
          const data = await res.json().catch(() => null);
          const out = (data?.choices?.[0]?.message?.content || "").trim();
          if (out.length > 30) return out.slice(0, 1400);
        }
      } catch {
      }
    }
    if (env.GEMINI_API_KEY) {
      for (const model of GEMINI_MODEL_CANDIDATES) {
        try {
          const res = await fetchWithTimeout(
            `${GEMINI_BASE}/${model}:generateContent`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: `${system}\n\n${user}` }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 900 }
              })
            },
            2e4
          );
          if (!res.ok) continue;
          const data = await res.json().catch(() => null);
          const out = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
          if (out.length > 30) return out.slice(0, 1400);
        } catch {
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
__name(summarizeTranscript, "summarizeTranscript");
// فارسی: خواندن سهمیه باقی‌مانده حساب Coarena برای دستور /usage.
async function getCoarenaLimits(env, key = env.COARENA_API_KEY) {
  if (!key) return null;
  try {
    const res = await fetchWithTimeout(
      `${COARENA_BASE_URL}/limits`,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
      8e3
    );
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}
__name(getCoarenaLimits, "getCoarenaLimits");
function formatCoarenaLimits(lim) {
  if (!lim || typeof lim !== "object") return null;
  const d = lim.data && typeof lim.data === "object" ? lim.data : lim;
  const today = d.today && typeof d.today === "object" ? d.today : {};
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  const fmt = (n) => Math.round(n * 100) / 100;
  let used = num(today.used_usd);
  let left = num(today.left_usd);
  let limit = num(d.usd_per_day);
  let reqs = num(today.requests);
  if (used === void 0 && limit === void 0 && reqs === void 0) {
    const pick = (...keys) => {
      for (const k of keys) {
        if (typeof d[k] === "number") return d[k];
      }
      return void 0;
    };
    used = pick("usd_used", "used_usd", "used", "spent_usd");
    limit = pick("usd_limit", "limit_usd", "limit", "daily_limit_usd");
    reqs = pick("requests_today", "requests", "request_count");
  }
  const parts = [];
  if (used !== void 0 && limit !== void 0) parts.push(`\u0645\u0635\u0631\u0641 \u0627\u0645\u0631\u0648\u0632 Coarena: ${fmt(used)} \u0627\u0632 ${limit} \u062F\u0644\u0627\u0631`);
  else if (used !== void 0) parts.push(`\u0645\u0635\u0631\u0641 \u0627\u0645\u0631\u0648\u0632 Coarena: ${fmt(used)} \u062F\u0644\u0627\u0631`);
  if (left !== void 0) parts.push(`\u0628\u0627\u0642\u06CC\u200C\u0645\u0627\u0646\u062F\u0647 \u0627\u0645\u0631\u0648\u0632: ${fmt(left)} \u062F\u0644\u0627\u0631`);
  if (reqs !== void 0) parts.push(`\u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627\u06CC \u0627\u0645\u0631\u0648\u0632: ${reqs}`);
  return parts.length ? parts.join("\n") : null;
}
__name(formatCoarenaLimits, "formatCoarenaLimits");

// src/subtitle/srt-generator.js
function wrapSubtitleText(rawText, maxLineChars = 42) {
  const flat = String(rawText || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if ([...flat].length <= maxLineChars) return flat;
  const words = flat.split(" ");
  if (words.length === 1) return flat;
  const total = [...flat].length;
  let best = -1;
  let bestScore = Infinity;
  let len1 = 0;
  for (let i = 0; i < words.length - 1; i++) {
    len1 += [...words[i]].length + (i > 0 ? 1 : 0);
    const len2 = total - len1 - 1;
    let score = Math.abs(len1 - len2);
    if (/[\u060C.,\u061B:!?\u061F;:]$/.test(words[i])) score -= 4;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return words.slice(0, best + 1).join(" ") + "\n" + words.slice(best + 1).join(" ");
}
__name(wrapSubtitleText, "wrapSubtitleText");
// فارسی: ساخت متن نهایی فایل SRT از روی خط‌های ترجمه‌شده و زمان‌بندی آن‌ها.
function generateSrt(cues) {
  if (!Array.isArray(cues) || cues.length === 0) {
    return "";
  }
  const blocks = [];
  let seq = 1;
  for (const cue of cues) {
    const cleanText = wrapSubtitleText(cue.text);
    if (!cleanText) continue;
    const start = msToSrtTime(cue.startMs);
    const end = msToSrtTime(Math.max(cue.startMs + 100, cue.endMs));
    blocks.push(`${seq}
${start} --> ${end}
${cleanText}`);
    seq++;
  }
  return "\uFEFF" + blocks.join("\n\n") + "\n";
}
__name(generateSrt, "generateSrt");

// src/telegram/handlers.js
var CHOICE_LABELS = { srt: "\u0641\u0642\u0637 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633", sum: "\u0641\u0642\u0637 \u062E\u0644\u0627\u0635\u0647", both: "\u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0648 \u062E\u0644\u0627\u0635\u0647" };
function makeChoiceToken() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(makeChoiceToken, "makeChoiceToken");
function buildChoiceCallbackData(mode, token) {
  return `c:${mode}:${token}`;
}
__name(buildChoiceCallbackData, "buildChoiceCallbackData");
function parseChoiceCallbackData(data) {
  const m = /^c:(srt|sum|both):([a-f0-9]{12})$/.exec(String(data || ""));
  return m ? { mode: m[1], token: m[2] } : null;
}
__name(parseChoiceCallbackData, "parseChoiceCallbackData");
function choiceKeyboard(token) {
  return {
    inline_keyboard: [[
      { text: "\u{1F4C4} \u0641\u0642\u0637 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633", callback_data: buildChoiceCallbackData("srt", token) },
      { text: "\u{1F4DD} \u0641\u0642\u0637 \u062E\u0644\u0627\u0635\u0647", callback_data: buildChoiceCallbackData("sum", token) },
      { text: "\u2728 \u0647\u0631 \u062F\u0648", callback_data: buildChoiceCallbackData("both", token) }
    ]]
  };
}
__name(choiceKeyboard, "choiceKeyboard");
function choicePromptText(links) {
  return links.length > 1 ? `\u{1F3AC} \u0628\u0631\u0627\u06CC \u0627\u06CC\u0646 ${links.length} \u0644\u06CC\u0646\u06A9 \u0686\u06CC \u0645\u06CC\u200C\u062E\u0648\u0627\u06CC\u061F` : "\u{1F3AC} \u0628\u0631\u0627\u06CC \u0627\u06CC\u0646 \u0648\u06CC\u062F\u06CC\u0648 \u0686\u06CC \u0645\u06CC\u200C\u062E\u0648\u0627\u06CC\u061F";
}
__name(choicePromptText, "choicePromptText");
function translationCacheKey(videoId, srcLang, provider, model) {
  return `fa2:${videoId}:${srcLang}:${provider}:${model}`;
}
__name(translationCacheKey, "translationCacheKey");
async function readTranslationCache(kv, videoId, srcLang, provider, model) {
  if (!kv) return null;
  try {
    const hit = await kv.get(translationCacheKey(videoId, srcLang, provider, model), "json");
    if (hit && typeof hit.srt === "string" && hit.srt.length > 10) return hit;
  } catch (err) {
    console.error(`[cache] translation read failed: ${errName(err)}`);
  }
  return null;
}
__name(readTranslationCache, "readTranslationCache");
async function writeTranslationCache(kv, videoId, srcLang, provider, model, payload) {
  if (!kv) return;
  try {
    await kv.put(translationCacheKey(videoId, srcLang, provider, model), JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
    console.log(`[cache] translation stored for ${videoId} (${srcLang}/${provider}/${model})`);
  } catch (err) {
    console.error(`[cache] translation write failed: ${errName(err)}`);
  }
}
__name(writeTranslationCache, "writeTranslationCache");
var PROGRESS_BASE_URL = "https://subtube-bot.hsdoebc.workers.dev";
var STAGE_LABELS_SUB = ["\u062F\u0631\u06CC\u0627\u0641\u062A \u0648\u06CC\u062F\u06CC\u0648", "\u0627\u0633\u062A\u062E\u0631\u0627\u062C \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0627\u0635\u0644\u06CC", "\u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0645\u062A\u0646", "\u0627\u0631\u0633\u0627\u0644 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0628\u0647 Gemini 4 Argon", "\u062F\u0631\u06CC\u0627\u0641\u062A \u062A\u0631\u062C\u0645\u0647\u200C\u0647\u0627", "\u0627\u0639\u062A\u0628\u0627\u0631\u0633\u0646\u062C\u06CC \u062A\u0631\u062C\u0645\u0647\u200C\u0647\u0627", "\u0645\u0631\u062A\u0628\u200C\u0633\u0627\u0632\u06CC \u0648 \u0647\u0645\u06AF\u0627\u0645\u200C\u0633\u0627\u0632\u06CC \u0632\u0645\u0627\u0646\u200C\u0647\u0627", "\u062A\u0648\u0644\u06CC\u062F \u0641\u0627\u06CC\u0644 \u0646\u0647\u0627\u06CC\u06CC"];
var STAGE_LABELS_SUM = ["\u062F\u0631\u06CC\u0627\u0641\u062A \u0648\u06CC\u062F\u06CC\u0648", "\u0627\u0633\u062A\u062E\u0631\u0627\u062C \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0627\u0635\u0644\u06CC", "\u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0645\u062A\u0646", "\u0633\u0627\u062E\u062A \u062E\u0644\u0627\u0635\u0647", "\u062A\u0648\u0644\u06CC\u062F \u062E\u0631\u0648\u062C\u06CC \u0646\u0647\u0627\u06CC\u06CC"];
var STAGE_ICONS = { wait: "\u23F3", run: "\u{1F504}", done: "\u2705", fail: "\u274C" };
function faNum(n) {
  return String(n).replace(/\d/g, (d) => "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9"[Number(d)]);
}
__name(faNum, "faNum");
function createProgressState({ jobId, videoId, mode }) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const labels = mode === "sum" ? STAGE_LABELS_SUM : STAGE_LABELS_SUB;
  return {
    v: 1,
    jobId,
    videoId,
    mode,
    token,
    status: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    chunksTotal: 0,
    chunksDone: 0,
    requests: 0,
    retries: 0,
    provider: null,
    model: null,
    stages: labels.map((label) => ({ label, state: "wait" }))
  };
}
__name(createProgressState, "createProgressState");
function setStage(p, idx, state) {
  if (p && p.stages && p.stages[idx]) p.stages[idx].state = state;
}
__name(setStage, "setStage");
function progressPercents(p) {
  let progress = p.total > 0 ? Math.floor(p.processed / p.total * 100) : 0;
  if (p.status === "done") progress = 100;
  const successRate = p.processed > 0 ? Math.round(p.succeeded / p.processed * 100) : null;
  return { progress, successRate };
}
__name(progressPercents, "progressPercents");
function progressBar(pct, cells = 10) {
  const filled = Math.max(0, Math.min(cells, Math.round(pct / 100 * cells)));
  return "\u25B0".repeat(filled) + "\u25B1".repeat(cells - filled);
}
__name(progressBar, "progressBar");
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1e3));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
__name(fmtElapsed, "fmtElapsed");
function progressSnapshot(p) {
  const { progress, successRate } = progressPercents(p);
  return { ...p, stages: p.stages.map((s) => ({ ...s })), progress, successRate, elapsedMs: Date.now() - p.startedAt, updatedAt: Date.now() };
}
__name(progressSnapshot, "progressSnapshot");
function renderProgressText(p) {
  // Minimal by Arshia's request: title + progress bar + percent, nothing
  // else (no counts, stages, elapsed time or web link in the chat message;
  // the detailed state still lives in the KV snapshot for /status).
  const snap = progressSnapshot(p);
  const title = p.status === "done" ? "\u2705 \u0633\u0627\u062E\u062A \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u06A9\u0627\u0645\u0644 \u0634\u062F" : p.status === "failed" ? "\u274C \u067E\u0631\u062F\u0627\u0632\u0634 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F" : "\u{1F4CA} \u062F\u0631 \u062D\u0627\u0644 \u0633\u0627\u062E\u062A \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633...";
  return `${title}\n${progressBar(snap.progress)} ${faNum(snap.progress)}\u066A`;
}
__name(renderProgressText, "renderProgressText");
var progressMappedStates = /* @__PURE__ */ new WeakSet();
async function persistProgress(env, p) {
  if (!env.SUBTITLE_CACHE || !p) return;
  try {
    await env.SUBTITLE_CACHE.put(`jobprog:${p.jobId}`, JSON.stringify(progressSnapshot(p)), { expirationTtl: 86400 });
    if (!progressMappedStates.has(p)) {
      // The token -> jobId mapping never changes during a job; write it once
      // instead of on every progress render.
      await env.SUBTITLE_CACHE.put(`prog:${p.token}`, String(p.jobId), { expirationTtl: 86400 });
      progressMappedStates.add(p);
    }
  } catch (err) {
    console.error(`[progress] persist failed: ${errName(err)}`);
  }
}
__name(persistProgress, "persistProgress");
function syncProgressFromUsage(p, usage) {
  if (!p || !usage) return;
  if (usage.progress) {
    p.total = usage.progress.total;
    p.processed = usage.progress.processed;
    p.succeeded = usage.progress.succeeded;
    p.failed = usage.progress.failed;
    p.chunksTotal = usage.progress.chunksTotal;
    p.chunksDone = usage.progress.chunksDone;
    if (usage.progress.phase === "repair") {
      setStage(p, 4, "done");
      setStage(p, 5, "run");
    }
  }
  p.requests = usage.requests || 0;
  p.retries = usage.retries || 0;
  if (usage.provider) p.provider = usage.provider;
  if (usage.model) p.model = usage.model;
}
__name(syncProgressFromUsage, "syncProgressFromUsage");
// فارسی: صفحه وب زنده پیشرفت هر پردازش (آدرس /p/<token>).
function progressPageHtml(token) {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>\u067E\u06CC\u0634\u0631\u0641\u062A \u0633\u0627\u062E\u062A \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 | SubTube</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Tahoma, system-ui, sans-serif; background: #0b1120; color: #e2e8f0; min-height: 100vh; display: flex; justify-content: center; padding: 24px 14px; }
  .card { width: 100%; max-width: 430px; background: #111a2e; border: 1px solid #1e293b; border-radius: 20px; padding: 26px 22px; height: fit-content; }
  h1 { font-size: 17px; margin: 0 0 4px; text-align: center; }
  .sub { text-align: center; color: #94a3b8; font-size: 12px; margin-bottom: 18px; }
  .ring-wrap { display: flex; justify-content: center; margin: 6px 0 14px; }
  .ring-pct { font-size: 40px; font-weight: bold; fill: #f1f5f9; }
  .ring-label { font-size: 12px; fill: #94a3b8; }
  #ringFg { transition: stroke-dashoffset .7s ease; }
  .bar { height: 10px; background: #1e293b; border-radius: 99px; overflow: hidden; margin: 10px 0 18px; }
  .bar > div { height: 100%; background: linear-gradient(90deg, #38bdf8, #22c55e); width: 0%; transition: width .7s ease; border-radius: 99px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 16px; }
  .cell { background: #0f172a; border: 1px solid #1e293b; border-radius: 12px; padding: 10px 12px; text-align: center; }
  .cell .n { font-size: 20px; font-weight: bold; }
  .cell .t { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .ok { color: #4ade80; } .bad { color: #f87171; } .wait { color: #fbbf24; }
  .rate { text-align: center; font-size: 15px; margin: 4px 0 16px; }
  .stages { list-style: none; margin: 0; padding: 0; }
  .stages li { display: flex; align-items: center; gap: 9px; padding: 7px 10px; border-radius: 10px; font-size: 13.5px; }
  .stages li.run { background: #16283f; }
  .stages li.fail { background: #3f1d24; }
  .stages .ic { width: 20px; text-align: center; }
  .meta { text-align: center; color: #94a3b8; font-size: 12px; margin-top: 16px; line-height: 1.9; }
  .done-msg { text-align: center; color: #4ade80; font-weight: bold; margin-top: 12px; display: none; }
</style>
</head>
<body data-token="${token}">
<div class="card">
  <h1>\u{1F4CA} \u067E\u06CC\u0634\u0631\u0641\u062A \u0633\u0627\u062E\u062A \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633</h1>
  <div class="sub">SubTube \u2022 <span id="vid"></span></div>
  <div class="ring-wrap">
    <svg width="190" height="190" viewBox="0 0 190 190">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#38bdf8"/>
          <stop offset="100%" stop-color="#22c55e"/>
        </linearGradient>
      </defs>
      <circle cx="95" cy="95" r="82" fill="none" stroke="#1e293b" stroke-width="13"/>
      <circle id="ringFg" cx="95" cy="95" r="82" fill="none" stroke="url(#grad)" stroke-width="13" stroke-linecap="round" stroke-dasharray="515.2" stroke-dashoffset="515.2" transform="rotate(-90 95 95)"/>
      <text id="pct" x="95" y="98" text-anchor="middle" class="ring-pct">\u06F0\u066A</text>
      <text x="95" y="122" text-anchor="middle" class="ring-label">\u067E\u06CC\u0634\u0631\u0641\u062A \u06A9\u0644\u06CC</text>
    </svg>
  </div>
  <div class="bar"><div id="barFill"></div></div>
  <div class="grid">
    <div class="cell"><div class="n" id="cTotal">-</div><div class="t">\u06A9\u0644 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633\u200C\u0647\u0627</div></div>
    <div class="cell"><div class="n" id="cProc">-</div><div class="t">\u067E\u0631\u062F\u0627\u0632\u0634\u200C\u0634\u062F\u0647</div></div>
    <div class="cell"><div class="n ok" id="cOk">-</div><div class="t">\u0645\u0648\u0641\u0642</div></div>
    <div class="cell"><div class="n bad" id="cFail">-</div><div class="t">\u0646\u0627\u0645\u0648\u0641\u0642</div></div>
    <div class="cell"><div class="n wait" id="cRem">-</div><div class="t">\u0628\u0627\u0642\u06CC\u200C\u0645\u0627\u0646\u062F\u0647</div></div>
    <div class="cell"><div class="n" id="cElapsed">-</div><div class="t">\u0632\u0645\u0627\u0646 \u0633\u067E\u0631\u06CC\u200C\u0634\u062F\u0647</div></div>
  </div>
  <div class="rate">\u{1F3AF} \u0646\u0631\u062E \u0645\u0648\u0641\u0642\u06CC\u062A \u062A\u0631\u062C\u0645\u0647: <b class="ok" id="rate">-</b></div>
  <ul class="stages" id="stages"></ul>
  <div class="done-msg" id="doneMsg">\u2705 \u0633\u0627\u062E\u062A \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u06A9\u0627\u0645\u0644 \u0634\u062F</div>
  <div class="meta" id="meta"></div>
</div>
<script>
  var token = document.body.getAttribute("data-token");
  var FA = "\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9";
  function fa(n) { return String(n).replace(/[0-9]/g, function (d) { return FA[Number(d)]; }); }
  function fmt(ms) { var s = Math.max(0, Math.floor(ms / 1000)); var m = Math.floor(s / 60); var r = s % 60; return fa((m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r); }
  var ICONS = { wait: "\u23F3", run: "\u{1F504}", done: "\u2705", fail: "\u274C" };
  var startedAt = 0, timer = null, elapsedTimer = null;
  function render(d) {
    if (!d) return;
    startedAt = d.startedAt || startedAt;
    document.getElementById("vid").textContent = d.videoId || "";
    var pct = d.progress || 0;
    document.getElementById("pct").textContent = fa(pct) + "\u066A";
    document.getElementById("ringFg").style.strokeDashoffset = String(515.2 * (1 - pct / 100));
    document.getElementById("barFill").style.width = pct + "%";
    document.getElementById("cTotal").textContent = fa(d.total || 0);
    document.getElementById("cProc").textContent = fa(d.processed || 0);
    document.getElementById("cOk").textContent = fa(d.succeeded || 0);
    document.getElementById("cFail").textContent = fa(d.failed || 0);
    document.getElementById("cRem").textContent = fa(Math.max(0, (d.total || 0) - (d.processed || 0)));
    document.getElementById("rate").textContent = d.successRate === null || d.successRate === undefined ? "-" : fa(d.successRate) + "\u066A";
    var ul = document.getElementById("stages");
    ul.innerHTML = "";
    (d.stages || []).forEach(function (st) {
      var li = document.createElement("li");
      if (st.state === "run") li.className = "run";
      if (st.state === "fail") li.className = "fail";
      var ic = document.createElement("span");
      ic.className = "ic";
      ic.textContent = ICONS[st.state] || "\u23F3";
      var tx = document.createElement("span");
      tx.textContent = st.label;
      li.appendChild(ic);
      li.appendChild(tx);
      ul.appendChild(li);
    });
    var meta = [];
    if (d.model) meta.push("\u0645\u062F\u0644: " + d.model);
    if (d.requests) meta.push("\u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627\u06CC \u0645\u062F\u0644: " + fa(d.requests));
    if (d.retries) meta.push("\u062A\u0644\u0627\u0634 \u0645\u062C\u062F\u062F: " + fa(d.retries));
    document.getElementById("meta").textContent = meta.join(" \u2022 ");
    if (d.status === "done") {
      document.getElementById("doneMsg").style.display = "block";
      stopPolling();
    }
    if (d.status === "failed") {
      document.getElementById("doneMsg").style.display = "block";
      document.getElementById("doneMsg").style.color = "#f87171";
      document.getElementById("doneMsg").textContent = "\u274C \u067E\u0631\u062F\u0627\u0632\u0634 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F";
      stopPolling();
    }
  }
  function tickElapsed() {
    if (startedAt) document.getElementById("cElapsed").textContent = fmt(Date.now() - startedAt);
  }
  function poll() {
    fetch("/p/" + token + "/json", { cache: "no-store" }).then(function (r) { return r.json(); }).then(render).catch(function () {});
  }
  function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }
  poll();
  timer = setInterval(poll, 2000);
  elapsedTimer = setInterval(tickElapsed, 1000);
</script>
</body>
</html>`;
}
__name(progressPageHtml, "progressPageHtml");
var SRC_LANG_FA_NAMES = { ar: "\u0639\u0631\u0628\u06CC", es: "\u0627\u0633\u067E\u0627\u0646\u06CC\u0627\u06CC\u06CC", fr: "\u0641\u0631\u0627\u0646\u0633\u0648\u06CC", de: "\u0622\u0644\u0645\u0627\u0646\u06CC", tr: "\u062A\u0631\u06A9\u06CC", ru: "\u0631\u0648\u0633\u06CC", it: "\u0627\u06CC\u062A\u0627\u0644\u06CC\u0627\u06CC\u06CC", pt: "\u067E\u0631\u062A\u063A\u0627\u0644\u06CC", hi: "\u0647\u0646\u062F\u06CC", ur: "\u0627\u0631\u062F\u0648", zh: "\u0686\u06CC\u0646\u06CC", ja: "\u0698\u0627\u067E\u0646\u06CC", ko: "\u06A9\u0631\u0647\u200C\u0627\u06CC" };
// فارسی: تحویل فایل زیرنویس به کاربر در تلگرام؛ اگر ارسال فایل نشد، متن را تکه‌تکه می‌فرستد.
async function deliverSrt(env, tg, chatId, srtContent, caption, replyToMessageId) {
  // Delivery ladder (measured 2026-11-15): Telegram's media ingress from
  // this Worker is degraded \u2014 any multipart request carrying a file part
  // stalls until timeout, and Telegram's fetcher refuses this Worker's
  // /f/ URLs, while plain JSON calls answer in ~200ms. So: try URL
  // delivery (instant when Telegram accepts it), then a short-probe
  // classic upload (succeeds again once Telegram recovers), and finally
  // send the subtitle as text chunks so the user ALWAYS receives it.
  try {
    const token = makeChoiceToken() + makeChoiceToken().slice(0, 4);
    await env.SUBTITLE_CACHE.put(`file:${token}`, srtContent, { expirationTtl: 172800 });
    const url = `${PROGRESS_BASE_URL}/f/${token}/subtitle.fa.srt`;
    await tg.sendDocumentByUrl(chatId, url, caption, replyToMessageId);
    return "url";
  } catch (err) {
    console.error(`[deliver] URL delivery failed: ${errName(err)}`);
  }
  try {
    await tg.sendSrtDocument(chatId, srtContent, caption, replyToMessageId, 15e3);
    return "upload";
  } catch (err) {
    console.error(`[deliver] upload delivery failed: ${errName(err)}`);
  }
  const chunks = splitSrtForTextDelivery(srtContent, 3500);
  for (let i = 0; i < chunks.length; i++) {
    const head = i === 0 ? `${caption}\n\n\u26A0\uFE0F \u0627\u0631\u0633\u0627\u0644 \u0641\u0627\u06CC\u0644 \u0641\u0639\u0644\u0627\u064B \u0627\u0632 \u0637\u0631\u0641 \u062A\u0644\u06AF\u0631\u0627\u0645 \u06AF\u06CC\u0631 \u06A9\u0631\u062F\u0647\u061B \u0645\u062A\u0646 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0631\u0627 \u0645\u0648\u0642\u062A\u0627\u064B \u0627\u06CC\u0646\u062C\u0627 \u0645\u06CC\u200C\u0641\u0631\u0633\u062A\u0645 (${i + 1}/${chunks.length}):\n\n` : `(${i + 1}/${chunks.length})\n\n`;
    await tg.sendMessage(chatId, head + chunks[i]);
  }
  return "text";
}
function splitSrtForTextDelivery(srt, maxChars = 3500) {
  const blocks = String(srt || "").replace(/^\uFEFF/, "").split(/\n\n+/).filter((b) => b.trim().length);
  const chunks = [];
  let cur = "";
  for (const b of blocks) {
    if (cur && cur.length + b.length + 2 > maxChars) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? cur + "\n\n" + b : b;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [String(srt || "")];
}
__name(splitSrtForTextDelivery, "splitSrtForTextDelivery");
__name(deliverSrt, "deliverSrt");
// فارسی: قلب پردازش یک ویدیو: استخراج، ترجمه، ساخت SRT، کش و تحویل.
async function processVideoJob({ env, tg, chatId, user, message, videoId, canonicalUrl, mode = "both", maxPerHour = 0 }) {
  const swept = await sweepStaleJobs(env.DB, user.id);
  if (swept.length) {
    await tg.sendMessage(chatId, "\u26A0\uFE0F \u06CC\u06A9 \u067E\u0631\u062F\u0627\u0632\u0634 \u0642\u0628\u0644\u06CC \u0628\u0647\u200C\u0639\u0644\u062A \u0648\u0642\u0641\u0647 \u0633\u0631\u0648\u0631 \u0646\u0627\u062A\u0645\u0627\u0645 \u0645\u0627\u0646\u062F \u0648 \u0628\u0633\u062A\u0647 \u0634\u062F. \u0627\u06AF\u0631 \u0647\u0646\u0648\u0632 \u0644\u0627\u0632\u0645\u0634 \u062F\u0627\u0631\u06CC\u060C \u0644\u06CC\u0646\u06A9\u0634 \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0641\u0631\u0633\u062A.");
  }
  for (const sj of swept) {
    try {
      const snap = await env.SUBTITLE_CACHE.get(`jobprog:${sj.id}`, "json");
      if (snap && snap.status === "running") {
        snap.status = "failed";
        snap.updatedAt = Date.now();
        await env.SUBTITLE_CACHE.put(`jobprog:${sj.id}`, JSON.stringify(snap), { expirationTtl: 86400 });
      }
    } catch {
    }
  }
  const duplicate = await hasActiveJobForVideo(env.DB, user.id, videoId);
  if (duplicate) return "duplicate";
  const created = await createJobAtomic(env.DB, {
    telegramId: user.id,
    videoId,
    videoUrl: canonicalUrl,
    sourceLanguage: "en",
    targetLanguage: "fa",
    maxPerHour
  });
  if (created.blocked) return created.blocked;
  const jobId = created.jobId;
  const statusMsgRes = await tg.sendMessage(chatId, MESSAGES.statusChecking, {
    reply_to_message_id: message.message_id
  });
  const statusMsgId = statusMsgRes?.result?.message_id;
  let progress = null;
  try {
    const tSettings = await resolveTranslationSettings(env);
    await tg.editMessageText(chatId, statusMsgId, MESSAGES.statusExtracting);
    const extracted = await extractEnglishSubtitles(videoId, env);
    const cues = extracted.cues;
    const srcLang = normalizeLangCode(extracted.languageCode);
    await throwIfCancelled(env, jobId);
    const cachedFa = await readTranslationCache(env.SUBTITLE_CACHE, videoId, srcLang, tSettings.provider, tSettings.model);
    if (cachedFa && mode === "sum" && cachedFa.summary) {
      await tg.sendMessage(chatId, `\u{1F4DD} \u062E\u0644\u0627\u0635\u0647 \u0648\u06CC\u062F\u06CC\u0648:\n\n${cachedFa.summary}`);
      await tg.deleteMessage(chatId, statusMsgId);
      await completeJob(env.DB, jobId, user.id);
      console.log(`[job] ${videoId} summary served from translation cache`);
      return "ok";
    }
    if (cachedFa && mode !== "sum") {
      const caption = MESSAGES.statusDoneCaption({
        videoId,
        cueCount: cachedFa.cueCount || 0,
        isAuto: Boolean(cachedFa.isAuto)
      });
      await deliverSrt(env, tg, chatId, cachedFa.srt, caption, message.message_id);
      if (mode === "both" && cachedFa.summary) {
        await tg.sendMessage(chatId, `\u{1F4DD} \u062E\u0644\u0627\u0635\u0647 \u0648\u06CC\u062F\u06CC\u0648:\n\n${cachedFa.summary}`);
      }
      await tg.deleteMessage(chatId, statusMsgId);
      await completeJob(env.DB, jobId, user.id);
      console.log(`[job] ${videoId} served from translation cache`);
      return "ok";
    }
    if (mode === "sum") {
      try {
        progress = createProgressState({ jobId, videoId, mode });
        setStage(progress, 0, "done");
        setStage(progress, 1, "done");
        setStage(progress, 2, "done");
        setStage(progress, 3, "run");
        await persistProgress(env, progress);
        await tg.editMessageText(chatId, statusMsgId, renderProgressText(progress));
      } catch {
        progress = null;
      }
      const summary = await summarizeTranscript(cues, env, tSettings);
      if (!summary) {
        throw new AppError(
          ERROR_CODES.EXTRACTION_FAILED,
          "\u274C \u062E\u0644\u0627\u0635\u0647 \u0627\u06CC\u0646 \u0648\u06CC\u062F\u06CC\u0648 \u0633\u0627\u062E\u062A\u0647 \u0646\u0634\u062F. \u0645\u0645\u06A9\u0646 \u0627\u0633\u062A \u0645\u062A\u0646 \u0648\u06CC\u062F\u06CC\u0648 \u062E\u06CC\u0644\u06CC \u06A9\u0648\u062A\u0627\u0647 \u0628\u0627\u0634\u062F \u06CC\u0627 \u0633\u0631\u0648\u06CC\u0633 \u062E\u0644\u0627\u0635\u0647\u200C\u0633\u0627\u0632\u06CC \u0627\u0644\u0627\u0646 \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u0628\u0627\u0634\u062F.",
          "summary unavailable"
        );
      }
      await tg.sendMessage(chatId, `\u{1F4DD} \u062E\u0644\u0627\u0635\u0647 \u0648\u06CC\u062F\u06CC\u0648:\n\n${summary}`);
      if (cachedFa) {
        await writeTranslationCache(env.SUBTITLE_CACHE, videoId, srcLang, tSettings.provider, tSettings.model, { ...cachedFa, summary });
      }
      if (progress) {
        setStage(progress, 3, "done");
        setStage(progress, 4, "done");
        progress.status = "done";
        await persistProgress(env, progress);
        await tg.editMessageText(chatId, statusMsgId, renderProgressText(progress));
      } else {
        await tg.deleteMessage(chatId, statusMsgId);
      }
      await completeJob(env.DB, jobId, user.id);
      return "ok";
    }
    const maxCueCount = parseInt(env.MAX_CUE_COUNT || "1200", 10) || 1200;
    const maxTotalChars = parseInt(env.MAX_TOTAL_CHARS || "45000", 10) || 45e3;
    const totalChars = cues.reduce((sum, c) => sum + c.text.length, 0);
    if (cues.length > maxCueCount || totalChars > maxTotalChars) {
      throw new AppError(
        ERROR_CODES.VIDEO_TOO_LONG,
        MESSAGES.videoTooLong(maxCueCount),
        `Cue count ${cues.length}, chars ${totalChars} exceeded free tier limits`
      );
    }
    try {
      progress = createProgressState({ jobId, videoId, mode });
      progress.total = cues.length;
      setStage(progress, 0, "done");
      setStage(progress, 1, "done");
      setStage(progress, 2, "done");
      setStage(progress, 3, "run");
      await persistProgress(env, progress);
    } catch {
      progress = null;
    }
    if (progress) {
      await tg.editMessageText(chatId, statusMsgId, renderProgressText(progress));
    } else {
      await tg.editMessageText(chatId, statusMsgId, MESSAGES.statusTranslating(0, 1));
    }
    let lastUpdateAt = Date.now();
    const jobUsageSink = {};
    const heartbeatStop = { stop: false };
    (async () => {
      while (!heartbeatStop.stop) {
        await sleep2(2e4);
        if (heartbeatStop.stop || !progress) break;
        try {
          syncProgressFromUsage(progress, jobUsageSink);
          await persistProgress(env, progress);
        } catch {
        }
      }
    })();
    const translatedCues = await translateCuesToPersian(cues, async (done, total) => {
      await throwIfCancelled(env, jobId);
      const now = Date.now();
      if (total > 1 && now - lastUpdateAt >= 2500) {
        lastUpdateAt = now;
        if (progress) {
          syncProgressFromUsage(progress, jobUsageSink);
          if (progress.chunksDone > 0 && progress.stages[3].state === "run") {
            setStage(progress, 3, "done");
            setStage(progress, 4, "run");
          }
          await persistProgress(env, progress);
          await tg.editMessageText(chatId, statusMsgId, renderProgressText(progress));
        } else {
          await tg.editMessageText(chatId, statusMsgId, MESSAGES.statusTranslating(done, total));
        }
      }
    }, env, jobUsageSink, srcLang);
    heartbeatStop.stop = true;
    if (progress) {
      syncProgressFromUsage(progress, jobUsageSink);
      setStage(progress, 3, "done");
      setStage(progress, 4, "done");
      setStage(progress, 5, "done");
      setStage(progress, 6, "run");
      await persistProgress(env, progress);
      await tg.editMessageText(chatId, statusMsgId, renderProgressText(progress));
    } else {
      await tg.editMessageText(chatId, statusMsgId, MESSAGES.statusBuildingSrt);
    }
    const srtContent = generateSrt(translatedCues);
    if (!srtContent || srtContent.trim().length < 10) {
      throw new AppError(ERROR_CODES.EXTRACTION_FAILED, MESSAGES.genericError, "Empty SRT output");
    }
    const caption = MESSAGES.statusDoneCaption({
      videoId,
      cueCount: translatedCues.length,
      isAuto: extracted.isAuto
    });
    let fullCaption = jobUsageSink.untranslatedCount > 0 ? `${caption}

\u26A0\uFE0F ${jobUsageSink.untranslatedCount} \u062E\u0637 \u0628\u0647\u200C\u0639\u0644\u062A \u0645\u062D\u062F\u0648\u062F\u06CC\u062A \u0632\u0645\u0627\u0646\u06CC \u0628\u062F\u0648\u0646 \u062A\u0631\u062C\u0645\u0647 \u0645\u0627\u0646\u062F (\u0645\u062A\u0646 \u0627\u0646\u06AF\u0644\u06CC\u0633\u06CC).` : caption;
    if (srcLang === "fa") {
      fullCaption += "\n\n\u2139\uFE0F \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0641\u0627\u0631\u0633\u06CC \u0622\u0645\u0627\u062F\u0647 \u0628\u0648\u062F \u0648 \u0628\u062F\u0648\u0646 \u062A\u0631\u062C\u0645\u0647 \u0627\u0631\u0633\u0627\u0644 \u0634\u062F.";
    } else if (srcLang !== "en") {
      fullCaption += `\n\n\u{1F310} \u0632\u0628\u0627\u0646 \u0645\u0628\u062F\u0623 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633: ${SRC_LANG_FA_NAMES[srcLang] || srcLang}`;
    }
    if (!jobUsageSink.untranslatedCount) {
      await writeTranslationCache(env.SUBTITLE_CACHE, videoId, srcLang, tSettings.provider, tSettings.model, {
        srt: srtContent,
        cueCount: translatedCues.length,
        isAuto: extracted.isAuto,
        summary: null
      });
    }
    await throwIfCancelled(env, jobId);
    await deliverSrt(env, tg, chatId, srtContent, fullCaption, message.message_id);
    if (progress) {
      setStage(progress, 6, "done");
      setStage(progress, 7, "done");
      progress.status = "done";
      await persistProgress(env, progress);
      await tg.editMessageText(chatId, statusMsgId, renderProgressText(progress));
    } else {
      await tg.deleteMessage(chatId, statusMsgId);
    }
    await completeJob(env.DB, jobId, user.id);
    // Bonus step (mode "both" only): the Persian summary is generated and
    // sent only AFTER the subtitle file is delivered, so a slow or failing
    // summary can never block or lose the file itself.
    if (mode === "both") try {
      const summary = await summarizeTranscript(cues, env, tSettings);
      if (summary) {
        await tg.sendMessage(chatId, `\u{1F4DD} \u062E\u0644\u0627\u0635\u0647 \u0648\u06CC\u062F\u06CC\u0648:\n\n${summary}`);
        if (!jobUsageSink.untranslatedCount) {
          await writeTranslationCache(env.SUBTITLE_CACHE, videoId, srcLang, tSettings.provider, tSettings.model, {
            srt: srtContent,
            cueCount: translatedCues.length,
            isAuto: extracted.isAuto,
            summary
          });
        }
      }
    } catch (err) {
      console.error(`[job] summary step failed: ${errName(err)}`);
    }
    return "ok";
  } catch (err) {
    const isCancelled = err?.code === ERROR_CODES.JOB_CANCELLED;
    const safeInternal = isCancelled ? "cancelled_by_user" : sanitizeErrorMessage(err);
    if (progress) {
      progress.status = "failed";
      const running = progress.stages.find((s) => s.state === "run");
      if (running) running.state = "fail";
      await persistProgress(env, progress);
    }
    try {
      await failJob(env.DB, jobId, user.id, safeInternal);
    } catch (dbErr) {
      console.error("failJob failed:", sanitizeErrorMessage(dbErr));
    }
    const userFacing = err instanceof AppError ? err.userMessage : MESSAGES.genericError;
    const errorText = userFacing;
    if (statusMsgId) {
      await tg.editMessageText(chatId, statusMsgId, errorText);
    } else {
      await tg.sendMessage(chatId, errorText);
    }
    return "error";
  }
}
__name(processVideoJob, "processVideoJob");
// فارسی: پردازش پیام‌های تلگرام و دستورات ربات (/start ،/status ،/history و…).
async function handleTelegramUpdate(update, env, tg) {
  const message = update?.message;
  if (!message || !message.chat || !message.from) {
    return;
  }
  const chatId = message.chat.id;
  const user = message.from;
  const text = (message.text || message.caption || "").trim();
  if (!text) {
    await tg.sendMessage(chatId, MESSAGES.invalidLink);
    return;
  }
  await upsertUser(env.DB, user);
  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start") {
    await tg.sendMessage(chatId, MESSAGES.welcome(user.first_name));
    return;
  }
  if (command === "/help") {
    await tg.sendMessage(chatId, MESSAGES.help);
    return;
  }
  if (command === "/about") {
    await tg.sendMessage(chatId, MESSAGES.about);
    return;
  }
  if (command === "/stats") {
    const stats = await getUserStats(env.DB, user.id);
    await tg.sendMessage(chatId, MESSAGES.stats(stats));
    return;
  }
  if (command === "/usage") {
    const keys = coarenaApiKeys(env);
    const limParts = [];
    for (let i = 0; i < keys.length; i++) {
      const t = formatCoarenaLimits(await getCoarenaLimits(env, keys[i]));
      if (t) limParts.push(keys.length > 1 ? `\u062D\u0633\u0627\u0628 ${i + 1}:\n${t}` : t);
    }
    const limText = limParts.length ? limParts.join("\n") : null;
    let recentJobs = 0;
    try {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM jobs WHERE telegram_id = ?1 AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day')`
      ).bind(Number(user.id)).first();
      recentJobs = Number(row?.cnt || 0);
    } catch {
    }
    const lines = ["\u{1F4CA} \u0645\u0635\u0631\u0641 \u0648 \u0633\u0647\u0645\u06CC\u0647"];
    lines.push(limText || "\u0627\u0637\u0644\u0627\u0639\u0627\u062A \u0633\u0647\u0645\u06CC\u0647 Coarena \u0627\u0644\u0627\u0646 \u062F\u0631 \u062F\u0633\u062A\u0631\u0633 \u0646\u06CC\u0633\u062A.");
    lines.push(`\u062F\u0631\u062E\u0648\u0627\u0633\u062A\u200C\u0647\u0627\u06CC \u0634\u0645\u0627 \u062F\u0631 \u06F2\u06F4 \u0633\u0627\u0639\u062A \u06AF\u0630\u0634\u062A\u0647: ${recentJobs}`);
    await tg.sendMessage(chatId, lines.join("\n"));
    return;
  }
  if (command === "/translate") {
    await tg.sendMessage(chatId, "🎬 لینک ویدیوی یوتیوب را بفرست تا زیرنویسش را به فارسی ترجمه کنم.\nبعد از ارسال لینک، با دکمه‌ها انتخاب می‌کنی: فقط زیرنویس، فقط خلاصه یا هر دو.");
    return;
  }
  if (command === "/status") {
    let job = null;
    try {
      job = await env.DB.prepare(
        `SELECT id, video_id, status, error_message, created_at FROM jobs WHERE telegram_id = ?1 AND status = 'processing' ORDER BY id DESC LIMIT 1`
      ).bind(Number(user.id)).first();
    } catch {
    }
    let snap = null;
    if (job) {
      try {
        snap = await env.SUBTITLE_CACHE.get(`jobprog:${job.id}`, "json");
      } catch {
      }
    }
    await tg.sendMessage(chatId, renderStatusMessage(job, snap));
    return;
  }
  if (command === "/history") {
    let jobs = [];
    try {
      const res = await env.DB.prepare(
        `SELECT video_id, status, error_message, created_at FROM jobs WHERE telegram_id = ?1 ORDER BY id DESC LIMIT 8`
      ).bind(Number(user.id)).all();
      jobs = res?.results || [];
    } catch {
    }
    await tg.sendMessage(chatId, renderHistoryMessage(jobs));
    return;
  }
  if (command === "/cancel") {
    let job = null;
    try {
      job = await env.DB.prepare(
        `SELECT id, video_id FROM jobs WHERE telegram_id = ?1 AND status = 'processing' ORDER BY id DESC LIMIT 1`
      ).bind(Number(user.id)).first();
    } catch {
    }
    if (!job) {
      await tg.sendMessage(chatId, "💤 پردازش فعالی نداری که لغو شود.");
      return;
    }
    try {
      await env.SUBTITLE_CACHE.put(cancelKey(job.id), "1", { expirationTtl: 3600 });
    } catch {
    }
    await tg.sendMessage(chatId, `⛔ درخواست لغو پردازش ویدیو ${job.video_id} ثبت شد؛ در اولین فرصت متوقف می‌شود.`);
    return;
  }
  const botEnabled = await getSetting(env.DB, "bot_enabled", "true");
  if (botEnabled === "false") {
    await tg.sendMessage(chatId, MESSAGES.botDisabled);
    return;
  }
  const { links, truncated } = parseAllYouTubeUrls(text);
  if (!links.length) {
    await tg.sendMessage(chatId, MESSAGES.invalidLink);
    return;
  }
  const rateLimitStr = await getSetting(env.DB, "rate_limit_per_hour", null) || env.RATE_LIMIT_MAX_PER_HOUR || "10";
  const maxPerHour = Math.max(1, parseInt(rateLimitStr, 10) || 10);
  const recentCount = await countRecentUserJobs(env.DB, user.id, 60);
  if (recentCount >= maxPerHour) {
    await tg.sendMessage(chatId, MESSAGES.rateLimited(maxPerHour));
    return;
  }
  const token = makeChoiceToken();
  let pendingStored = false;
  try {
    await env.SUBTITLE_CACHE.put(`pend:${token}`, JSON.stringify({
      userId: user.id,
      chatId,
      linkMessageId: message.message_id,
      links,
      truncated: Boolean(truncated)
    }), { expirationTtl: 1800 });
    pendingStored = true;
  } catch (err) {
    console.error(`[choice] pending store failed: ${errName(err)}`);
  }
  if (!pendingStored) {
    // Without pending storage the buttons cannot work; process immediately
    // with the full default (subtitle + summary) instead of dead buttons.
    const queued = await enqueueBatch(env, buildQueueMessage({ chatId, user, messageId: message.message_id, links, mode: "both", truncated }));
    if (!queued) await runLinkBatch({ env, tg, chatId, user, message, links, mode: "both" });
    if (!queued && truncated) {
      await tg.sendMessage(chatId, "\u2139\uFE0F \u0641\u0642\u0637 \u06F3 \u0644\u06CC\u0646\u06A9 \u0627\u0648\u0644 \u067E\u0631\u062F\u0627\u0632\u0634 \u0634\u062F\u061B \u0628\u0642\u06CC\u0647 \u0631\u0627 \u062C\u062F\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.");
    }
    return;
  }
  await tg.sendMessage(chatId, choicePromptText(links), {
    reply_to_message_id: message.message_id,
    reply_markup: choiceKeyboard(token)
  });
}
__name(handleTelegramUpdate, "handleTelegramUpdate");

// ===== Bot commands menu + /status /history /cancel helpers =====
// BOT_COMMANDS is registered once at Telegram via diag mode=setcommands
// (setMyCommands). Only commands with a real handler below are listed:
// /settings and /language are intentionally absent (no such features yet).
var BOT_COMMANDS = [
  { command: "start", description: "شروع کار با ربات" },
  { command: "translate", description: "ترجمه زیرنویس ویدیو" },
  { command: "status", description: "وضعیت پردازش جاری" },
  { command: "cancel", description: "لغو پردازش جاری" },
  { command: "history", description: "تاریخچه درخواست‌ها" },
  { command: "usage", description: "مصرف و سهمیه" },
  { command: "stats", description: "آمار شما" },
  { command: "help", description: "راهنمای استفاده" },
  { command: "about", description: "درباره ربات" }
];
function cancelKey(jobId) {
  return `cancel:${jobId}`;
}
__name(cancelKey, "cancelKey");
async function throwIfCancelled(env, jobId) {
  if (!env?.SUBTITLE_CACHE || !jobId) return;
  let flag = null;
  try {
    flag = await env.SUBTITLE_CACHE.get(cancelKey(jobId));
  } catch {
  }
  if (flag) {
    throw new AppError(ERROR_CODES.JOB_CANCELLED, "⛔ عملیات به درخواست شما لغو شد.", "cancelled_by_user");
  }
}
__name(throwIfCancelled, "throwIfCancelled");
function statusIconForJob(job) {
  if (!job) return "❓";
  if (job.status === "completed") return "✅";
  if (job.status === "processing") return "🔄";
  if (job.error_message === "cancelled_by_user") return "🚫";
  return "❌";
}
__name(statusIconForJob, "statusIconForJob");
function fmtJobDate(iso) {
  try {
    return new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return String(iso || "").slice(0, 16);
  }
}
__name(fmtJobDate, "fmtJobDate");
function renderHistoryMessage(jobs) {
  if (!jobs || !jobs.length) {
    return "📜 هنوز درخواستی ثبت نشده است.\nیک لینک یوتیوب بفرست تا شروع کنیم.";
  }
  const lines = ["📜 تاریخچه درخواست‌های شما:"];
  for (const j of jobs) {
    lines.push(`${statusIconForJob(j)} ${j.video_id} — ${fmtJobDate(j.created_at)}`);
  }
  return lines.join("\n");
}
__name(renderHistoryMessage, "renderHistoryMessage");
var PROGRESS_STALE_MS = 15e4;
function snapshotLiveness(snap, now = Date.now()) {
  if (!snap) return "missing";
  if (snap.status !== "running") return "final";
  return now - (snap.updatedAt || snap.startedAt || 0) > PROGRESS_STALE_MS ? "stalled" : "live";
}
__name(snapshotLiveness, "snapshotLiveness");
function renderStatusMessage(job, snap) {
  if (!job) {
    return "💤 الان پردازش فعالی نداری.\nیک لینک یوتیوب بفرست تا شروع کنم.";
  }
  if (snap && snapshotLiveness(snap) === "stalled") {
    return `⚠️ پردازش ویدیو ${job.video_id} متوقف شده و دیگر ادامه پیدا نمی‌کند.\nلینک را دوباره بفرست تا از اول انجام شود.`;
  }
  if (snap && typeof snap.progress === "number" && snap.token) {
    const remaining = Math.max(0, (snap.total || 0) - (snap.processed || 0));
    const lines = [
      `🔄 در حال پردازش ویدیو ${job.video_id}`,
      `${progressBar(snap.progress)} ${faNum(snap.progress)}٪`,
      `📄 کل: ${faNum(snap.total || 0)} | ✅ موفق: ${faNum(snap.succeeded || 0)} | ❌ ناموفق: ${faNum(snap.failed || 0)} | ⏳ باقی‌مانده: ${faNum(remaining)}`
    ];
    return lines.join("\n");
  }
  return `🔄 در حال پردازش ویدیو ${job.video_id} (مراحل اولیه)`;
}
__name(renderStatusMessage, "renderStatusMessage");

// ===== Job queue (Cloudflare Queues) =====
// Webhook executions are terminated ~30s after the response is sent
// (measured on this account), which kept killing long jobs mid-flight.
// Real processing therefore runs in a queue consumer (15-minute limit):
// the webhook only enqueues; the consumer runs the unchanged batch code.
function buildQueueMessage({ chatId, user, messageId, links, mode, truncated }) {
  return {
    chatId,
    user: { id: user.id, first_name: user.first_name || "", username: user.username || "" },
    messageId: messageId || null,
    links,
    mode: mode || "both",
    truncated: Boolean(truncated)
  };
}
__name(buildQueueMessage, "buildQueueMessage");
async function enqueueBatch(env, payload) {
  if (!env.JOB_QUEUE) return false;
  try {
    await env.JOB_QUEUE.send(payload);
    return true;
  } catch (err) {
    console.error(`[queue] enqueue failed: ${errName(err)}`);
    return false;
  }
}
__name(enqueueBatch, "enqueueBatch");
// فارسی: اجرای پردازش‌هایی که از صف Cloudflare Queues رسیده‌اند.
async function runQueuedBatch(env, tg, body) {
  if (!body || !Array.isArray(body.links) || !body.links.length) return;
  await runLinkBatch({ env, tg, chatId: body.chatId, user: body.user, message: { message_id: body.messageId }, links: body.links, mode: body.mode || "both" });
  if (body.truncated) {
    await tg.sendMessage(body.chatId, "\u2139\uFE0F \u0641\u0642\u0637 \u06F3 \u0644\u06CC\u0646\u06A9 \u0627\u0648\u0644 \u067E\u0631\u062F\u0627\u0632\u0634 \u0634\u062F\u061B \u0628\u0642\u06CC\u0647 \u0631\u0627 \u062C\u062F\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.");
  }
}
__name(runQueuedBatch, "runQueuedBatch");
async function runLinkBatch({ env, tg, chatId, user, message, links, mode }) {
  const rateLimitStr = await getSetting(env.DB, "rate_limit_per_hour", null) || env.RATE_LIMIT_MAX_PER_HOUR || "10";
  const maxPerHour = Math.max(1, parseInt(rateLimitStr, 10) || 10);
  let recentCount = await countRecentUserJobs(env.DB, user.id, 60);
  if (recentCount >= maxPerHour) {
    await tg.sendMessage(chatId, MESSAGES.rateLimited(maxPerHour));
    return;
  }
  let okCount = 0;
  let dupCount = 0;
  let errCount = 0;
  for (const link of links) {
    if (recentCount >= maxPerHour) {
      await tg.sendMessage(chatId, MESSAGES.rateLimited(maxPerHour));
      break;
    }
    const outcome = await processVideoJob({
      env,
      tg,
      chatId,
      user,
      message,
      videoId: link.videoId,
      canonicalUrl: link.canonicalUrl,
      mode,
      maxPerHour
    });
    if (outcome === "ratelimited") {
      await tg.sendMessage(chatId, MESSAGES.rateLimited(maxPerHour));
      break;
    }
    if (outcome === "ok") {
      okCount++;
      recentCount++;
    } else if (outcome === "duplicate") {
      dupCount++;
      if (links.length === 1) {
        await tg.sendMessage(chatId, MESSAGES.duplicateJob);
      }
    } else {
      errCount++;
      recentCount++;
    }
  }
  if (links.length > 1) {
    const parts = [`\u{1F4E6} \u067E\u0631\u062F\u0627\u0632\u0634 ${links.length} \u0644\u06CC\u0646\u06A9 \u062A\u0645\u0627\u0645 \u0634\u062F: ${okCount} \u0645\u0648\u0641\u0642`];
    if (errCount) parts.push(`${errCount} \u0646\u0627\u0645\u0648\u0641\u0642`);
    if (dupCount) parts.push(`${dupCount} \u062A\u06A9\u0631\u0627\u0631\u06CC (\u062F\u0631 \u062D\u0627\u0644 \u067E\u0631\u062F\u0627\u0632\u0634)`);
    await tg.sendMessage(chatId, parts.join("\u060C ") + ".");
  }
}
__name(runLinkBatch, "runLinkBatch");
// فارسی: پردازش دکمه‌های انتخاب حالت (فقط زیرنویس / فقط خلاصه / هر دو).
async function handleCallbackQuery(update, env, tg) {
  const cq = update?.callback_query;
  if (!cq || !cq.from || !cq.message || !cq.message.chat) {
    return;
  }
  const chatId = cq.message.chat.id;
  const parsed = parseChoiceCallbackData(cq.data);
  if (!parsed) {
    await tg.answerCallbackQuery(cq.id);
    return;
  }
  let pending = null;
  try {
    pending = await env.SUBTITLE_CACHE.get(`pend:${parsed.token}`, "json");
  } catch (err) {
    console.error(`[choice] pending read failed: ${errName(err)}`);
  }
  if (!pending || !Array.isArray(pending.links) || !pending.links.length) {
    await tg.answerCallbackQuery(cq.id, "\u23F0 \u0627\u06CC\u0646 \u0627\u0646\u062A\u062E\u0627\u0628 \u0645\u0646\u0642\u0636\u06CC \u0634\u062F\u0647\u061B \u0644\u06CC\u0646\u06A9 \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0641\u0631\u0633\u062A.");
    return;
  }
  if (Number(pending.userId) !== Number(cq.from.id)) {
    await tg.answerCallbackQuery(cq.id, "\u0627\u06CC\u0646 \u062F\u06A9\u0645\u0647 \u0628\u0631\u0627\u06CC \u0634\u0645\u0627 \u0646\u06CC\u0633\u062A.");
    return;
  }
  try {
    await env.SUBTITLE_CACHE.delete(`pend:${parsed.token}`);
  } catch {
  }
  await tg.answerCallbackQuery(cq.id, "\u2705 \u0627\u0646\u062A\u062E\u0627\u0628 \u0634\u062F");
  await upsertUser(env.DB, cq.from);
  const botEnabled = await getSetting(env.DB, "bot_enabled", "true");
  if (botEnabled === "false") {
    await tg.sendMessage(chatId, MESSAGES.botDisabled);
    return;
  }
  await tg.editMessageText(chatId, cq.message.message_id, `\u2705 \u0627\u0646\u062A\u062E\u0627\u0628 \u0634\u062F: ${CHOICE_LABELS[parsed.mode]}\n\u23F3 \u062F\u0631 \u062D\u0627\u0644 \u067E\u0631\u062F\u0627\u0632\u0634...`, {
    reply_markup: { inline_keyboard: [] }
  });
  const queued = await enqueueBatch(env, buildQueueMessage({ chatId, user: cq.from, messageId: pending.linkMessageId, links: pending.links, mode: parsed.mode, truncated: pending.truncated }));
  if (!queued) {
    // Queue binding unavailable: fall back to inline processing so the
    // request is not lost (short jobs still finish inside the limit).
    const message = { message_id: pending.linkMessageId };
    await runLinkBatch({ env, tg, chatId, user: cq.from, message, links: pending.links, mode: parsed.mode });
    if (pending.truncated) {
      await tg.sendMessage(chatId, "\u2139\uFE0F \u0641\u0642\u0637 \u06F3 \u0644\u06CC\u0646\u06A9 \u0627\u0648\u0644 \u067E\u0631\u062F\u0627\u0632\u0634 \u0634\u062F\u061B \u0628\u0642\u06CC\u0647 \u0631\u0627 \u062C\u062F\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.");
    }
  }
}
__name(handleCallbackQuery, "handleCallbackQuery");
async function routeTelegramUpdate(update, env, tg) {
  if (update?.callback_query) {
    try {
      await env.SUBTITLE_CACHE.put("dbg:lastcb", JSON.stringify({
        at: (/* @__PURE__ */ new Date()).toISOString(),
        data: update.callback_query.data || null,
        fromId: update.callback_query.from?.id || null
      }), { expirationTtl: 3600 });
    } catch {
    }
    try {
      return await handleCallbackQuery(update, env, tg);
    } catch (err) {
      try {
        await env.SUBTITLE_CACHE.put("dbg:cberror", JSON.stringify({
          at: (/* @__PURE__ */ new Date()).toISOString(),
          error: sanitizeErrorMessage(err)
        }), { expirationTtl: 3600 });
      } catch {
      }
      throw err;
    }
  }
  return handleTelegramUpdate(update, env, tg);
}
__name(routeTelegramUpdate, "routeTelegramUpdate");

// src/index.js
var VIDEO_ID_RE2 = /^[A-Za-z0-9_-]{11}$/;
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json({
        ok: true,
        service: "SubTube Bot",
        status: "running"
      });
    }
    if (request.method === "GET" && url.pathname === "/_diag") {
      if (env.DIAG_TOKEN && !timingSafeEqualStr(url.searchParams.get("token") || "", env.DIAG_TOKEN)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const videoId = (url.searchParams.get("v") || "").trim();
      if (!VIDEO_ID_RE2.test(videoId)) {
        return Response.json({ ok: false, error: "pass ?v=<11-char video id>" }, { status: 400 });
      }
      const mode = url.searchParams.get("mode") || "all";
      try {
        const report = await diagnoseExtraction(videoId, mode, env);
        return Response.json({ ok: true, ...report });
      } catch (err) {
        return Response.json({ ok: false, error: String(err && err.message || err) }, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname === "/webhook") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        console.error("Missing TELEGRAM_BOT_TOKEN secret.");
        return new Response("Server misconfigured: missing bot token", { status: 500 });
      }
      if (!env.TELEGRAM_WEBHOOK_SECRET) {
        console.error("Missing TELEGRAM_WEBHOOK_SECRET secret.");
        return new Response("Server misconfigured: missing webhook secret", { status: 500 });
      }
      if (!verifyTelegramSecret(request, env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN || "MISSING");
      ctx.waitUntil(
        routeTelegramUpdate(update, env, tg).catch((err) => {
          console.error("Unhandled update error:", sanitizeErrorMessage(err));
        })
      );
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname.startsWith("/f/")) {
      const fm = url.pathname.match(/^\/f\/([a-f0-9]{16})(\/subtitle\.fa\.srt)?$/);
      if (fm && env.SUBTITLE_CACHE) {
        try {
          const srt = await env.SUBTITLE_CACHE.get(`file:${fm[1]}`);
          if (srt) {
            return new Response(srt, {
              headers: { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=\"subtitle.fa.srt\"", "Cache-Control": "no-store" }
            });
          }
        } catch {
        }
      }
      return new Response("Not Found", { status: 404 });
    }
    if (request.method === "GET" && url.pathname.startsWith("/p/")) {
      const rest = url.pathname.slice(3);
      const isJson = rest.endsWith("/json");
      const token = isJson ? rest.slice(0, -5) : rest;
      if (/^[a-f0-9]{16}$/.test(token) && env.SUBTITLE_CACHE) {
        try {
          const jobId = await env.SUBTITLE_CACHE.get(`prog:${token}`);
          const snap = jobId ? await env.SUBTITLE_CACHE.get(`jobprog:${jobId}`, "json") : null;
          if (snap) {
            if (isJson) {
              if (snapshotLiveness(snap) === "stalled") {
                return Response.json({ ...snap, status: "failed", stalled: true });
              }
              return Response.json(snap);
            }
            return new Response(progressPageHtml(token), {
              headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
            });
          }
        } catch {
        }
      }
      return new Response("Not Found", { status: 404 });
    }
    return new Response("Not Found", { status: 404 });
  },
  async queue(batch, env, ctx) {
    const tg = createTelegramClient(env.TELEGRAM_BOT_TOKEN || "MISSING");
    for (const msg of batch.messages) {
      try {
        await runQueuedBatch(env, tg, msg.body);
        msg.ack();
      } catch (err) {
        console.error(`[queue] consumer failed: ${sanitizeErrorMessage(err)}`);
        msg.retry();
      }
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map