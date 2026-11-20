// Offline tests for the delivery ladder (Telegram media-ingress incident):
// URL delivery -> classic upload -> ONE message with the direct download
// link. Since 2026-11-18 (Arshia's call) the subtitle is NEVER dumped into
// the chat as text chunks.
import { deliverSrt } from "/tmp/test_bundle.mjs";

let fails = 0;
const ok = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + " " + label); if (!cond) fails++; };

const SRT = "\uFEFF" + Array.from({ length: 30 }, (_, i) =>
  `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},900\nمتن زیرنویس شماره ${i + 1} برای آزمون تحویل`
).join("\n\n");

function fakeEnv() {
  const store = new Map();
  return { SUBTITLE_CACHE: { put: async (k, v) => { store.set(k, v); }, get: async (k) => store.get(k) ?? null }, _store: store };
}

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

// --- ladder step 3: both file routes fail -> ONE link message, no SRT text ---
{
  const sent = [];
  const tg = {
    sendDocumentByUrl: async () => { throw new Error("url fail"); },
    sendSrtDocument: async () => { throw new Error("The operation was aborted"); },
    sendMessage: async (chatId, text) => { sent.push(text); return { ok: true }; }
  };
  const how = await deliverSrt(fakeEnv(), tg, 1, SRT, "عنوان ویدیو", null);
  ok(how === "link", "both file routes down -> link delivery");
  ok(sent.length === 1, "exactly one fallback message");
  ok(sent[0].includes("عنوان ویدیو"), "link message carries the caption");
  ok(/\/f\/[a-f0-9]+\/subtitle\.fa\.srt/.test(sent[0]), "link message carries the /f/ download URL");
  ok(!sent[0].includes("متن زیرنویس شماره"), "no subtitle text dumped into the chat");
}

// --- ladder step 4: file store also unavailable -> plain failure note ---
{
  const sent = [];
  const env = { SUBTITLE_CACHE: { put: async () => { throw new Error("kv down"); }, get: async () => null } };
  const tg = {
    sendDocumentByUrl: async () => { throw new Error("url fail"); },
    sendSrtDocument: async () => { throw new Error("upload fail"); },
    sendMessage: async (chatId, text) => { sent.push(text); return { ok: true }; }
  };
  const how = await deliverSrt(env, tg, 1, SRT, "عنوان ویدیو", null);
  ok(how === "failed", "no file anywhere -> failed");
  ok(sent.length === 1 && !sent[0].includes("/f/"), "one failure note without a link");
  ok(!sent[0].includes("متن زیرنویس شماره"), "still no subtitle text in the chat");
}

console.log(fails === 0 ? "ALL DELIVER TESTS PASSED" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
