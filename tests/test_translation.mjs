// Adversarial alignment tests for the fixed translation pipeline.
// The mock "model" deliberately returns shuffled, malformed, incomplete and
// duplicated outputs. The pipeline must still deliver every translation in
// exactly its own cue position, with untouched timestamps.
import assert from "node:assert";

const scenario = { mode: "clean", callsByChunk: new Map() };

function geminiResponse(payloadText, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ candidates: [{ content: { parts: [{ text: payloadText }] } }] })
  };
}

function handleGemini(options) {
  const body = JSON.parse(options.body);
  const prompt = body.contents[0].parts[0].text;
  const m = prompt.match(/\[\{"id":[\s\S]*\]\s*$/);
  const items = JSON.parse(m[0]);
  const firstId = items[0].id;
  const n = (scenario.callsByChunk.get(firstId) || 0) + 1;
  scenario.callsByChunk.set(firstId, n);
  const good = items.map((it) => ({ id: it.id, fa: "FA:" + it.text }));
  switch (scenario.mode) {
    case "clean":
      return geminiResponse(JSON.stringify(good));
    case "shuffle":
      return geminiResponse(JSON.stringify([...good].reverse()));
    case "badformat-then-clean": {
      if (n === 1) {
        // old-style plain string array, rotated by 5 (the original bug shape)
        const strs = items.map((it) => "FA:" + it.text);
        const rotated = strs.slice(5).concat(strs.slice(0, 5));
        return geminiResponse(JSON.stringify(rotated));
      }
      return geminiResponse(JSON.stringify(good));
    }
    case "missing-dup-then-clean": {
      if (n === 1) {
        const broken = good.slice(0, -1); // last id missing
        broken.push({ ...good[0] }); // first id duplicated
        return geminiResponse(JSON.stringify(broken));
      }
      return geminiResponse(JSON.stringify(good));
    }
    case "auth":
      return geminiResponse("{}", 401);
    default:
      throw new Error("unknown mode " + scenario.mode);
  }
}

function handleGoogle(options) {
  const q = new URLSearchParams(options.body).get("q") || "";
  let translated;
  if (q.includes("[[[")) {
    translated = q.split("\n").map((line) =>
      /^\[\[\[\d+\]\]\]$/.test(line.trim()) || !line.trim() ? line : "FA:" + line
    ).join("\n");
  } else {
    translated = "FA:" + q;
  }
  return { ok: true, status: 200, json: async () => [[[translated, q]]] };
}

globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("generativelanguage.googleapis.com")) return handleGemini(options);
  if (u.includes("translate.googleapis.com")) return handleGoogle(options);
  throw new Error("unexpected fetch: " + u);
};

const { translateCuesToPersian, matchTranslationsById, validateTranslatedCues, generateSrt } =
  await import("/tmp/test_bundle.mjs");

// ---- unit checks: the ID matcher itself ----
const ids = new Set([10, 11, 12]);
assert.ok(matchTranslationsById(JSON.stringify([{ id: 12, fa: "x" }, { id: 10, fa: "y" }, { id: 11, fa: "z" }]), ids), "shuffled objects must match by id");
assert.strictEqual(matchTranslationsById(JSON.stringify(["a", "b", "c"]), ids), null, "plain string array must be rejected");
assert.strictEqual(matchTranslationsById(JSON.stringify([{ id: 10, fa: "a" }, { id: 10, fa: "b" }, { id: 11, fa: "c" }]), ids), null, "duplicate id must be rejected");
assert.strictEqual(matchTranslationsById(JSON.stringify([{ id: 10, fa: "a" }, { id: 11, fa: "b" }, { id: 99, fa: "c" }]), ids), null, "unknown id must be rejected");
assert.strictEqual(matchTranslationsById(JSON.stringify([{ id: 10, fa: "a" }, { id: 11, fa: "b" }]), ids), null, "missing id must be rejected");
assert.strictEqual(matchTranslationsById(JSON.stringify([{ id: 10, fa: "a" }, { id: 11, fa: " " }, { id: 12, fa: "c" }]), ids), null, "empty translation must be rejected");
console.log("unit checks (matchTranslationsById): PASS");

// ---- full pipeline: 150 cues, several chunks ----
const N = 150;
const cues = Array.from({ length: N }, (_, i) => ({
  startMs: i * 4000,
  endMs: i * 4000 + 3200,
  text: `Cue ${i} unique line number ${i}`
}));

function checkAligned(out, label) {
  assert.strictEqual(out.length, N, `${label}: cue count changed`);
  const seen = new Set();
  for (let i = 0; i < N; i++) {
    assert.strictEqual(out[i].startMs, cues[i].startMs, `${label}: startMs changed at ${i}`);
    assert.strictEqual(out[i].endMs, cues[i].endMs, `${label}: endMs changed at ${i}`);
    assert.strictEqual(out[i].text, "FA:" + cues[i].text, `${label}: wrong text at position ${i}: ${out[i].text}`);
    assert.ok(!seen.has(out[i].text), `${label}: duplicated text at ${i}`);
    seen.add(out[i].text);
  }
  const v = validateTranslatedCues(cues, out);
  assert.ok(v.ok, `${label}: final validation failed: ${v.problems.join("; ")}`);
  const srt = generateSrt(out).replace(/^\uFEFF/, "");
  const blocks = srt.trim().split("\n\n");
  assert.strictEqual(blocks.length, N, `${label}: SRT block count changed`);
  for (const i of [0, 1, 79, 80, 81, 149]) {
    const lines = blocks[i].split("\n");
    assert.strictEqual(lines[0], String(i + 1), `${label}: SRT numbering wrong at block ${i}`);
    assert.ok(lines[2].includes(`number ${i}`), `${label}: SRT block ${i} holds another line's text`);
  }
  console.log(`${label}: PASS (150/150 aligned, timestamps exact, SRT numbering exact)`);
}

for (const mode of ["clean", "shuffle", "badformat-then-clean", "missing-dup-then-clean", "auth"]) {
  scenario.mode = mode;
  scenario.callsByChunk = new Map();
  const out = await translateCuesToPersian(cues, null, { GEMINI_API_KEY: "test-key" });
  checkAligned(out, `scenario ${mode}`);
}
console.log("ALL TESTS PASSED");
