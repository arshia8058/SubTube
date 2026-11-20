// Offline tests for file-upload subtitles (pick #3, 2026-11-20):
// media routing at intake, the 20 MB cap (Telegram's bot download
// limit), the pend payload round-trip through the choice callback, the
// Whisper-response -> cues normalization (turbo segments with word
// timings, classic VTT incl. the blank first start), and a full
// processUploadJob run with stubbed download + Workers AI.
import assert from "node:assert";

const {
  telegramMediaOf, transcribeUploadedAudio, cuesFromWhisperSegments,
  parseWhisperVtt, processUploadJob, handleTelegramUpdate,
  handleCallbackQuery, buildQueueMessage, MAX_UPLOAD_BYTES
} = await import("/tmp/test_bundle.mjs");

let fails = 0;
const ok = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + " " + label); if (!cond) fails++; };

// ---------- media routing ----------
{
  ok(telegramMediaOf({ video: { file_id: "V1", file_size: 100 } })?.kind === "video", "video message routes as video");
  ok(telegramMediaOf({ video_note: { file_id: "VN" } })?.kind === "video", "video note routes as video");
  ok(telegramMediaOf({ audio: { file_id: "A1", file_name: "x.mp3" } })?.fileName === "x.mp3", "audio keeps its file name");
  ok(telegramMediaOf({ voice: { file_id: "VO", mime_type: "audio/ogg" } })?.kind === "voice", "voice routes as voice");
  ok(telegramMediaOf({ document: { file_id: "D1", mime_type: "video/mp4" } })?.kind === "document", "video document routes");
  ok(telegramMediaOf({ document: { file_id: "D2", mime_type: "audio/mpeg" } })?.kind === "document", "audio document routes");
  ok(telegramMediaOf({ document: { file_id: "D3", mime_type: "application/pdf" } }) === null, "pdf document is NOT an upload");
  ok(telegramMediaOf({ photo: [{ file_id: "P" }] }) === null, "photo is NOT an upload");
  ok(telegramMediaOf({ text: "hello" }) === null, "plain text is NOT an upload");
  ok(MAX_UPLOAD_BYTES === 20 * 1024 * 1024, "cap is exactly Telegram's 20 MB");
}

// ---------- Whisper response -> cues ----------
{
  // one long segment with word timings must split into <=6.5s cues
  const words = [];
  let t = 0;
  for (const w of "And so my fellow Americans ask not what your country can do for you ask what you can do for your country".split(" ")) {
    words.push({ word: w, start: t, end: t + 0.4 });
    t += 0.47;
  }
  const cues = cuesFromWhisperSegments([{ start: 0, end: t, text: words.map((w) => w.word).join(" "), words }]);
  ok(cues.length >= 2, "long word-timed segment splits into multiple cues");
  ok(cues.every((c) => c.endMs - c.startMs <= 6600), "split cues stay within ~6.5s");
  ok(cues.map((c) => c.text).join(" ").startsWith("And so my fellow"), "split preserves the words in order");
  // short segment without words stays whole
  const one = cuesFromWhisperSegments([{ start: 1, end: 4.5, text: "  Hello   there " }]);
  ok(one.length === 1 && one[0].text === "Hello there" && one[0].startMs === 1000 && one[0].endMs === 4500, "short segment stays one cue, whitespace collapsed");
  // long segment without words splits by text with proportional timings
  const longText = Array.from({ length: 40 }, (_, i) => "word" + i).join(" ");
  const split = cuesFromWhisperSegments([{ start: 0, end: 20, text: longText }]);
  ok(split.length >= 3 && split[0].startMs === 0 && split[split.length - 1].endMs === 20000, "long word-less segment splits proportionally");
}
{
  const vtt = "WEBVTT\n\n00:00.000 --> 00:02.480\nAnd so my fellow Americans\n\n --> 05.000\nask not what your country\n\n00:05.500 --> 00:07.000\ncan do for you";
  const cues = parseWhisperVtt(vtt);
  ok(cues.length === 3, "VTT parses all cues");
  ok(cues[1].startMs === 2480, "blank VTT start falls back to the previous cue's end");
  ok(cues[2].startMs === 5500 && cues[2].endMs === 7000, "HH-less timestamps parse");
}
{
  // transcribe: turbo segments win; detected language passes through
  const envTurbo = { AI: { run: async (model) => model.includes("turbo")
    ? { transcription_info: { language: "en" }, segments: [{ start: 0, end: 2, text: "Hello world", words: [{ word: "Hello", start: 0, end: 0.5 }, { word: "world", start: 0.6, end: 2 }] }], text: "Hello world" }
    : { text: "", vtt: "" } } };
  const r = await transcribeUploadedAudio(new Uint8Array([1, 2, 3]), envTurbo);
  ok(r.source === "whisper_turbo" && r.cues.length === 1 && r.languageCode === "en", "turbo result becomes cues with language");
  // turbo empty -> classic VTT fallback
  const envClassic = { AI: { run: async (model) => model.includes("turbo")
    ? { segments: [], text: "" }
    : { text: "hi", vtt: "WEBVTT\n\n00:00.000 --> 00:01.500\nhi there" } } };
  const r2 = await transcribeUploadedAudio(new Uint8Array([1]), envClassic);
  ok(r2.source === "whisper_vtt" && r2.cues.length === 1 && r2.cues[0].text === "hi there", "classic VTT fallback works");
  // responded but no speech -> NO_CAPTIONS AppError
  const envEmpty = { AI: { run: async () => ({ segments: [], text: "", vtt: "" }) } };
  let code = null;
  try { await transcribeUploadedAudio(new Uint8Array([1]), envEmpty); } catch (e) { code = e.code; }
  ok(code === "NO_CAPTIONS", "no speech in file -> NO_CAPTIONS");
}

// ---------- fakes for handler/job tests ----------
function makeKv() {
  const store = new Map();
  return {
    store,
    get: async (k, type) => { const v = store.get(k); return v == null ? null : type === "json" ? JSON.parse(v) : type === "arrayBuffer" ? new TextEncoder().encode(v).buffer : v; },
    put: async (k, v) => { store.set(k, typeof v === "string" ? v : new TextDecoder().decode(v)); },
    delete: async (k) => { store.delete(k); }
  };
}
function makeDb() {
  const jobs = [];
  let seq = 0;
  const norm = (sql) => sql.replace(/\s+/g, " ");
  return {
    jobs,
    prepare(sql) {
      const q = norm(sql);
      let args = [];
      const s = {
        bind(...a) { args = a; return s; },
        async first() {
          if (q.includes("FROM settings")) return null;
          if (q.includes("SELECT subtitle_lang FROM users")) return { subtitle_lang: "fa" };
          if (q.includes("SELECT is_blocked FROM users")) return { is_blocked: 0 };
          if (q.includes("SELECT COUNT(*) AS cnt FROM jobs")) return { cnt: 0 };
          if (q.includes("status = 'processing'")) return null;
          return null;
        },
        async run() {
          if (q.startsWith("INSERT INTO jobs")) {
            const row = { id: ++seq, telegram_id: args[0], video_id: args[1], video_url: args[2], target_language: args[4], status: "processing" };
            jobs.push(row);
            return { meta: { changes: 1, last_row_id: row.id } };
          }
          if (q.includes("SET status = 'completed'")) { const r = jobs.find((j) => j.id === args[0]); if (r) r.status = "completed"; return { meta: { changes: 1 } }; }
          if (q.includes("SET status = 'failed'")) { const r = jobs.find((j) => j.id === args[0]); if (r) r.status = "failed"; return { meta: { changes: 1 } }; }
          return { meta: { changes: 1 } };
        },
        async all() { return { results: [] }; }
      };
      return s;
    }
  };
}
function makeTg(extra = {}) {
  const sent = [];
  return {
    sent,
    platform: "telegram",
    pendKeyPrefix: "pend:",
    sendMessage: async (chatId, text, opts) => { sent.push({ text, opts }); return { ok: true, result: { message_id: 42 } }; },
    editMessageText: async () => ({ ok: true }),
    deleteMessage: async () => ({ ok: true }),
    answerCallbackQuery: async () => ({ ok: true }),
    sendDocumentByUrl: async () => ({ ok: true, result: {} }),
    sendSrtDocument: async () => ({ ok: true, result: {} }),
    ...extra
  };
}

// ---------- intake via the shared handler ----------
{
  const kv = makeKv();
  const tg = makeTg();
  const env = { DB: makeDb(), SUBTITLE_CACHE: kv };
  const upd = { message: { message_id: 7, chat: { id: 555 }, from: { id: 555, first_name: "T" }, video: { file_id: "VID1", file_size: 5_000_000, file_name: "clip.mp4" } } };
  await handleTelegramUpdate(upd, env, tg);
  const pendKey = [...kv.store.keys()].find((k) => k.startsWith("pend:"));
  ok(!!pendKey, "video intake stores a pending choice");
  const pend = JSON.parse(kv.store.get(pendKey));
  ok(pend.upload?.fileId === "VID1" && pend.upload?.kind === "video" && !pend.links, "pend payload references the file, not links");
  ok(tg.sent.length === 1 && tg.sent[0].opts?.reply_markup?.inline_keyboard?.length === 1, "choice keyboard sent with the upload prompt");
}
{
  // over-cap file: rejected at intake, no pend stored
  const kv = makeKv();
  const tg = makeTg();
  const env = { DB: makeDb(), SUBTITLE_CACHE: kv };
  const upd = { message: { message_id: 8, chat: { id: 556 }, from: { id: 556, first_name: "T" }, video: { file_id: "BIG", file_size: 21 * 1024 * 1024 } } };
  await handleTelegramUpdate(upd, env, tg);
  ok(tg.sent.length === 1 && tg.sent[0].text.includes("۲۰ مگابایت"), "21 MB video rejected with the cap message");
  ok(![...kv.store.keys()].some((k) => k.startsWith("pend:")), "no pend stored for the rejected file");
}
{
  // pdf document keeps the historical invalid-link behavior
  const tg = makeTg();
  const env = { DB: makeDb(), SUBTITLE_CACHE: makeKv() };
  const upd = { message: { message_id: 9, chat: { id: 557 }, from: { id: 557, first_name: "T" }, document: { file_id: "PDF", mime_type: "application/pdf" } } };
  await handleTelegramUpdate(upd, env, tg);
  ok(tg.sent.length === 1 && tg.sent[0].text.includes("لینک معتبر"), "pdf document gets the invalid-link reply, as before");
}

// ---------- choice callback with an upload pend ----------
{
  const kv = makeKv();
  const queuePayloads = [];
  const tg = makeTg();
  const env = { DB: makeDb(), SUBTITLE_CACHE: kv, JOB_QUEUE: { send: async (p) => { queuePayloads.push(p); } } };
  await kv.put("pend:abc123456789", JSON.stringify({ userId: 555, chatId: 555, linkMessageId: 7, upload: { token: "abc123456789", fileId: "VID1", fileSize: 100, kind: "video", fileName: "clip.mp4" }, truncated: false }));
  const cq = { id: "cb1", data: "c:srt:abc123456789", from: { id: 555, first_name: "T" }, message: { message_id: 43, chat: { id: 555 } } };
  await handleCallbackQuery({ callback_query: cq }, env, tg);
  ok(queuePayloads.length === 1, "upload choice enqueues exactly one job");
  ok(queuePayloads[0].upload?.fileId === "VID1" && queuePayloads[0].mode === "srt", "queue payload carries the upload + chosen mode");
  ok(queuePayloads[0].lang === "fa", "queue payload pins the user's stored language");
  ok(!("upload" in buildQueueMessage({ chatId: 1, user: { id: 1 }, messageId: 1, links: [{ videoId: "x" }], mode: "srt" })), "link queue payloads stay upload-free (byte-identical)");
}

// ---------- processUploadJob end-to-end ----------
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("coarena.ai")) {
    const body = JSON.parse(options.body);
    const userPrompt = body.messages[1].content;
    const items = JSON.parse(userPrompt.split("\n\n").pop());
    const out = items.map((it) => ({ id: it.id, fa: "FA:" + it.text }));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ items: out }) } }], usage: { total_tokens: 2 } }) };
  }
  throw new Error("unexpected fetch: " + u);
};
function fakeAiTurbo() {
  const words = [];
  let t = 0;
  for (const w of "And so my fellow Americans ask not what your country can do for you".split(" ")) {
    words.push({ word: w, start: t, end: t + 0.35 });
    t += 0.42;
  }
  return { run: async (model) => {
    if (!model.includes("turbo")) throw new Error("classic should not be called");
    return { transcription_info: { language: "en" }, segments: [{ start: 0, end: t, text: words.map((w) => w.word).join(" "), words }], text: words.map((w) => w.word).join(" ") };
  } };
}
{
  const db = makeDb();
  const kv = makeKv();
  let delivered = null;
  const tg = makeTg({
    downloadFile: async () => new Uint8Array(2048),
    sendDocumentByUrl: async (chatId, url, caption) => { delivered = { url, caption }; return { ok: true, result: {} }; }
  });
  const env = { DB: db, SUBTITLE_CACHE: kv, AI: fakeAiTurbo(), COARENA_API_KEY: "test-key" };
  const outcome = await processUploadJob({
    env, tg, chatId: 555, user: { id: 555, first_name: "T" }, message: { message_id: 7 },
    upload: { token: "e2etesttoken", fileId: "VID1", fileSize: 2048, kind: "video", fileName: "clip.mp4" },
    mode: "srt", targetLang: "fa"
  });
  ok(outcome === "ok", "upload job completes end-to-end");
  const job = db.jobs.find((j) => j.video_id === "upload:e2etesttoken");
  ok(!!job && job.status === "completed", "job row recorded under upload:<token> and completed");
  ok(job.target_language === "fa", "job row carries the target language");
  ok(!!delivered, "SRT delivered (by-url rung)");
  const fileKey = [...kv.store.keys()].find((k) => k.startsWith("file:"));
  ok(!!fileKey && kv.store.get(fileKey).includes("FA:And so"), "stored SRT contains the translated lines");
  ok([...kv.store.keys()].some((k) => k === "cap2:upload:e2etesttoken"), "transcribed cues cached under cap2:upload:<token>");
}
{
  // downloaded bytes over the cap -> job fails with the cap message
  const db = makeDb();
  const kv = makeKv();
  const edits = [];
  const tg = makeTg({
    downloadFile: async () => new Uint8Array(MAX_UPLOAD_BYTES + 1),
    editMessageText: async (c, m, text) => { edits.push(text); return { ok: true }; }
  });
  const env = { DB: db, SUBTITLE_CACHE: kv, AI: fakeAiTurbo(), COARENA_API_KEY: "test-key" };
  const outcome = await processUploadJob({
    env, tg, chatId: 555, user: { id: 555, first_name: "T" }, message: { message_id: 7 },
    upload: { token: "bigtesttoken", fileId: "BIG", fileSize: 0, kind: "video", fileName: "big.mp4" },
    mode: "srt", targetLang: "fa"
  });
  ok(outcome === "error", "over-cap download fails the job");
  ok(edits.some((t) => t.includes("۲۰ مگابایت")), "user sees the 20 MB cap message");
  ok(db.jobs.find((j) => j.video_id === "upload:bigtesttoken")?.status === "failed", "job row marked failed");
}
globalThis.fetch = realFetch;

console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
