// Offline tests for selectable subtitle target language (pick #6,
// 2026-11-20): language registry, per-user persistence (with the column
// self-heal), cache-key separation between targets, provider prompt
// parameterization, Google tl= wiring, generalized src==target
// passthrough, and the /lang command + l:<code> callback flow.
// Persian ("fa") must stay byte-identical to the legacy behavior: fa2: /
// chunkfa1: keys, the exact legacy prompts, subtitle.fa.srt.
import assert from "node:assert";

const {
  normalizeTargetLang, targetLangName, targetLangFaName, srtFileNameForLang,
  langKeyboard, TARGET_LANGS, translationCacheKey, readTranslationCache,
  writeTranslationCache, getUserSubtitleLang, setUserSubtitleLang,
  matchTranslationsArray, translateCuesToPersian, translateSingleChunkViaGoogle,
  handleTelegramUpdate, handleCallbackQuery, buildQueueMessage
} = await import("/tmp/test_bundle.mjs");

let fails = 0;
const ok = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + " " + label); if (!cond) fails++; };

// ---------- registry ----------
ok(normalizeTargetLang("fa") === "fa" && normalizeTargetLang("AR") === "ar" && normalizeTargetLang("en-US") === "en", "normalizeTargetLang accepts supported codes");
ok(normalizeTargetLang("xx") === "fa" && normalizeTargetLang(null) === "fa" && normalizeTargetLang("") === "fa", "unknown/empty target falls back to fa");
ok(Object.keys(TARGET_LANGS).join(",") === "fa,en,ar,tr,ru,es,fr,de", "exactly the 8 offered languages");
ok(targetLangName("fa") === "Persian (Farsi)" && targetLangName("ar") === "Arabic", "prompt names");
ok(targetLangFaName("fa") === "فارسی" && targetLangFaName("tr") === "ترکی", "Persian display names");
ok(srtFileNameForLang("fa") === "subtitle.fa.srt" && srtFileNameForLang("de") === "subtitle.de.srt", "SRT filename per language");

// ---------- /lang keyboard ----------
{
  const kb = langKeyboard("ar");
  const flat = kb.inline_keyboard.flat();
  ok(kb.inline_keyboard.length === 4 && flat.length === 8, "keyboard: 4 rows x 2 = 8 languages");
  ok(flat.every((b) => /^l:[a-z]{2}$/.test(b.callback_data)), "every button carries an l:<code> callback");
  ok(flat.find((b) => b.callback_data === "l:ar").text.startsWith("✅"), "current language is check-marked");
  ok(flat.filter((b) => b.text.startsWith("✅")).length === 1, "exactly one check mark");
}

// ---------- persistence (fake users table, column starts missing) ----------
function makeUsersDb({ column = false } = {}) {
  // `column: true` simulates the already-migrated production table. The
  // runtime self-heal flag is module-level (one database per isolate in
  // production), so only the first fake may start column-less.
  let hasColumn = column;
  const langs = new Map();
  const norm = (sql) => sql.replace(/\s+/g, " ");
  return {
    langs,
    prepare(sql) {
      const q = norm(sql);
      let args = [];
      const s = {
        bind(...a) { args = a; return s; },
        async first() {
          if (q.includes("SELECT subtitle_lang FROM users LIMIT 1")) {
            if (!hasColumn) throw new Error("no such column: subtitle_lang");
            return { subtitle_lang: "fa" };
          }
          if (q.includes("SELECT subtitle_lang FROM users WHERE telegram_id")) {
            if (!hasColumn) throw new Error("no such column: subtitle_lang");
            return langs.has(args[0]) ? { subtitle_lang: langs.get(args[0]) } : null;
          }
          if (q.includes("SELECT is_blocked FROM users")) return { is_blocked: 0 };
          if (q.includes("FROM settings")) return null;
          return null;
        },
        async run() {
          if (q.startsWith("ALTER TABLE users ADD COLUMN subtitle_lang")) { hasColumn = true; return { meta: { changes: 0 } }; }
          if (q.includes("UPDATE users SET subtitle_lang")) { langs.set(args[0], args[1]); return { meta: { changes: 1 } }; }
          return { meta: { changes: 1 } };
        },
        async all() { return { results: [] }; }
      };
      return s;
    }
  };
}
{
  const db = makeUsersDb();
  ok((await getUserSubtitleLang(db, 111)) === "fa", "unknown user defaults to fa (column self-healed on the way)");
  ok((await setUserSubtitleLang(db, 111, "ar")) === "ar", "set returns the stored language");
  ok((await getUserSubtitleLang(db, 111)) === "ar", "language persists per user");
  ok((await getUserSubtitleLang(db, 222)) === "fa", "another user is unaffected");
  ok((await setUserSubtitleLang(db, 111, "xx")) === "fa" && (await getUserSubtitleLang(db, 111)) === "fa", "invalid language is normalized to fa before storing");
  ok((await getUserSubtitleLang(null, 111)) === "fa", "no db -> fa");
}

// ---------- translation cache separation ----------
{
  ok(translationCacheKey("VID", "en", "coarena", "m") === "fa2:VID:en:coarena:m", "fa keeps the legacy fa2: key byte-identical");
  ok(translationCacheKey("VID", "en", "coarena", "m", "ar") === "tr2:VID:en:ar:coarena:m", "ar uses the new tr2: key with the target embedded");
  ok(translationCacheKey("VID", "en", "coarena", "m", "tr") !== translationCacheKey("VID", "en", "coarena", "m", "ar"), "different targets never share a key");
  const store = new Map();
  const kv = {
    get: async (k, type) => { const v = store.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
    put: async (k, v) => { store.set(k, String(v)); }
  };
  const payload = { srt: "1\n00:00:00,000 --> 00:00:01,000\nسلام دنیا این یک زیرنویس است", cueCount: 1, isAuto: false };
  await writeTranslationCache(kv, "VID", "en", "coarena", "m", payload, "ar");
  ok((await readTranslationCache(kv, "VID", "en", "coarena", "m", "ar"))?.srt === payload.srt, "ar entry readable under ar");
  ok((await readTranslationCache(kv, "VID", "en", "coarena", "m")) === null, "fa read does NOT see the ar entry");
  ok((await readTranslationCache(kv, "VID", "en", "coarena", "m", "tr")) === null, "tr read does NOT see the ar entry");
}

// ---------- ID matcher with a non-fa key ----------
{
  const ids = new Set([1, 2]);
  ok(matchTranslationsArray([{ id: 1, ar: "أ" }, { id: 2, ar: "ب" }], ids, "ar")?.size === 2, "matcher accepts the ar key");
  ok(matchTranslationsArray([{ id: 1, fa: "أ" }, { id: 2, fa: "ب" }], ids, "ar") === null, "matcher rejects fa-keyed items when ar is expected");
  ok(matchTranslationsArray([{ id: 1, fa: "أ" }, { id: 2, fa: "ب" }], ids)?.size === 2, "matcher still defaults to the fa key");
  ok(matchTranslationsArray([{ id: 1, ar: "أ" }, { id: 2, ar: "ب" }], ids) === null, "default fa key rejects ar-keyed items");
}

// ---------- provider prompts + chunk cache, by target ----------
const coarenaCalls = [];
function stubCoarenaFetch(url, options = {}) {
  const u = String(url);
  if (u.includes("coarena.ai")) {
    const body = JSON.parse(options.body);
    coarenaCalls.push(body);
    const userPrompt = body.messages[1].content;
    const key = /"([a-z]{2})": "<its/.exec(userPrompt)[1];
    const items = JSON.parse(userPrompt.split("\n\n").pop());
    const out = items.map((it) => ({ id: it.id, [key]: (key === "fa" ? "FA:" : "TR:") + it.text }));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ items: out }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) };
  }
  throw new Error("unexpected fetch: " + u);
}
const cues = [
  { startMs: 0, endMs: 2000, text: "Hello world" },
  { startMs: 3000, endMs: 5000, text: "How are you" },
  { startMs: 6000, endMs: 8000, text: "Goodbye now" }
];
function makeKv() {
  const store = new Map();
  return {
    store,
    get: async (k, type) => { const v = store.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
    put: async (k, v) => { store.set(k, String(v)); },
    delete: async (k) => { store.delete(k); }
  };
}
{
  globalThis.fetch = stubCoarenaFetch;
  coarenaCalls.length = 0;
  const usage = {};
  const out = await translateCuesToPersian(cues, null, { COARENA_API_KEY: "k1" }, usage, "en", null, "ar");
  ok(out.map((c) => c.text).join("|") === "TR:Hello world|TR:How are you|TR:Goodbye now", "ar job translates via the ar key, aligned");
  ok(usage.targetLang === "ar", "usage records the target language");
  const sys = coarenaCalls[0].messages[0].content;
  const usr = coarenaCalls[0].messages[1].content;
  ok(sys.includes("translating English dialogue into Arabic.") && !sys.includes("Persian"), "coarena system prompt targets Arabic, no Persian");
  ok(usr.includes('"ar": "<its Arabic translation>"'), "coarena user prompt asks for the ar key");
}
{
  globalThis.fetch = stubCoarenaFetch;
  coarenaCalls.length = 0;
  const out = await translateCuesToPersian(cues, null, { COARENA_API_KEY: "k1" }, {}, "en", null, "fa");
  ok(out[0].text === "FA:Hello world", "fa job still translates");
  const sys = coarenaCalls[0].messages[0].content;
  const usr = coarenaCalls[0].messages[1].content;
  ok(sys.startsWith("You are a professional subtitle translator for films and TV series, translating English dialogue into Persian (Farsi)."), "fa system prompt is the legacy wording");
  ok(usr.includes('{"items": [{"id": <the item\'s id>, "fa": "<its Persian translation>"}]}'), "fa user prompt is the legacy wording");
}
{
  // chunk cache: ar writes chunktr1: keys, fa writes chunkfa1: keys
  globalThis.fetch = stubCoarenaFetch;
  const kvAr = makeKv();
  await translateCuesToPersian(cues, null, { COARENA_API_KEY: "k1", SUBTITLE_CACHE: kvAr }, {}, "en", "VIDAR", "ar");
  const arKeys = [...kvAr.store.keys()].filter((k) => k.startsWith("chunk"));
  ok(arKeys.length === 1 && arKeys[0].startsWith("chunktr1:VIDAR:en:ar:"), "ar chunks cached under chunktr1: with the target");
  const kvFa = makeKv();
  await translateCuesToPersian(cues, null, { COARENA_API_KEY: "k1", SUBTITLE_CACHE: kvFa }, {}, "en", "VIDFA", "fa");
  const faKeys = [...kvFa.store.keys()].filter((k) => k.startsWith("chunk"));
  ok(faKeys.length === 1 && faKeys[0].startsWith("chunkfa1:VIDFA:en:"), "fa chunks cached under the legacy chunkfa1: key");
}

// ---------- Google fallback target wiring ----------
{
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => [[["Merhaba dünya", "Hello world"]]] };
  };
  const one = [{ index: 0, text: "Hello world" }];
  const tr = await translateSingleChunkViaGoogle(one, "en", "tr");
  ok(tr[0].translatedText === "Merhaba dünya" && urls[0].includes("tl=tr") && urls[0].includes("sl=en"), "google fallback sends tl=tr");
  urls.length = 0;
  await translateSingleChunkViaGoogle(one, "en");
  ok(urls[0].includes("tl=fa"), "google fallback defaults to tl=fa");
}

// ---------- generalized passthrough (src == target, non-fa) ----------
{
  globalThis.fetch = async () => { throw new Error("fetch must not be called for passthrough"); };
  const usage = {};
  const out = await translateCuesToPersian(cues, null, {}, usage, "en", null, "en");
  ok(out.every((c, i) => c.text === cues[i].text && c.startMs === cues[i].startMs), "en->en passes through untranslated");
  ok(usage.chunksByProvider?.passthrough === 1 && usage.targetLang === "en", "passthrough recorded for en->en");
  const usage2 = {};
  const out2 = await translateCuesToPersian(cues, null, {}, usage2, "ar", null, "ar");
  ok(out2.every((c, i) => c.text === cues[i].text), "ar->ar passes through untranslated");
}

// ---------- queue payload: lang only when pinned ----------
{
  const user = { id: 5, first_name: "A", username: "a" };
  const links = [{ videoId: "u2MfX-J1_zo", canonicalUrl: "https://www.youtube.com/watch?v=u2MfX-J1_zo" }];
  const plain = buildQueueMessage({ chatId: 1, user, messageId: 1, links, mode: "srt", truncated: false });
  ok(!("lang" in plain), "unpinned queue payload has no lang field (byte-identical to before)");
  const pinned = buildQueueMessage({ chatId: 1, user, messageId: 1, links, mode: "srt", truncated: false, targetLang: "ar" });
  ok(pinned.lang === "ar", "pinned queue payload carries lang");
}

// ---------- /lang command + l:<code> callback (shared handler) ----------
{
  const db = makeUsersDb({ column: true });
  const kv = makeKv();
  const env = { DB: db, SUBTITLE_CACHE: kv };
  const sent = [];
  const tg = {
    platform: "telegram",
    sendMessage: async (chatId, text, extra) => { sent.push({ chatId, text, extra }); return { ok: true, result: { message_id: 10 } }; },
    editMessageText: async (chatId, messageId, text, extra) => { sent.push({ edit: true, chatId, text, extra }); return { ok: true }; },
    answerCallbackQuery: async (id, text) => { sent.push({ answer: true, text }); return { ok: true }; },
    deleteMessage: async () => ({ ok: true })
  };
  const from = { id: 777, first_name: "T", username: "t" };
  await handleTelegramUpdate({ message: { chat: { id: 777 }, from, text: "/lang", message_id: 1 } }, env, tg);
  ok(sent.length === 1 && sent[0].text.includes("فارسی") && sent[0].extra?.reply_markup?.inline_keyboard?.flat().length === 8, "/lang replies with the current language (fa) + 8 buttons");
  sent.length = 0;
  await handleCallbackQuery({ callback_query: { id: "q1", from, message: { chat: { id: 777 }, message_id: 10 }, data: "l:tr" } }, env, tg);
  ok(db.langs.get(777) === "tr", "l:tr tap persists tr for the tapper");
  ok(sent.some((s) => s.answer && s.text.includes("ترکی")), "tap is acknowledged with the new language name");
  ok(sent.some((s) => s.edit && s.text.includes("ترکی") && s.extra?.reply_markup?.inline_keyboard?.length === 0), "prompt message is edited to the confirmation, buttons cleared");
  sent.length = 0;
  await handleTelegramUpdate({ message: { chat: { id: 777 }, from, text: "/lang", message_id: 2 } }, env, tg);
  ok(sent[0].text.includes("ترکی") && sent[0].extra.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === "l:tr").text.startsWith("✅"), "/lang now shows tr as current");
  // a bogus language callback must not change anything
  await handleCallbackQuery({ callback_query: { id: "q2", from, message: { chat: { id: 777 }, message_id: 10 }, data: "l:xx" } }, env, tg);
  ok(db.langs.get(777) === "tr", "l:xx is ignored (no such target)");
}

console.log(fails === 0 ? "ALL LANG TESTS PASSED" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
