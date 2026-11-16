// ساخت باندل تست از سورس اصلی: خروجی default را حذف و توابع داخلی را export می‌کند
// تا تست‌های آفلاین بتوانند آن‌ها را مستقیم صدا بزنند. (تنها تغییر نسبت به نسخه
// داخلی پروژه: مسیر سورس، چون در مخزن عمومی سورس داخل src/ است.)
import { readFileSync, writeFileSync } from "node:fs";
let src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
src = src.replace(/export\s*\{\s*index_default as default\s*\};?/, "");
src = src.replace(/\/\/# sourceMappingURL=.*$/m, "");
src += "\nexport { translateCuesToPersian, buildTranslationChunks, validateTranslatedCues, matchTranslationsById, generateSrt, translateChunkViaCoarenaById, parseCoarenaContent, parseYouTubeUrl, parseAllYouTubeUrls, normalizeLangCode, sourceLangName, summarizeTranscript, formatCoarenaLimits, buildChoiceCallbackData, parseChoiceCallbackData, choiceKeyboard, choicePromptText, makeChoiceToken, normalizeCues, wrapSubtitleText, analyzeCues, analyzeSrt, createProgressState, progressPercents, renderProgressText, syncProgressFromUsage, progressSnapshot, faNum, progressPageHtml, translationCacheKey, BOT_COMMANDS, cancelKey, throwIfCancelled, statusIconForJob, renderHistoryMessage, renderStatusMessage, snapshotLiveness, buildQueueMessage, deliverSrt, splitSrtForTextDelivery };\n";
writeFileSync("/tmp/test_bundle.mjs", src);
console.log("test bundle written", src.length);
