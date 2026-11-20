// Offline tests: the Gemini provider path must try gemini-3.1-flash-lite
// first (Arshia's choice since 2026-11-18: it was by far the fastest
// Gemini model in the live probe, 0.45s) and fall back to the other
// candidates only if it is unavailable.
import assert from "node:assert";

const S = { failLite: false, geminiCalls: [] };

function itemsFrom(text) {
  const start = text.lastIndexOf('[{"id":');
  return JSON.parse(text.slice(start));
}
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("generativelanguage.googleapis.com")) {
    const model = u.split("/models/")[1].split(":")[0];
    S.geminiCalls.push(model);
    if (model === "gemini-3.1-flash-lite" && S.failLite) {
      return { ok: false, status: 404, json: async () => ({ error: { message: "model not found" } }) };
    }
    const body = JSON.parse(options.body);
    const items = itemsFrom(body.contents[0].parts[0].text);
    const payload = JSON.stringify(items.map((it) => ({ id: it.id, fa: "FA:" + it.text })));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: payload }] } }] }) };
  }
  throw new Error("unexpected fetch " + u);
};

const { translateCuesToPersian } = await import("/tmp/test_bundle.mjs");
const cues = Array.from({ length: 20 }, (_, i) => ({
  startMs: i * 4000, endMs: i * 4000 + 3200, text: `Line ${i} spoken words here`
}));
const ENV = { TRANSLATION_PROVIDER: "gemini", GEMINI_API_KEY: "G" };

// A: 3.1-flash-lite healthy -> it is the first and only model called
{
  S.failLite = false;
  S.geminiCalls = [];
  const usage = {};
  const out = await translateCuesToPersian(cues, null, ENV, usage);
  assert.strictEqual(S.geminiCalls[0], "gemini-3.1-flash-lite", "first Gemini call must be 3.1-flash-lite, got: " + S.geminiCalls[0]);
  assert.ok(S.geminiCalls.every((m) => m === "gemini-3.1-flash-lite"), "only 3.1-flash-lite used when healthy");
  assert.strictEqual(usage.chunksByProvider.gemini, 1);
  for (let i = 0; i < 20; i++) assert.strictEqual(out[i].text, "FA:" + cues[i].text, "aligned at " + i);
  console.log("A (3.1-flash-lite primary): PASS");
}

// B: 3.1-flash-lite 404 -> next candidate takes over, output still aligned
{
  S.failLite = true;
  S.geminiCalls = [];
  const usage = {};
  const out = await translateCuesToPersian(cues, null, ENV, usage);
  assert.strictEqual(S.geminiCalls[0], "gemini-3.1-flash-lite", "3.1-flash-lite tried first");
  assert.ok(S.geminiCalls.includes("gemini-3.6-flash"), "fell back to 3.6-flash, calls: " + S.geminiCalls.join(","));
  for (let i = 0; i < 20; i++) assert.strictEqual(out[i].text, "FA:" + cues[i].text, "aligned at " + i);
  console.log("B (lite down -> 3.6 fallback): PASS");
}

console.log("ALL GEMINI-ORDER TESTS PASSED");
