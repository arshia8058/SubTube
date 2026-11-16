// Offline tests for the two-key Coarena pool: rotation on auth (401) and
// quota (402), Gemini fallback when all keys are rejected, single-key regression.
import assert from "node:assert";

const S = { keyStatus: { KEY1: 200, KEY2: 200 }, calls: [] };

function coarenaReply(content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => status === 200
      ? { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      : { error: { message: "mock error" } }
  };
}
function itemsFrom(text) {
  const start = text.lastIndexOf('[{"id":');
  return JSON.parse(text.slice(start));
}
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("coarena.ai")) {
    const auth = options.headers?.Authorization || "";
    const key = auth.replace("Bearer ", "");
    S.calls.push(key);
    const status = S.keyStatus[key] ?? 200;
    if (status !== 200) return coarenaReply("", status);
    const body = JSON.parse(options.body);
    const items = itemsFrom(body.messages[1].content);
    const good = items.map((it) => ({ id: it.id, fa: "FA:" + it.text }));
    return coarenaReply(JSON.stringify({ items: good }));
  }
  if (u.includes("generativelanguage.googleapis.com")) {
    const body = JSON.parse(options.body);
    const items = itemsFrom(body.contents[0].parts[0].text);
    return {
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(items.map((it) => ({ id: it.id, fa: "FA:" + it.text }))) }] } }] })
    };
  }
  if (u.includes("translate.googleapis.com")) {
    const q = new URLSearchParams(options.body).get("q") || "";
    return { ok: true, status: 200, json: async () => [[[("FA:" + q), q]]] };
  }
  throw new Error("unexpected fetch " + u);
};

const { translateCuesToPersian } = await import("/tmp/test_bundle.mjs");
const cues = Array.from({ length: 30 }, (_, i) => ({
  startMs: i * 4000, endMs: i * 4000 + 3200, text: `Line ${i} with some spoken words`
}));
function checkAligned(out, label) {
  assert.strictEqual(out.length, 30, label + ": count");
  for (let i = 0; i < 30; i++) {
    assert.strictEqual(out[i].text, "FA:" + cues[i].text, `${label}: text at ${i}`);
    assert.strictEqual(out[i].startMs, cues[i].startMs, `${label}: startMs at ${i}`);
  }
}

// A: key1 rejected with 401 -> key2 takes over
{
  S.keyStatus = { KEY1: 401, KEY2: 200 };
  S.calls = [];
  const usage = {};
  const out = await translateCuesToPersian(cues, null, { COARENA_API_KEY: "KEY1", COARENA_API_KEY_2: "KEY2" }, usage);
  checkAligned(out, "A");
  assert.strictEqual(usage.chunksByProvider.coarena, 1, "A: chunk via coarena");
  assert.strictEqual(usage.coarenaKeyUsed, 2, "A: second key used");
  assert.strictEqual(S.calls[0], "KEY1", "A: first key tried first");
  assert.strictEqual(S.calls[1], "KEY2", "A: rotated to second key");
  console.log("A (401 rotation): PASS");
}

// B: key1 quota-exhausted with 402 -> key2 takes over
{
  S.keyStatus = { KEY1: 402, KEY2: 200 };
  S.calls = [];
  const usage = {};
  const out = await translateCuesToPersian(cues, null, { COARENA_API_KEY: "KEY1", COARENA_API_KEY_2: "KEY2" }, usage);
  checkAligned(out, "B");
  assert.strictEqual(usage.coarenaKeyUsed, 2, "B: second key used after 402");
  console.log("B (402 quota rotation): PASS");
}

// C: both keys rejected -> Gemini fallback, output still aligned
{
  S.keyStatus = { KEY1: 401, KEY2: 403 };
  S.calls = [];
  const usage = {};
  const out = await translateCuesToPersian(cues, null, { COARENA_API_KEY: "KEY1", COARENA_API_KEY_2: "KEY2", GEMINI_API_KEY: "G" }, usage);
  checkAligned(out, "C");
  assert.strictEqual(usage.chunksByProvider.coarena, undefined, "C: coarena unused");
  assert.strictEqual(usage.chunksByProvider.gemini, 1, "C: gemini fallback used");
  console.log("C (all keys rejected -> gemini): PASS");
}

// D: single key only -> unchanged behavior, key 1 used
{
  S.keyStatus = { KEY1: 200 };
  S.calls = [];
  const usage = {};
  const out = await translateCuesToPersian(cues, null, { COARENA_API_KEY: "KEY1" }, usage);
  checkAligned(out, "D");
  assert.strictEqual(usage.coarenaKeyUsed, 1, "D: first key used");
  assert.deepStrictEqual(S.calls, ["KEY1"], "D: only key1 called");
  console.log("D (single key regression): PASS");
}

console.log("ALL KEY-ROTATION TESTS PASSED");
