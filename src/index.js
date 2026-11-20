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
// --- Multi-source links (TikTok / Instagram / X / Facebook) ---
// External videos get ids of the form "<platform>:<nativeId>" so every
// downstream system (jobs, caches, panel) can treat them uniformly while
// isExternalVideoId() routes extraction to the generic Supadata endpoint.
function parseExternalUrl(input) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    return null;
  }
  const host = (url.hostname || "").replace(/^www\./, "").toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  const validId = (id) => /^[A-Za-z0-9_-]{3,80}$/.test(id || "");
  const mk = (platform, nativeId, canonicalUrl) => validId(nativeId) ? { videoId: `${platform}:${nativeId}`, canonicalUrl } : null;
  if (host === "tiktok.com" || host === "m.tiktok.com") {
    const vi = parts.indexOf("video");
    if (vi >= 0 && parts[vi + 1]) return mk("tiktok", parts[vi + 1], `https://www.tiktok.com${url.pathname}`);
    return null;
  }
  if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
    if (parts[0]) return mk("tiktok", parts[0], `https://${host}/${parts[0]}`);
    return null;
  }
  if (host === "instagram.com") {
    if ((parts[0] === "reel" || parts[0] === "reels" || parts[0] === "p") && parts[1]) {
      return mk("instagram", parts[1], `https://www.instagram.com/${parts[0] === "reels" ? "reel" : parts[0]}/${parts[1]}/`);
    }
    return null;
  }
  if (host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com") {
    const si = parts.indexOf("status");
    if (si >= 1 && parts[si + 1]) return mk("x", parts[si + 1], `https://x.com/${parts[0]}/status/${parts[si + 1]}`);
    return null;
  }
  if (host === "facebook.com" || host === "m.facebook.com") {
    const v = url.searchParams.get("v");
    if ((url.pathname === "/watch" || url.pathname === "/watch/") && v) {
      return mk("facebook", v, `https://www.facebook.com/watch?v=${encodeURIComponent(v)}`);
    }
    const vi = parts.indexOf("videos");
    if (vi >= 0 && parts[vi + 1]) return mk("facebook", parts[vi + 1], `https://www.facebook.com${url.pathname}`);
    if (parts[0] === "reel" && parts[1]) return mk("facebook", parts[1], `https://www.facebook.com/reel/${parts[1]}`);
    return null;
  }
  if (host === "fb.watch") {
    if (parts[0]) return mk("facebook", parts[0], `https://fb.watch/${parts[0]}`);
    return null;
  }
  return null;
}
__name(parseExternalUrl, "parseExternalUrl");
function isExternalVideoId(videoId) {
  return /^(tiktok|instagram|x|facebook):/.test(String(videoId || ""));
}
__name(isExternalVideoId, "isExternalVideoId");
function parseAllSupportedUrls(inputText, maxLinks = 3) {
  if (!inputText || typeof inputText !== "string") return { links: [], truncated: false };
  const candidates = inputText.match(/https?:\/\/[^\s<>"]+|(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s<>"]+/gi) || [];
  const seen = new Set();
  const links = [];
  let total = 0;
  for (const cand of candidates) {
    const parsed = parseYouTubeUrl(cand) || parseExternalUrl(cand);
    if (!parsed || seen.has(parsed.videoId)) continue;
    seen.add(parsed.videoId);
    total++;
    if (links.length < maxLinks) links.push(parsed);
  }
  if (!links.length) {
    const single = parseYouTubeUrl(inputText) || parseExternalUrl(inputText);
    if (single) return { links: [single], truncated: false };
  }
  return { links, truncated: total > maxLinks };
}
__name(parseAllSupportedUrls, "parseAllSupportedUrls");
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
    platform: "telegram",
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
    async sendSrtDocument(chatId, srtContent, caption, replyToMessageId = null, timeoutMs = 45e3, fileName = "subtitle.fa.srt") {
      const formData = new FormData();
      formData.append("chat_id", String(chatId));
      if (caption) {
        formData.append("caption", caption);
      }
      if (replyToMessageId) {
        formData.append("reply_to_message_id", String(replyToMessageId));
      }
      const blob = new Blob([srtContent], { type: "application/x-subrip; charset=utf-8" });
      formData.append("document", blob, fileName);
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
    async downloadFile(fileId, timeoutMs = 12e4) {
      // Bot API file download: getFile resolves the id to a path, then
      // the bytes come from the file endpoint. Telegram caps bot
      // downloads at 20 MB; callers check the size they get back.
      const info = await callApi("getFile", { file_id: fileId });
      const filePath = info?.result?.file_path;
      if (!info?.ok || !filePath) {
        throw new Error(`TELEGRAM_GETFILE_FAILED: ${info?.description || "no file_path"}`);
      }
      const res = await fetchWithTimeout(`https://api.telegram.org/file/bot${botToken}/${filePath}`, {}, timeoutMs);
      if (!res.ok) {
        throw new Error(`TELEGRAM_FILE_DOWNLOAD_FAILED: http ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
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
      }, 45e3);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(`TELEGRAM_SEND_DOC_URL_FAILED: ${data?.description || res.status}`);
      }
      return data.result;
    }
  };
}
__name(createTelegramClient, "createTelegramClient");

// src/rubika/client.js
// Rubika front-end (RUBIKA_PLAN.md). The Rubika Bot API is NOT a Telegram
// clone, so this client translates: it exposes the same verbs the shared
// pipeline uses on the Telegram client (sendMessage / editMessageText /
// deleteMessage / answerCallbackQuery / sendSrtDocument /
// sendDocumentByUrl) and normalizes Rubika's replies to the Telegram
// shape { ok, result, description }. All Rubika ids are strings and are
// passed through as strings — never Number()-coerced (a Rubika message
// id exceeds 2^53 and would lose precision).
var RUBIKA_API_BASE = "https://botapi.rubika.ir/v3";
function telegramKeyboardToRubika(replyMarkup) {
  const rows = replyMarkup?.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  const outRows = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const buttons = [];
    for (const b of row) {
      if (!b || typeof b.text !== "string") continue;
      if (typeof b.callback_data !== "string" || !b.callback_data) continue;
      buttons.push({ id: b.callback_data, type: "Simple", button_text: b.text });
    }
    if (buttons.length) outRows.push({ buttons });
  }
  return outRows.length ? { rows: outRows } : null;
}
__name(telegramKeyboardToRubika, "telegramKeyboardToRubika");
function createRubikaClient(botToken) {
  const apiBase = `${RUBIKA_API_BASE}/${botToken}`;
  async function callApi(method, payload) {
    try {
      const res = await fetchWithTimeout(`${apiBase}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }, 15e3);
      const data = await res.json().catch(() => null);
      return { ok: res.ok && data?.status === "OK", result: data?.data ?? null, description: data?.status || null };
    } catch (err) {
      console.error(`[rubika] ${method} failed: ${errName(err)}`);
      return { ok: false, result: null, description: "network_timeout" };
    }
  }
  __name(callApi, "callApi");
  return {
    platform: "rubika",
    platformNameFa: "روبیکا",
    // Pending-choice KV keys are namespaced per platform (RUBIKA_PLAN.md)
    // so a Telegram and a Rubika choice token can never collide.
    pendKeyPrefix: "pend:rubika:",
    async getMe() {
      return callApi("getMe", {});
    },
    async sendMessage(chatId, text, extra = {}) {
      const payload = {
        chat_id: String(chatId),
        text,
        chat_keypad_type: "None"
      };
      if (extra.reply_to_message_id) {
        payload.reply_to_message_id = String(extra.reply_to_message_id);
      }
      if (extra.reply_markup) {
        const keypad = telegramKeyboardToRubika(extra.reply_markup);
        if (keypad) payload.inline_keypad = keypad;
      }
      return callApi("sendMessage", payload);
    },
    async editMessageText(chatId, messageId, text, extra = {}) {
      if (!messageId) return { ok: false };
      const res = await callApi("editMessageText", {
        chat_id: String(chatId),
        message_id: String(messageId),
        text
      });
      if (extra && extra.reply_markup) {
        // Telegram clears buttons by editing with an empty keyboard; the
        // Rubika equivalent is a separate editMessageKeypad call.
        const keypad = telegramKeyboardToRubika(extra.reply_markup);
        await callApi("editMessageKeypad", {
          chat_id: String(chatId),
          message_id: String(messageId),
          inline_keypad: keypad || { rows: [] }
        });
      }
      return res;
    },
    async deleteMessage(chatId, messageId) {
      if (!messageId) return { ok: false };
      return callApi("deleteMessage", {
        chat_id: String(chatId),
        message_id: String(messageId)
      });
    },
    async answerCallbackQuery() {
      // Rubika inline taps are delivered as their own updates; there is
      // no callback acknowledgement call. No-op so shared code can call
      // it unconditionally.
      return { ok: true };
    },
    async sendSrtDocument(chatId, srtContent, caption, replyToMessageId = null, timeoutMs = 45e3, fileName = "subtitle.fa.srt") {
      const req = await callApi("requestSendFile", { type: "File" });
      const uploadUrl = req.result?.upload_url;
      if (!req.ok || !uploadUrl) {
        throw new Error(`RUBIKA_REQUEST_SENDFILE_FAILED: ${req.description || "no upload_url"}`);
      }
      const formData = new FormData();
      const blob = new Blob([srtContent], { type: "application/x-subrip; charset=utf-8" });
      formData.append("file", blob, fileName);
      const upRes = await fetchWithTimeout(uploadUrl, {
        method: "POST",
        body: formData
      }, timeoutMs);
      const upData = await upRes.json().catch(() => null);
      const fileId = upData?.data?.file_id;
      if (!upRes.ok || !fileId) {
        throw new Error(`RUBIKA_UPLOAD_FAILED: ${upRes.status}`);
      }
      const payload = {
        chat_id: String(chatId),
        file_id: fileId,
        chat_keypad_type: "None"
      };
      if (caption) {
        payload.text = caption;
      }
      if (replyToMessageId) {
        payload.reply_to_message_id = String(replyToMessageId);
      }
      const sent = await callApi("sendFile", payload);
      if (!sent.ok) {
        throw new Error(`RUBIKA_SEND_FILE_FAILED: ${sent.description || "unknown"}`);
      }
      return sent.result;
    },
    async sendDocumentByUrl() {
      // Rubika cannot fetch a file from a URL; files must be uploaded.
      // Throwing here moves deliverSrt to its upload rung, exactly like
      // a Telegram URL-delivery failure.
      throw new Error("RUBIKA_SEND_DOC_URL_UNSUPPORTED");
    }
  };
}
__name(createRubikaClient, "createRubikaClient");

// src/rubika/identity.js
// IDENTITY DECISION (RUBIKA_PLAN.md, build-time audit 2026-11-20): every
// D1 table keys users by telegram_id INTEGER and every data-layer
// function coerces ids with Number(...) — upsertUser, sweepStaleJobs,
// hasActiveJobForVideo, countRecentUserJobs, createJob, createJobAtomic,
// bumpUserStats, completeJob, failJob, isUserBlocked, getUserStats,
// logLinkEvent and the inline /usage /status /history /cancel queries.
// Rubika chat ids are strings ("b0..."), so feeding them into that layer
// would silently corrupt data (Number("b0...") is NaN). Instead of
// touching any of those shared functions, each external platform
// identity is mapped ONCE to a synthetic numeric uid in a reserved
// range (PLATFORM_UID_BASE and up). Real Telegram ids stay far below
// the base, and the base is exactly representable both as a JS number
// (< 2^53) and as a SQLite INTEGER, so every existing query, stat and
// admin view keeps working unchanged for Rubika users.
var PLATFORM_UID_BASE = 900000000000000;
var platformUsersTableReady = false;
async function ensurePlatformUsersTable(db) {
  if (platformUsersTableReady || !db) return;
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS platform_users (
       platform TEXT NOT NULL,
       external_id TEXT NOT NULL,
       uid INTEGER NOT NULL UNIQUE,
       created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
       PRIMARY KEY (platform, external_id)
     )`
  ).run();
  platformUsersTableReady = true;
}
__name(ensurePlatformUsersTable, "ensurePlatformUsersTable");
async function resolvePlatformUid(db, platform, externalId) {
  if (!db || !externalId) return null;
  await ensurePlatformUsersTable(db);
  const ext = String(externalId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await db.prepare(
      `SELECT uid FROM platform_users WHERE platform = ?1 AND external_id = ?2`
    ).bind(platform, ext).first();
    if (found) return Number(found.uid);
    try {
      await db.prepare(
        `INSERT INTO platform_users (platform, external_id, uid)
         VALUES (?1, ?2, COALESCE((SELECT MAX(uid) FROM platform_users), ?3 - 1) + 1)`
      ).bind(platform, ext, PLATFORM_UID_BASE).run();
    } catch {
      // Lost a race (a concurrent first contact took the uid or created
      // this very identity); loop around and read the row that exists.
    }
  }
  const final = await db.prepare(
    `SELECT uid FROM platform_users WHERE platform = ?1 AND external_id = ?2`
  ).bind(platform, ext).first();
  return final ? Number(final.uid) : null;
}
__name(resolvePlatformUid, "resolvePlatformUid");

// src/rubika/updates.js
// Normalize Rubika webhook payloads. ReceiveUpdate posts
// { update: { type, chat_id, new_message } }; ReceiveInlineMessage posts
// { inline_message: { chat_id, sender_id, message_id, aux_data } }.
// Message ids stay strings end to end (they exceed 2^53).
function normalizeRubikaUpdate(update) {
  if (!update || typeof update !== "object") return null;
  const chatId = typeof update.chat_id === "string" && update.chat_id ? update.chat_id : null;
  if (!chatId) return null;
  if (update.type === "StartedBot") {
    return { kind: "start", chatId };
  }
  const msg = update.new_message;
  if (update.type === "NewMessage" && msg && typeof msg.text === "string") {
    return {
      kind: "message",
      chatId,
      messageId: msg.message_id != null ? String(msg.message_id) : null,
      text: msg.text,
      senderId: typeof msg.sender_id === "string" ? msg.sender_id : null
    };
  }
  return null;
}
__name(normalizeRubikaUpdate, "normalizeRubikaUpdate");
function normalizeRubikaInline(inlineMessage) {
  if (!inlineMessage || typeof inlineMessage !== "object") return null;
  const chatId = typeof inlineMessage.chat_id === "string" && inlineMessage.chat_id ? inlineMessage.chat_id : null;
  const buttonId = typeof inlineMessage.aux_data?.button_id === "string" && inlineMessage.aux_data.button_id ? inlineMessage.aux_data.button_id : null;
  if (!chatId || !buttonId) return null;
  return {
    chatId,
    buttonId,
    messageId: inlineMessage.message_id != null ? String(inlineMessage.message_id) : null,
    senderId: typeof inlineMessage.sender_id === "string" ? inlineMessage.sender_id : null
  };
}
__name(normalizeRubikaInline, "normalizeRubikaInline");

// src/telegram/messages.js
var MESSAGES = {
  welcome: /* @__PURE__ */ __name((firstName) => `سلام${firstName ? ` ${firstName}` : ""}! به SubTube خوش آمدی.

با ارسال لینک ویدیو از یوتیوب، تیک‌تاک، اینستاگرام، ایکس یا فیس‌بوک، زیرنویس آن را به زبان انتخابی‌ات (پیش‌فرض: فارسی) ترجمه می‌کنم و فایل SRT را برایت می‌فرستم.

🌍 برای انتخاب زبان زیرنویس دستور /lang را بفرست.
📌 برای مشاهده راهنما دستور /help را بفرست.`, "welcome"),
  help: `📖 راهنمای استفاده از SubTube

کافیست لینک یک ویدیو را ارسال کنی؛ این منابع پشتیبانی می‌شوند:
• یوتیوب (youtube.com، youtu.be و Shorts)
• تیک‌تاک (tiktok.com)
• اینستاگرام (ریل و پست ویدیویی)
• ایکس / توییتر (x.com)
• فیس‌بوک (facebook.com و fb.watch)

⚙️ نحوه عملکرد:
۱. بررسی ویدیو و اولویت با زیرنویس دستی انگلیسی (در صورت نبود، زیرنویس خودکار)
۲. استخراج دقیق زمان‌بندی‌ها
۳. ترجمه روان به زبان انتخابی شما (پیش‌فرض: فارسی؛ با دستور /lang عوض می‌شود)
۴. ارسال مستقیم فایل زیرنویس

\u062F\u0633\u062A\u0648\u0631\u0627\u062A \u0631\u0628\u0627\u062A:
/start - \u0634\u0631\u0648\u0639 \u0645\u062C\u062F\u062F
/help - \u0631\u0627\u0647\u0646\u0645\u0627\u06CC \u0627\u0633\u062A\u0641\u0627\u062F\u0647
/translate - \u062A\u0631\u062C\u0645\u0647 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u06CC\u06A9 \u0648\u06CC\u062F\u06CC\u0648
/lang - \u0632\u0628\u0627\u0646 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633
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
  uploadPrompt: "📎 فایلت رسید! از روی صدای فایل، زیرنویس می‌سازم.\nبرای این فایل چی می‌خوای؟",
  uploadTooBig: "⚠️ حجم این فایل بیشتر از ۲۰ مگابایت است.\nربات‌های تلگرام فقط می‌توانند فایل‌های تا ۲۰ مگابایت را دریافت کنند. لطفاً فایل کوچک‌تری بفرست، یا لینک ویدیو را ارسال کن.",
  invalidLink: `⚠️ لطفاً یک لینک معتبر از یوتیوب، تیک‌تاک، اینستاگرام، ایکس یا فیس‌بوک ارسال کنید.

نمونه‌های معتبر:
https://www.youtube.com/watch?v=jNQXAC9IVRw
https://www.tiktok.com/@user/video/1234567890
https://www.instagram.com/reel/ABC123xyz/`,
  statusChecking: "\u{1F50D} \u062F\u0631 \u062D\u0627\u0644 \u0628\u0631\u0631\u0633\u06CC \u0648\u06CC\u062F\u06CC\u0648...",
  statusExtracting: "\u{1F4DD} \u062F\u0631 \u062D\u0627\u0644 \u0627\u0633\u062A\u062E\u0631\u0627\u062C \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633...",
  statusTranslating: /* @__PURE__ */ __name((done, total, targetLang = "fa") => total > 1 ? `\u{1F310} \u062F\u0631 \u062D\u0627\u0644 \u062A\u0631\u062C\u0645\u0647 \u0628\u0647 ${targetLangFaName(targetLang)}... (${done}/${total})` : `\u{1F310} \u062F\u0631 \u062D\u0627\u0644 \u062A\u0631\u062C\u0645\u0647 \u0628\u0647 ${targetLangFaName(targetLang)}...`, "statusTranslating"),
  statusBuildingSrt: "\u{1F4E6} \u062F\u0631 \u062D\u0627\u0644 \u0633\u0627\u062E\u062A \u0641\u0627\u06CC\u0644 SRT...",
  statusDoneCaption: /* @__PURE__ */ __name(({ videoId, cueCount, isAuto, targetLang = "fa" }) => `\u2705 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 ${targetLangFaName(targetLang)} \u0622\u0645\u0627\u062F\u0647 \u0634\u062F.

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
// The user's persistent subtitle target language lives in its own column
// (migration 0004): users.language is the Telegram UI language_code and
// must not be repurposed. Existing rows take the 'fa' default, which is
// exactly the historical behavior. The column self-heals at runtime the
// same way platform_users does, so a deploy never depends on the
// migration having been applied first.
var subtitleLangColumnReady = false;
async function ensureSubtitleLangColumn(db) {
  if (subtitleLangColumnReady || !db) return;
  try {
    await db.prepare(`SELECT subtitle_lang FROM users LIMIT 1`).first();
  } catch {
    try {
      await db.prepare(`ALTER TABLE users ADD COLUMN subtitle_lang TEXT NOT NULL DEFAULT 'fa'`).run();
    } catch {
      // A concurrent execution added the column first; that is fine.
    }
  }
  subtitleLangColumnReady = true;
}
__name(ensureSubtitleLangColumn, "ensureSubtitleLangColumn");
async function getUserSubtitleLang(db, telegramId) {
  if (!db || telegramId == null) return "fa";
  try {
    await ensureSubtitleLangColumn(db);
    const row = await db.prepare(`SELECT subtitle_lang FROM users WHERE telegram_id = ?1`).bind(Number(telegramId)).first();
    return normalizeTargetLang(row?.subtitle_lang || "fa");
  } catch {
    return "fa";
  }
}
__name(getUserSubtitleLang, "getUserSubtitleLang");
async function setUserSubtitleLang(db, telegramId, lang) {
  const tgt = normalizeTargetLang(lang);
  if (!db || telegramId == null) return tgt;
  await ensureSubtitleLangColumn(db);
  await db.prepare(`UPDATE users SET subtitle_lang = ?2 WHERE telegram_id = ?1`).bind(Number(telegramId), tgt).run();
  return tgt;
}
__name(setUserSubtitleLang, "setUserSubtitleLang");
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
  const swept = [];
  for (const r of rows) {
    const res = await db.prepare(
      `UPDATE jobs
         SET status = 'failed',
             error_message = 'timeout_stale_job',
             completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
         WHERE id = ?1 AND status = 'processing'`
    ).bind(Number(r.id)).run();
    if (Number(res?.meta?.changes || 0) > 0) {
      swept.push({ id: r.id, videoId: r.video_id });
      await bumpUserStats(db, telegramId, false);
    }
  }
  return swept;
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
async function bumpUserStats(db, telegramId, succeeded) {
  await db.prepare(
    succeeded
      ? `INSERT INTO user_stats (telegram_id, total_jobs, successful_jobs, failed_jobs, last_job_at)
         VALUES (?1, 1, 1, 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(telegram_id) DO UPDATE SET
           total_jobs = user_stats.total_jobs + 1,
           successful_jobs = user_stats.successful_jobs + 1,
           last_job_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
      : `INSERT INTO user_stats (telegram_id, total_jobs, successful_jobs, failed_jobs, last_job_at)
         VALUES (?1, 1, 0, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(telegram_id) DO UPDATE SET
           total_jobs = user_stats.total_jobs + 1,
           failed_jobs = user_stats.failed_jobs + 1,
           last_job_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
  ).bind(Number(telegramId)).run();
}
__name(bumpUserStats, "bumpUserStats");
// Guarded terminal transitions: user_stats is bumped only when this call
// is the one that actually moves the job out of 'processing'. A second
// terminal call for the same job (queue redelivery, a late failure after
// completion, a sweep race) can no longer double-count the user's stats.
async function completeJob(db, jobId, telegramId) {
  const res = await db.prepare(
    `UPDATE jobs
       SET status = 'completed',
           completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?1 AND status = 'processing'`
  ).bind(Number(jobId)).run();
  if (Number(res?.meta?.changes || 0) < 1) return false;
  await bumpUserStats(db, telegramId, true);
  return true;
}
__name(completeJob, "completeJob");
async function failJob(db, jobId, telegramId, errorMessage) {
  const safeMsg = String(errorMessage || "unknown_error").slice(0, 500);
  const res = await db.prepare(
    `UPDATE jobs
       SET status = 'failed',
           error_message = ?2,
           completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?1 AND status = 'processing'`
  ).bind(Number(jobId), safeMsg).run();
  if (Number(res?.meta?.changes || 0) < 1) return false;
  await bumpUserStats(db, telegramId, false);
  return true;
}
__name(failJob, "failJob");
// --- Admin panel support: link events, job metadata, user blocking ---
// Best-effort instrumentation for the admin panel: a failure in any of
// these helpers must never break the bot's main flow, so each one swallows
// its own errors.
function extractDomain(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    return (u.hostname || "").replace(/^www\./, "").toLowerCase() || null;
  } catch {
    const m = String(rawUrl || "").match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
    return m ? m[1].toLowerCase() : null;
  }
}
__name(extractDomain, "extractDomain");
function sourceFromDomain(domain) {
  if (!domain) return "Unknown";
  if (/(^|\.)youtube\.com$/.test(domain) || domain === "youtu.be") return "YouTube";
  if (/(^|\.)tiktok\.com$/.test(domain)) return "TikTok";
  if (/(^|\.)instagram\.com$/.test(domain)) return "Instagram";
  if (/(^|\.)x\.com$/.test(domain) || /(^|\.)twitter\.com$/.test(domain)) return "X";
  if (/(^|\.)facebook\.com$/.test(domain) || domain === "fb.watch") return "Facebook";
  return "Other";
}
__name(sourceFromDomain, "sourceFromDomain");
async function logLinkEvent(db, { user, url, outcome }, kv = null) {
  try {
    if (!db || !url) return;
    if (kv && user?.id) {
      // Flood guard: one user can only add a bounded number of link-event
      // rows per hour, so spamming the bot cannot grow the table without
      // limit. Best-effort: a KV hiccup never blocks logging entirely.
      try {
        const hour = Math.floor(Date.now() / 3600000);
        const key = `lev:${user.id}:${hour}`;
        const n = Number(await kv.get(key)) || 0;
        if (n >= 100) return;
        await kv.put(key, String(n + 1), { expirationTtl: 7200 });
      } catch {
      }
    }
    const domain = extractDomain(url);
    await db.prepare(
      `INSERT INTO link_events (telegram_id, username, first_name, url, domain, source, outcome)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(Number(user?.id) || 0, user?.username || null, user?.first_name || null, String(url).slice(0, 1000), domain, sourceFromDomain(domain), outcome || "received").run();
  } catch {
  }
}
__name(logLinkEvent, "logLinkEvent");
async function recordJobMeta(db, jobId, { provider = null, model = null, cueCount = null } = {}) {
  try {
    if (!db || !jobId) return;
    await db.prepare(
      `UPDATE jobs SET provider = ?2, model = ?3, cue_count = ?4 WHERE id = ?1`
    ).bind(Number(jobId), provider, model, cueCount == null ? null : Number(cueCount)).run();
  } catch {
  }
}
__name(recordJobMeta, "recordJobMeta");
async function isUserBlocked(db, telegramId) {
  try {
    if (!db) return false;
    const row = await db.prepare(`SELECT is_blocked FROM users WHERE telegram_id = ?1 LIMIT 1`).bind(Number(telegramId)).first();
    return Number(row?.is_blocked || 0) === 1;
  } catch {
    return false;
  }
}
__name(isUserBlocked, "isUserBlocked");

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
async function extractViaSupadata(videoId, deadline, apiKey, langWanted = "en", targetUrl = null, mode = "native") {
  const watchUrl = targetUrl || `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const langParam = langWanted ? `&lang=${encodeURIComponent(langWanted)}` : "";
  const apiUrl = `https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(watchUrl)}${langParam}&mode=${mode}`;
  const budget = Math.min(mode === "generate" ? 280e3 : 12e3, remaining(deadline));
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
    const maxPolls = mode === "generate" ? 70 : 5;
    for (let i = 0; i < maxPolls && !done; i++) {
      const b2 = Math.min(mode === "generate" ? 15e3 : 4e3, remaining(deadline));
      if (b2 < 1200) break;
      await sleep(mode === "generate" ? 3000 : 1100);
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
    const errText = String(data?.error || data?.message || data?.detail || "").slice(0, 90);
    return { status: "fail", detail: `supadata http ${res.status}${errText ? " " + errText : ""}` };
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
async function extractExternalSubtitles(videoId, canonicalUrl, env = {}) {
  const kv = env.SUBTITLE_CACHE;
  const cacheKey = `cap2:${videoId}`;
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
    } catch (err) {
      console.error(`[cache] ${videoId} read failed: ${errName(err)}`);
    }
  }
  const TEMP_FAIL = "⏳ سرویس‌های دریافت زیرنویس الان جواب نمی‌دهند (مشکل موقت شبکه). چند دقیقه دیگر دوباره امتحان کنید.";
  if (!env.SUPADATA_API_KEY) {
    throw new AppError(ERROR_CODES.EXTRACTION_FAILED, TEMP_FAIL);
  }
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const attempts = [];
  LAST_EXTRACT_ATTEMPTS = attempts;
  let hit = null;
  const sd = await extractViaSupadata(videoId, deadline, env.SUPADATA_API_KEY, "en", canonicalUrl).catch((err) => ({
    status: "fail",
    detail: `supadata ${errName(err)}`
  }));
  logAttempt(videoId, sd);
  attempts.push(sd);
  if (sd.status === "ok" && sd.cues?.length) hit = sd;
  if (!hit && sd.status === "empty" && sd.definitive) {
    throw new AppError(ERROR_CODES.NO_CAPTIONS, "❌ این ویدیو هیچ زیرنویسی ندارد (نه دستی و نه خودکار).");
  }
  if (!hit) {
    const sdAny = await extractViaSupadata(videoId, deadline, env.SUPADATA_API_KEY, null, canonicalUrl).catch((err) => ({
      status: "fail",
      detail: `supadata-any ${errName(err)}`
    }));
    logAttempt(videoId, sdAny);
    attempts.push(sdAny);
    if (sdAny.status === "ok" && sdAny.cues?.length) hit = sdAny;
    if (!hit && sdAny.status === "empty" && sdAny.definitive) {
      throw new AppError(ERROR_CODES.NO_CAPTIONS, "❌ این ویدیو هیچ زیرنویسی ندارد (نه دستی و نه خودکار).");
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
        console.log(`[extract] ${videoId} CACHED ${payload.cues.length} cues via ${hit.source} (48h)`);
      } catch (err) {
        console.error(`[cache] ${videoId} write failed: ${errName(err)}`);
      }
    }
    console.log(`[extract] ${videoId} OK via ${hit.source}`);
    return payload;
  }
  if (attempts.some((a) => a.detail && /http 404/.test(a.detail))) {
    throw new AppError(ERROR_CODES.EXTRACTION_FAILED, "⚠️ خود ویدیو در دسترس نیست: خصوصی، حذف‌شده یا محدود به کشور دیگری است.");
  }
  throw new AppError(ERROR_CODES.EXTRACTION_FAILED, TEMP_FAIL);
}
__name(extractExternalSubtitles, "extractExternalSubtitles");
async function extractGeneratedSubtitles(videoId, canonicalUrl, env = {}) {
  const kv = env.SUBTITLE_CACHE;
  const cacheKey = `cap2:${videoId}`;
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
    } catch (err) {
      console.error(`[cache] ${videoId} read failed: ${errName(err)}`);
    }
  }
  const TEMP_FAIL = "⏳ سرویس‌های دریافت زیرنویس الان جواب نمی‌دهند (مشکل موقت شبکه). چند دقیقه دیگر دوباره امتحان کنید.";
  if (!env.SUPADATA_API_KEY) {
    throw new AppError(ERROR_CODES.EXTRACTION_FAILED, TEMP_FAIL);
  }
  // Generation is a single expensive provider job (the whole video is
  // transcribed), so it gets one attempt with a long polling budget
  // instead of the native path's quick language retries.
  const deadline = Date.now() + 300e3;
  const attempts = [];
  LAST_EXTRACT_ATTEMPTS = attempts;
  const sd = await extractViaSupadata(videoId, deadline, env.SUPADATA_API_KEY, null, canonicalUrl, "generate").catch((err) => ({
    status: "fail",
    detail: `supadata-gen ${errName(err)}`
  }));
  logAttempt(videoId, sd);
  attempts.push(sd);
  if (sd.status === "ok" && sd.cues?.length) {
    const payload = {
      cues: normalizeCues(sd.cues),
      isAuto: true,
      languageCode: sd.lang || "en",
      source: "supadata_generated"
    };
    if (kv) {
      try {
        await kv.put(cacheKey, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
        console.log(`[extract] ${videoId} CACHED ${payload.cues.length} generated cues (48h)`);
      } catch (err) {
        console.error(`[cache] ${videoId} write failed: ${errName(err)}`);
      }
    }
    console.log(`[extract] ${videoId} GENERATED ${payload.cues.length} cues lang=${payload.languageCode}`);
    return payload;
  }
  if (sd.status === "empty" && sd.definitive) {
    throw new AppError(ERROR_CODES.NO_CAPTIONS, "❌ ساخت زیرنویس با هوش مصنوعی هم برای این ویدیو ممکن نشد؛ گفتار قابل تشخیصی پیدا نشد.");
  }
  if (sd.detail && /http 404/.test(sd.detail)) {
    throw new AppError(ERROR_CODES.EXTRACTION_FAILED, "⚠️ خود ویدیو در دسترس نیست: خصوصی، حذف‌شده یا محدود به کشور دیگری است.");
  }
  throw new AppError(ERROR_CODES.EXTRACTION_FAILED, TEMP_FAIL);
}
__name(extractGeneratedSubtitles, "extractGeneratedSubtitles");
// ===== Upload transcription (Workers AI Whisper) =====
// Feasibility proven live 2026-11-20 via diag mode=whisper: from inside
// the Worker, @cf/openai/whisper-large-v3-turbo transcribed FLAC, MP4
// (AAC), OGG/Opus and a 9.7 MB WAV correctly, returning segments with
// word timings plus a detected language; the classic @cf/openai/whisper
// returns a timed VTT. Telegram bots can only download user files up to
// 20 MB (getFile), so that is the upload cap everywhere below.
var MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(bin);
}
__name(bytesToBase64, "bytesToBase64");
function parseWhisperTimestamp(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const parts = s.split(":").map((p) => parseFloat(p));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Math.round(sec * 1e3);
}
__name(parseWhisperTimestamp, "parseWhisperTimestamp");
function parseWhisperVtt(vtt) {
  const cues = [];
  let prevEnd = 0;
  for (const block of String(vtt || "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const arrow = lines.findIndex((l) => l.includes("-->"));
    if (arrow === -1) continue;
    const sides = lines[arrow].split("-->").map((x) => x.trim().split(/\s+/)[0]);
    let startMs = parseWhisperTimestamp(sides[0]);
    const endMs = parseWhisperTimestamp(sides[1]);
    if (endMs == null) continue;
    // The classic model's first VTT cue can arrive with an empty start
    // (" --> 02.480"); fall back to the previous cue's end (0 at first).
    if (startMs == null) startMs = prevEnd;
    const text = lines.slice(arrow + 1).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    cues.push({ startMs, endMs: Math.max(startMs + 200, endMs), text });
    prevEnd = Math.max(prevEnd, endMs);
  }
  return cues;
}
__name(parseWhisperVtt, "parseWhisperVtt");
function cuesFromWhisperSegments(segments) {
  const cues = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const segStart = Math.max(0, Math.round((Number(seg?.start) || 0) * 1e3));
    const segEnd = Math.max(segStart + 200, Math.round((Number(seg?.end) || 0) * 1e3));
    const text = String(seg?.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const dur = segEnd - segStart;
    const words = (Array.isArray(seg?.words) ? seg.words : []).filter((w) => w && typeof w.word === "string" && w.word.trim());
    if (dur <= 7500) {
      cues.push({ startMs: segStart, endMs: segEnd, text });
      continue;
    }
    if (!words.length) {
      // Long segment without word timings: split the text into
      // ~6.5-second word groups with proportional timings.
      const parts = Math.max(2, Math.ceil(dur / 6500));
      const toks = text.split(" ");
      const per = Math.ceil(toks.length / parts);
      for (let i = 0; i < toks.length; i += per) {
        const s = segStart + Math.round(dur * (i / toks.length));
        const e = segStart + Math.round(dur * (Math.min(i + per, toks.length) / toks.length));
        cues.push({ startMs: s, endMs: Math.max(s + 200, e), text: toks.slice(i, i + per).join(" ") });
      }
      continue;
    }
    // Word-timed split: group words into <=6.5s / <=84-char cues.
    let cur = null;
    for (const w of words) {
      const wStart = Math.max(segStart, Math.round((Number(w.start) || 0) * 1e3));
      const wEnd = Math.max(wStart + 100, Math.round((Number(w.end) || 0) * 1e3));
      const wText = w.word.trim();
      if (!cur) {
        cur = { startMs: wStart, endMs: wEnd, text: wText };
        continue;
      }
      if (wEnd - cur.startMs > 6500 || (cur.text.length + 1 + wText.length > 84 && wStart > cur.startMs)) {
        cues.push(cur);
        cur = { startMs: wStart, endMs: wEnd, text: wText };
      } else {
        cur.text += " " + wText;
        cur.endMs = wEnd;
      }
    }
    if (cur) cues.push(cur);
  }
  return cues;
}
__name(cuesFromWhisperSegments, "cuesFromWhisperSegments");
async function transcribeUploadedAudio(bytes, env = {}) {
  const TEMP_FAIL = "⏳ سرویس ساخت زیرنویس از روی صدا الان جواب نمی‌دهد (مشکل موقت). چند دقیقه دیگر دوباره امتحان کنید.";
  if (!env.AI) {
    throw new AppError(ERROR_CODES.EXTRACTION_FAILED, TEMP_FAIL, "workers ai binding missing");
  }
  let responded = false;
  try {
    const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: bytesToBase64(bytes) });
    responded = true;
    let cues = cuesFromWhisperSegments(r?.segments);
    if (!cues.length && typeof r?.vtt === "string") cues = parseWhisperVtt(r.vtt);
    if (cues.length) {
      return {
        cues: normalizeCues(cues),
        isAuto: true,
        languageCode: normalizeLangCode(r?.transcription_info?.language || "en"),
        source: "whisper_turbo"
      };
    }
  } catch (err) {
    console.error(`[whisper] turbo failed: ${errName(err)}`);
  }
  // Classic model fallback (timed VTT, no language report — the source
  // is then assumed English). Its byte-array input is only used up to
  // 12 MB; the spread of a larger array risks the Worker memory limit.
  if (bytes.length <= 12 * 1024 * 1024) {
    try {
      const r2 = await env.AI.run("@cf/openai/whisper", { audio: [...bytes] });
      responded = true;
      const cues = typeof r2?.vtt === "string" ? parseWhisperVtt(r2.vtt) : [];
      if (cues.length) {
        return { cues: normalizeCues(cues), isAuto: true, languageCode: "en", source: "whisper_vtt" };
      }
    } catch (err) {
      console.error(`[whisper] classic failed: ${errName(err)}`);
    }
  }
  if (responded) {
    throw new AppError(ERROR_CODES.NO_CAPTIONS, "❌ در این فایل گفتار قابل تشخیصی پیدا نشد.", "whisper returned no speech");
  }
  throw new AppError(ERROR_CODES.EXTRACTION_FAILED, TEMP_FAIL, "whisper unavailable");
}
__name(transcribeUploadedAudio, "transcribeUploadedAudio");
var LAST_EXTRACT_ATTEMPTS = [];
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
    if (!hit && sd.status === "empty" && sd.definitive) {
      // Supadata's 206 is definitive (the video has no transcript at all);
      // asking again without a language would burn a second credit from
      // the 100/month plan for the same answer.
      throw new AppError(
        ERROR_CODES.NO_CAPTIONS,
        "\u274C \u0627\u06CC\u0646 \u0648\u06CC\u062F\u06CC\u0648 \u0647\u06CC\u0686 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633\u06CC \u0646\u062F\u0627\u0631\u062F (\u0646\u0647 \u062F\u0633\u062A\u06CC \u0648 \u0646\u0647 \u062E\u0648\u062F\u06A9\u0627\u0631)."
      );
    }
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
      }, env, jobUsageSink, srcLang, videoId);
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
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest"
];
var TRANSLATE_ENDPOINT = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fa&dt=t";
var MAX_CHUNK_CHARS = 4500;
var MAX_ITEMS_PER_CHUNK = 40;
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
// Selectable subtitle TARGET languages (Arshia's pick #6, 2026-11-20).
// "fa" is the default and keeps every legacy behavior byte-identical
// (fa2:/chunkfa1: cache keys, prompt wording, subtitle.fa.srt filename);
// the other targets are strictly additive. `name` is the English name
// used in provider prompts, `faName` the Persian name shown to users,
// `short` the adjective used inside prompt sentences (for fa the legacy
// prompts say "Persian", not "Persian (Farsi)").
var TARGET_LANGS = {
  fa: { name: "Persian (Farsi)", short: "Persian", faName: "فارسی" },
  en: { name: "English", short: "English", faName: "انگلیسی" },
  ar: { name: "Arabic", short: "Arabic", faName: "عربی" },
  tr: { name: "Turkish", short: "Turkish", faName: "ترکی" },
  ru: { name: "Russian", short: "Russian", faName: "روسی" },
  es: { name: "Spanish", short: "Spanish", faName: "اسپانیایی" },
  fr: { name: "French", short: "French", faName: "فرانسوی" },
  de: { name: "German", short: "German", faName: "آلمانی" }
};
function normalizeTargetLang(raw) {
  const c = String(raw || "fa").toLowerCase().split("-")[0];
  return Object.prototype.hasOwnProperty.call(TARGET_LANGS, c) ? c : "fa";
}
__name(normalizeTargetLang, "normalizeTargetLang");
function targetLangName(code) {
  return TARGET_LANGS[normalizeTargetLang(code)].name;
}
__name(targetLangName, "targetLangName");
function targetLangShort(code) {
  return TARGET_LANGS[normalizeTargetLang(code)].short;
}
__name(targetLangShort, "targetLangShort");
function targetLangFaName(code) {
  return TARGET_LANGS[normalizeTargetLang(code)].faName;
}
__name(targetLangFaName, "targetLangFaName");
function srtFileNameForLang(code) {
  return `subtitle.${normalizeTargetLang(code)}.srt`;
}
__name(srtFileNameForLang, "srtFileNameForLang");
function langKeyboard(current) {
  const cur = normalizeTargetLang(current);
  const codes = Object.keys(TARGET_LANGS);
  const rows = [];
  for (let i = 0; i < codes.length; i += 2) {
    rows.push(codes.slice(i, i + 2).map((code) => ({
      text: `${code === cur ? "✅ " : ""}${TARGET_LANGS[code].faName}`,
      callback_data: `l:${code}`
    })));
  }
  return { inline_keyboard: rows };
}
__name(langKeyboard, "langKeyboard");
async function translateChunkViaGeminiById(chunk, apiKey, langName = "English", targetLang = "fa") {
  const items = chunk.map((c) => ({
    id: c.index,
    text: c.text.replace(/\n+/g, " ").replace(/\r/g, "").trim()
  }));
  const expectedIds = new Set(items.map((i) => i.id));
  const tgt = normalizeTargetLang(targetLang);
  const prompt = `Translate each ${langName} subtitle item into natural, fluent ${targetLangName(tgt)}.
You receive a JSON array of items, each with a unique "id" and its "text".
Return ONLY a JSON array with exactly one object per input item, in this shape: {"id": <the same id>, "${tgt}": "<the ${targetLangShort(tgt)} translation of that item's text>"}.
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
                  properties: { id: { type: "INTEGER" }, [tgt]: { type: "STRING" } },
                  required: ["id", tgt]
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
    const byId = matchTranslationsById(text, expectedIds, tgt);
    if (byId) {
      return { ok: true, byId };
    }
  }
  return { ok: false, reason: "unavailable", status: 0 };
}
__name(translateChunkViaGeminiById, "translateChunkViaGeminiById");
function matchTranslationsArray(arr, expectedIds, key = "fa") {
  if (!Array.isArray(arr)) return null;
  const byId = new Map();
  for (const item of arr) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const id = Number(item.id);
    const tr = typeof item[key] === "string" ? item[key].trim() : "";
    if (!Number.isInteger(id) || !expectedIds.has(id)) return null;
    if (byId.has(id)) return null;
    if (!tr) return null;
    byId.set(id, tr);
  }
  if (byId.size !== expectedIds.size) return null;
  return byId;
}
__name(matchTranslationsArray, "matchTranslationsArray");
function matchTranslationsById(text, expectedIds, key = "fa") {
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    return null;
  }
  return matchTranslationsArray(arr, expectedIds, key);
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
async function translateChunkViaCoarenaById(chunk, apiKey, model, usage, langName = "English", deadlineAt = 0, targetLang = "fa") {
  const items = chunk.map((c) => ({
    id: c.index,
    text: c.text.replace(/\n+/g, " ").replace(/\r/g, "").trim()
  }));
  const expectedIds = new Set(items.map((i) => i.id));
  const tgt = normalizeTargetLang(targetLang);
  const systemPrompt = `You are a professional subtitle translator for films and TV series, translating ${langName} dialogue into ${targetLangName(tgt)}.
Translate naturally and fluently, the way people actually speak in ${targetLangShort(tgt)} subtitles and dubbing: render idioms, slang, jokes and cultural references by their intended meaning, not word by word. Keep the tone of each line (funny, angry, sad, formal). Preserve names, numbers and any {{{S%}}} placeholders exactly.`;
  const userPrompt = `Translate every item below. Return ONLY a JSON object of this exact shape: {"items": [{"id": <the item's id>, "${tgt}": "<its ${targetLangShort(tgt)} translation>"}]}.
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
    if (res.status === 429 || res.status === 408 || res.status >= 500) {
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
    const byId = parseCoarenaContent(content, expectedIds, tgt);
    if (byId) return { ok: true, byId };
    contentFailures++;
    if (contentFailures >= 2) {
      return { ok: false, reason: "invalid_output", status: res.status };
    }
  }
  return { ok: false, reason: "unavailable", status: 0 };
}
__name(translateChunkViaCoarenaById, "translateChunkViaCoarenaById");
function parseCoarenaContent(content, expectedIds, key = "fa") {
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
  return matchTranslationsArray(arr, expectedIds, key);
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
async function fetchGoogleTranslateRaw(queryText, maxRetries = 2, srcLang = "en", targetLang = "fa") {
  const endpoint = TRANSLATE_ENDPOINT.replace("sl=en", `sl=${srcLang}`).replace("tl=fa", `tl=${normalizeTargetLang(targetLang)}`);
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
async function translateSingleChunkViaGoogle(chunk, srcLang = "en", targetLang = "fa") {
  if (chunk.length === 1) {
    const translated = await fetchGoogleTranslateRaw(chunk[0].text, 2, srcLang, targetLang);
    return [{ index: chunk[0].index, translatedText: translated.trim() || chunk[0].text }];
  }
  const prepared = chunk.map((item, idx) => {
    const flattened = item.text.replace(/\n+/g, " \u23CE ");
    return idx === 0 ? flattened : `
[[[${idx}]]]
${flattened}`;
  });
  const payload = prepared.join("");
  const rawTranslated = await fetchGoogleTranslateRaw(payload, 2, srcLang, targetLang);
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
        const t = await fetchGoogleTranslateRaw(item.text, 2, srcLang, targetLang);
        singleOut.push({ index: item.index, translatedText: t.trim() || item.text });
      }
      return singleOut;
    }
    const mid = Math.ceil(chunk.length / 2);
    const left = await translateSingleChunkViaGoogle(chunk.slice(0, mid), srcLang, targetLang);
    const right = await translateSingleChunkViaGoogle(chunk.slice(mid), srcLang, targetLang);
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
async function translateCuesToPersian(cues, onProgress = null, env = {}, usageSink = null, sourceLang = "en", videoId = null, targetLang = "fa") {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const srcLang = normalizeLangCode(sourceLang);
  const langName = sourceLangName(srcLang);
  const tgtLang = normalizeTargetLang(targetLang);
  const tSettings = await resolveTranslationSettings(env);
  const jobUsage = usageSink || {};
  Object.assign(jobUsage, {
    provider: tSettings.provider,
    model: tSettings.model,
    sourceLang: srcLang,
    targetLang: tgtLang,
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
  if (srcLang === tgtLang) {
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
  // The job runs in a Queue consumer with a 15-minute budget, so translation
  // gets 10 minutes: the old 120s cap killed big videos mid-way and dumped
  // most cues into the slow one-by-one repair (job 91: 507 cues, 0 chunks ok).
  const overallDeadline = Date.now() + 6e5;
  // Pool size measured, not guessed (2026-11-17, isolated 507-cue jobs,
  // GPT-6 Luna): concurrency 4 -> 70s with 6 retries; 2 -> 107s with 1
  // retry; 3 -> 137s with 3 retries. Coarena's limits API does report a
  // concurrency cap of 2 and counts concurrency refusals, but refused
  // requests retry into freed slots and act as backpressure — the net
  // wall-clock winner is 4, and the retry overhead costs ~$0.001 per job.
  const effectiveConcurrency = CONCURRENCY;
  let geminiAvailable = Boolean(env.GEMINI_API_KEY);
  let coarenaAvailable = coarenaKeys.length > 0;
  const candidates = [];
  for (const p of [tSettings.provider, "coarena", "gemini", "google"]) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  async function translateChunk(chunk, chunkOrdinal = 0) {
    for (const p of candidates) {
      if (p === "coarena") {
        if (!coarenaAvailable || overallDeadline - Date.now() < 2e3) continue;
        let res = null;
        const keyCount = coarenaKeys.length;
        // Rotate the starting key per chunk so parallel chunks spread across
        // the key pool instead of all queueing on key 1 while key 2 idles.
        let keyIdx = keyCount > 0 ? chunkOrdinal % keyCount : 0;
        let keysTried = 0;
        while (keysTried < keyCount) {
          if (deadCoarenaKeys.has(keyIdx)) {
            keyIdx = (keyIdx + 1) % keyCount;
            keysTried++;
            continue;
          }
          try {
            res = await translateChunkViaCoarenaById(chunk, coarenaKeys[keyIdx], tSettings.model, jobUsage, langName, overallDeadline, tgtLang);
          } catch {
            res = null;
          }
          keysTried++;
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
            keyIdx = (keyIdx + 1) % keyCount;
            res = null;
            continue;
          }
          if (res && res.reason === "unavailable" && keysTried < keyCount && overallDeadline - Date.now() > 3e4) {
            keyIdx = (keyIdx + 1) % keyCount;
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
            gem = await translateChunkViaGeminiById(chunk, env.GEMINI_API_KEY, langName, tgtLang);
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
        const g = await translateSingleChunkViaGoogle(chunk, srcLang, tgtLang);
        markUsed("google");
        return { ok: true, items: g };
      } catch {
        continue;
      }
    }
    return { ok: false, items: chunk.map((c) => ({ index: c.index, translatedText: c.text })) };
  }
  __name(translateChunk, "translateChunk");
  // Worker pool (not fixed waves): a slow chunk no longer blocks the next
  // ones — as soon as a worker finishes a chunk it pulls the next.
  let nextChunkIdx = 0;
  let progressError = null;
  // Per-chunk result cache (KV, 48h): chunks a previous run of this same
  // video already translated are reused instead of re-bought from the
  // provider — a queue-retried job, or a re-send after a partial failure,
  // resumes instead of starting from zero. An entry applies only when its
  // stored cue-id set exactly matches the chunk's, so a shifted extraction
  // can never misalign translations.
  const chunkKv = env && env.SUBTITLE_CACHE ? env.SUBTITLE_CACHE : null;
  const chunkCacheOn = Boolean(chunkKv && videoId);
  // Chunk cache keys are versioned per target family: Persian keeps the
  // legacy chunkfa1: keys untouched (warm caches stay valid); every other
  // target gets chunktr1: keys with the target embedded, so two languages
  // can never read each other's chunks.
  const chunkKey = tgtLang === "fa" ? (i) => `chunkfa1:${videoId}:${sourceLang}:${tSettings.provider}:${tSettings.model}:${i}` : (i) => `chunktr1:${videoId}:${sourceLang}:${tgtLang}:${tSettings.provider}:${tSettings.model}:${i}`;
  const cachedChunks = new Set();
  if (chunkCacheOn) {
    for (let ci = 0; ci < chunks.length; ci++) {
      try {
        const stored = await chunkKv.get(chunkKey(ci), "json");
        if (!stored || !Array.isArray(stored.items) || stored.items.length !== chunks[ci].length) continue;
        const want = new Set(chunks[ci].map((c) => c.index));
        let valid = stored.items.length > 0;
        for (const it of stored.items) {
          if (!it || !want.has(it.index) || typeof it.translatedText !== "string" || !it.translatedText.trim()) {
            valid = false;
            break;
          }
          want.delete(it.index);
        }
        if (!valid || want.size !== 0) continue;
        for (const it of stored.items) translatedByIndex[it.index] = it.translatedText;
        cachedChunks.add(ci);
        prog.chunksDone++;
        prog.chunksOk++;
        prog.processed += chunks[ci].length;
        prog.succeeded += chunks[ci].length;
        completedChunks++;
      } catch {
      }
    }
    if (cachedChunks.size > 0 && typeof onProgress === "function") {
      try {
        await onProgress(completedChunks, chunks.length);
      } catch (err) {
        if (!progressError) progressError = err;
      }
    }
  }
  async function chunkWorker() {
    while (nextChunkIdx < chunks.length && !progressError && Date.now() < overallDeadline) {
      const chunkIdx = nextChunkIdx++;
      if (cachedChunks.has(chunkIdx)) continue;
      const chunkCues = chunks[chunkIdx];
      const chunkRes = await translateChunk(chunkCues, chunkIdx);
      for (const item of chunkRes.items) {
        translatedByIndex[item.index] = item.translatedText;
      }
      prog.chunksDone++;
      prog.processed += chunkCues.length;
      if (chunkRes.ok) {
        prog.chunksOk++;
        prog.succeeded += chunkCues.length;
        if (chunkCacheOn && chunkRes.items.every((it) => typeof it.translatedText === "string" && it.translatedText.trim())) {
          try {
            await chunkKv.put(chunkKey(chunkIdx), JSON.stringify({ items: chunkRes.items }), { expirationTtl: 172800 });
          } catch {
          }
        }
      } else {
        prog.chunksFailed++;
        prog.failed += chunkCues.length;
        for (const c of chunkCues) failedIndices.push(c.index);
      }
      completedChunks++;
      if (typeof onProgress === "function") {
        try {
          await onProgress(completedChunks, chunks.length);
        } catch (err) {
          if (!progressError) progressError = err;
        }
      }
    }
  }
  const chunkWorkers = [];
  const chunkWorkerCount = Math.min(effectiveConcurrency, chunks.length);
  for (let w = 0; w < chunkWorkerCount; w++) chunkWorkers.push(chunkWorker());
  await Promise.all(chunkWorkers);
  if (progressError) throw progressError;
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
  const repairSet = [...new Set([...check.brokenIndices, ...holeIndices, ...failedIndices])].slice(0, 300);
  if (repairSet.length > 0) prog.phase = "repair";
  const repairedOk = new Set();
  if (!check.ok || repairSet.length > 0) {
    if (!check.ok) {
      console.error(`[translate] validation failed: ${check.problems.slice(0, 8).join("; ")}`);
    }
    // Batched repair: groups of 25 lines per Google request, 3 groups in
    // parallel — the old one-line-at-a-time loop needed ~1s per line, so
    // repairing 120 lines alone could take two minutes.
    const repairGroups = [];
    for (let gi = 0; gi < repairSet.length; gi += 25) {
      repairGroups.push(repairSet.slice(gi, gi + 25).map((idx) => ({ index: idx, text: cues[idx].text })));
    }
    let nextRepairGroup = 0;
    async function repairWorker() {
      while (nextRepairGroup < repairGroups.length) {
        const group = repairGroups[nextRepairGroup++];
        try {
          const items = await translateSingleChunkViaGoogle(group, srcLang, tgtLang);
          for (const item of items) {
            if (item && typeof item.translatedText === "string" && item.translatedText.trim()) {
              out[item.index] = { startMs: cues[item.index].startMs, endMs: cues[item.index].endMs, text: item.translatedText.trim() };
              repairedOk.add(item.index);
            }
          }
        } catch {
        }
      }
    }
    const repairWorkers = [];
    const repairWorkerCount = Math.min(3, repairGroups.length);
    for (let w = 0; w < repairWorkerCount; w++) repairWorkers.push(repairWorker());
    await Promise.all(repairWorkers);
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
var RETRANSLATE_ROTATION = [
  { provider: "coarena", model: "gpt-6-luna" },
  { provider: "coarena", model: "deepseek-v4-1-flash-1017" },
  { provider: "gemini", model: "gemini-3.6-flash" }
];
function nextRetranslateSettings(last) {
  const idx = RETRANSLATE_ROTATION.findIndex((s) => s.provider === last?.provider && s.model === last?.model);
  return RETRANSLATE_ROTATION[(idx + 1) % RETRANSLATE_ROTATION.length];
}
__name(nextRetranslateSettings, "nextRetranslateSettings");
function buildRetranslateCallbackData(token) {
  return `r:${token}`;
}
__name(buildRetranslateCallbackData, "buildRetranslateCallbackData");
function parseRetranslateCallbackData(data) {
  const m = /^r:([a-f0-9]{12})$/.exec(String(data || ""));
  return m ? { token: m[1] } : null;
}
__name(parseRetranslateCallbackData, "parseRetranslateCallbackData");
function retranslateKeyboard(token) {
  return { inline_keyboard: [[{ text: "\u{1F501} \u062A\u0631\u062C\u0645\u0647 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627 \u0645\u062F\u0644 \u062F\u06CC\u06AF\u0631", callback_data: buildRetranslateCallbackData(token) }]] };
}
__name(retranslateKeyboard, "retranslateKeyboard");
// After a subtitle file is delivered, offer a one-tap re-translation with a
// different model. The offer is a separate message so it works with every
// delivery route (URL, upload, text). Best-effort: a failure here must never
// break the completed job, so everything is wrapped in try/catch.
async function offerRetranslate(env, tg, chatId, { videoId, canonicalUrl, userId, mode, provider, model, targetLang = "fa" }) {
  try {
    if (!env.SUBTITLE_CACHE) return;
    const token = makeChoiceToken();
    await env.SUBTITLE_CACHE.put(`retr:${token}`, JSON.stringify({ videoId, canonicalUrl, userId, mode, provider, model, targetLang: normalizeTargetLang(targetLang) }), { expirationTtl: 86400 });
    await tg.sendMessage(chatId, "\u0627\u0632 \u062A\u0631\u062C\u0645\u0647 \u0631\u0627\u0636\u06CC \u0646\u06CC\u0633\u062A\u06CC\u061F \u0628\u0627 \u06CC\u0647 \u0645\u062F\u0644 \u062F\u06CC\u06AF\u0647 \u062F\u0648\u0628\u0627\u0631\u0647 \u062A\u0631\u062C\u0645\u0647\u200C\u0634 \u06A9\u0646\u0645\u061F", { reply_markup: retranslateKeyboard(token) });
  } catch (err) {
    console.error(`[retranslate] offer failed: ${errName(err)}`);
  }
}
__name(offerRetranslate, "offerRetranslate");
function buildGenerateCallbackData(token) {
  return `g:${token}`;
}
__name(buildGenerateCallbackData, "buildGenerateCallbackData");
function parseGenerateCallbackData(data) {
  const m = /^g:([a-f0-9]{12})$/.exec(String(data || ""));
  return m ? { token: m[1] } : null;
}
__name(parseGenerateCallbackData, "parseGenerateCallbackData");
function generateKeyboard(token) {
  return { inline_keyboard: [[{ text: "🎙 با هوش مصنوعی بساز", callback_data: buildGenerateCallbackData(token) }]] };
}
__name(generateKeyboard, "generateKeyboard");
// When a video turns out to have no captions at all, offer one-tap AI
// generation (Supadata speech-to-text). Generation burns the monthly
// credit quota per minute of video, so it is always the user's tap that
// starts it, never an automatic retry. Best-effort like offerRetranslate.
async function offerGenerate(env, tg, chatId, { videoId, canonicalUrl, userId, mode, targetLang = "fa" }) {
  try {
    if (!env.SUBTITLE_CACHE) return;
    const token = makeChoiceToken();
    await env.SUBTITLE_CACHE.put(`gen:${token}`, JSON.stringify({ videoId, canonicalUrl, userId, mode, targetLang: normalizeTargetLang(targetLang) }), { expirationTtl: 86400 });
    await tg.sendMessage(chatId, `🎙 این ویدیو زیرنویس آماده ندارد.\nاگر بخواهی، با هوش مصنوعی از روی صدای ویدیو زیرنویس می‌سازم و به ${targetLangFaName(targetLang)} ترجمه می‌کنم. (کمی طول می‌کشد و از سهمیه ماهانه ساخت زیرنویس کم می‌شود)`, { reply_markup: generateKeyboard(token) });
  } catch (err) {
    console.error(`[generate] offer failed: ${errName(err)}`);
  }
}
__name(offerGenerate, "offerGenerate");
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
function translationCacheKey(videoId, srcLang, provider, model, targetLang = "fa") {
  const tgt = normalizeTargetLang(targetLang);
  // Persian keeps the legacy fa2: key byte-identical (existing warm
  // entries stay valid); other targets use the new tr2: version with the
  // target embedded, so languages never share an entry.
  if (tgt === "fa") return `fa2:${videoId}:${srcLang}:${provider}:${model}`;
  return `tr2:${videoId}:${srcLang}:${tgt}:${provider}:${model}`;
}
__name(translationCacheKey, "translationCacheKey");
async function readTranslationCache(kv, videoId, srcLang, provider, model, targetLang = "fa") {
  if (!kv) return null;
  try {
    const hit = await kv.get(translationCacheKey(videoId, srcLang, provider, model, targetLang), "json");
    if (hit && typeof hit.srt === "string" && hit.srt.length > 10) return hit;
  } catch (err) {
    console.error(`[cache] translation read failed: ${errName(err)}`);
  }
  return null;
}
__name(readTranslationCache, "readTranslationCache");
async function writeTranslationCache(kv, videoId, srcLang, provider, model, payload, targetLang = "fa") {
  if (!kv) return;
  try {
    await kv.put(translationCacheKey(videoId, srcLang, provider, model, targetLang), JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
    console.log(`[cache] translation stored for ${videoId} (${srcLang}/${provider}/${model})`);
  } catch (err) {
    console.error(`[cache] translation write failed: ${errName(err)}`);
  }
}
__name(writeTranslationCache, "writeTranslationCache");
var PROGRESS_BASE_URL = "https://subtube-bot.hsdoebc.workers.dev";
var STAGE_LABELS_SUB = ["\u062F\u0631\u06CC\u0627\u0641\u062A \u0648\u06CC\u062F\u06CC\u0648", "\u0627\u0633\u062A\u062E\u0631\u0627\u062C \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0627\u0635\u0644\u06CC", "\u0622\u0645\u0627\u062F\u0647\u200C\u0633\u0627\u0632\u06CC \u0645\u062A\u0646", "\u0627\u0631\u0633\u0627\u0644 \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u062A\u0631\u062C\u0645\u0647", "\u062F\u0631\u06CC\u0627\u0641\u062A \u062A\u0631\u062C\u0645\u0647\u200C\u0647\u0627", "\u0627\u0639\u062A\u0628\u0627\u0631\u0633\u0646\u062C\u06CC \u062A\u0631\u062C\u0645\u0647\u200C\u0647\u0627", "\u0645\u0631\u062A\u0628\u200C\u0633\u0627\u0632\u06CC \u0648 \u0647\u0645\u06AF\u0627\u0645\u200C\u0633\u0627\u0632\u06CC \u0632\u0645\u0627\u0646\u200C\u0647\u0627", "\u062A\u0648\u0644\u06CC\u062F \u0641\u0627\u06CC\u0644 \u0646\u0647\u0627\u06CC\u06CC"];
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
  const elapsedMs = Date.now() - p.startedAt;
  // ETA from the real completion rate so far; only reported once enough of
  // the job has run for the rate to mean something (>=5s elapsed, >=1 cue).
  let etaMs = null;
  if (p.status === "done") etaMs = 0;
  else if (p.processed > 0 && p.total > p.processed && elapsedMs >= 5e3) {
    etaMs = Math.round(elapsedMs * (p.total - p.processed) / p.processed);
  }
  return { ...p, stages: p.stages.map((s) => ({ ...s })), progress, successRate, elapsedMs, etaMs, updatedAt: Date.now() };
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
    <div class="cell"><div class="n" id="cChunks">-</div><div class="t">\u0628\u0686\u200C\u0647\u0627 (\u0627\u0646\u062C\u0627\u0645\u200C\u0634\u062F\u0647/\u06A9\u0644)</div></div>
    <div class="cell"><div class="n" id="cEta">-</div><div class="t">\u0632\u0645\u0627\u0646 \u0628\u0627\u0642\u06CC\u200C\u0645\u0627\u0646\u062F\u0647 (\u062A\u062E\u0645\u06CC\u0646\u06CC)</div></div>
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
    document.getElementById("cChunks").textContent = fa(d.chunksDone || 0) + "/" + fa(d.chunksTotal || 0);
    document.getElementById("cEta").textContent = d.etaMs === null || d.etaMs === undefined ? "-" : fmt(d.etaMs);
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
async function deliverSrt(env, tg, chatId, srtContent, caption, replyToMessageId, targetLang = "fa") {
  // Delivery ladder (measured 2026-11-15): Telegram's media ingress from
  // this Worker is degraded \u2014 any multipart request carrying a file part
  // stalls until timeout, and Telegram's fetcher refuses this Worker's
  // /f/ URLs, while plain JSON calls answer in ~200ms. So: try URL
  // delivery (instant when Telegram accepts it), then a short-probe
  // classic upload (succeeds again once Telegram recovers), and finally
  // send ONE message with the direct download link (the file already
  // sits in KV for 48h). The subtitle itself is never dumped into the
  // chat as text \u2014 Arshia removed that fallback on 2026-11-18 because
  // six long text messages flood the conversation.
  // Lesson (2026-11-17, job 92): a sendDocument that times out on OUR side
  // can still be delivered by Telegram afterwards — the old 20s/15s probe
  // budgets were shorter than Telegram's actual ingress latency, so both
  // file rungs "failed", the text fallback went out claiming the file was
  // stuck, and then the file arrived anyway. Budgets are now 45s per rung
  // so a timeout really means stuck, and the fallback note no longer
  // claims the file is not coming.
  // The ladder is shared with the Rubika front-end; only the platform
  // name in the fallback note differs (clients may set platformNameFa).
  const platformName = tg?.platformNameFa || "تلگرام";
  const fileName = srtFileNameForLang(targetLang);
  let fileUrl = null;
  try {
    const token = makeChoiceToken() + makeChoiceToken().slice(0, 4);
    await env.SUBTITLE_CACHE.put(`file:${token}`, srtContent, { expirationTtl: 172800 });
    fileUrl = `${PROGRESS_BASE_URL}/f/${token}/${fileName}`;
    await tg.sendDocumentByUrl(chatId, fileUrl, caption, replyToMessageId);
    return "url";
  } catch (err) {
    console.error(`[deliver] URL delivery failed: ${errName(err)}`);
  }
  try {
    await tg.sendSrtDocument(chatId, srtContent, caption, replyToMessageId, 45e3, fileName);
    return "upload";
  } catch (err) {
    console.error(`[deliver] upload delivery failed: ${errName(err)}`);
  }
  try {
    if (fileUrl) {
      await tg.sendMessage(chatId, `${caption}\n\n\u26A0\uFE0F \u0627\u0631\u0633\u0627\u0644 \u0641\u0627\u06CC\u0644 \u062F\u0631 ${platformName} \u0637\u0648\u0644 \u06A9\u0634\u06CC\u062F\u061B \u0641\u0627\u06CC\u0644 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0622\u0645\u0627\u062F\u0647 \u0627\u0633\u062A\u060C \u0627\u0632 \u0627\u06CC\u0646 \u0644\u06CC\u0646\u06A9 \u062F\u0627\u0646\u0644\u0648\u062F\u0634 \u06A9\u0646 (\u062A\u0627 \u06F4\u06F8 \u0633\u0627\u0639\u062A \u0641\u0639\u0627\u0644 \u0627\u0633\u062A):\n${fileUrl}`);
      return "link";
    }
    await tg.sendMessage(chatId, `${caption}\n\n\u26A0\uFE0F \u0627\u0631\u0633\u0627\u0644 \u0641\u0627\u06CC\u0644 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062F. \u0644\u0637\u0641\u0627\u064B \u0644\u06CC\u0646\u06A9 \u0648\u06CC\u062F\u06CC\u0648 \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0641\u0631\u0633\u062A.`);
  } catch (err) {
    console.error(`[deliver] link fallback failed: ${errName(err)}`);
  }
  return "failed";
}
__name(deliverSrt, "deliverSrt");
async function processVideoJob({ env, tg, chatId, user, message, videoId, canonicalUrl, mode = "both", maxPerHour = 0, altSettings = null, skipCaches = false, generate = false, targetLang = null }) {
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
  // The job's target language: an explicit value (queue payload, or a
  // retranslate offer preserving the original job's language) wins;
  // otherwise the user's stored /lang preference; default Persian.
  const tgtLang = normalizeTargetLang(targetLang || await getUserSubtitleLang(env.DB, user.id));
  const created = await createJobAtomic(env.DB, {
    telegramId: user.id,
    videoId,
    videoUrl: canonicalUrl,
    sourceLanguage: "en",
    targetLanguage: tgtLang,
    maxPerHour
  });
  if (created.blocked) return created.blocked;
  const jobId = created.jobId;
  const statusMsgRes = await tg.sendMessage(chatId, MESSAGES.statusChecking, {
    reply_to_message_id: message.message_id
  });
  const statusMsgId = statusMsgRes?.result?.message_id;
  let progress = null;
  let jobMeta = null;
  try {
    const tSettings = altSettings || await resolveTranslationSettings(env);
    jobMeta = { provider: tSettings.provider, model: tSettings.model, cueCount: null };
    await tg.editMessageText(chatId, statusMsgId, MESSAGES.statusExtracting);
    const extracted = await (generate ? extractGeneratedSubtitles(videoId, canonicalUrl, env) : isExternalVideoId(videoId) ? extractExternalSubtitles(videoId, canonicalUrl, env) : extractEnglishSubtitles(videoId, env));
    const cues = extracted.cues;
    const srcLang = normalizeLangCode(extracted.languageCode);
    await throwIfCancelled(env, jobId);
    const cachedFa = skipCaches ? null : await readTranslationCache(env.SUBTITLE_CACHE, videoId, srcLang, tSettings.provider, tSettings.model, tgtLang);
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
        isAuto: Boolean(cachedFa.isAuto),
        targetLang: tgtLang
      });
      await deliverSrt(env, tg, chatId, cachedFa.srt, caption, message.message_id, tgtLang);
      if (mode === "both" && cachedFa.summary) {
        await tg.sendMessage(chatId, `\u{1F4DD} \u062E\u0644\u0627\u0635\u0647 \u0648\u06CC\u062F\u06CC\u0648:\n\n${cachedFa.summary}`);
      }
      await tg.deleteMessage(chatId, statusMsgId);
      await recordJobMeta(env.DB, jobId, { provider: tSettings.provider, model: tSettings.model, cueCount: cachedFa.cueCount || null });
      await completeJob(env.DB, jobId, user.id);
      console.log(`[job] ${videoId} served from translation cache`);
      if (srcLang !== tgtLang) {
        await offerRetranslate(env, tg, chatId, { videoId, canonicalUrl, userId: user.id, mode, provider: tSettings.provider, model: tSettings.model, targetLang: tgtLang });
      }
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
        await writeTranslationCache(env.SUBTITLE_CACHE, videoId, srcLang, tSettings.provider, tSettings.model, { ...cachedFa, summary }, tgtLang);
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
      await tg.editMessageText(chatId, statusMsgId, MESSAGES.statusTranslating(0, 1, tgtLang));
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
          await tg.editMessageText(chatId, statusMsgId, MESSAGES.statusTranslating(done, total, tgtLang));
        }
      }
    }, env, jobUsageSink, srcLang, skipCaches ? null : videoId, tgtLang);
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
    await recordJobMeta(env.DB, jobId, { provider: tSettings.provider, model: tSettings.model, cueCount: translatedCues.length });
    const caption = MESSAGES.statusDoneCaption({
      videoId,
      cueCount: translatedCues.length,
      isAuto: extracted.isAuto,
      targetLang: tgtLang
    });
    let fullCaption = jobUsageSink.untranslatedCount > 0 ? `${caption}

\u26A0\uFE0F ${jobUsageSink.untranslatedCount} \u062E\u0637 \u0628\u0647\u200C\u0639\u0644\u062A \u0645\u062D\u062F\u0648\u062F\u06CC\u062A \u0632\u0645\u0627\u0646\u06CC \u0628\u062F\u0648\u0646 \u062A\u0631\u062C\u0645\u0647 \u0645\u0627\u0646\u062F (\u0645\u062A\u0646 \u0627\u0646\u06AF\u0644\u06CC\u0633\u06CC).` : caption;
    if (srcLang === tgtLang) {
      fullCaption += `\n\n\u2139\uFE0F \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633 ${targetLangFaName(tgtLang)} \u0622\u0645\u0627\u062F\u0647 \u0628\u0648\u062F \u0648 \u0628\u062F\u0648\u0646 \u062A\u0631\u062C\u0645\u0647 \u0627\u0631\u0633\u0627\u0644 \u0634\u062F.`;
    } else if (srcLang !== "en") {
      fullCaption += `\n\n\u{1F310} \u0632\u0628\u0627\u0646 \u0645\u0628\u062F\u0623 \u0632\u06CC\u0631\u0646\u0648\u06CC\u0633: ${SRC_LANG_FA_NAMES[srcLang] || srcLang}`;
    }
    if (!jobUsageSink.untranslatedCount) {
      await writeTranslationCache(env.SUBTITLE_CACHE, videoId, srcLang, tSettings.provider, tSettings.model, {
        srt: srtContent,
        cueCount: translatedCues.length,
        isAuto: extracted.isAuto,
        summary: null
      }, tgtLang);
    }
    await throwIfCancelled(env, jobId);
    await deliverSrt(env, tg, chatId, srtContent, fullCaption, message.message_id, tgtLang);
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
      // summarizeTranscript always calls Coarena with tSettings.model, so a
      // re-translate job whose alt model belongs to another provider (e.g.
      // Gemini) would ask Coarena for a foreign model and silently lose the
      // summary. Alt jobs therefore summarize with the default settings.
      const sumSettings = altSettings ? await resolveTranslationSettings(env) : tSettings;
      const summary = await summarizeTranscript(cues, env, sumSettings);
      if (summary) {
        await tg.sendMessage(chatId, `\u{1F4DD} \u062E\u0644\u0627\u0635\u0647 \u0648\u06CC\u062F\u06CC\u0648:\n\n${summary}`);
        if (!jobUsageSink.untranslatedCount) {
          await writeTranslationCache(env.SUBTITLE_CACHE, videoId, srcLang, tSettings.provider, tSettings.model, {
            srt: srtContent,
            cueCount: translatedCues.length,
            isAuto: extracted.isAuto,
            summary
          }, tgtLang);
        }
      }
    } catch (err) {
      console.error(`[job] summary step failed: ${errName(err)}`);
    }
    if (srcLang !== tgtLang) {
      await offerRetranslate(env, tg, chatId, { videoId, canonicalUrl, userId: user.id, mode, provider: tSettings.provider, model: tSettings.model, targetLang: tgtLang });
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
    if (jobMeta) await recordJobMeta(env.DB, jobId, jobMeta);
    try {
      await failJob(env.DB, jobId, user.id, safeInternal);
    } catch (dbErr) {
      console.error("failJob failed:", sanitizeErrorMessage(dbErr));
    }
    if (err?.code === ERROR_CODES.NO_CAPTIONS && !generate) {
      await offerGenerate(env, tg, chatId, { videoId, canonicalUrl, userId: user.id, mode, targetLang: tgtLang });
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
async function processUploadJob({ env, tg, chatId, user, message, upload, mode = "both", maxPerHour = 0, targetLang = null }) {
  const videoId = `upload:${upload.token}`;
  const swept = await sweepStaleJobs(env.DB, user.id);
  if (swept.length) {
    await tg.sendMessage(chatId, "⚠️ یک پردازش قبلی به‌علت وقفه سرور ناتمام ماند و بسته شد. اگر هنوز لازمش داری، فایلش را دوباره بفرست.");
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
  const tgtLang = normalizeTargetLang(targetLang || await getUserSubtitleLang(env.DB, user.id));
  const created = await createJobAtomic(env.DB, {
    telegramId: user.id,
    videoId,
    videoUrl: upload.fileName || "",
    sourceLanguage: "en",
    targetLanguage: tgtLang,
    maxPerHour
  });
  if (created.blocked) return created.blocked;
  const jobId = created.jobId;
  const displayName = upload.fileName ? String(upload.fileName).slice(0, 60) : "فایل آپلودی";
  const statusMsgRes = await tg.sendMessage(chatId, "📥 در حال دریافت فایل...", {
    reply_to_message_id: message.message_id
  });
  const statusMsgId = statusMsgRes?.result?.message_id;
  let progress = null;
  let jobMeta = null;
  try {
    const tSettings = await resolveTranslationSettings(env);
    jobMeta = { provider: tSettings.provider, model: tSettings.model, cueCount: null };
    // Extraction for uploads = transcription of the file's audio. The
    // cues are cached under the same cap2: key as every other source, so
    // a queue redelivery never pays for the same transcription twice.
    let extracted = null;
    const kv = env.SUBTITLE_CACHE;
    if (kv) {
      try {
        const cached = await kv.get(`cap2:${videoId}`, "json");
        if (cached && Array.isArray(cached.cues) && cached.cues.length > 0) {
          extracted = {
            cues: normalizeCues(cached.cues),
            isAuto: true,
            languageCode: cached.languageCode || "en",
            source: `${cached.source || "cache"}_cached`
          };
        }
      } catch (err) {
        console.error(`[cache] ${videoId} read failed: ${errName(err)}`);
      }
    }
    if (!extracted) {
      if (typeof tg.downloadFile !== "function") {
        throw new AppError(ERROR_CODES.EXTRACTION_FAILED, MESSAGES.genericError, "client cannot download files");
      }
      const bytes = await tg.downloadFile(upload.fileId);
      if (bytes.length > MAX_UPLOAD_BYTES) {
        throw new AppError(ERROR_CODES.EXTRACTION_FAILED, MESSAGES.uploadTooBig, "downloaded file over the 20 MB bot cap");
      }
      await throwIfCancelled(env, jobId);
      await tg.editMessageText(chatId, statusMsgId, "🎙 در حال ساخت زیرنویس از روی صدا...");
      extracted = await transcribeUploadedAudio(bytes, env);
      if (kv) {
        try {
          await kv.put(`cap2:${videoId}`, JSON.stringify({
            cues: extracted.cues,
            isAuto: true,
            languageCode: extracted.languageCode,
            source: extracted.source
          }), { expirationTtl: CACHE_TTL_SECONDS });
        } catch (err) {
          console.error(`[cache] ${videoId} write failed: ${errName(err)}`);
        }
      }
    }
    const cues = extracted.cues;
    const srcLang = normalizeLangCode(extracted.languageCode);
    await throwIfCancelled(env, jobId);
    if (mode === "sum") {
      const summary = await summarizeTranscript(cues, env, tSettings);
      if (!summary) {
        throw new AppError(
          ERROR_CODES.EXTRACTION_FAILED,
          "❌ خلاصه این فایل ساخته نشد. ممکن است متن گفتار خیلی کوتاه باشد یا سرویس خلاصه‌سازی الان در دسترس نباشد.",
          "summary unavailable"
        );
      }
      await tg.sendMessage(chatId, `📝 خلاصه فایل:\n\n${summary}`);
      await tg.deleteMessage(chatId, statusMsgId);
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
      await tg.editMessageText(chatId, statusMsgId, MESSAGES.statusTranslating(0, 1, tgtLang));
    }
    let lastUpdateAt = Date.now();
    const jobUsageSink = {};
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
          await tg.editMessageText(chatId, statusMsgId, MESSAGES.statusTranslating(done, total, tgtLang));
        }
      }
    }, env, jobUsageSink, srcLang, videoId, tgtLang);
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
    await recordJobMeta(env.DB, jobId, { provider: tSettings.provider, model: tSettings.model, cueCount: translatedCues.length });
    const caption = MESSAGES.statusDoneCaption({
      videoId: displayName,
      cueCount: translatedCues.length,
      isAuto: true,
      targetLang: tgtLang
    });
    let fullCaption = jobUsageSink.untranslatedCount > 0 ? `${caption}

⚠️ ${jobUsageSink.untranslatedCount} خط به‌علت محدودیت زمانی بدون ترجمه ماند (متن اصلی).` : caption;
    if (srcLang === tgtLang) {
      fullCaption += `\n\nℹ️ گفتار این فایل ${targetLangFaName(tgtLang)} بود و زیرنویس بدون ترجمه ارسال شد.`;
    } else if (srcLang !== "en") {
      fullCaption += `\n\n🌐 زبان گفتار فایل: ${SRC_LANG_FA_NAMES[srcLang] || srcLang}`;
    }
    await throwIfCancelled(env, jobId);
    await deliverSrt(env, tg, chatId, srtContent, fullCaption, message.message_id, tgtLang);
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
    // Same rule as link jobs: the Persian summary is a bonus AFTER the
    // file is delivered, so it can never block or lose the file.
    if (mode === "both") try {
      const summary = await summarizeTranscript(cues, env, tSettings);
      if (summary) {
        await tg.sendMessage(chatId, `📝 خلاصه فایل:\n\n${summary}`);
      }
    } catch (err) {
      console.error(`[job] upload summary step failed: ${errName(err)}`);
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
    if (jobMeta) await recordJobMeta(env.DB, jobId, jobMeta);
    try {
      await failJob(env.DB, jobId, user.id, safeInternal);
    } catch (dbErr) {
      console.error("failJob failed:", sanitizeErrorMessage(dbErr));
    }
    const userFacing = err instanceof AppError ? err.userMessage : MESSAGES.genericError;
    if (statusMsgId) {
      await tg.editMessageText(chatId, statusMsgId, userFacing);
    } else {
      await tg.sendMessage(chatId, userFacing);
    }
    return "error";
  }
}
__name(processUploadJob, "processUploadJob");
async function runUploadJob({ env, tg, chatId, user, message, upload, mode = "both", targetLang = null, qid = null }) {
  const rateLimitStr = await getSetting(env.DB, "rate_limit_per_hour", null) || env.RATE_LIMIT_MAX_PER_HOUR || "10";
  const maxPerHour = Math.max(1, parseInt(rateLimitStr, 10) || 10);
  const recentCount = await countRecentUserJobs(env.DB, user.id, 60);
  if (recentCount >= maxPerHour) {
    await tg.sendMessage(chatId, MESSAGES.rateLimited(maxPerHour));
    return;
  }
  const videoId = `upload:${upload.token}`;
  if (qid && env.SUBTITLE_CACHE) {
    try {
      if (await env.SUBTITLE_CACHE.get(`qdone:${qid}:${videoId}`)) {
        console.log(`[queue] skip already-processed upload ${videoId} (qid ${qid})`);
        return;
      }
    } catch {
    }
  }
  const outcome = await processUploadJob({ env, tg, chatId, user, message, upload, mode, maxPerHour, targetLang });
  if (outcome === "duplicate") {
    await tg.sendMessage(chatId, MESSAGES.duplicateJob);
  }
  if (qid && env.SUBTITLE_CACHE) {
    try {
      await env.SUBTITLE_CACHE.put(`qdone:${qid}:${videoId}`, "1", { expirationTtl: 1800 });
    } catch {
    }
  }
}
__name(runUploadJob, "runUploadJob");
function telegramMediaOf(message) {
  // Media a user can upload for transcription: video, video note, audio,
  // voice, or a document whose MIME type is audio/video. Anything else
  // (photos, stickers, text documents, ...) is not an upload and keeps
  // the historical invalid-link reply. Telegram-only in v1: Rubika
  // updates are normalized without media fields, so this returns null
  // for them and the shared flow is unchanged there.
  if (!message) return null;
  const pick = (obj, kind) => obj && obj.file_id ? {
    kind,
    fileId: String(obj.file_id),
    fileSize: Number(obj.file_size) || 0,
    fileName: obj.file_name || "",
    mimeType: obj.mime_type || ""
  } : null;
  if (message.video) return pick(message.video, "video");
  if (message.video_note) return pick(message.video_note, "video");
  if (message.audio) return pick(message.audio, "audio");
  if (message.voice) return pick(message.voice, "voice");
  const doc = message.document;
  if (doc && /^(audio|video)\//.test(String(doc.mime_type || ""))) return pick(doc, "document");
  return null;
}
__name(telegramMediaOf, "telegramMediaOf");
async function handleMediaUpload({ env, tg, chatId, user, message, media }) {
  // The bytes are NOT downloaded here: webhook executions are killed
  // ~30s after the response (measured), so the intake only records the
  // Telegram file_id in the pending choice; the queue consumer downloads
  // inside its 15-minute budget. The 20 MB cap is Telegram's own bot
  // download limit — when the size is known upfront we reject at once,
  // otherwise the job checks the downloaded length.
  if (media.fileSize && media.fileSize > MAX_UPLOAD_BYTES) {
    await tg.sendMessage(chatId, MESSAGES.uploadTooBig, { reply_to_message_id: message.message_id });
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
  const upload = { token, fileId: media.fileId, fileSize: media.fileSize || 0, kind: media.kind, fileName: media.fileName || "" };
  let stored = false;
  try {
    await env.SUBTITLE_CACHE.put(`${tg.pendKeyPrefix || "pend:"}${token}`, JSON.stringify({
      userId: user.id,
      chatId,
      linkMessageId: message.message_id,
      upload,
      truncated: false
    }), { expirationTtl: 1800 });
    stored = true;
  } catch (err) {
    console.error(`[upload] pending store failed: ${errName(err)}`);
  }
  if (!stored) {
    await tg.sendMessage(chatId, MESSAGES.genericError);
    return;
  }
  await tg.sendMessage(chatId, MESSAGES.uploadPrompt, {
    reply_to_message_id: message.message_id,
    reply_markup: choiceKeyboard(token)
  });
}
__name(handleMediaUpload, "handleMediaUpload");
async function handleTelegramUpdate(update, env, tg) {
  const message = update?.message;
  if (!message || !message.chat || !message.from) {
    return;
  }
  const chatId = message.chat.id;
  const user = message.from;
  const media = telegramMediaOf(message);
  const text = (message.text || message.caption || "").trim();
  if (!text && !media) {
    await tg.sendMessage(chatId, MESSAGES.invalidLink);
    return;
  }
  await upsertUser(env.DB, user);
  if (await isUserBlocked(env.DB, user.id)) {
    await tg.sendMessage(chatId, "\u{1F6AB} \u062F\u0633\u062A\u0631\u0633\u06CC \u0634\u0645\u0627 \u0628\u0647 \u0627\u06CC\u0646 \u0631\u0628\u0627\u062A \u0645\u0633\u062F\u0648\u062F \u0634\u062F\u0647 \u0627\u0633\u062A.");
    return;
  }
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
  if (command === "/lang") {
    const current = await getUserSubtitleLang(env.DB, user.id);
    await tg.sendMessage(chatId, `🌍 زبان فعلی زیرنویس شما: ${targetLangFaName(current)}\n\nزبان جدید را انتخاب کن:`, {
      reply_markup: langKeyboard(current)
    });
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
    const current = await getUserSubtitleLang(env.DB, user.id);
    await tg.sendMessage(chatId, `🎬 لینک ویدیو را بفرست (یوتیوب، تیک‌تاک، اینستاگرام، ایکس یا فیس‌بوک) تا زیرنویسش را به ${targetLangFaName(current)} ترجمه کنم.\nبعد از ارسال لینک، با دکمه‌ها انتخاب می‌کنی: فقط زیرنویس، فقط خلاصه یا هر دو.`);
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
  const { links, truncated } = parseAllSupportedUrls(text);
  if (!links.length) {
    if (media) {
      await handleMediaUpload({ env, tg, chatId, user, message, media });
      return;
    }
    const urlMatch = text.match(/https?:\/\/\S+|www\.\S+/i);
    if (urlMatch) {
      await logLinkEvent(env.DB, { user, url: urlMatch[0], outcome: "invalid" }, env.SUBTITLE_CACHE);
    }
    await tg.sendMessage(chatId, MESSAGES.invalidLink);
    return;
  }
  for (const link of links) {
    await logLinkEvent(env.DB, { user, url: link.canonicalUrl, outcome: "received" }, env.SUBTITLE_CACHE);
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
    await env.SUBTITLE_CACHE.put(`${tg.pendKeyPrefix || "pend:"}${token}`, JSON.stringify({
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
    const userLang = await getUserSubtitleLang(env.DB, user.id);
    const queued = await enqueueBatch(env, buildQueueMessage({ chatId, user, messageId: message.message_id, links, mode: "both", truncated, platform: tg.platform || "telegram", targetLang: userLang }));
    if (!queued) await runLinkBatch({ env, tg, chatId, user, message, links, mode: "both", targetLang: userLang });
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
// (setMyCommands). Only commands with a real handler above are listed:
// /settings is intentionally absent (no such feature). /lang sets the
// subtitle target language (added 2026-11-20).
var BOT_COMMANDS = [
  { command: "start", description: "شروع کار با ربات" },
  { command: "translate", description: "ترجمه زیرنویس ویدیو" },
  { command: "lang", description: "زبان زیرنویس" },
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
function buildQueueMessage({ chatId, user, messageId, links, mode, truncated, altSettings = null, generate = false, platform = "telegram", targetLang = null, upload = null }) {
  return {
    chatId,
    user: { id: user.id, first_name: user.first_name || "", username: user.username || "" },
    messageId: messageId || null,
    links,
    mode: mode || "both",
    truncated: Boolean(truncated),
    // qid identifies this exact enqueue across queue redeliveries, so a
    // redelivered copy of the same message can be recognised and skipped
    // instead of delivering the same file twice.
    qid: makeChoiceToken() + makeChoiceToken(),
    // Platform is only recorded for non-Telegram batches, so Telegram
    // queue payloads stay byte-identical to before; the consumer picks
    // the reply client from this field (default: telegram).
    ...platform && platform !== "telegram" ? { platform } : {},
    // The job's target language is recorded only when the caller pinned
    // one (a /lang choice at tap time, or a retranslate/generate offer
    // preserving the original job's language); when absent the consumer
    // resolves the user's stored preference, as before.
    ...targetLang ? { lang: normalizeTargetLang(targetLang) } : {},
    ...altSettings ? { alt: altSettings } : {},
    ...generate ? { gen: true } : {},
    // Upload jobs carry a Telegram file_id reference instead of links;
    // the consumer downloads the bytes (webhook executions are too short
    // for a 20 MB download). Absent for link jobs, as with the others.
    ...upload ? { upload } : {}
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
async function runQueuedBatch(env, tg, body) {
  if (body?.upload && body.upload.fileId && body.upload.token) {
    await runUploadJob({ env, tg, chatId: body.chatId, user: body.user, message: { message_id: body.messageId }, upload: body.upload, mode: body.mode || "both", targetLang: body.lang || null, qid: body.qid || null });
    return;
  }
  if (!body || !Array.isArray(body.links) || !body.links.length) return;
  await runLinkBatch({ env, tg, chatId: body.chatId, user: body.user, message: { message_id: body.messageId }, links: body.links, mode: body.mode || "both", altSettings: body.alt || null, generate: Boolean(body.gen), qid: body.qid || null, targetLang: body.lang || null });
  if (body.truncated) {
    await tg.sendMessage(body.chatId, "\u2139\uFE0F \u0641\u0642\u0637 \u06F3 \u0644\u06CC\u0646\u06A9 \u0627\u0648\u0644 \u067E\u0631\u062F\u0627\u0632\u0634 \u0634\u062F\u061B \u0628\u0642\u06CC\u0647 \u0631\u0627 \u062C\u062F\u0627 \u0628\u0641\u0631\u0633\u062A\u06CC\u062F.");
  }
}
__name(runQueuedBatch, "runQueuedBatch");
async function runLinkBatch({ env, tg, chatId, user, message, links, mode, altSettings = null, generate = false, qid = null, targetLang = null }) {
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
    if (qid && env.SUBTITLE_CACHE) {
      try {
        if (await env.SUBTITLE_CACHE.get(`qdone:${qid}:${link.videoId}`)) {
          console.log(`[queue] skip already-processed link ${link.videoId} (qid ${qid})`);
          continue;
        }
      } catch {
      }
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
      maxPerHour,
      altSettings,
      skipCaches: Boolean(altSettings),
      generate,
      targetLang
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
    if (qid && env.SUBTITLE_CACHE) {
      try {
        await env.SUBTITLE_CACHE.put(`qdone:${qid}:${link.videoId}`, "1", { expirationTtl: 1800 });
      } catch {
      }
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
async function handleCallbackQuery(update, env, tg) {
  const cq = update?.callback_query;
  if (!cq || !cq.from || !cq.message || !cq.message.chat) {
    return;
  }
  const chatId = cq.message.chat.id;
  if (await isUserBlocked(env.DB, cq.from.id)) {
    await tg.answerCallbackQuery(cq.id, "\u{1F6AB} \u062F\u0633\u062A\u0631\u0633\u06CC \u0634\u0645\u0627 \u0645\u0633\u062F\u0648\u062F \u0634\u062F\u0647 \u0627\u0633\u062A.");
    return;
  }
  const retr = parseRetranslateCallbackData(cq.data);
  if (retr) {
    let saved = null;
    try {
      saved = await env.SUBTITLE_CACHE.get(`retr:${retr.token}`, "json");
    } catch (err) {
      console.error(`[retranslate] read failed: ${errName(err)}`);
    }
    if (!saved || !saved.videoId) {
      await tg.answerCallbackQuery(cq.id, "\u23F0 \u0627\u06CC\u0646 \u062F\u06A9\u0645\u0647 \u0645\u0646\u0642\u0636\u06CC \u0634\u062F\u0647\u061B \u0644\u06CC\u0646\u06A9 \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0641\u0631\u0633\u062A.");
      return;
    }
    if (Number(saved.userId) !== Number(cq.from.id)) {
      await tg.answerCallbackQuery(cq.id, "\u0627\u06CC\u0646 \u062F\u06A9\u0645\u0647 \u0628\u0631\u0627\u06CC \u0634\u0645\u0627 \u0646\u06CC\u0633\u062A.");
      return;
    }
    try {
      await env.SUBTITLE_CACHE.delete(`retr:${retr.token}`);
    } catch {
    }
    const nextSettings = nextRetranslateSettings({ provider: saved.provider, model: saved.model });
    await tg.answerCallbackQuery(cq.id, "\u{1F501} \u062A\u0631\u062C\u0645\u0647 \u062F\u0648\u0628\u0627\u0631\u0647 \u0634\u0631\u0648\u0639 \u0634\u062F");
    await upsertUser(env.DB, cq.from);
    const botEnabled2 = await getSetting(env.DB, "bot_enabled", "true");
    if (botEnabled2 === "false") {
      await tg.sendMessage(chatId, MESSAGES.botDisabled);
      return;
    }
    await tg.editMessageText(chatId, cq.message.message_id, "\u{1F501} \u062A\u0631\u062C\u0645\u0647 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0627 \u0645\u062F\u0644 \u062F\u06CC\u06AF\u0631 \u0634\u0631\u0648\u0639 \u0634\u062F\n\u23F3 \u062F\u0631 \u062D\u0627\u0644 \u067E\u0631\u062F\u0627\u0632\u0634...", {
      reply_markup: { inline_keyboard: [] }
    });
    const retrLinks = [{ videoId: saved.videoId, canonicalUrl: saved.canonicalUrl || `https://www.youtube.com/watch?v=${saved.videoId}` }];
    const retrMode = saved.mode === "both" ? "both" : "srt";
    const queued2 = await enqueueBatch(env, buildQueueMessage({ chatId, user: cq.from, messageId: cq.message.message_id, links: retrLinks, mode: retrMode, truncated: false, altSettings: nextSettings, platform: tg.platform || "telegram", targetLang: saved.targetLang || null }));
    if (!queued2) {
      const message = { message_id: cq.message.message_id };
      await runLinkBatch({ env, tg, chatId, user: cq.from, message, links: retrLinks, mode: retrMode, altSettings: nextSettings, targetLang: saved.targetLang || null });
    }
    return;
  }
  const gen = parseGenerateCallbackData(cq.data);
  if (gen) {
    let saved = null;
    try {
      saved = await env.SUBTITLE_CACHE.get(`gen:${gen.token}`, "json");
    } catch (err) {
      console.error(`[generate] read failed: ${errName(err)}`);
    }
    if (!saved || !saved.videoId) {
      await tg.answerCallbackQuery(cq.id, "⏰ این دکمه منقضی شده؛ لینک را دوباره بفرست.");
      return;
    }
    if (Number(saved.userId) !== Number(cq.from.id)) {
      await tg.answerCallbackQuery(cq.id, "این دکمه برای شما نیست.");
      return;
    }
    try {
      await env.SUBTITLE_CACHE.delete(`gen:${gen.token}`);
    } catch {
    }
    await tg.answerCallbackQuery(cq.id, "🎙 ساخت زیرنویس شروع شد");
    await upsertUser(env.DB, cq.from);
    const botEnabled3 = await getSetting(env.DB, "bot_enabled", "true");
    if (botEnabled3 === "false") {
      await tg.sendMessage(chatId, MESSAGES.botDisabled);
      return;
    }
    await tg.editMessageText(chatId, cq.message.message_id, "🎙 ساخت زیرنویس با هوش مصنوعی شروع شد\n⏳ در حال پردازش...", {
      reply_markup: { inline_keyboard: [] }
    });
    const genLinks = [{ videoId: saved.videoId, canonicalUrl: saved.canonicalUrl || `https://www.youtube.com/watch?v=${saved.videoId}` }];
    const genMode = saved.mode === "both" || saved.mode === "sum" ? saved.mode : "srt";
    const queued3 = await enqueueBatch(env, buildQueueMessage({ chatId, user: cq.from, messageId: cq.message.message_id, links: genLinks, mode: genMode, truncated: false, generate: true, platform: tg.platform || "telegram", targetLang: saved.targetLang || null }));
    if (!queued3) {
      const message = { message_id: cq.message.message_id };
      await runLinkBatch({ env, tg, chatId, user: cq.from, message, links: genLinks, mode: genMode, generate: true, targetLang: saved.targetLang || null });
    }
    return;
  }
  const langPick = /^l:([a-z]{2})$/.exec(String(cq.data || ""));
  if (langPick && Object.prototype.hasOwnProperty.call(TARGET_LANGS, langPick[1])) {
    // /lang pick: persist the tapper's subtitle language and confirm in
    // place. No KV state is involved, so there is nothing to expire and
    // nothing another user could replay against a different account —
    // the setting always applies to cq.from, the person who tapped.
    const tgt = await setUserSubtitleLang(env.DB, cq.from.id, langPick[1]);
    await tg.answerCallbackQuery(cq.id, `✅ زبان زیرنویس: ${targetLangFaName(tgt)}`);
    await tg.editMessageText(chatId, cq.message.message_id, `🌍 زبان زیرنویس شما: ${targetLangFaName(tgt)}\n\nاز این به بعد، زیرنویس‌ها به این زبان ساخته می‌شوند. برای تغییر دوباره، /lang را بفرست.`, {
      reply_markup: { inline_keyboard: [] }
    });
    return;
  }
  const parsed = parseChoiceCallbackData(cq.data);
  if (!parsed) {
    await tg.answerCallbackQuery(cq.id);
    return;
  }
  let pending = null;
  try {
    pending = await env.SUBTITLE_CACHE.get(`${tg.pendKeyPrefix || "pend:"}${parsed.token}`, "json");
  } catch (err) {
    console.error(`[choice] pending read failed: ${errName(err)}`);
  }
  const hasLinks = Array.isArray(pending?.links) && pending.links.length > 0;
  if (!pending || (!hasLinks && !pending.upload)) {
    await tg.answerCallbackQuery(cq.id, "\u23F0 \u0627\u06CC\u0646 \u0627\u0646\u062A\u062E\u0627\u0628 \u0645\u0646\u0642\u0636\u06CC \u0634\u062F\u0647\u061B \u0644\u06CC\u0646\u06A9 \u0631\u0627 \u062F\u0648\u0628\u0627\u0631\u0647 \u0628\u0641\u0631\u0633\u062A.");
    return;
  }
  if (Number(pending.userId) !== Number(cq.from.id)) {
    await tg.answerCallbackQuery(cq.id, "\u0627\u06CC\u0646 \u062F\u06A9\u0645\u0647 \u0628\u0631\u0627\u06CC \u0634\u0645\u0627 \u0646\u06CC\u0633\u062A.");
    return;
  }
  try {
    await env.SUBTITLE_CACHE.delete(`${tg.pendKeyPrefix || "pend:"}${parsed.token}`);
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
  const userLang = await getUserSubtitleLang(env.DB, cq.from.id);
  if (pending.upload) {
    const queuedU = await enqueueBatch(env, buildQueueMessage({ chatId, user: cq.from, messageId: pending.linkMessageId, links: [], mode: parsed.mode, truncated: false, platform: tg.platform || "telegram", targetLang: userLang, upload: pending.upload }));
    if (!queuedU) {
      const message = { message_id: pending.linkMessageId };
      await runUploadJob({ env, tg, chatId, user: cq.from, message, upload: pending.upload, mode: parsed.mode, targetLang: userLang });
    }
    return;
  }
  const queued = await enqueueBatch(env, buildQueueMessage({ chatId, user: cq.from, messageId: pending.linkMessageId, links: pending.links, mode: parsed.mode, truncated: pending.truncated, platform: tg.platform || "telegram", targetLang: userLang }));
  if (!queued) {
    // Queue binding unavailable: fall back to inline processing so the
    // request is not lost (short jobs still finish inside the limit).
    const message = { message_id: pending.linkMessageId };
    await runLinkBatch({ env, tg, chatId, user: cq.from, message, links: pending.links, mode: parsed.mode, targetLang: userLang });
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

// src/rubika/handlers.js
// Rubika updates are normalized into the exact shapes the Telegram flow
// already handles, so commands, the choice prompt, buttons, jobs and
// stats are all shared code — only the client (rb) and the synthetic
// uid differ. Rubika chat ids map to uids via resolvePlatformUid.
async function routeRubikaUpdate(update, env, rb) {
  const n = normalizeRubikaUpdate(update);
  if (!n) return;
  const uid = await resolvePlatformUid(env.DB, "rubika", n.chatId);
  if (uid == null) {
    console.error("[rubika] could not resolve uid for chat");
    return;
  }
  const user = { id: uid, first_name: "", username: null };
  if (n.kind === "start") {
    await upsertUser(env.DB, user);
    if (await isUserBlocked(env.DB, uid)) {
      await rb.sendMessage(n.chatId, "🚫 دسترسی شما به این ربات مسدود شده است.");
      return;
    }
    await rb.sendMessage(n.chatId, MESSAGES.welcome(""));
    return;
  }
  const tgUpdate = {
    message: {
      chat: { id: n.chatId },
      from: user,
      text: n.text,
      message_id: n.messageId
    }
  };
  return handleTelegramUpdate(tgUpdate, env, rb);
}
__name(routeRubikaUpdate, "routeRubikaUpdate");
async function routeRubikaInline(inlineMessage, env, rb) {
  const n = normalizeRubikaInline(inlineMessage);
  if (!n) return;
  const uid = await resolvePlatformUid(env.DB, "rubika", n.chatId);
  if (uid == null) {
    console.error("[rubika] could not resolve uid for inline chat");
    return;
  }
  const user = { id: uid, first_name: "", username: null };
  // A Rubika inline tap carries exactly what the shared callback handler
  // needs: who tapped, in which chat, on which message, which button.
  const cqUpdate = {
    callback_query: {
      id: "",
      from: user,
      message: { chat: { id: n.chatId }, message_id: n.messageId },
      data: n.buttonId
    }
  };
  return handleCallbackQuery(cqUpdate, env, rb);
}
__name(routeRubikaInline, "routeRubikaInline");
async function handleRubikaWebhook(request, env, ctx, url) {
  // Rubika webhooks have no secret header, so the secret lives in the
  // path: /rubika/<32 hex>/<update|inline>. Anything else is a 404 and
  // the handler fails closed when the secret is not configured.
  const m = /^\/rubika\/([a-f0-9]{32})\/(update|inline)$/.exec(url.pathname);
  if (!m || !env.RUBIKA_WEBHOOK_SECRET || !timingSafeEqualStr(m[1], env.RUBIKA_WEBHOOK_SECRET)) {
    return new Response("Not Found", { status: 404 });
  }
  if (!env.RUBIKA_BOT_TOKEN) {
    console.error("Missing RUBIKA_BOT_TOKEN.");
    return new Response("Server misconfigured: missing bot token", { status: 500 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const rb = createRubikaClient(env.RUBIKA_BOT_TOKEN);
  if (m[2] === "update") {
    ctx.waitUntil(
      routeRubikaUpdate(body?.update, env, rb).catch((err) => {
        console.error("[rubika] update error:", sanitizeErrorMessage(err));
      })
    );
  } else {
    ctx.waitUntil(
      routeRubikaInline(body?.inline_message, env, rb).catch((err) => {
        console.error("[rubika] inline error:", sanitizeErrorMessage(err));
      })
    );
  }
  return Response.json({ status: "OK" });
}
__name(handleRubikaWebhook, "handleRubikaWebhook");

// src/index.js
var VIDEO_ID_RE2 = /^[A-Za-z0-9_-]{11}$/;
// === ADMIN ASSETS BEGIN (generated by build_admin_assets.py from admin_src/ - do not edit by hand) ===
const ADMIN_HTML = "<!DOCTYPE html>\n<html lang=\"fa\" dir=\"rtl\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>\u067e\u0646\u0644 \u0645\u062f\u06cc\u0631\u06cc\u062a SubTube</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700;800&display=swap\">\n<link rel=\"stylesheet\" href=\"/admin/app.css\">\n</head>\n<body>\n<div id=\"app\"><div class=\"boot\">\u2026</div></div>\n<script src=\"/admin/app.js\"></script>\n</body>\n</html>\n";
const ADMIN_CSS = ":root{\n  --bg:#0d1117; --bg2:#111826; --surface:#161e2e; --surface2:#1c2639; --surface3:#232f47;\n  --border:#26314a; --text:#e8edf6; --muted:#93a1bb; --faint:#5d6c88;\n  --accent:#7c6cf0; --accent2:#2dd4bf; --danger:#f87171; --warn:#fbbf24; --ok:#34d399;\n  --radius:14px;\n  --grad:linear-gradient(135deg,#7c6cf0,#2dd4bf);\n}\n*{box-sizing:border-box}\nhtml,body{margin:0;padding:0}\nbody{background:var(--bg);color:var(--text);font-family:\"Vazirmatn\",Tahoma,\"Segoe UI\",system-ui,sans-serif;font-size:14px;line-height:1.7}\na{color:var(--accent2);text-decoration:none}\nbutton{font-family:inherit;cursor:pointer}\ninput,select{font-family:inherit}\nsvg.ic{width:20px;height:20px;flex:0 0 auto}\n.boot{display:flex;align-items:center;justify-content:center;height:100vh;color:var(--muted);font-size:28px}\n\n/* ---------- brand ---------- */\n.brand{display:flex;align-items:center;gap:10px;font-size:19px;font-weight:800;padding:2px 10px 16px}\n.logo-mark{width:36px;height:36px;border-radius:10px;background:var(--grad);display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(124,108,240,.35)}\n.logo-mark svg{width:20px;height:20px}\n.brand .logo-accent{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}\n\n/* ---------- auth ---------- */\n.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:radial-gradient(900px 500px at 70% -10%,rgba(124,108,240,.18),transparent),radial-gradient(700px 400px at 10% 110%,rgba(45,212,191,.12),transparent),var(--bg)}\n.auth-card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:34px 30px;width:100%;max-width:400px;box-shadow:0 24px 60px rgba(0,0,0,.45)}\n.auth-logo{display:flex;flex-direction:column;align-items:center;gap:10px;font-size:26px;font-weight:800;margin-bottom:4px}\n.auth-logo .logo-mark{width:52px;height:52px;border-radius:14px}\n.auth-logo .logo-mark svg{width:28px;height:28px}\n.auth-logo .logo-accent{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}\n.auth-sub{text-align:center;color:var(--muted);margin:0 0 22px;font-size:13px}\n.field{margin-bottom:14px}\n.field label{display:block;margin-bottom:5px;color:var(--muted);font-size:13px}\n.field input{width:100%;height:42px;background:var(--bg);border:1px solid var(--border);border-radius:10px;color:var(--text);padding:10px 12px;font-size:14px;outline:none}\n.field input:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(124,108,240,.4)}\n.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--grad);color:#fff;border:none;border-radius:10px;padding:10px 18px;font-size:14px;font-weight:600;transition:opacity .15s,box-shadow .15s}\n.btn:hover{opacity:.92;box-shadow:0 6px 20px rgba(45,212,191,.25)}\n.btn:disabled{opacity:.5;cursor:default;box-shadow:none}\n.btn.block{width:100%}\n.btn.ghost{background:var(--surface2);color:var(--text);border:1px solid var(--border);font-weight:500;box-shadow:none}\n.btn.ghost:hover{background:var(--surface3)}\n.btn.danger{background:transparent;color:var(--danger);border:1px solid rgba(248,113,113,.4);font-weight:500;box-shadow:none}\n.btn.small{padding:5px 12px;font-size:12.5px;border-radius:8px}\n.auth-error{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.35);color:#fca5a5;border-radius:10px;padding:9px 12px;margin-bottom:14px;font-size:13px}\n.auth-note{color:var(--faint);font-size:12px;text-align:center;margin-top:14px}\n\n/* ---------- layout ---------- */\n.layout{display:flex;min-height:100vh}\n.sidebar{width:236px;flex:0 0 236px;background:var(--bg2);border-inline-end:1px solid var(--border);padding:20px 14px;display:flex;flex-direction:column;gap:4px;position:sticky;top:0;height:100vh}\n.nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;color:var(--muted);border:none;background:transparent;width:100%;text-align:start;font-size:14px;position:relative;transition:background .15s,color .15s}\n.nav-item:hover{background:var(--surface);color:var(--text)}\n.nav-item.active{background:var(--surface2);color:var(--text)}\n.nav-item.active::before{content:\"\";position:absolute;inset-inline-start:-14px;top:8px;bottom:8px;width:3px;border-radius:3px;background:var(--grad)}\n.sidebar .spacer{flex:1}\n.main{flex:1;min-width:0;padding:22px 26px 40px}\n.topbar{display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap}\n.topbar h1{font-size:20px;margin:0;font-weight:800}\n.topbar .spacer{flex:1}\n.search-box{display:flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:0 10px;height:40px}\n.search-box svg{width:17px;height:17px;color:var(--faint)}\n.search-box input{background:transparent;border:none;color:var(--text);padding:8px 2px;outline:none;width:180px;font-size:13.5px}\n.user-chip{color:var(--muted);font-size:13px}\n.icon-btn{display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--border);color:var(--muted);border-radius:10px;height:40px;padding:0 12px;font-size:13px}\n.icon-btn:hover{color:var(--text);background:var(--surface2)}\n.icon-btn svg{width:17px;height:17px}\n\n/* ---------- bottom navigation (mobile) ---------- */\n.bottomnav{display:none}\n@media (max-width:900px){\n  .bottomnav{display:flex;position:fixed;bottom:0;inset-inline:0;z-index:60;background:rgba(22,30,46,.95);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-top:1px solid var(--border);padding:6px 4px calc(6px + env(safe-area-inset-bottom));justify-content:space-around;box-shadow:0 -4px 24px rgba(0,0,0,.45)}\n  .bottomnav button{display:flex;flex-direction:column;align-items:center;gap:2px;background:transparent;border:none;color:var(--faint);font-size:11px;padding:5px 4px;min-width:58px;border-radius:12px;position:relative}\n  .bottomnav button svg{width:22px;height:22px}\n  .bottomnav button.active{color:var(--text)}\n  .bottomnav button.active::before{content:\"\";position:absolute;top:-6px;width:22px;height:3px;border-radius:3px;background:var(--grad)}\n  .bottomnav button.active svg{color:var(--accent2)}\n}\n\n/* ---------- cards & tables ---------- */\n.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:22px}\n.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;transition:background .15s}\n.card:hover{background:var(--surface2)}\n.card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}\n.card .card-label{color:var(--muted);font-size:12.5px}\n.card .card-value{font-size:27px;font-weight:800;line-height:1.35;margin-top:6px}\n.card .card-value.ok{color:var(--ok)} .card .card-value.bad{color:var(--danger)} .card .card-value.warn{color:var(--warn)}\n.icon-chip{width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:rgba(124,108,240,.14);color:#b3a8ff}\n.icon-chip svg{width:18px;height:18px}\n.icon-chip.teal{background:rgba(45,212,191,.13);color:var(--accent2)}\n.icon-chip.ok{background:rgba(52,211,153,.12);color:var(--ok)}\n.icon-chip.bad{background:rgba(248,113,113,.12);color:var(--danger)}\n.icon-chip.warn{background:rgba(251,191,36,.12);color:var(--warn)}\n.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-bottom:20px}\n.panel h2{margin:0 0 14px;font-size:16px;font-weight:700}\ntable{width:100%;border-collapse:collapse;font-size:13.5px}\nth,td{padding:9px 10px;text-align:start;border-bottom:1px solid var(--border);vertical-align:top}\nth{color:var(--muted);font-weight:600;font-size:12.5px;white-space:nowrap}\ntr:last-child td{border-bottom:none}\ntbody tr:hover{background:rgba(255,255,255,.02)}\n.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 11px;border-radius:999px;font-size:12px;white-space:nowrap}\n.badge .dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}\n.badge.completed{background:rgba(52,211,153,.12);color:var(--ok)}\n.badge.failed{background:rgba(248,113,113,.12);color:var(--danger)}\n.badge.processing{background:rgba(251,191,36,.12);color:var(--warn)}\n.badge.blocked{background:rgba(248,113,113,.12);color:var(--danger)}\n.user-cell{display:flex;align-items:center;gap:10px}\n.avatar{width:34px;height:34px;border-radius:50%;background:var(--grad);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex:0 0 auto;text-transform:uppercase}\n.muted{color:var(--muted)} .faint{color:var(--faint)} .small{font-size:12.5px}\n.err-text{color:#fca5a5;font-size:12.5px;max-width:340px;word-break:break-word}\n.link-text{word-break:break-all;direction:ltr;text-align:end}\n.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}\n.toolbar select,.toolbar input[type=\"text\"]{background:var(--bg);border:1px solid var(--border);border-radius:10px;color:var(--text);padding:8px 11px;font-size:13.5px;outline:none;height:40px}\n.toolbar select:focus,.toolbar input[type=\"text\"]:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(124,108,240,.4)}\n.pager{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:16px}\n.pager button{background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 14px}\n.pager button:disabled{opacity:.4;cursor:default}\n.tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}\n.tab{background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:999px;padding:6px 16px;font-size:13px}\n.tab.active{color:var(--text);border-color:var(--accent);background:rgba(124,108,240,.15)}\n.empty{color:var(--faint);text-align:center;padding:26px 0}\n.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}\n.chart-wrap{overflow-x:auto}\n.notice{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);color:#fcd34d;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px}\n\n@media (max-width:900px){\n  .layout{flex-direction:column}\n  .sidebar{width:100%;flex:none;height:auto;position:static;flex-direction:row;align-items:center;border-inline-end:none;border-bottom:1px solid var(--border);padding:10px 14px}\n  .sidebar .brand{padding:0}\n  .sidebar .nav-item,.sidebar .spacer{display:none}\n  .main{padding:16px 14px 110px}\n  .grid2{grid-template-columns:1fr}\n  .search-box input{width:120px}\n}\n\n/* tables become stacked cards on small screens */\n@media (max-width:700px){\n  .table-scroll{overflow:visible}\n  .table-scroll table,.table-scroll tbody,.table-scroll tr,.table-scroll td{display:block;width:100%}\n  .table-scroll thead{display:none}\n  .table-scroll tr{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin-bottom:12px}\n  .table-scroll td{border-bottom:1px dashed rgba(38,49,74,.7);padding:7px 0;display:flex;align-items:flex-start;justify-content:space-between;gap:14px}\n  .table-scroll td:last-child{border-bottom:none}\n  .table-scroll td::before{content:attr(data-label);color:var(--faint);font-size:12px;white-space:nowrap;padding-top:1px}\n  .table-scroll td .cell-v{text-align:end;min-width:0}\n  .err-text{max-width:none}\n}\n";
const ADMIN_JS = "\"use strict\";\n/* SubTube admin panel \u2014 framework-free SPA. All data comes from the\n   authenticated /admin/api endpoints; nothing sensitive lives here. */\n\nconst I18N = {\n  fa: {\n    panelTitle: \"\u067e\u0646\u0644 \u0645\u062f\u06cc\u0631\u06cc\u062a\", dashboard: \"\u062f\u0627\u0634\u0628\u0648\u0631\u062f\", activity: \"\u06af\u0632\u0627\u0631\u0634 \u0641\u0639\u0627\u0644\u06cc\u062a\", users: \"\u06a9\u0627\u0631\u0628\u0631\u0627\u0646\",\n    translations: \"\u062a\u0631\u062c\u0645\u0647\u200c\u0647\u0627\", links: \"\u062a\u062d\u0644\u06cc\u0644 \u0644\u06cc\u0646\u06a9\u200c\u0647\u0627\", logout: \"\u062e\u0631\u0648\u062c\", refresh: \"\u0628\u0647\u200c\u0631\u0648\u0632\u0631\u0633\u0627\u0646\u06cc\",\n    searchPlaceholder: \"\u062c\u0633\u062a\u062c\u0648\u06cc \u0633\u0631\u06cc\u0639\u2026\", search: \"\u062c\u0633\u062a\u062c\u0648\",\n    totalUsers: \"\u06a9\u0644 \u06a9\u0627\u0631\u0628\u0631\u0627\u0646\", activeToday: \"\u0641\u0639\u0627\u0644 \u0627\u0645\u0631\u0648\u0632\", totalRequests: \"\u06a9\u0644 \u062f\u0631\u062e\u0648\u0627\u0633\u062a\u200c\u0647\u0627\",\n    completed: \"\u0645\u0648\u0641\u0642\", failed: \"\u0646\u0627\u0645\u0648\u0641\u0642\", processing: \"\u062f\u0631 \u062d\u0627\u0644 \u0627\u0646\u062c\u0627\u0645\", linksToday: \"\u0644\u06cc\u0646\u06a9\u200c\u0647\u0627\u06cc \u0627\u0645\u0631\u0648\u0632\",\n    last14: \"\u062f\u0631\u062e\u0648\u0627\u0633\u062a\u200c\u0647\u0627\u06cc \u06f1\u06f4 \u0631\u0648\u0632 \u0627\u062e\u06cc\u0631\", recentActivity: \"\u0622\u062e\u0631\u06cc\u0646 \u0641\u0639\u0627\u0644\u06cc\u062a\u200c\u0647\u0627\",\n    user: \"\u06a9\u0627\u0631\u0628\u0631\", link: \"\u0644\u06cc\u0646\u06a9\", source: \"\u0645\u0646\u0628\u0639\", status: \"\u0648\u0636\u0639\u06cc\u062a\", model: \"\u0645\u062f\u0644 / \u0633\u0631\u0648\u06cc\u0633\",\n    cues: \"\u0632\u06cc\u0631\u0646\u0648\u06cc\u0633\", duration: \"\u0645\u062f\u062a\", time: \"\u0632\u0645\u0627\u0646\", error: \"\u062e\u0637\u0627\",\n    all: \"\u0647\u0645\u0647\", prev: \"\u0642\u0628\u0644\u06cc\", next: \"\u0628\u0639\u062f\u06cc\", pageOf: (p, n) => `\u0635\u0641\u062d\u0647 ${p} \u0627\u0632 ${n}`,\n    noData: \"\u062f\u0627\u062f\u0647\u200c\u0627\u06cc \u0646\u06cc\u0633\u062a\", firstSeen: \"\u0627\u0648\u0644\u06cc\u0646 \u0641\u0639\u0627\u0644\u06cc\u062a\", lastSeen: \"\u0622\u062e\u0631\u06cc\u0646 \u0641\u0639\u0627\u0644\u06cc\u062a\",\n    requests: \"\u062f\u0631\u062e\u0648\u0627\u0633\u062a\u200c\u0647\u0627\", actions: \"\u0639\u0645\u0644\u06cc\u0627\u062a\", history: \"\u062a\u0627\u0631\u06cc\u062e\u0686\u0647\", block: \"\u0645\u0633\u062f\u0648\u062f \u06a9\u0646\", unblock: \"\u0631\u0641\u0639 \u0645\u0633\u062f\u0648\u062f\u06cc\",\n    blocked: \"\u0645\u0633\u062f\u0648\u062f\", back: \"\u0628\u0627\u0632\u06af\u0634\u062a\", userActivity: (u) => `\u062a\u0627\u0631\u06cc\u062e\u0686\u0647 \u062f\u0631\u062e\u0648\u0627\u0633\u062a\u200c\u0647\u0627\u06cc ${u}`,\n    receivedLinks: \"\u0644\u06cc\u0646\u06a9\u200c\u0647\u0627\u06cc \u062f\u0631\u06cc\u0627\u0641\u062a\u06cc\", invalidLinks: \"\u0644\u06cc\u0646\u06a9\u200c\u0647\u0627\u06cc \u0646\u0627\u0645\u0639\u062a\u0628\u0631\", topDomains: \"\u062f\u0627\u0645\u0646\u0647\u200c\u0647\u0627\u06cc \u067e\u0631\u062a\u06a9\u0631\u0627\u0631\",\n    bySource: \"\u0628\u0647 \u062a\u0641\u06a9\u06cc\u06a9 \u0645\u0646\u0628\u0639\", domain: \"\u062f\u0627\u0645\u0646\u0647\", count: \"\u062a\u0639\u062f\u0627\u062f\", outcome: \"\u0646\u062a\u06cc\u062c\u0647\",\n    received: \"\u062f\u0631\u06cc\u0627\u0641\u062a\u200c\u0634\u062f\u0647\", invalid: \"\u0646\u0627\u0645\u0639\u062a\u0628\u0631\",\n    login: \"\u0648\u0631\u0648\u062f\", username: \"\u0646\u0627\u0645 \u06a9\u0627\u0631\u0628\u0631\u06cc\", password: \"\u0631\u0645\u0632 \u0639\u0628\u0648\u0631\", loginSub: \"\u0648\u0631\u0648\u062f \u0645\u062f\u06cc\u0631 \u0631\u0628\u0627\u062a SubTube\",\n    badCreds: \"\u0646\u0627\u0645 \u06a9\u0627\u0631\u0628\u0631\u06cc \u06cc\u0627 \u0631\u0645\u0632 \u0639\u0628\u0648\u0631 \u0627\u0634\u062a\u0628\u0627\u0647 \u0627\u0633\u062a.\", tooMany: \"\u062a\u0644\u0627\u0634\u200c\u0647\u0627\u06cc \u0646\u0627\u0645\u0648\u0641\u0642 \u0632\u06cc\u0627\u062f \u0634\u062f\u061b \u0686\u0646\u062f \u062f\u0642\u06cc\u0642\u0647 \u062f\u06cc\u06af\u0631 \u062f\u0648\u0628\u0627\u0631\u0647 \u062a\u0644\u0627\u0634 \u06a9\u0646.\",\n    sessionExpired: \"\u0646\u0634\u0633\u062a \u0634\u0645\u0627 \u062a\u0645\u0627\u0645 \u0634\u062f\u0647\u061b \u062f\u0648\u0628\u0627\u0631\u0647 \u0648\u0627\u0631\u062f \u0634\u0648.\", genericErr: \"\u062e\u0637\u0627\u06cc\u06cc \u0631\u062e \u062f\u0627\u062f\u061b \u062f\u0648\u0628\u0627\u0631\u0647 \u062a\u0644\u0627\u0634 \u06a9\u0646.\",\n    setupTitle: \"\u0631\u0627\u0647\u200c\u0627\u0646\u062f\u0627\u0632\u06cc \u0627\u0648\u0644\u06cc\u0647 \u0645\u062f\u06cc\u0631\", setupSub: \"\u0647\u0646\u0648\u0632 \u0645\u062f\u06cc\u0631 \u062a\u0639\u0631\u06cc\u0641 \u0646\u0634\u062f\u0647 \u0627\u0633\u062a. \u0646\u0627\u0645 \u06a9\u0627\u0631\u0628\u0631\u06cc \u0648 \u0631\u0645\u0632 \u0639\u0628\u0648\u0631 \u0645\u062f\u06cc\u0631 \u0631\u0627 \u0628\u0633\u0627\u0632.\",\n    setupBtn: \"\u0633\u0627\u062e\u062a\u0646 \u0645\u062f\u06cc\u0631 \u0648 \u0648\u0631\u0648\u062f\", passConfirm: \"\u062a\u06a9\u0631\u0627\u0631 \u0631\u0645\u0632 \u0639\u0628\u0648\u0631\", passMismatch: \"\u0631\u0645\u0632 \u0639\u0628\u0648\u0631 \u0648 \u062a\u06a9\u0631\u0627\u0631\u0634 \u06cc\u06a9\u06cc \u0646\u06cc\u0633\u062a\u0646\u062f.\",\n    weakPass: \"\u0631\u0645\u0632 \u0639\u0628\u0648\u0631 \u0628\u0627\u06cc\u062f \u062f\u0633\u062a\u200c\u06a9\u0645 \u06f1\u06f0 \u0646\u0648\u06cc\u0633\u0647 \u0628\u0627\u0634\u062f.\", badUsername: \"\u0646\u0627\u0645 \u06a9\u0627\u0631\u0628\u0631\u06cc \u0628\u0627\u06cc\u062f \u06f3 \u062a\u0627 \u06f3\u06f2 \u0646\u0648\u06cc\u0633\u0647 (\u062d\u0631\u0648\u0641 \u0627\u0646\u06af\u0644\u06cc\u0633\u06cc\u060c \u0639\u062f\u062f\u060c . _ -) \u0628\u0627\u0634\u062f.\",\n    linksNote: \"\u062b\u0628\u062a \u0644\u06cc\u0646\u06a9\u200c\u0647\u0627 \u0627\u0632 \u0632\u0645\u0627\u0646 \u0631\u0627\u0647\u200c\u0627\u0646\u062f\u0627\u0632\u06cc \u067e\u0646\u0644 \u0627\u0646\u062c\u0627\u0645 \u0645\u06cc\u200c\u0634\u0648\u062f\u061b \u0641\u0639\u0627\u0644\u06cc\u062a\u200c\u0647\u0627\u06cc \u0642\u0628\u0644\u06cc \u062f\u0631 \u06af\u0632\u0627\u0631\u0634 \u0641\u0639\u0627\u0644\u06cc\u062a (\u0628\u0631 \u0627\u0633\u0627\u0633 \u067e\u0631\u062f\u0627\u0632\u0634\u200c\u0647\u0627) \u062f\u06cc\u062f\u0647 \u0645\u06cc\u200c\u0634\u0648\u0646\u062f.\",\n    telegramId: \"\u0634\u0646\u0627\u0633\u0647 \u062a\u0644\u06af\u0631\u0627\u0645\"\n  },\n  en: {\n    panelTitle: \"Admin Panel\", dashboard: \"Dashboard\", activity: \"Activity\", users: \"Users\",\n    translations: \"Translations\", links: \"Link Analytics\", logout: \"Log out\", refresh: \"Refresh\",\n    searchPlaceholder: \"Quick search\u2026\", search: \"Search\",\n    totalUsers: \"Total users\", activeToday: \"Active today\", totalRequests: \"Total requests\",\n    completed: \"Successful\", failed: \"Failed\", processing: \"In progress\", linksToday: \"Links today\",\n    last14: \"Requests \u2014 last 14 days\", recentActivity: \"Recent activity\",\n    user: \"User\", link: \"Link\", source: \"Source\", status: \"Status\", model: \"Model / Service\",\n    cues: \"Cues\", duration: \"Duration\", time: \"Time\", error: \"Error\",\n    all: \"All\", prev: \"Prev\", next: \"Next\", pageOf: (p, n) => `Page ${p} of ${n}`,\n    noData: \"No data\", firstSeen: \"First seen\", lastSeen: \"Last active\",\n    requests: \"Requests\", actions: \"Actions\", history: \"History\", block: \"Block\", unblock: \"Unblock\",\n    blocked: \"Blocked\", back: \"Back\", userActivity: (u) => `Request history of ${u}`,\n    receivedLinks: \"Received links\", invalidLinks: \"Invalid links\", topDomains: \"Top domains\",\n    bySource: \"By source\", domain: \"Domain\", count: \"Count\", outcome: \"Outcome\",\n    received: \"Received\", invalid: \"Invalid\",\n    login: \"Log in\", username: \"Username\", password: \"Password\", loginSub: \"SubTube bot admin sign-in\",\n    badCreds: \"Wrong username or password.\", tooMany: \"Too many failed attempts; try again in a few minutes.\",\n    sessionExpired: \"Your session expired; please log in again.\", genericErr: \"Something went wrong; try again.\",\n    setupTitle: \"First-run admin setup\", setupSub: \"No admin exists yet. Create the admin username and password.\",\n    setupBtn: \"Create admin & log in\", passConfirm: \"Repeat password\", passMismatch: \"Passwords do not match.\",\n    weakPass: \"Password must be at least 10 characters.\", badUsername: \"Username must be 3\u201332 chars (letters, digits, . _ -).\",\n    linksNote: \"Links are recorded since the panel launched; earlier activity is visible in the Activity report (from processed jobs).\",\n    telegramId: \"Telegram ID\"\n  }\n};\n\nconst state = {\n  lang: localStorage.getItem(\"st_admin_lang\") || \"fa\",\n  csrf: \"\",\n  username: \"\",\n  view: \"dashboard\",\n  activity: { page: 1, status: \"\", q: \"\" },\n  translations: { page: 1, status: \"\" },\n  users: { page: 1, q: \"\" },\n  userDetail: null,\n  userActivity: { page: 1 },\n  notice: \"\"\n};\nconst PAGE_SIZE = 25;\nconst $app = document.getElementById(\"app\");\n\nconst ICON_PATHS = {\n  grid: '<rect x=\"3.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"1.6\"/><rect x=\"13.5\" y=\"3.5\" width=\"7\" height=\"7\" rx=\"1.6\"/><rect x=\"3.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"1.6\"/><rect x=\"13.5\" y=\"13.5\" width=\"7\" height=\"7\" rx=\"1.6\"/>',\n  list: '<path d=\"M9 6h11M9 12h11M9 18h11\"/><circle cx=\"4.5\" cy=\"6\" r=\"1.15\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"4.5\" cy=\"12\" r=\"1.15\" fill=\"currentColor\" stroke=\"none\"/><circle cx=\"4.5\" cy=\"18\" r=\"1.15\" fill=\"currentColor\" stroke=\"none\"/>',\n  group: '<circle cx=\"9\" cy=\"8.2\" r=\"3.4\"/><path d=\"M3.2 19.2c.7-3.1 3-4.7 5.8-4.7s5.1 1.6 5.8 4.7\"/><circle cx=\"17.2\" cy=\"9.2\" r=\"2.7\"/><path d=\"M16.4 14.6c2.2.3 3.7 1.7 4.2 4.1\"/>',\n  person: '<circle cx=\"12\" cy=\"8\" r=\"3.6\"/><path d=\"M5 20c.8-3.4 3.6-5.2 7-5.2s6.2 1.8 7 5.2\"/>',\n  captions: '<rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2.2\"/><path d=\"M6.8 12h4.2M6.8 15.4h7M13.8 12h3.4\"/>',\n  link: '<path d=\"M10.2 13.8a5 5 0 0 0 7 0l2.8-2.8a5 5 0 0 0-7-7l-1.6 1.6\"/><path d=\"M13.8 10.2a5 5 0 0 0-7 0L4 13a5 5 0 0 0 7 7l1.6-1.6\"/>',\n  search: '<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20.5 20.5-4-4\"/>',\n  refresh: '<path d=\"M20 12a8 8 0 1 1-2.34-5.66\"/><path d=\"M20.2 3.4v4h-4\"/>',\n  logout: '<path d=\"M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3\"/><path d=\"m16 17 5-5-5-5\"/><path d=\"M21 12H9\"/>',\n  globe: '<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M3 12h18\"/><path d=\"M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z\"/>',\n  film: '<rect x=\"3\" y=\"4\" width=\"18\" height=\"16\" rx=\"2.2\"/><path d=\"M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21\"/>',\n  check: '<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"m8.4 12.3 2.5 2.5 4.8-5.3\"/>',\n  xcross: '<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6\"/>',\n  clock: '<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5.2l3.4 2\"/>'\n};\nfunction icon(name) {\n  return `<svg class=\"ic\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">${ICON_PATHS[name] || \"\"}</svg>`;\n}\nconst LOGO_SVG = '<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M8.2 5.6v12.8c0 .9 1 1.5 1.8 1L19.4 13a1.15 1.15 0 0 0 0-2L10 4.6c-.8-.5-1.8.1-1.8 1Z\" fill=\"#fff\"/></svg>';\n\nfunction t(key, ...args) {\n  const v = I18N[state.lang][key] ?? I18N.fa[key] ?? key;\n  return typeof v === \"function\" ? v(...args) : v;\n}\nfunction esc(s) {\n  return String(s ?? \"\").replace(/[&<>\"']/g, (c) => ({ \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", '\"': \"&quot;\", \"'\": \"&#39;\" }[c]));\n}\nfunction num(n) {\n  return Number(n ?? 0).toLocaleString(state.lang === \"fa\" ? \"fa-IR\" : \"en-US\");\n}\nfunction fmtTime(iso) {\n  if (!iso) return \"\u2014\";\n  try {\n    return new Date(iso).toLocaleString(state.lang === \"fa\" ? \"fa-IR\" : \"en-GB\", { timeZone: \"Asia/Tehran\", dateStyle: \"medium\", timeStyle: \"short\" });\n  } catch { return iso; }\n}\nfunction fmtDuration(sec) {\n  if (sec == null) return \"\u2014\";\n  if (sec < 60) return state.lang === \"fa\" ? `${num(sec)} \u062b\u0627\u0646\u06cc\u0647` : `${sec}s`;\n  return `${num(Math.floor(sec / 60))}:${String(sec % 60).padStart(2, \"0\")}`;\n}\nfunction statusBadge(st) {\n  return `<span class=\"badge ${esc(st)}\"><span class=\"dot\"></span>${esc(t(st) || st)}</span>`;\n}\nfunction userLabel(r) {\n  const name = r.username ? \"@\" + r.username : (r.firstName || \"\u2014\");\n  const initial = esc(String(r.username || r.firstName || \"?\").trim().charAt(0) || \"?\");\n  return `<div class=\"user-cell\"><span class=\"avatar\">${initial}</span><span><div>${esc(name)}</div><div class=\"faint small\">${num(r.telegramId)}${r.firstName ? \" \u00b7 \" + esc(r.firstName) : \"\"}</div></span></div>`;\n}\n\nasync function api(path, opts = {}) {\n  const headers = { ...(opts.headers || {}) };\n  if (opts.method && opts.method !== \"GET\") {\n    headers[\"Content-Type\"] = \"application/json\";\n    if (state.csrf) headers[\"X-CSRF-Token\"] = state.csrf;\n  }\n  const res = await fetch(path, { ...opts, headers, credentials: \"same-origin\" });\n  let data = null;\n  try { data = await res.json(); } catch { }\n  if (res.status === 401 && !path.endsWith(\"/login\") && !path.endsWith(\"/setup\") && !path.endsWith(\"/me\")) {\n    state.notice = t(\"sessionExpired\");\n    renderAuth(false);\n    throw new Error(\"unauthorized\");\n  }\n  return { status: res.status, data };\n}\n\n/* ---------------- auth views ---------------- */\nfunction renderAuth(setupNeeded, errorMsg = \"\") {\n  document.documentElement.lang = state.lang;\n  document.documentElement.dir = state.lang === \"fa\" ? \"rtl\" : \"ltr\";\n  const isSetup = !!setupNeeded;\n  $app.innerHTML = `\n  <div class=\"auth-wrap\"><div class=\"auth-card\">\n    <div class=\"auth-logo\"><span class=\"logo-mark\">${LOGO_SVG}</span><span>Sub<span class=\"logo-accent\">Tube</span></span></div>\n    <p class=\"auth-sub\">${esc(isSetup ? t(\"setupTitle\") : t(\"loginSub\"))}</p>\n    ${state.notice ? `<div class=\"notice\">${esc(state.notice)}</div>` : \"\"}\n    ${errorMsg ? `<div class=\"auth-error\">${esc(errorMsg)}</div>` : \"\"}\n    <form id=\"auth-form\">\n      <div class=\"field\"><label>${esc(t(\"username\"))}</label><input id=\"auth-user\" autocomplete=\"username\" required></div>\n      <div class=\"field\"><label>${esc(t(\"password\"))}</label><input id=\"auth-pass\" type=\"password\" autocomplete=\"${isSetup ? \"new-password\" : \"current-password\"}\" required></div>\n      ${isSetup ? `<div class=\"field\"><label>${esc(t(\"passConfirm\"))}</label><input id=\"auth-pass2\" type=\"password\" autocomplete=\"new-password\" required></div>` : \"\"}\n      <button class=\"btn block\" type=\"submit\">${esc(isSetup ? t(\"setupBtn\") : t(\"login\"))}</button>\n    </form>\n    ${isSetup ? `<p class=\"auth-note\">${esc(t(\"setupSub\"))}</p>` : \"\"}\n  </div></div>`;\n  document.getElementById(\"auth-form\").addEventListener(\"submit\", async (e) => {\n    e.preventDefault();\n    const username = document.getElementById(\"auth-user\").value.trim();\n    const password = document.getElementById(\"auth-pass\").value;\n    if (isSetup) {\n      const pass2 = document.getElementById(\"auth-pass2\").value;\n      if (password.length < 10) return renderAuth(true, t(\"weakPass\"));\n      if (password !== pass2) return renderAuth(true, t(\"passMismatch\"));\n      const { status, data } = await api(\"/admin/api/setup\", { method: \"POST\", body: JSON.stringify({ username, password }) });\n      if (status === 201 && data?.ok) return enterApp(data);\n      const msg = data?.error === \"bad_username\" ? t(\"badUsername\") : data?.error === \"too_many_attempts\" ? t(\"tooMany\") : t(\"genericErr\");\n      return renderAuth(true, msg);\n    }\n    const { status, data } = await api(\"/admin/api/login\", { method: \"POST\", body: JSON.stringify({ username, password }) });\n    if (status === 200 && data?.ok) return enterApp(data);\n    const msg = data?.error === \"invalid_credentials\" ? t(\"badCreds\") : data?.error === \"too_many_attempts\" ? t(\"tooMany\") : data?.error === \"setup_required\" ? t(\"setupSub\") : t(\"genericErr\");\n    return renderAuth(false, msg);\n  });\n}\n\n/* ---------------- app shell ---------------- */\nfunction enterApp(sessionData) {\n  state.csrf = sessionData.csrf || state.csrf;\n  state.username = sessionData.username || state.username;\n  state.notice = \"\";\n  renderShell();\n  showView(\"dashboard\");\n}\nfunction renderShell() {\n  document.documentElement.lang = state.lang;\n  document.documentElement.dir = state.lang === \"fa\" ? \"rtl\" : \"ltr\";\n  const nav = [\n    [\"dashboard\", \"grid\", t(\"dashboard\")], [\"activity\", \"list\", t(\"activity\")], [\"users\", \"group\", t(\"users\")],\n    [\"translations\", \"captions\", t(\"translations\")], [\"links\", \"link\", t(\"links\")]\n  ];\n  $app.innerHTML = `\n  <div class=\"layout\">\n    <aside class=\"sidebar\">\n      <div class=\"brand\"><span class=\"logo-mark\">${LOGO_SVG}</span><span>Sub<span class=\"logo-accent\">Tube</span></span></div>\n      ${nav.map(([v, ic, label]) => `<button class=\"nav-item ${state.view === v ? \"active\" : \"\"}\" data-nav=\"${v}\">${icon(ic)} ${esc(label)}</button>`).join(\"\")}\n    </aside>\n    <main class=\"main\">\n      <div class=\"topbar\">\n        <h1 id=\"view-title\"></h1>\n        <div class=\"spacer\"></div>\n        <div class=\"search-box\">${icon(\"search\")}<input id=\"global-search\" placeholder=\"${esc(t(\"searchPlaceholder\"))}\"></div>\n        <span class=\"user-chip\">${esc(state.username)}</span>\n        <button class=\"icon-btn\" id=\"refresh-btn\" title=\"${esc(t(\"refresh\"))}\">${icon(\"refresh\")}</button>\n        <button class=\"icon-btn\" id=\"lang-toggle\">${icon(\"globe\")} ${state.lang === \"fa\" ? \"EN\" : \"\u0641\u0627\u0631\u0633\u06cc\"}</button>\n        <button class=\"icon-btn\" id=\"logout-btn\">${icon(\"logout\")} ${esc(t(\"logout\"))}</button>\n      </div>\n      <div id=\"view-body\"></div>\n    </main>\n    <nav class=\"bottomnav\">\n      ${nav.map(([v, ic, label]) => `<button class=\"${state.view === v ? \"active\" : \"\"}\" data-nav=\"${v}\">${icon(ic)}<span>${esc(label)}</span></button>`).join(\"\")}\n    </nav>\n  </div>`;\n  $app.querySelectorAll(\"[data-nav]\").forEach((b) => b.addEventListener(\"click\", () => showView(b.dataset.nav)));\n  document.getElementById(\"lang-toggle\").addEventListener(\"click\", () => {\n    state.lang = state.lang === \"fa\" ? \"en\" : \"fa\";\n    localStorage.setItem(\"st_admin_lang\", state.lang);\n    renderShell();\n    showView(state.view);\n  });\n  document.getElementById(\"logout-btn\").addEventListener(\"click\", async () => {\n    await api(\"/admin/api/logout\", { method: \"POST\", body: \"{}\" }).catch(() => { });\n    state.csrf = \"\"; state.username = \"\";\n    renderAuth(false);\n  });\n  document.getElementById(\"refresh-btn\").addEventListener(\"click\", () => showView(state.view));\n  const gs = document.getElementById(\"global-search\");\n  gs.addEventListener(\"keydown\", (e) => {\n    if (e.key === \"Enter\") {\n      state.activity.q = gs.value.trim();\n      state.activity.page = 1;\n      showView(\"activity\");\n    }\n  });\n}\n\nfunction showView(view) {\n  state.view = view;\n  state.userDetail = view === \"userDetail\" ? state.userDetail : (view === \"users\" ? null : state.userDetail);\n  $app.querySelectorAll(\"[data-nav]\").forEach((b) => b.classList.toggle(\"active\", b.dataset.nav === view));\n  const titles = { dashboard: t(\"dashboard\"), activity: t(\"activity\"), users: t(\"users\"), translations: t(\"translations\"), links: t(\"links\"), userDetail: t(\"history\") };\n  document.getElementById(\"view-title\").textContent = titles[view] || \"\";\n  const body = document.getElementById(\"view-body\");\n  body.innerHTML = `<div class=\"empty\">\u2026</div>`;\n  if (view === \"dashboard\") return viewDashboard(body);\n  if (view === \"activity\") return viewJobs(body, state.activity, \"activity\");\n  if (view === \"translations\") return viewJobs(body, state.translations, \"translations\");\n  if (view === \"users\") return viewUsers(body);\n  if (view === \"userDetail\") return viewUserDetail(body);\n  if (view === \"links\") return viewLinks(body);\n}\n\n/* ---------------- dashboard ---------------- */\nasync function viewDashboard(body) {\n  const [statsRes, chartRes, recentRes] = await Promise.all([\n    api(\"/admin/api/stats\"), api(\"/admin/api/chart\"), api(\"/admin/api/activity?pageSize=8\")\n  ]);\n  const s = statsRes.data || {};\n  const days = chartRes.data?.days || [];\n  const max = Math.max(1, ...days.map((d) => d.total));\n  const W = 700, H = 170, bw = W / Math.max(1, days.length);\n  const bars = days.map((d, i) => {\n    const x = i * bw + bw * 0.22, w = bw * 0.26;\n    const hT = (d.total / max) * (H - 34), hC = (d.completed / max) * (H - 34);\n    return `<rect x=\"${x}\" y=\"${H - 18 - hT}\" width=\"${w}\" height=\"${hT}\" rx=\"3\" fill=\"#7c6cf0\" opacity=\"0.55\"><title>${esc(d.date)} \u2014 ${esc(t(\"totalRequests\"))}: ${d.total}</title></rect>\n            <rect x=\"${x + w + 2}\" y=\"${H - 18 - hC}\" width=\"${w}\" height=\"${hC}\" rx=\"3\" fill=\"#2dd4bf\"><title>${esc(d.date)} \u2014 ${esc(t(\"completed\"))}: ${d.completed}</title></rect>\n            <text x=\"${x + w / 2}\" y=\"${H - 3}\" font-size=\"9.5\" fill=\"#5d6c88\" text-anchor=\"middle\">${esc(d.date.slice(5))}</text>`;\n  }).join(\"\");\n  body.innerHTML = `\n    <div class=\"cards\">\n      <div class=\"card\"><div class=\"card-top\"><span class=\"card-label\">${esc(t(\"totalUsers\"))}</span><span class=\"icon-chip\">${icon(\"group\")}</span></div><div class=\"card-value\">${num(s.totalUsers)}</div></div>\n      <div class=\"card\"><div class=\"card-top\"><span class=\"card-label\">${esc(t(\"activeToday\"))}</span><span class=\"icon-chip teal\">${icon(\"person\")}</span></div><div class=\"card-value\">${num(s.activeToday)}</div></div>\n      <div class=\"card\"><div class=\"card-top\"><span class=\"card-label\">${esc(t(\"totalRequests\"))}</span><span class=\"icon-chip\">${icon(\"film\")}</span></div><div class=\"card-value\">${num(s.totalRequests)}</div></div>\n      <div class=\"card\"><div class=\"card-top\"><span class=\"card-label\">${esc(t(\"completed\"))}</span><span class=\"icon-chip ok\">${icon(\"check\")}</span></div><div class=\"card-value ok\">${num(s.completed)}</div></div>\n      <div class=\"card\"><div class=\"card-top\"><span class=\"card-label\">${esc(t(\"failed\"))}</span><span class=\"icon-chip bad\">${icon(\"xcross\")}</span></div><div class=\"card-value bad\">${num(s.failed)}</div></div>\n      <div class=\"card\"><div class=\"card-top\"><span class=\"card-label\">${esc(t(\"processing\"))}</span><span class=\"icon-chip warn\">${icon(\"clock\")}</span></div><div class=\"card-value warn\">${num(s.processing)}</div></div>\n      <div class=\"card\"><div class=\"card-top\"><span class=\"card-label\">${esc(t(\"linksToday\"))}</span><span class=\"icon-chip teal\">${icon(\"link\")}</span></div><div class=\"card-value\">${num(s.linksToday)}</div></div>\n    </div>\n    <div class=\"panel\"><h2>${esc(t(\"last14\"))}</h2><div class=\"chart-wrap\"><svg viewBox=\"0 0 ${W} ${H}\" width=\"100%\" height=\"${H}\">${bars}</svg></div></div>\n    <div class=\"panel\"><h2>${esc(t(\"recentActivity\"))}</h2>${jobsTable(recentRes.data?.rows || [], true)}</div>`;\n}\n\nfunction jobsTable(rows, compact = false) {\n  if (!rows.length) return `<div class=\"empty\">${esc(t(\"noData\"))}</div>`;\n  return `<div class=\"table-scroll\"><table><thead><tr>\n    <th>${esc(t(\"user\"))}</th><th>${esc(t(\"link\"))}</th><th>${esc(t(\"source\"))}</th><th>${esc(t(\"status\"))}</th>\n    <th>${esc(t(\"model\"))}</th><th>${esc(t(\"cues\"))}</th><th>${esc(t(\"duration\"))}</th><th>${esc(t(\"time\"))}</th>${compact ? \"\" : `<th>${esc(t(\"error\"))}</th>`}\n  </tr></thead><tbody>\n  ${rows.map((r) => `<tr>\n    <td data-label=\"${esc(t(\"user\"))}\">${userLabel(r)}</td>\n    <td data-label=\"${esc(t(\"link\"))}\" class=\"link-text small\"><a href=\"${esc(r.videoUrl)}\" target=\"_blank\" rel=\"noopener\">${esc(r.domain || \"\")}/${esc(r.videoId || \"\")}</a></td>\n    <td data-label=\"${esc(t(\"source\"))}\">${esc(r.source || \"\u2014\")}</td>\n    <td data-label=\"${esc(t(\"status\"))}\">${statusBadge(r.status)}</td>\n    <td data-label=\"${esc(t(\"model\"))}\" class=\"small\">${esc(r.provider || \"\u2014\")}${r.model ? \" / \" + esc(r.model) : \"\"}</td>\n    <td data-label=\"${esc(t(\"cues\"))}\">${r.cueCount == null ? \"\u2014\" : num(r.cueCount)}</td>\n    <td data-label=\"${esc(t(\"duration\"))}\">${esc(fmtDuration(r.durationSec))}</td>\n    <td data-label=\"${esc(t(\"time\"))}\" class=\"small\">${esc(fmtTime(r.createdAt))}</td>\n    ${compact ? \"\" : `<td data-label=\"${esc(t(\"error\"))}\" class=\"err-text\">${esc(r.error || \"\")}</td>`}\n  </tr>`).join(\"\")}\n  </tbody></table></div>`;\n}\n\nfunction pagerHtml(page, total, pageSize) {\n  const pages = Math.max(1, Math.ceil(total / pageSize));\n  return `<div class=\"pager\">\n    <button data-pg=\"prev\" ${page <= 1 ? \"disabled\" : \"\"}>${esc(t(\"prev\"))}</button>\n    <span class=\"muted\">${esc(t(\"pageOf\", num(page), num(pages)))} \u00b7 ${num(total)}</span>\n    <button data-pg=\"next\" ${page >= pages ? \"disabled\" : \"\"}>${esc(t(\"next\"))}</button></div>`;\n}\nfunction bindPager(body, st, rerender) {\n  body.querySelectorAll(\"[data-pg]\").forEach((b) => b.addEventListener(\"click\", () => {\n    st.page += b.dataset.pg === \"next\" ? 1 : -1;\n    if (st.page < 1) st.page = 1;\n    rerender();\n  }));\n}\n\n/* ---------------- activity & translations ---------------- */\nasync function viewJobs(body, st, kind) {\n  const params = new URLSearchParams({ page: st.page, pageSize: PAGE_SIZE });\n  if (st.status) params.set(\"status\", st.status);\n  if (kind === \"activity\" && st.q) params.set(\"q\", st.q);\n  const { data } = await api(`/admin/api/${kind}?${params}`);\n  const rows = data?.rows || [];\n  const statusTabs = [\"\", \"completed\", \"failed\", \"processing\"];\n  body.innerHTML = `\n    <div class=\"tabs\">${statusTabs.map((s) => `<button class=\"tab ${st.status === s ? \"active\" : \"\"}\" data-st=\"${s}\">${esc(s === \"\" ? t(\"all\") : t(s))}</button>`).join(\"\")}</div>\n    ${kind === \"activity\" ? `<div class=\"toolbar\"><input type=\"text\" id=\"jobs-q\" placeholder=\"${esc(t(\"searchPlaceholder\"))}\" value=\"${esc(st.q)}\"><button class=\"btn ghost small\" id=\"jobs-search\">${esc(t(\"search\"))}</button></div>` : \"\"}\n    ${jobsTable(rows)}\n    ${pagerHtml(st.page, data?.total || 0, PAGE_SIZE)}`;\n  body.querySelectorAll(\"[data-st]\").forEach((b) => b.addEventListener(\"click\", () => { st.status = b.dataset.st; st.page = 1; viewJobs(body, st, kind); }));\n  const searchBtn = document.getElementById(\"jobs-search\");\n  if (searchBtn) searchBtn.addEventListener(\"click\", () => { st.q = document.getElementById(\"jobs-q\").value.trim(); st.page = 1; viewJobs(body, st, kind); });\n  bindPager(body, st, () => viewJobs(body, st, kind));\n}\n\n/* ---------------- users ---------------- */\nasync function viewUsers(body) {\n  const st = state.users;\n  const params = new URLSearchParams({ page: st.page, pageSize: PAGE_SIZE });\n  if (st.q) params.set(\"q\", st.q);\n  const { data } = await api(`/admin/api/users?${params}`);\n  const rows = data?.rows || [];\n  body.innerHTML = `\n    <div class=\"toolbar\"><input type=\"text\" id=\"users-q\" placeholder=\"${esc(t(\"searchPlaceholder\"))} (${esc(t(\"telegramId\"))} / @username)\" value=\"${esc(st.q)}\"><button class=\"btn ghost small\" id=\"users-search\">${esc(t(\"search\"))}</button></div>\n    ${rows.length ? `<div class=\"table-scroll\"><table><thead><tr>\n      <th>${esc(t(\"user\"))}</th><th>${esc(t(\"requests\"))}</th><th>${esc(t(\"completed\"))} / ${esc(t(\"failed\"))}</th>\n      <th>${esc(t(\"firstSeen\"))}</th><th>${esc(t(\"lastSeen\"))}</th><th>${esc(t(\"status\"))}</th><th>${esc(t(\"actions\"))}</th>\n    </tr></thead><tbody>\n    ${rows.map((u) => `<tr>\n      <td data-label=\"${esc(t(\"user\"))}\">${userLabel(u)}</td>\n      <td data-label=\"${esc(t(\"requests\"))}\">${num(u.totalJobs)}</td>\n      <td data-label=\"${esc(t(\"completed\"))} / ${esc(t(\"failed\"))}\">${num(u.successfulJobs)} / ${num(u.failedJobs)}</td>\n      <td data-label=\"${esc(t(\"firstSeen\"))}\" class=\"small\">${esc(fmtTime(u.createdAt))}</td>\n      <td data-label=\"${esc(t(\"lastSeen\"))}\" class=\"small\">${esc(fmtTime(u.lastActiveAt))}</td>\n      <td data-label=\"${esc(t(\"status\"))}\">${u.isBlocked ? `<span class=\"badge blocked\"><span class=\"dot\"></span>${esc(t(\"blocked\"))}</span>` : \"\u2014\"}</td>\n      <td data-label=\"${esc(t(\"actions\"))}\">\n        <button class=\"btn ghost small\" data-hist=\"${u.telegramId}\">${esc(t(\"history\"))}</button>\n        <button class=\"btn ${u.isBlocked ? \"ghost\" : \"danger\"} small\" data-block=\"${u.telegramId}\" data-state=\"${u.isBlocked ? \"1\" : \"0\"}\">${esc(u.isBlocked ? t(\"unblock\") : t(\"block\"))}</button>\n      </td></tr>`).join(\"\")}\n    </tbody></table></div>` : `<div class=\"empty\">${esc(t(\"noData\"))}</div>`}\n    ${pagerHtml(st.page, data?.total || 0, PAGE_SIZE)}`;\n  document.getElementById(\"users-search\").addEventListener(\"click\", () => { st.q = document.getElementById(\"users-q\").value.trim(); st.page = 1; viewUsers(body); });\n  body.querySelectorAll(\"[data-hist]\").forEach((b) => b.addEventListener(\"click\", () => {\n    const u = rows.find((x) => String(x.telegramId) === b.dataset.hist);\n    state.userDetail = u;\n    state.userActivity.page = 1;\n    showView(\"userDetail\");\n  }));\n  body.querySelectorAll(\"[data-block]\").forEach((b) => b.addEventListener(\"click\", async () => {\n    const blocked = b.dataset.state !== \"1\";\n    b.disabled = true;\n    const { status, data: d } = await api(`/admin/api/users/${b.dataset.block}/block`, { method: \"POST\", body: JSON.stringify({ blocked }) });\n    if (status === 200 && d?.ok) viewUsers(body); else { b.disabled = false; alert(t(\"genericErr\")); }\n  }));\n  bindPager(body, st, () => viewUsers(body));\n}\n\nasync function viewUserDetail(body) {\n  const u = state.userDetail;\n  if (!u) return showView(\"users\");\n  const st = state.userActivity;\n  const { data } = await api(`/admin/api/users/${u.telegramId}/activity?page=${st.page}&pageSize=${PAGE_SIZE}`);\n  body.innerHTML = `\n    <div class=\"toolbar\"><button class=\"btn ghost small\" id=\"back-users\">\u2190 ${esc(t(\"back\"))}</button>\n    <strong>${esc(t(\"userActivity\", u.username ? \"@\" + u.username : String(u.telegramId)))}</strong></div>\n    ${jobsTable(data?.rows || [])}\n    ${pagerHtml(st.page, data?.total || 0, PAGE_SIZE)}`;\n  document.getElementById(\"back-users\").addEventListener(\"click\", () => showView(\"users\"));\n  bindPager(body, st, () => viewUserDetail(body));\n}\n\n/* ---------------- links ---------------- */\nasync function viewLinks(body) {\n  const { data } = await api(\"/admin/api/links\");\n  const d = data || { bySource: [], topDomains: [], invalidRecent: [], totals: { received: 0, invalid: 0 } };\n  body.innerHTML = `\n    <div class=\"notice\">${esc(t(\"linksNote\"))}</div>\n    <div class=\"cards\">\n      <div class=\"card\"><div class=\"card-label\">${esc(t(\"receivedLinks\"))}</div><div class=\"card-value\">${num(d.totals.received)}</div></div>\n      <div class=\"card\"><div class=\"card-label\">${esc(t(\"invalidLinks\"))}</div><div class=\"card-value bad\">${num(d.totals.invalid)}</div></div>\n    </div>\n    <div class=\"grid2\">\n      <div class=\"panel\"><h2>${esc(t(\"bySource\"))}</h2>\n        ${d.bySource.length ? `<table><thead><tr><th>${esc(t(\"source\"))}</th><th>${esc(t(\"outcome\"))}</th><th>${esc(t(\"count\"))}</th></tr></thead><tbody>\n          ${d.bySource.map((r) => `<tr><td>${esc(r.source)}</td><td>${esc(t(r.outcome) || r.outcome)}</td><td>${num(r.count)}</td></tr>`).join(\"\")}\n        </tbody></table>` : `<div class=\"empty\">${esc(t(\"noData\"))}</div>`}\n      </div>\n      <div class=\"panel\"><h2>${esc(t(\"topDomains\"))}</h2>\n        ${d.topDomains.length ? `<table><thead><tr><th>${esc(t(\"domain\"))}</th><th>${esc(t(\"count\"))}</th></tr></thead><tbody>\n          ${d.topDomains.map((r) => `<tr><td>${esc(r.domain)}</td><td>${num(r.count)}</td></tr>`).join(\"\")}\n        </tbody></table>` : `<div class=\"empty\">${esc(t(\"noData\"))}</div>`}\n      </div>\n    </div>\n    <div class=\"panel\"><h2>${esc(t(\"invalidLinks\"))}</h2>\n      ${d.invalidRecent.length ? `<div class=\"table-scroll\"><table><thead><tr><th>${esc(t(\"user\"))}</th><th>${esc(t(\"link\"))}</th><th>${esc(t(\"time\"))}</th></tr></thead><tbody>\n        ${d.invalidRecent.map((r) => `<tr><td>${esc(r.username ? \"@\" + r.username : String(r.telegramId))}</td><td class=\"link-text small\">${esc(r.url)}</td><td class=\"small\">${esc(fmtTime(r.createdAt))}</td></tr>`).join(\"\")}\n      </tbody></table></div>` : `<div class=\"empty\">${esc(t(\"noData\"))}</div>`}\n    </div>`;\n}\n\n/* ---------------- boot ---------------- */\n(async function boot() {\n  const { status, data } = await api(\"/admin/api/me\");\n  if (status === 200 && data?.ok) return enterApp(data);\n  renderAuth(!!data?.setupNeeded);\n})();\n";
// === ADMIN ASSETS END ===
// ===== Admin panel backend (same Worker, routes under /admin) =====
// Security model:
// - The admin password is only ever stored as a PBKDF2-HMAC-SHA256 hash
//   (100k iterations, per-install random salt). It can come from the
//   Cloudflare secrets ADMIN_USERNAME + ADMIN_PASSWORD_HASH, or from a
//   one-time /admin setup flow that stores the same hash format in D1.
// - Sessions are random 256-bit tokens; only their SHA-256 hash is kept
//   in D1 (admin_sessions) with a fixed 12h expiry. The cookie is
//   HttpOnly + Secure + SameSite=Lax and scoped to Path=/admin.
// - Every /admin/api/* data endpoint requires a valid session; state-
//   changing calls additionally require the per-session CSRF token.
// - Login attempts are rate-limited per IP (admin_login_attempts).
// - All SQL is parameterized; list endpoints are paginated.
const ADMIN_SESSION_TTL_SEC = 12 * 3600;
const ADMIN_LOGIN_WINDOW_SEC = 15 * 60;
const ADMIN_LOGIN_MAX_FAILS = 5;
const ADMIN_COOKIE_NAME = "st_admin";
const ADMIN_DUMMY_HASH = "v1$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ADMIN_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
};
function adminJson(data, status = 200, extraHeaders = {}) {
  return Response.json(data, { status, headers: { ...ADMIN_SECURITY_HEADERS, ...extraHeaders } });
}
function adminText(body, contentType, status = 200) {
  return new Response(body, { status, headers: { ...ADMIN_SECURITY_HEADERS, "Content-Type": contentType } });
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
function randomHex(byteCount) {
  const a = new Uint8Array(byteCount);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(randomHex, "randomHex");
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
__name(bytesToB64, "bytesToB64");
function b64ToBytes(b64) {
  const s = atob(String(b64 || ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
__name(b64ToBytes, "b64ToBytes");
function timingSafeEqualBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
__name(timingSafeEqualBytes, "timingSafeEqualBytes");
async function hashAdminPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return `v1$100000$${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}
__name(hashAdminPassword, "hashAdminPassword");
async function verifyAdminPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 4 || parts[0] !== "v1") return false;
    const iterations = Math.max(1000, Math.min(600000, parseInt(parts[1], 10) || 0));
    const salt = b64ToBytes(parts[2]);
    const expected = b64ToBytes(parts[3]);
    if (!salt.length || expected.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
    return timingSafeEqualBytes(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}
__name(verifyAdminPassword, "verifyAdminPassword");
async function getAdminAuth(env) {
  if (env.ADMIN_USERNAME && env.ADMIN_PASSWORD_HASH) {
    return { username: String(env.ADMIN_USERNAME), hash: String(env.ADMIN_PASSWORD_HASH), source: "secret" };
  }
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'admin_auth' LIMIT 1`).first();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (parsed?.username && parsed?.hash) return { username: String(parsed.username), hash: String(parsed.hash), source: "db" };
    }
  } catch {
  }
  return null;
}
__name(getAdminAuth, "getAdminAuth");
function clientIp(request) {
  return (request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "").split(",")[0].trim().slice(0, 64);
}
__name(clientIp, "clientIp");
async function adminLoginFails(env, ip) {
  try {
    const since = Math.floor(Date.now() / 1000) - ADMIN_LOGIN_WINDOW_SEC;
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM admin_login_attempts WHERE ip = ?1 AND success = 0 AND attempted_at >= ?2`
    ).bind(ip, since).first();
    return Number(row?.cnt || 0);
  } catch {
    return 0;
  }
}
__name(adminLoginFails, "adminLoginFails");
async function recordLoginAttempt(env, ip, username, success) {
  try {
    await env.DB.prepare(
      `INSERT INTO admin_login_attempts (ip, username, success, attempted_at) VALUES (?1, ?2, ?3, ?4)`
    ).bind(ip, String(username || "").slice(0, 64), success ? 1 : 0, Math.floor(Date.now() / 1000)).run();
  } catch {
  }
}
__name(recordLoginAttempt, "recordLoginAttempt");
function adminSessionCookie(token, maxAge) {
  return `${ADMIN_COOKIE_NAME}=${token}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
__name(adminSessionCookie, "adminSessionCookie");
async function createAdminSession(env, request, username) {
  const token = randomHex(32);
  const csrf = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`DELETE FROM admin_sessions WHERE expires_at < ?1`).bind(now).run();
  await env.DB.prepare(
    `INSERT INTO admin_sessions (token_hash, csrf_token, username, created_at, expires_at, ip, user_agent) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(await sha256Hex(token), csrf, username, now, now + ADMIN_SESSION_TTL_SEC, clientIp(request), (request.headers.get("User-Agent") || "").slice(0, 200)).run();
  return { token, csrf };
}
__name(createAdminSession, "createAdminSession");
function parseCookieHeader(request) {
  const out = new Map();
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}
__name(parseCookieHeader, "parseCookieHeader");
async function getAdminSession(request, env) {
  try {
    const token = parseCookieHeader(request).get(ADMIN_COOKIE_NAME);
    if (!token) return null;
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      `SELECT token_hash, csrf_token, username, expires_at FROM admin_sessions WHERE token_hash = ?1 LIMIT 1`
    ).bind(await sha256Hex(token)).first();
    if (!row || Number(row.expires_at) <= now) return null;
    return row;
  } catch {
    return null;
  }
}
__name(getAdminSession, "getAdminSession");
function checkAdminCsrf(request, session) {
  const sent = request.headers.get("X-CSRF-Token") || "";
  if (!sent || !timingSafeEqualStr(sent, session.csrf_token)) return false;
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return false;
    } catch {
      return false;
    }
  }
  return true;
}
__name(checkAdminCsrf, "checkAdminCsrf");
function tehranDayStartIso(nowMs = Date.now()) {
  const tehran = new Date(nowMs + 3.5 * 3600 * 1000);
  const startUtcMs = Date.UTC(tehran.getUTCFullYear(), tehran.getUTCMonth(), tehran.getUTCDate()) - 3.5 * 3600 * 1000;
  return new Date(startUtcMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}
__name(tehranDayStartIso, "tehranDayStartIso");
function parsePageParams(url) {
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "25", 10) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
__name(parsePageParams, "parsePageParams");
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}
__name(escapeLike, "escapeLike");
function jobRowToApi(r) {
  const domain = extractDomain(r.video_url);
  let durationSec = null;
  if (r.created_at && r.completed_at) {
    const d = Math.round((Date.parse(r.completed_at) - Date.parse(r.created_at)) / 1000);
    if (Number.isFinite(d) && d >= 0) durationSec = d;
  }
  return {
    id: r.id,
    telegramId: r.telegram_id,
    username: r.username || null,
    firstName: r.first_name || null,
    videoUrl: r.video_url,
    videoId: r.video_id,
    domain,
    source: sourceFromDomain(domain),
    status: r.status,
    provider: r.provider || null,
    model: r.model || null,
    cueCount: r.cue_count == null ? null : Number(r.cue_count),
    error: r.error_message || null,
    createdAt: r.created_at,
    completedAt: r.completed_at || null,
    durationSec
  };
}
__name(jobRowToApi, "jobRowToApi");
async function queryJobsPage(env, { page, pageSize, offset, status = "", q = "", telegramId = null }) {
  const where = [];
  const binds = [];
  if (telegramId != null) { where.push("j.telegram_id = ?"); binds.push(Number(telegramId)); }
  if (status && ["processing", "completed", "failed"].includes(status)) { where.push("j.status = ?"); binds.push(status); }
  if (q) {
    const like = "%" + escapeLike(q) + "%";
    where.push("(u.username LIKE ? ESCAPE '\\' OR u.first_name LIKE ? ESCAPE '\\' OR j.video_id LIKE ? ESCAPE '\\' OR CAST(j.telegram_id AS TEXT) = ?)");
    binds.push(like, like, like, q);
  }
  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM jobs j LEFT JOIN users u ON u.telegram_id = j.telegram_id${whereSql}`
  ).bind(...binds).first();
  const res = await env.DB.prepare(
    `SELECT j.id, j.telegram_id, u.username, u.first_name, j.video_url, j.video_id, j.status,
            j.provider, j.model, j.cue_count, j.error_message, j.created_at, j.completed_at
       FROM jobs j LEFT JOIN users u ON u.telegram_id = j.telegram_id${whereSql}
      ORDER BY j.id DESC LIMIT ? OFFSET ?`
  ).bind(...binds, pageSize, offset).all();
  return { rows: (res?.results || []).map(jobRowToApi), total: Number(totalRow?.cnt || 0), page, pageSize };
}
__name(queryJobsPage, "queryJobsPage");
async function handleAdminSetup(request, env) {
  const ip = clientIp(request);
  if ((await adminLoginFails(env, ip)) >= ADMIN_LOGIN_MAX_FAILS * 2) {
    return adminJson({ ok: false, error: "too_many_attempts" }, 429);
  }
  const auth = await getAdminAuth(env);
  if (auth) return adminJson({ ok: false, error: "setup_closed" }, 403);
  let body;
  try { body = await request.json(); } catch { return adminJson({ ok: false, error: "bad_request" }, 400); }
  const username = String(body?.username || "").trim();
  const password = String(body?.password || "");
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return adminJson({ ok: false, error: "bad_username" }, 400);
  if (password.length < 10 || password.length > 200) return adminJson({ ok: false, error: "weak_password" }, 400);
  const hash = await hashAdminPassword(password);
  const res = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('admin_auth', ?1) ON CONFLICT(key) DO NOTHING`
  ).bind(JSON.stringify({ username, hash })).run();
  if (!Number(res?.meta?.changes || 0)) return adminJson({ ok: false, error: "setup_closed" }, 403);
  await recordLoginAttempt(env, ip, username, 1);
  const session = await createAdminSession(env, request, username);
  return adminJson({ ok: true, username, csrf: session.csrf }, 201, { "Set-Cookie": adminSessionCookie(session.token, ADMIN_SESSION_TTL_SEC) });
}
__name(handleAdminSetup, "handleAdminSetup");
async function handleAdminLogin(request, env) {
  const ip = clientIp(request);
  if ((await adminLoginFails(env, ip)) >= ADMIN_LOGIN_MAX_FAILS) {
    return adminJson({ ok: false, error: "too_many_attempts" }, 429);
  }
  let body;
  try { body = await request.json(); } catch { return adminJson({ ok: false, error: "bad_request" }, 400); }
  const username = String(body?.username || "");
  const password = String(body?.password || "");
  const auth = await getAdminAuth(env);
  if (!auth) return adminJson({ ok: false, error: "setup_required" }, 403);
  const userOk = timingSafeEqualStr(username, auth.username);
  const passOk = await verifyAdminPassword(password, userOk ? auth.hash : ADMIN_DUMMY_HASH);
  if (!userOk || !passOk) {
    await recordLoginAttempt(env, ip, username, 0);
    return adminJson({ ok: false, error: "invalid_credentials" }, 401);
  }
  await recordLoginAttempt(env, ip, username, 1);
  const session = await createAdminSession(env, request, auth.username);
  return adminJson({ ok: true, username: auth.username, csrf: session.csrf }, 200, { "Set-Cookie": adminSessionCookie(session.token, ADMIN_SESSION_TTL_SEC) });
}
__name(handleAdminLogin, "handleAdminLogin");
async function handleAdminApi(request, env, url) {
  const sub = url.pathname.slice("/admin/api".length);
  if (request.method === "POST" && sub === "/setup") return handleAdminSetup(request, env);
  if (request.method === "POST" && sub === "/login") return handleAdminLogin(request, env);
  const session = await getAdminSession(request, env);
  if (!session) {
    const auth = await getAdminAuth(env);
    return adminJson({ ok: false, error: "unauthorized", setupNeeded: !auth }, 401);
  }
  if (request.method !== "GET" && !checkAdminCsrf(request, session)) {
    return adminJson({ ok: false, error: "csrf_failed" }, 403);
  }
  if (request.method === "GET" && sub === "/me") {
    return adminJson({ ok: true, username: session.username, csrf: session.csrf_token });
  }
  if (request.method === "POST" && sub === "/logout") {
    try {
      await env.DB.prepare(`DELETE FROM admin_sessions WHERE token_hash = ?1`).bind(session.token_hash).run();
    } catch {
    }
    return adminJson({ ok: true }, 200, { "Set-Cookie": adminSessionCookie("", 0) });
  }
  if (request.method === "GET" && sub === "/stats") {
    const today = tehranDayStartIso();
    const [totalUsers, activeToday, totalRequests, byStatus, linksToday] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM users`).first(),
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE last_active_at >= ?1`).bind(today).first(),
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM jobs`).first(),
      env.DB.prepare(`SELECT status, COUNT(*) AS cnt FROM jobs GROUP BY status`).all(),
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM link_events WHERE created_at >= ?1 AND outcome = 'received'`).bind(today).first()
    ]);
    const counts = { completed: 0, failed: 0, processing: 0 };
    for (const r of byStatus?.results || []) {
      if (r.status in counts) counts[r.status] = Number(r.cnt || 0);
    }
    return adminJson({
      ok: true,
      totalUsers: Number(totalUsers?.cnt || 0),
      activeToday: Number(activeToday?.cnt || 0),
      totalRequests: Number(totalRequests?.cnt || 0),
      completed: counts.completed,
      failed: counts.failed,
      processing: counts.processing,
      linksToday: Number(linksToday?.cnt || 0)
    });
  }
  if (request.method === "GET" && sub === "/chart") {
    const since = new Date(Date.now() - 16 * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const res = await env.DB.prepare(
      `SELECT date(created_at, '+210 minutes') AS d, COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM jobs WHERE created_at >= ?1 GROUP BY d ORDER BY d`
    ).bind(since).all();
    const byDay = new Map((res?.results || []).map((r) => [r.d, r]));
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const t = new Date(Date.now() - i * 86400 * 1000 + 3.5 * 3600 * 1000);
      const key = t.toISOString().slice(0, 10);
      const r = byDay.get(key);
      days.push({ date: key, total: Number(r?.total || 0), completed: Number(r?.completed || 0), failed: Number(r?.failed || 0) });
    }
    return adminJson({ ok: true, days });
  }
  if (request.method === "GET" && (sub === "/activity" || sub === "/translations")) {
    const { page, pageSize, offset } = parsePageParams(url);
    const data = await queryJobsPage(env, {
      page, pageSize, offset,
      status: url.searchParams.get("status") || "",
      q: (url.searchParams.get("q") || "").trim()
    });
    return adminJson({ ok: true, ...data });
  }
  if (request.method === "GET" && sub === "/users") {
    const { page, pageSize, offset } = parsePageParams(url);
    const q = (url.searchParams.get("q") || "").trim();
    const where = [];
    const binds = [];
    if (q) {
      const like = "%" + escapeLike(q) + "%";
      where.push("(CAST(u.telegram_id AS TEXT) = ? OR u.username LIKE ? ESCAPE '\\' OR u.first_name LIKE ? ESCAPE '\\')");
      binds.push(q, like, like);
    }
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
    const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM users u${whereSql}`).bind(...binds).first();
    const res = await env.DB.prepare(
      `SELECT u.telegram_id, u.username, u.first_name, u.created_at, u.last_active_at, u.is_blocked,
              COALESCE(s.total_jobs, 0) AS total_jobs, COALESCE(s.successful_jobs, 0) AS successful_jobs, COALESCE(s.failed_jobs, 0) AS failed_jobs
         FROM users u LEFT JOIN user_stats s ON s.telegram_id = u.telegram_id${whereSql}
        ORDER BY u.last_active_at DESC LIMIT ? OFFSET ?`
    ).bind(...binds, pageSize, offset).all();
    return adminJson({
      ok: true,
      rows: (res?.results || []).map((r) => ({
        telegramId: r.telegram_id,
        username: r.username || null,
        firstName: r.first_name || null,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
        isBlocked: Number(r.is_blocked || 0) === 1,
        totalJobs: Number(r.total_jobs || 0),
        successfulJobs: Number(r.successful_jobs || 0),
        failedJobs: Number(r.failed_jobs || 0)
      })),
      total: Number(totalRow?.cnt || 0),
      page, pageSize
    });
  }
  const userActivityMatch = sub.match(/^\/users\/(\d+)\/activity$/);
  if (request.method === "GET" && userActivityMatch) {
    const { page, pageSize, offset } = parsePageParams(url);
    const data = await queryJobsPage(env, { page, pageSize, offset, telegramId: Number(userActivityMatch[1]) });
    return adminJson({ ok: true, ...data });
  }
  const blockMatch = sub.match(/^\/users\/(\d+)\/block$/);
  if (request.method === "POST" && blockMatch) {
    let body;
    try { body = await request.json(); } catch { return adminJson({ ok: false, error: "bad_request" }, 400); }
    const blocked = body?.blocked === true;
    const res = await env.DB.prepare(
      `UPDATE users SET is_blocked = ?1, blocked_at = ?2 WHERE telegram_id = ?3`
    ).bind(blocked ? 1 : 0, blocked ? new Date().toISOString().replace(/\.\d{3}Z$/, "Z") : null, Number(blockMatch[1])).run();
    if (!Number(res?.meta?.changes || 0)) return adminJson({ ok: false, error: "user_not_found" }, 404);
    return adminJson({ ok: true, isBlocked: blocked });
  }
  if (request.method === "GET" && sub === "/links") {
    const [bySource, topDomains, invalidRecent, totals] = await Promise.all([
      env.DB.prepare(`SELECT source, outcome, COUNT(*) AS cnt FROM link_events GROUP BY source, outcome ORDER BY cnt DESC`).all(),
      env.DB.prepare(`SELECT domain, COUNT(*) AS cnt FROM link_events WHERE domain IS NOT NULL GROUP BY domain ORDER BY cnt DESC LIMIT 10`).all(),
      env.DB.prepare(`SELECT id, telegram_id, username, url, domain, created_at FROM link_events WHERE outcome = 'invalid' ORDER BY id DESC LIMIT 20`).all(),
      env.DB.prepare(`SELECT outcome, COUNT(*) AS cnt FROM link_events GROUP BY outcome`).all()
    ]);
    const tot = { received: 0, invalid: 0 };
    for (const r of totals?.results || []) {
      if (r.outcome in tot) tot[r.outcome] = Number(r.cnt || 0);
    }
    return adminJson({
      ok: true,
      bySource: (bySource?.results || []).map((r) => ({ source: r.source, outcome: r.outcome, count: Number(r.cnt || 0) })),
      topDomains: (topDomains?.results || []).map((r) => ({ domain: r.domain, count: Number(r.cnt || 0) })),
      invalidRecent: (invalidRecent?.results || []).map((r) => ({
        id: r.id, telegramId: r.telegram_id, username: r.username || null, url: r.url, domain: r.domain, createdAt: r.created_at
      })),
      totals: tot
    });
  }
  return adminJson({ ok: false, error: "not_found" }, 404);
}
__name(handleAdminApi, "handleAdminApi");
async function handleAdminRequest(request, env, url) {
  if (!env.DB) return adminJson({ ok: false, error: "db_unavailable" }, 500);
  const path = url.pathname;
  if (path.startsWith("/admin/api/") || path === "/admin/api") {
    try {
      return await handleAdminApi(request, env, url);
    } catch (err) {
      console.error("[admin] api error:", sanitizeErrorMessage(err));
      return adminJson({ ok: false, error: "server_error" }, 500);
    }
  }
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: ADMIN_SECURITY_HEADERS });
  if (path === "/admin" || path === "/admin/") return adminText(ADMIN_HTML, "text/html; charset=utf-8");
  if (path === "/admin/app.css") return adminText(ADMIN_CSS, "text/css; charset=utf-8");
  if (path === "/admin/app.js") return adminText(ADMIN_JS, "text/javascript; charset=utf-8");
  return new Response("Not Found", { status: 404, headers: ADMIN_SECURITY_HEADERS });
}
__name(handleAdminRequest, "handleAdminRequest");
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
      const mode = url.searchParams.get("mode") || "all";
      if (mode === "rubika") {
        // Rubika front-end health: started as the egress probe required
        // by RUBIKA_PLAN.md (prove the Worker can reach botapi.rubika.ir
        // from inside Cloudflare), kept as a permanent gated check now
        // that it runs through the real client.
        if (!env.RUBIKA_BOT_TOKEN) {
          return Response.json({ ok: false, error: "RUBIKA_BOT_TOKEN not set" });
        }
        try {
          const rb = createRubikaClient(env.RUBIKA_BOT_TOKEN);
          const me = await rb.getMe();
          return Response.json({ ok: me.ok, rubikaStatus: me.description, bot: me.result?.bot?.username || null });
        } catch (err) {
          return Response.json({ ok: false, error: errName(err) });
        }
      }
      if (mode === "whisper") {
        // Upload-feature feasibility probe (2026-11-20): can Workers AI
        // Whisper transcribe raw audio bytes from inside the Worker, and
        // does the result carry timing (segments/vtt) usable as cues?
        // Sample: a short public speech clip (OpenAI Whisper test file).
        if (!env.AI) {
          return Response.json({ ok: false, error: "AI binding not set" });
        }
        const sampleUrl = (url.searchParams.get("u") || "https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac").trim();
        const kvToken = (url.searchParams.get("kv") || "").trim();
        try {
          const t0 = Date.now();
          let buf;
          if (kvToken) {
            // Read the sample from KV as bytes (a text read would corrupt
            // binary data — the /f/ route's SRT path is text-only).
            const ab = await env.SUBTITLE_CACHE.get(`file:${kvToken}`, "arrayBuffer");
            if (!ab) return Response.json({ ok: false, error: "kv sample not found" });
            buf = new Uint8Array(ab);
          } else {
            const audioRes = await fetchWithTimeout(sampleUrl, {}, 3e4);
            if (!audioRes.ok) return Response.json({ ok: false, error: `sample fetch http ${audioRes.status}` });
            buf = new Uint8Array(await audioRes.arrayBuffer());
          }
          const out = { ok: true, sampleBytes: buf.length, fetchMs: Date.now() - t0, models: {} };
          try {
            const t1 = Date.now();
            const r = await env.AI.run("@cf/openai/whisper", { audio: [...buf] });
            out.models.whisper = { ms: Date.now() - t1, keys: Object.keys(r || {}), text: String(r?.text || "").slice(0, 200), hasVtt: typeof r?.vtt === "string" && r.vtt.length > 0, vttHead: String(r?.vtt || "").slice(0, 300), wordCount: Array.isArray(r?.words) ? r.words.length : null };
          } catch (err) {
            out.models.whisper = { error: String(err?.message || err).slice(0, 240) };
          }
          try {
            const t2 = Date.now();
            let bin = "";
            for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode(...buf.subarray(i, i + 32768));
            const r2 = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: btoa(bin) });
            out.models.turbo = { ms: Date.now() - t2, keys: Object.keys(r2 || {}), text: String(r2?.text || "").slice(0, 200), segmentCount: Array.isArray(r2?.segments) ? r2.segments.length : null, segmentsHead: Array.isArray(r2?.segments) ? r2.segments.slice(0, 3) : null };
          } catch (err) {
            out.models.turbo = { error: String(err?.message || err).slice(0, 240) };
          }
          return Response.json(out);
        } catch (err) {
          return Response.json({ ok: false, error: String(err?.message || err).slice(0, 240) });
        }
      }
      if (mode === "ext") {
        const parsedExt = parseExternalUrl((url.searchParams.get("u") || "").trim());
        if (!parsedExt) {
          return Response.json({ ok: false, error: "pass ?u=<supported external url>" }, { status: 400 });
        }
        const t0 = Date.now();
        const attemptView = () => (LAST_EXTRACT_ATTEMPTS || []).map((a) => ({ status: a.status, detail: a.detail || null }));
        try {
          const out = await extractExternalSubtitles(parsedExt.videoId, parsedExt.canonicalUrl, env);
          return Response.json({ ok: true, videoId: parsedExt.videoId, source: out.source, lang: out.languageCode || null, cues: out.cues.length, attempts: attemptView(), ms: Date.now() - t0 });
        } catch (err) {
          return Response.json({ ok: false, videoId: parsedExt.videoId, code: err.code || null, error: String(err.message || err).slice(0, 200), attempts: attemptView(), ms: Date.now() - t0 });
        }
      }
      const videoId = (url.searchParams.get("v") || "").trim();
      if (!VIDEO_ID_RE2.test(videoId)) {
        return Response.json({ ok: false, error: "pass ?v=<11-char video id>" }, { status: 400 });
      }
      try {
        const report = await diagnoseExtraction(videoId, mode, env);
        return Response.json({ ok: true, ...report });
      } catch (err) {
        return Response.json({ ok: false, error: String(err && err.message || err) }, { status: 500 });
      }
    }
    if (request.method === "POST" && url.pathname.startsWith("/rubika/")) {
      return handleRubikaWebhook(request, env, ctx, url);
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
      const fm = url.pathname.match(/^\/f\/([a-f0-9]{16})(\/subtitle\.([a-z]{2,3})\.srt)?$/);
      if (fm && env.SUBTITLE_CACHE) {
        try {
          const srt = await env.SUBTITLE_CACHE.get(`file:${fm[1]}`);
          if (srt) {
            const dlName = fm[3] ? `subtitle.${fm[3]}.srt` : "subtitle.fa.srt";
            return new Response(srt, {
              headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${dlName}"`, "Cache-Control": "no-store" }
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
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Frame-Options": "DENY",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
              }
            });
          }
        } catch {
        }
      }
      return new Response("Not Found", { status: 404 });
    }
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdminRequest(request, env, url);
    }
    return new Response("Not Found", { status: 404 });
  },
  async queue(batch, env, ctx) {
    for (const msg of batch.messages) {
      // Each batch message replies through its own platform's client;
      // Telegram stays the default for payloads without a platform.
      const tg = msg.body?.platform === "rubika" ? createRubikaClient(env.RUBIKA_BOT_TOKEN || "MISSING") : createTelegramClient(env.TELEGRAM_BOT_TOKEN || "MISSING");
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