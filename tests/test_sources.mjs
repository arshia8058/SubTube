// Offline tests for multi-source links: TikTok / Instagram / X / Facebook.
import assert from "node:assert";

const {
  parseExternalUrl,
  parseAllSupportedUrls,
  parseAllYouTubeUrls,
  isExternalVideoId,
  extractExternalSubtitles,
  handleTelegramUpdate
} = await import("/tmp/test_bundle.mjs");

// --- parser: one happy path per platform + shape of ids ---
{
  const tk = parseExternalUrl("https://www.tiktok.com/@chef/video/7299888777666555444");
  assert.strictEqual(tk.videoId, "tiktok:7299888777666555444");
  assert.ok(tk.canonicalUrl.startsWith("https://www.tiktok.com/"));
  assert.strictEqual(parseExternalUrl("https://vm.tiktok.com/ZMabc123/").videoId, "tiktok:ZMabc123");
  assert.strictEqual(parseExternalUrl("https://vt.tiktok.com/ZSxyz789/").videoId, "tiktok:ZSxyz789");
  assert.strictEqual(parseExternalUrl("https://www.instagram.com/reel/DAbc123XYZ_/").videoId, "instagram:DAbc123XYZ_");
  assert.strictEqual(parseExternalUrl("https://www.instagram.com/reels/DAbc123XYZ_/").videoId, "instagram:DAbc123XYZ_");
  assert.strictEqual(parseExternalUrl("https://www.instagram.com/p/CQwerty123/").videoId, "instagram:CQwerty123");
  assert.strictEqual(parseExternalUrl("https://x.com/someuser/status/1876543210987654321").videoId, "x:1876543210987654321");
  assert.strictEqual(parseExternalUrl("https://twitter.com/someuser/status/1876543210987654321").videoId, "x:1876543210987654321");
  assert.strictEqual(parseExternalUrl("https://www.facebook.com/watch?v=123456789012345").videoId, "facebook:123456789012345");
  assert.strictEqual(parseExternalUrl("https://www.facebook.com/somepage/videos/987654321/").videoId, "facebook:987654321");
  assert.strictEqual(parseExternalUrl("https://fb.watch/AbCdEfGh/").videoId, "facebook:AbCdEfGh");
  console.log("parseExternalUrl happy paths: PASS");
}

// --- parser: rejections ---
{
  assert.strictEqual(parseExternalUrl("https://www.youtube.com/watch?v=e7fnVYzW8Ko"), null, "youtube is not external");
  assert.strictEqual(parseExternalUrl("https://example.com/video/123"), null);
  assert.strictEqual(parseExternalUrl("https://www.tiktok.com/@chef"), null, "profile page is not a video");
  assert.strictEqual(parseExternalUrl("https://www.instagram.com/someuser/"), null, "profile is not a post");
  assert.strictEqual(parseExternalUrl("https://x.com/someuser"), null, "profile is not a status");
  assert.strictEqual(parseExternalUrl("not a url"), null);
  assert.strictEqual(parseExternalUrl(""), null);
  console.log("parseExternalUrl rejections: PASS");
}

// --- combined parser: YouTube behavior preserved, externals merged in order ---
{
  const ytText = "ببین https://youtu.be/e7fnVYzW8Ko و این https://www.youtube.com/watch?v=POHIwXGSd88";
  assert.deepStrictEqual(parseAllSupportedUrls(ytText), parseAllYouTubeUrls(ytText), "youtube-only text identical");

  const mixed = "اولی https://www.tiktok.com/@a/video/1112223334445556667 دومی https://youtu.be/e7fnVYzW8Ko سومی https://www.instagram.com/reel/DAbc123XYZ_/";
  const { links, truncated } = parseAllSupportedUrls(mixed);
  assert.strictEqual(links.length, 3);
  assert.strictEqual(links[0].videoId, "tiktok:1112223334445556667");
  assert.strictEqual(links[1].videoId, "e7fnVYzW8Ko");
  assert.strictEqual(links[2].videoId, "instagram:DAbc123XYZ_");
  assert.strictEqual(truncated, false);

  const dup = parseAllSupportedUrls("https://vm.tiktok.com/ZMabc123/ دوباره https://vm.tiktok.com/ZMabc123/");
  assert.strictEqual(dup.links.length, 1, "dedupe");

  const many = parseAllSupportedUrls("https://youtu.be/e7fnVYzW8Ko https://www.tiktok.com/@a/video/1112223334445556667 https://x.com/u/status/1876543210987654321 https://www.instagram.com/reel/DAbc123XYZ_/");
  assert.strictEqual(many.links.length, 3, "cap 3");
  assert.strictEqual(many.truncated, true);

  assert.deepStrictEqual(parseAllSupportedUrls("سلام خوبی؟"), { links: [], truncated: false });
  assert.strictEqual(isExternalVideoId("tiktok:123"), true);
  assert.strictEqual(isExternalVideoId("facebook:AbC"), true);
  assert.strictEqual(isExternalVideoId("e7fnVYzW8Ko"), false);
  console.log("parseAllSupportedUrls: PASS");
}

// --- extraction via the generic Supadata endpoint (stubbed fetch) ---
const realFetch = globalThis.fetch;
let fetchCalls = [];
function stubSupadata(handler) {
  fetchCalls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    fetchCalls.push(u);
    if (!u.includes("api.supadata.ai")) throw new Error("unexpected fetch " + u);
    return handler(u);
  };
}
function makeKv() {
  const store = new Map();
  return {
    store,
    get: async (k, type) => {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    put: async (k, v) => { store.set(k, String(v)); },
    delete: async (k) => { store.delete(k); }
  };
}
const EN_PAYLOAD = { content: [{ text: "Hello world", offset: 0, duration: 2000 }, { text: "Second line here", offset: 2000, duration: 2500 }], lang: "en" };
{
  stubSupadata(() => ({ status: 200, ok: true, json: async () => EN_PAYLOAD, text: async () => JSON.stringify(EN_PAYLOAD) }));
  const kv = makeKv();
  const env = { SUPADATA_API_KEY: "k", SUBTITLE_CACHE: kv };
  const out = await extractExternalSubtitles("tiktok:7299888777666555444", "https://www.tiktok.com/@chef/video/7299888777666555444", env);
  assert.strictEqual(out.cues.length, 2);
  assert.strictEqual(out.languageCode, "en");
  assert.strictEqual(out.source, "supadata");
  assert.ok(fetchCalls[0].includes("url=" + encodeURIComponent("https://www.tiktok.com/@chef/video/7299888777666555444")), "generic endpoint got the tiktok url");
  assert.ok(kv.store.has("cap2:tiktok:7299888777666555444"), "cached under external id");
  const callsBefore = fetchCalls.length;
  const out2 = await extractExternalSubtitles("tiktok:7299888777666555444", "https://www.tiktok.com/@chef/video/7299888777666555444", env);
  assert.strictEqual(out2.cues.length, 2);
  assert.strictEqual(fetchCalls.length, callsBefore, "second call served from cache");
  console.log("extractExternalSubtitles ok + cache: PASS");
}
{
  // non-English transcript: en attempt fails on language, no-lang attempt wins
  stubSupadata((u) => {
    const payload = { content: [{ text: "مرحبا بالعالم", offset: 0, duration: 2000 }], lang: "ar" };
    return { status: 200, ok: true, json: async () => payload, text: async () => JSON.stringify(payload) };
  });
  const env = { SUPADATA_API_KEY: "k", SUBTITLE_CACHE: makeKv() };
  const out = await extractExternalSubtitles("instagram:DAbc123XYZ_", "https://www.instagram.com/reel/DAbc123XYZ_/", env);
  assert.strictEqual(out.languageCode, "ar");
  assert.strictEqual(fetchCalls.length, 2, "en attempt then no-lang attempt");
  console.log("extractExternalSubtitles multilang: PASS");
}
{
  stubSupadata(() => ({ status: 206, ok: false, json: async () => ({}), text: async () => "{}" }));
  const env = { SUPADATA_API_KEY: "k", SUBTITLE_CACHE: makeKv() };
  await assert.rejects(
    () => extractExternalSubtitles("x:1876543210987654321", "https://x.com/u/status/1876543210987654321", env),
    (err) => String(err.userMessage || err.message || "").includes("زیرنویسی ندارد"),
    "definitive 206 -> NO_CAPTIONS"
  );
  await assert.rejects(
    () => extractExternalSubtitles("x:1876543210987654321", "https://x.com/u/status/1876543210987654321", { SUBTITLE_CACHE: makeKv() }),
    (err) => String(err.userMessage || err.message || "").includes("جواب نمی‌دهند"),
    "missing api key -> temp failure"
  );
  console.log("extractExternalSubtitles empty/no-key: PASS");
}
globalThis.fetch = realFetch;

// --- handler level: a TikTok link gets the choice prompt + a TikTok link event ---
{
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind: (...args) => ({
          first: async () => {
            if (sql.includes("is_blocked")) return { is_blocked: 0 };
            if (sql.includes("FROM settings")) return null;
            if (sql.includes("COUNT(*)")) return { cnt: 0 };
            return null;
          },
          run: async () => { calls.push({ sql, args }); return { success: true, meta: { changes: 1 } }; },
          all: async () => ({ results: [] })
        })
      };
    },
    batch: async () => []
  };
  const kv = makeKv();
  const sent = [];
  const tg = {
    sendMessage: async (chatId, text, opts) => { sent.push({ text, opts }); return { result: { message_id: 7 } }; },
    editMessageText: async () => ({}),
    deleteMessage: async () => ({}),
    answerCallbackQuery: async () => ({})
  };
  const update = { message: { message_id: 3, chat: { id: 100 }, from: { id: 7, first_name: "Ali", username: "ali" }, text: "اینو ببین https://www.tiktok.com/@chef/video/7299888777666555444" } };
  await handleTelegramUpdate(update, { DB: db, SUBTITLE_CACHE: kv }, tg);
  const ev = calls.find((c) => c.sql.includes("INSERT INTO link_events"));
  assert.ok(ev, "link event recorded");
  assert.strictEqual(ev.args[5], "TikTok");
  assert.strictEqual(ev.args[6], "received");
  assert.ok([...kv.store.keys()].some((k) => k.startsWith("pend:")), "choice prompt stored");
  const pend = JSON.parse(kv.store.get([...kv.store.keys()].find((k) => k.startsWith("pend:"))));
  assert.strictEqual(pend.links[0].videoId, "tiktok:7299888777666555444");
  assert.ok(sent.some((m) => m.opts?.reply_markup), "choice keyboard sent");
  console.log("handler tiktok flow: PASS");
}

console.log("test_sources: ALL PASS");

// --- 404 from Supadata maps to the not-available message ---
{
  stubSupadata(() => ({ status: 404, ok: false, json: async () => ({ error: "not-found" }), text: async () => '{"error":"not-found"}' }));
  const env = { SUPADATA_API_KEY: "k", SUBTITLE_CACHE: makeKv() };
  await assert.rejects(
    () => extractExternalSubtitles("tiktok:7000000000000000000", "https://www.tiktok.com/@gone/video/7000000000000000000", env),
    (err) => String(err.userMessage || err.message || "").includes("در دسترس نیست"),
    "404 -> not available message"
  );
  globalThis.fetch = realFetch;
  console.log("extractExternalSubtitles 404 mapping: PASS");
}
