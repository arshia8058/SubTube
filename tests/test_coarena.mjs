// Offline tests for the Coarena translation provider inside the real pipeline.
import assert from "node:assert";

const S = { mode: "ok-wrapped", callsByChunk: new Map() };
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
function geminiReply(payloadText, status = 200) {
  return { ok: status >= 200 && status < 300, status,
    json: async () => ({ candidates: [{ content: { parts: [{ text: payloadText }] } }] }) };
}
function itemsFrom(text) {
  const start = text.lastIndexOf('[{"id":');
  return JSON.parse(text.slice(start));
}
function handleCoarena(options) {
  const body = JSON.parse(options.body);
  assert.strictEqual(body.model, "claude-sonnet-5-5", "default model must be the documented id");
  const items = itemsFrom(body.messages[1].content);
  const firstId = items[0].id;
  const n = (S.callsByChunk.get(firstId) || 0) + 1;
  S.callsByChunk.set(firstId, n);
  const good = items.map((it) => ({ id: it.id, fa: "FA:" + it.text }));
  switch (S.mode) {
    case "ok-wrapped":
      return coarenaReply(JSON.stringify({ items: [...good].reverse() })); // shuffled order on purpose
    case "ok-bare-array":
      return coarenaReply(JSON.stringify(good));
    case "prose-wrapped":
      return coarenaReply("Here is the translation:\n" + JSON.stringify({ items: good }) + "\nDone.");
    case "retry-429":
      return n === 1 ? coarenaReply("", 429) : coarenaReply(JSON.stringify({ items: good }));
    case "missing-id":
      return coarenaReply(JSON.stringify({ items: good.slice(1) })); // one id missing, always
    case "auth":
      return coarenaReply("", 401);
    default: throw new Error("mode " + S.mode);
  }
}
function handleGemini(options) {
  const body = JSON.parse(options.body);
  const items = itemsFrom(body.contents[0].parts[0].text);
  return geminiReply(JSON.stringify(items.map((it) => ({ id: it.id, fa: "FA:" + it.text }))));
}
function handleGoogle(options) {
  const q = new URLSearchParams(options.body).get("q") || "";
  const t = q.includes("[[[")
    ? q.split("\n").map((l) => (/^\[\[\[\d+\]\]\]$/.test(l.trim()) || !l.trim() ? l : "FA:" + l)).join("\n")
    : "FA:" + q;
  return { ok: true, status: 200, json: async () => [[[t, q]]] };
}
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("coarena.ai")) return handleCoarena(options);
  if (u.includes("generativelanguage.googleapis.com")) return handleGemini(options);
  if (u.includes("translate.googleapis.com")) return handleGoogle(options);
  throw new Error("unexpected fetch " + u);
};

const { translateCuesToPersian } = await import("/tmp/test_bundle.mjs");
const N = 150;
const cues = Array.from({ length: N }, (_, i) => ({
  startMs: i * 4000, endMs: i * 4000 + 3200, text: `Cue ${i} unique line number ${i}`
}));
const ENV = { GEMINI_API_KEY: "g-key", COARENA_API_KEY: "c-key" };

function checkAligned(out, label) {
  assert.strictEqual(out.length, N, label + ": count");
  for (let i = 0; i < N; i++) {
    assert.strictEqual(out[i].startMs, cues[i].startMs, `${label}: startMs at ${i}`);
    assert.strictEqual(out[i].endMs, cues[i].endMs, `${label}: endMs at ${i}`);
    assert.strictEqual(out[i].text, "FA:" + cues[i].text, `${label}: text at ${i}`);
  }
  console.log(label + ": PASS (150/150 aligned)");
}

for (const mode of ["ok-wrapped", "ok-bare-array", "prose-wrapped", "retry-429", "missing-id", "auth"]) {
  S.mode = mode; S.callsByChunk = new Map();
  const usage = {};
  const out = await translateCuesToPersian(cues, null, ENV, usage);
  checkAligned(out, "coarena scenario " + mode);
  assert.strictEqual(usage.provider, "coarena");
  assert.strictEqual(usage.model, "claude-sonnet-5-5");
  if (mode === "ok-wrapped") {
    assert.strictEqual(usage.chunksByProvider.coarena, 2, "both chunks via coarena");
    assert.strictEqual(usage.requests, 2);
    assert.strictEqual(usage.totalTokens, 300, "usage tokens accumulated");
    console.log("  usage accounting: PASS", JSON.stringify(usage));
  }
  if (mode === "retry-429") {
    assert.ok(usage.retries >= 2, "retries recorded");
    assert.strictEqual(usage.chunksByProvider.coarena, 2);
    console.log("  retry with backoff: PASS (retries=" + usage.retries + ", requests=" + usage.requests + ")");
  }
  if (mode === "missing-id") {
    assert.strictEqual(usage.chunksByProvider.coarena, undefined, "invalid output must not be used");
    assert.strictEqual(usage.chunksByProvider.gemini, 2, "fell back to gemini per chunk");
    console.log("  invalid output rejected, gemini fallback: PASS");
  }
  if (mode === "auth") {
    assert.strictEqual(usage.chunksByProvider.gemini, 2, "auth failure disables coarena, gemini used");
    console.log("  auth fallback: PASS");
  }
}
console.log("ALL COARENA TESTS PASSED");
