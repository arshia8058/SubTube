// Offline tests for AI subtitle generation for caption-less videos:
// callback data, queue wiring (gen flag + qid), the generate tap flow,
// and generated extraction via a stubbed Supadata.
import assert from "node:assert";

const {
  buildGenerateCallbackData,
  parseGenerateCallbackData,
  generateKeyboard,
  parseChoiceCallbackData,
  parseRetranslateCallbackData,
  buildQueueMessage,
  handleCallbackQuery,
  extractGeneratedSubtitles,
  offerGenerate
} = await import("/tmp/test_bundle.mjs");

// callback data roundtrip + isolation
{
  const token = "0123abcdef89";
  const data = buildGenerateCallbackData(token);
  assert.ok(data.length <= 64);
  assert.deepStrictEqual(parseGenerateCallbackData(data), { token });
  for (const bad of ["", null, undefined, "g:xyz", "g:0123abcdef8", "r:0123abcdef89", "c:srt:0123abcdef89"]) {
    assert.strictEqual(parseGenerateCallbackData(bad), null, `rejects ${bad}`);
  }
  assert.strictEqual(parseChoiceCallbackData(data), null, "choice parser ignores g:");
  assert.strictEqual(parseRetranslateCallbackData(data), null, "retranslate parser ignores g:");
  const kb = generateKeyboard(token);
  assert.ok(kb.inline_keyboard[0][0].text.includes("هوش مصنوعی"));
  assert.deepStrictEqual(parseGenerateCallbackData(kb.inline_keyboard[0][0].callback_data), { token });
  console.log("generate callback data + keyboard: PASS");
}

// queue message: qid always present, gen flag only when requested
{
  const base = { chatId: 1, user: { id: 2 }, messageId: 3, links: [{ videoId: "e7fnVYzW8Ko" }], mode: "srt", truncated: false };
  const plain = buildQueueMessage(base);
  assert.ok(/^[a-f0-9]{24}$/.test(plain.qid), "qid is 24 hex");
  assert.ok(!("gen" in plain), "no gen key for normal jobs");
  const gen = buildQueueMessage({ ...base, generate: true });
  assert.strictEqual(gen.gen, true);
  assert.notStrictEqual(gen.qid, buildQueueMessage(base).qid, "qid unique per enqueue");
  console.log("buildQueueMessage gen + qid: PASS");
}

// stubs (mirrors test_retranslate)
function makeStubs() {
  const store = new Map();
  const kv = {
    get: async (k, type) => {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    put: async (k, v) => { store.set(k, String(v)); },
    delete: async (k) => { store.delete(k); }
  };
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        run: async () => ({ success: true }),
        all: async () => ({ results: [] })
      })
    })
  };
  const calls = [];
  const tg = {
    answerCallbackQuery: async (id, text) => { calls.push({ m: "answer", id, text }); return { ok: true }; },
    sendMessage: async (chatId, text, opts) => { calls.push({ m: "send", chatId, text, opts }); return { result: { message_id: 999 } }; },
    editMessageText: async (chatId, mid, text, opts) => { calls.push({ m: "edit", chatId, mid, text, opts }); return { ok: true }; }
  };
  const queuePayloads = [];
  const env = { SUBTITLE_CACHE: kv, DB: db, JOB_QUEUE: { send: async (p) => { queuePayloads.push(p); } } };
  return { store, kv, env, tg, calls, queuePayloads };
}
function cbUpdate(token, fromId) {
  return {
    callback_query: {
      id: "q1",
      from: { id: fromId, first_name: "T" },
      message: { message_id: 7, chat: { id: 555 } },
      data: `g:${token}`
    }
  };
}

// generate tap: happy path + replay + ownership
{
  const { store, kv, env, tg, calls, queuePayloads } = makeStubs();
  const token = "aaaa1111bbbb";
  await kv.put(`gen:${token}`, JSON.stringify({ videoId: "instagram:DfZ9sX_Ryty", canonicalUrl: "https://www.instagram.com/reel/DfZ9sX_Ryty/", userId: 42, mode: "srt" }));
  await handleCallbackQuery(cbUpdate(token, 42), env, tg);
  assert.strictEqual(queuePayloads.length, 1, "one job enqueued");
  const p = queuePayloads[0];
  assert.strictEqual(p.gen, true, "gen flag set");
  assert.ok(/^[a-f0-9]{24}$/.test(p.qid), "qid present");
  assert.strictEqual(p.links[0].videoId, "instagram:DfZ9sX_Ryty");
  assert.strictEqual(store.has(`gen:${token}`), false, "token consumed");
  assert.ok(calls.some((c) => c.m === "answer" && c.text && c.text.includes("شروع شد")), "started toast");
  console.log("generate tap happy path: PASS");

  calls.length = 0;
  await handleCallbackQuery(cbUpdate(token, 42), env, tg);
  assert.strictEqual(queuePayloads.length, 1, "no second enqueue on replay");
  assert.ok(calls.some((c) => c.m === "answer" && c.text && c.text.includes("منقضی")), "expired toast");
  console.log("generate tap replay: PASS");
}
{
  const { store, kv, env, tg, calls, queuePayloads } = makeStubs();
  const token = "cccc2222dddd";
  await kv.put(`gen:${token}`, JSON.stringify({ videoId: "e7fnVYzW8Ko", canonicalUrl: "https://www.youtube.com/watch?v=e7fnVYzW8Ko", userId: 42, mode: "both" }));
  await handleCallbackQuery(cbUpdate(token, 43), env, tg);
  assert.strictEqual(queuePayloads.length, 0, "stranger cannot enqueue");
  assert.strictEqual(store.has(`gen:${token}`), true, "token not consumed by stranger");
  assert.ok(calls.some((c) => c.m === "answer" && c.text && c.text.includes("برای شما نیست")), "not-yours toast");
  await handleCallbackQuery(cbUpdate(token, 42), env, tg);
  assert.strictEqual(queuePayloads.length, 1);
  assert.strictEqual(queuePayloads[0].mode, "both", "mode preserved");
  console.log("generate tap ownership: PASS");
}

// offerGenerate writes the token + sends the button
{
  const { store, env, tg, calls } = makeStubs();
  await offerGenerate(env, tg, 555, { videoId: "e7fnVYzW8Ko", canonicalUrl: "https://www.youtube.com/watch?v=e7fnVYzW8Ko", userId: 42, mode: "srt" });
  const genKeys = [...store.keys()].filter((k) => k.startsWith("gen:"));
  assert.strictEqual(genKeys.length, 1, "one gen token stored");
  const saved = JSON.parse(store.get(genKeys[0]));
  assert.strictEqual(saved.videoId, "e7fnVYzW8Ko");
  assert.strictEqual(saved.userId, 42);
  const sent = calls.find((c) => c.m === "send");
  assert.ok(sent && sent.opts?.reply_markup, "offer message with keyboard sent");
  assert.deepStrictEqual(parseGenerateCallbackData(sent.opts.reply_markup.inline_keyboard[0][0].callback_data), { token: genKeys[0].slice(4) });
  console.log("offerGenerate: PASS");
}

// generated extraction via stubbed Supadata
const realFetch = globalThis.fetch;
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
{
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (!u.includes("api.supadata.ai")) throw new Error("unexpected " + u);
    const payload = { content: [{ text: "سلام دنیا", offset: 0, duration: 2000 }, { text: "جمله دوم", offset: 2000, duration: 2000 }], lang: "fa" };
    return { status: 200, ok: true, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  const kv = makeKv();
  const out = await extractGeneratedSubtitles("instagram:DfZ9sX_Ryty", "https://www.instagram.com/reel/DfZ9sX_Ryty/", { SUPADATA_API_KEY: "k", SUBTITLE_CACHE: kv });
  assert.strictEqual(out.cues.length, 2);
  assert.strictEqual(out.languageCode, "fa", "spoken language auto-detected");
  assert.strictEqual(out.source, "supadata_generated");
  assert.strictEqual(out.isAuto, true);
  assert.ok(seen[0].includes("mode=generate"), "generate mode requested");
  assert.ok(seen[0].includes(encodeURIComponent("https://www.instagram.com/reel/DfZ9sX_Ryty/")), "canonical url passed");
  assert.ok(kv.store.has("cap2:instagram:DfZ9sX_Ryty"), "generated transcript cached");
  console.log("extractGeneratedSubtitles sync: PASS");
}
{
  // async generation job: 202 then completed on poll
  let polls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/v1/transcript/")) {
      polls++;
      const payload = { status: "completed", result: { content: [{ text: "Hello speech", offset: 0, duration: 3000 }], lang: "en" } };
      return { status: 200, ok: true, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    return { status: 202, ok: true, json: async () => ({ jobId: "job123" }), text: async () => "{}" };
  };
  const out = await extractGeneratedSubtitles("e7fnVYzW8Ko", "https://www.youtube.com/watch?v=e7fnVYzW8Ko", { SUPADATA_API_KEY: "k", SUBTITLE_CACHE: makeKv() });
  assert.strictEqual(out.cues.length, 1);
  assert.strictEqual(out.languageCode, "en");
  assert.ok(polls >= 1, "polled the generation job");
  console.log("extractGeneratedSubtitles polling: PASS");
}
{
  globalThis.fetch = async () => ({ status: 206, ok: false, json: async () => ({}), text: async () => "{}" });
  await assert.rejects(
    () => extractGeneratedSubtitles("e7fnVYzW8Ko", "https://www.youtube.com/watch?v=e7fnVYzW8Ko", { SUPADATA_API_KEY: "k", SUBTITLE_CACHE: makeKv() }),
    (err) => String(err.userMessage || err.message || "").includes("گفتار قابل تشخیصی"),
    "definitive empty -> generation-specific NO_CAPTIONS"
  );
  globalThis.fetch = realFetch;
  console.log("extractGeneratedSubtitles empty: PASS");
}

console.log("test_generate: ALL PASS");
