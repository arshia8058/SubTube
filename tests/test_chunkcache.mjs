// Offline tests for the per-chunk translation result cache (chunkfa1:):
// a second run of the same video must reuse finished chunks instead of
// re-buying them from the provider, and a corrupted/misaligned entry must
// be rejected and re-translated, never applied.
import assert from "node:assert";

const FAKE_USAGE = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };

function coarenaReply(content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => status === 200
      ? { choices: [{ message: { content } }], usage: FAKE_USAGE }
      : { error: { message: "mock error" } }
  };
}
function itemsFrom(text) {
  const start = text.lastIndexOf('[{"id":');
  return JSON.parse(text.slice(start));
}
function handleCoarena(options) {
  const body = JSON.parse(options.body);
  const items = itemsFrom(body.messages[1].content);
  const good = items.map((it) => ({ id: it.id, fa: "FA:" + it.text }));
  return coarenaReply(JSON.stringify({ items: good }));
}
function handleGoogle(options) {
  const q = new URLSearchParams(options.body).get("q") || "";
  const t = q.includes("[[[")
    ? q.split("\n").map((l) => (/^\[\[\[\d+\]\]\]$/.test(l.trim()) || !l.trim() ? l : "FA:" + l)).join("\n")
    : "FA:" + q;
  return { ok: true, status: 200, json: async () => [[[t, q]]] };
}
let fetchMode = "ok";
globalThis.fetch = async (url, options = {}) => {
  if (fetchMode === "down") throw new Error("network down (mock)");
  const u = String(url);
  if (u.includes("coarena.ai")) return handleCoarena(options);
  if (u.includes("translate.googleapis.com")) return handleGoogle(options);
  throw new Error("unexpected fetch " + u);
};

// Minimal KV stand-in with the Cloudflare get/put surface the code uses.
const kvStore = new Map();
const fakeKv = {
  get: async (key, type) => {
    const v = kvStore.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  },
  put: async (key, value) => { kvStore.set(key, String(value)); },
  delete: async (key) => { kvStore.delete(key); }
};

const { translateCuesToPersian } = await import("/tmp/test_bundle.mjs");
const N = 45; // -> 2 chunks (40 + 5) at the 40-item cap
const cues = Array.from({ length: N }, (_, i) => ({
  startMs: i * 4000, endMs: i * 4000 + 3200, text: `Cue ${i} unique line number ${i}`
}));
const VIDEO_ID = "dQw4w9WgXcQ";
const ENV = { COARENA_API_KEY: "k1", GEMINI_API_KEY: "g1", SUBTITLE_CACHE: fakeKv };

function checkAligned(out, label) {
  assert.strictEqual(out.length, N, label + ": count");
  for (let i = 0; i < N; i++) {
    assert.strictEqual(out[i].startMs, cues[i].startMs, `${label}: startMs at ${i}`);
    assert.strictEqual(out[i].endMs, cues[i].endMs, `${label}: endMs at ${i}`);
    assert.strictEqual(out[i].text, "FA:" + cues[i].text, `${label}: text at ${i}`);
  }
  console.log(label + ": PASS (45/45 aligned)");
}

// Run 1: cold cache — both chunks go to the provider and get stored.
const usage1 = {};
const out1 = await translateCuesToPersian(cues, null, ENV, usage1, "en", VIDEO_ID);
checkAligned(out1, "run 1 (cold cache)");
assert.strictEqual(usage1.requests, 2, "run 1 must call the provider once per chunk");
const chunkKeys = [...kvStore.keys()].filter((k) => k.startsWith("chunkfa1:"));
assert.strictEqual(chunkKeys.length, 2, "run 1 must store one entry per chunk, got: " + chunkKeys.join(","));
console.log("  run 1 stored 2 chunk entries: PASS");

// Run 2: provider completely down — the cached chunks must carry the job
// with zero provider requests.
fetchMode = "down";
const usage2 = {};
const out2 = await translateCuesToPersian(cues, null, ENV, usage2, "en", VIDEO_ID);
checkAligned(out2, "run 2 (warm cache, provider down)");
assert.ok(!usage2.requests, "run 2 must not call the provider at all, got requests=" + usage2.requests);
assert.strictEqual(usage2.progress.chunksOk, 2, "run 2: both chunks counted ok from cache");
assert.strictEqual(usage2.progress.succeeded, N, "run 2: all cues succeeded from cache");
console.log("  run 2 resumed fully from cache with 0 requests: PASS");

// Run 3: corrupt chunk 1's entry (shifted ids) — it must be rejected and
// re-translated; chunk 0 still comes from cache (exactly 1 provider call).
fetchMode = "ok";
const badKey = chunkKeys.find((k) => k.endsWith(":1"));
const storedBad = JSON.parse(kvStore.get(badKey));
storedBad.items = storedBad.items.map((it) => ({ index: it.index + 1000, translatedText: it.translatedText }));
kvStore.set(badKey, JSON.stringify(storedBad));
const usage3 = {};
const out3 = await translateCuesToPersian(cues, null, ENV, usage3, "en", VIDEO_ID);
checkAligned(out3, "run 3 (one corrupted entry)");
assert.strictEqual(usage3.requests, 1, "run 3 must re-translate only the corrupted chunk, got requests=" + usage3.requests);
console.log("  run 3 rejected the misaligned entry and re-translated 1 chunk: PASS");

console.log("ALL CHUNK-CACHE TESTS PASSED");
