// Offline tests for the liveness fixes (job 79 incident): a dead execution
// must not look "running" forever, and Coarena attempts must respect the
// job deadline instead of stretching one chunk to ~190s.
import {
  snapshotLiveness, renderStatusMessage, translateChunkViaCoarenaById, buildQueueMessage
} from "/tmp/test_bundle.mjs";

let fails = 0;
const ok = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + " " + label); if (!cond) fails++; };

// --- snapshotLiveness ---
const now = 1_000_000_000_000;
ok(snapshotLiveness(null, now) === "missing", "no snapshot -> missing");
ok(snapshotLiveness({ status: "done", updatedAt: now - 999999 }, now) === "final", "finished snapshot -> final regardless of age");
ok(snapshotLiveness({ status: "running", updatedAt: now - 1000 }, now) === "live", "fresh running snapshot -> live");
ok(snapshotLiveness({ status: "running", updatedAt: now - 200000 }, now) === "stalled", "running snapshot silent for 200s -> stalled");
ok(snapshotLiveness({ status: "running", startedAt: now - 200000 }, now) === "stalled", "missing updatedAt falls back to startedAt");

// --- /status tells the truth about a dead job ---
const stalledMsg = renderStatusMessage(
  { video_id: "YNeCr6Klk8M" },
  { status: "running", progress: 0, total: 129, processed: 0, succeeded: 0, failed: 0, token: "413f3325190d1ddb", updatedAt: Date.now() - 200000, startedAt: Date.now() - 200000 }
);
ok(stalledMsg.includes("متوقف شده"), "stalled job -> /status says it stopped");
ok(!stalledMsg.includes("در حال پردازش"), "stalled job -> /status does not claim it is running");
const liveMsg = renderStatusMessage(
  { video_id: "YNeCr6Klk8M" },
  { status: "running", progress: 40, successRate: 100, total: 10, processed: 4, succeeded: 4, failed: 0, token: "0123456789abcdef", updatedAt: Date.now(), startedAt: Date.now() }
);
ok(liveMsg.includes("در حال پردازش"), "fresh job -> /status shows running normally");

// --- Coarena deadline: a hanging provider must not stretch past the deadline ---
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
  const sig = opts.signal;
  if (sig) {
    if (sig.aborted) return reject(new Error("aborted"));
    sig.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }
  // never resolves on its own: simulates a stalled Coarena response
});
const chunk = [{ index: 0, startMs: 0, endMs: 1000, text: "Hello" }];
const t0 = Date.now();
const res = await translateChunkViaCoarenaById(chunk, "k", "gemini-4-argon", {}, "English", Date.now() + 400);
const elapsed = Date.now() - t0;
ok(res && res.ok === false, "hanging provider + near deadline -> chunk fails instead of hanging");
ok(elapsed < 5000, `deadline respected (elapsed ${elapsed}ms, not ~190s)`);

// --- Coarena without deadline still works on a healthy response ---
globalThis.fetch = async () => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ items: [{ id: 0, fa: "سلام" }] }) } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
}), { status: 200, headers: { "Content-Type": "application/json" } });
const res2 = await translateChunkViaCoarenaById(chunk, "k", "gemini-4-argon", {}, "English", Date.now() + 60000);
ok(res2 && res2.ok === true && res2.byId.get(0) === "سلام", "healthy provider + deadline -> translation succeeds");
globalThis.fetch = realFetch;

// --- Queue message shape (webhook -> consumer contract) ---
const qm = buildQueueMessage({ chatId: 111, user: { id: 222, first_name: "A", username: "u", is_bot: false }, messageId: 333, links: [{ videoId: "u2MfX-J1_zo", url: "https://youtu.be/u2MfX-J1_zo" }], mode: "srt", truncated: false });
ok(qm.chatId === 111 && qm.user.id === 222 && qm.messageId === 333 && qm.mode === "srt", "queue message carries chat/user/message/mode");
ok(Array.isArray(qm.links) && qm.links.length === 1 && qm.truncated === false, "queue message carries links + truncated flag");
ok(!("is_bot" in qm.user), "queue message keeps only the user fields the consumer needs");
const qm2 = buildQueueMessage({ chatId: 1, user: { id: 2 }, messageId: undefined, links: [], mode: undefined, truncated: 1 });
ok(qm2.messageId === null && qm2.mode === "both" && qm2.truncated === true, "queue message defaults: messageId null, mode both");

console.log(fails === 0 ? "ALL LIVENESS TESTS PASSED" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
