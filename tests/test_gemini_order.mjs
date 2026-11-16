// Offline tests: the Gemini provider path must try gemini-3.6-flash first
// (Arshia's choice for the Google AI Studio path) and fall back to the
// flash-lite candidates only if 3.6-flash is unavailable.
import assert from "node:assert";

const S = { fail36: false, geminiCalls: [] };

function itemsFrom(text) {
  const start = text.lastIndexOf('[{"id":');
  return JSON.parse(text.slice(start));
}
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("generativelanguage.googleapis.com")) {
    const model = u.split("/models/")[1].split(":")[0];
    S.geminiCalls.push(model);
    if (model === "gemini-3.6-flash" && S.fail36) {
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

// A: 3.6-flash healthy -> it is the first and only model called
{
  S.fail36 = false;
  S.geminiCalls = [];
  const usage = {};
  const out = await translateCuesToPersian(cues, null, ENV, usage);
  assert.strictEqual(S.geminiCalls[0], "gemini-3.6-flash", "first Gemini call must be 3.6-flash, got: " + S.geminiCalls[0]);
  assert.ok(S.geminiCalls.every((m) => m === "gemini-3.6-flash"), "only 3.6-flash used when healthy");
  assert.strictEqual(usage.chunksByProvider.gemini, 1);
  for (let i = 0; i < 20; i++) assert.strictEqual(out[i].text, "FA:" + cues[i].text, "aligned at " + i);
  console.log("A (3.6-flash primary): PASS");
}

// B: 3.6-flash 404 -> next candidate takes over, output still aligned
{
  S.fail36 = true;
  S.geminiCalls = [];
  const usage = {};
  const out = await translateCuesToPersian(cues, null, ENV, usage);
  assert.strictEqual(S.geminiCalls[0], "gemini-3.6-flash", "3.6-flash tried first");
  assert.ok(S.geminiCalls.includes("gemini-3.1-flash-lite"), "fell back to 3.1-flash-lite, calls: " + S.geminiCalls.join(","));
  for (let i = 0; i < 20; i++) assert.strictEqual(out[i].text, "FA:" + cues[i].text, "aligned at " + i);
  console.log("B (3.6 down -> lite fallback): PASS");
}

console.log("ALL GEMINI-ORDER TESTS PASSED");
