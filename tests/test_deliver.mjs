// Offline tests for the delivery ladder (Telegram media-ingress incident):
// URL delivery -> classic upload -> subtitle as text chunks, so the user
// always receives the translation even when Telegram file sends are down.
import { deliverSrt, splitSrtForTextDelivery } from "/tmp/test_bundle.mjs";

let fails = 0;
const ok = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + " " + label); if (!cond) fails++; };

const SRT = "\uFEFF" + Array.from({ length: 30 }, (_, i) =>
  `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},900\nمتن زیرنویس شماره ${i + 1} برای آزمون تحویل`
).join("\n\n");

function fakeEnv() {
  const store = new Map();
  return { SUBTITLE_CACHE: { put: async (k, v) => { store.set(k, v); }, get: async (k) => store.get(k) ?? null }, _store: store };
}

// --- splitting keeps every block intact and rejoins losslessly ---
const chunks = splitSrtForTextDelivery(SRT, 500);
ok(chunks.length > 1, "long SRT splits into multiple chunks");
ok(chunks.every((c) => c.length <= 500), "every chunk within the limit");
ok(chunks.join("\n\n") === SRT.replace(/^\uFEFF/, ""), "chunks rejoin to the exact original (minus BOM)");
ok(splitSrtForTextDelivery("1\n00:00:01,000 --> 00:00:02,000\nسلام", 3500).length === 1, "short SRT stays one chunk");

// --- ladder step 1: URL delivery succeeds -> stop there ---
{
  const calls = [];
  const tg = {
    sendDocumentByUrl: async () => { calls.push("url"); return { message_id: 1 }; },
    sendSrtDocument: async () => { calls.push("upload"); return { message_id: 2 }; },
    sendMessage: async () => { calls.push("text"); return { ok: true }; }
  };
  const how = await deliverSrt(fakeEnv(), tg, 1, SRT, "cap", null);
  ok(how === "url" && calls.join() === "url", "URL success -> delivered by URL only");
}

// --- ladder step 2: URL fails -> classic upload ---
{
  const calls = [];
  const tg = {
    sendDocumentByUrl: async () => { calls.push("url"); throw new Error("failed to get HTTP URL content"); },
    sendSrtDocument: async () => { calls.push("upload"); return { message_id: 2 }; },
    sendMessage: async () => { calls.push("text"); return { ok: true }; }
  };
  const how = await deliverSrt(fakeEnv(), tg, 1, SRT, "cap", null);
  ok(how === "upload" && calls.join() === "url,upload", "URL failure -> falls back to upload");
}

// --- ladder step 3: both file routes fail -> text chunks, complete content ---
{
  const BIG = Array.from({ length: 90 }, (_, i) =>
    `${i + 1}\n00:00:${String(i % 60).padStart(2, "0")},000 --> 00:00:${String(i % 60).padStart(2, "0")},900\nمتن زیرنویس شماره ${i + 1} برای آزمون تحویل`
  ).join("\n\n");
  const sent = [];
  const tg = {
    sendDocumentByUrl: async () => { throw new Error("url fail"); },
    sendSrtDocument: async () => { throw new Error("The operation was aborted"); },
    sendMessage: async (chatId, text) => { sent.push(text); return { ok: true }; }
  };
  const how = await deliverSrt(fakeEnv(), tg, 1, BIG, "عنوان ویدیو", null);
  ok(how === "text", "both file routes down -> text delivery");
  ok(sent.length >= 2, "text delivered in multiple messages");
  ok(sent[0].includes("عنوان ویدیو"), "first text message carries the caption");
  const body = sent.map((m) => m.replace(/^[\s\S]*?:\n\n/, "").replace(/^\(\d+\/\d+\)\n\n/, "")).join("\n\n");
  ok(body === BIG, "text chunks together contain the complete SRT");
}

console.log(fails === 0 ? "ALL DELIVER TESTS PASSED" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
