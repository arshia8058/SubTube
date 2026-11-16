// Offline tests for the new features: multi-language source, FA passthrough,
// multi-link parsing, summary helper, and /usage limit formatting.
import assert from "node:assert";

const S = { lastCoarenaSystem: null, lastGoogleUrl: null, summaryMode: "ok", fetchCount: 0 };

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
  S.fetchCount++;
  const u = String(url);
  if (u.includes("coarena.ai")) {
    const body = JSON.parse(options.body);
    const sys = body.messages?.[0]?.content || "";
    if (sys.includes("summarizes video transcripts")) {
      if (S.summaryMode === "ok") {
        return coarenaReply("این ویدیو درباره موضوعی آموزشی است.\n• نکته اول مهم\n• نکته دوم مهم\n• نکته سوم مهم\n• نکته چهارم مهم");
      }
      return coarenaReply("", 500);
    }
    S.lastCoarenaSystem = sys;
    const items = itemsFrom(body.messages[1].content);
    const good = items.map((it) => ({ id: it.id, fa: "FA:" + it.text }));
    return coarenaReply(JSON.stringify({ items: good }));
  }
  if (u.includes("generativelanguage.googleapis.com")) {
    return { ok: false, status: 500, json: async () => ({}) };
  }
  if (u.includes("translate.googleapis.com")) {
    S.lastGoogleUrl = u;
    const q = new URLSearchParams(options.body).get("q") || "";
    const t = q.includes("[[[")
      ? q.split("\n").map((l) => (/^\[\[\[\d+\]\]\]$/.test(l.trim()) || !l.trim() ? l : "FA:" + l)).join("\n")
      : "FA:" + q;
    return { ok: true, status: 200, json: async () => [[[t, q]]] };
  }
  throw new Error("unexpected fetch " + u);
};

const {
  translateCuesToPersian,
  parseAllYouTubeUrls,
  normalizeLangCode,
  summarizeTranscript,
  formatCoarenaLimits
} = await import("/tmp/test_bundle.mjs");

// --- parseAllYouTubeUrls ---
{
  const two = parseAllYouTubeUrls("ببین اینا رو https://www.youtube.com/watch?v=AAAAAAAAAAA و https://youtu.be/BBBBBBBBBBB مرسی");
  assert.strictEqual(two.links.length, 2, "two links parsed");
  assert.strictEqual(two.links[0].videoId, "AAAAAAAAAAA");
  assert.strictEqual(two.links[1].videoId, "BBBBBBBBBBB");
  assert.strictEqual(two.truncated, false);

  const dup = parseAllYouTubeUrls("https://youtu.be/AAAAAAAAAAA https://www.youtube.com/watch?v=AAAAAAAAAAA");
  assert.strictEqual(dup.links.length, 1, "same video deduped");

  const many = parseAllYouTubeUrls([1, 2, 3, 4, 5].map((n) => `https://youtu.be/${"C".repeat(10)}${n}`).join(" "));
  assert.strictEqual(many.links.length, 3, "capped at 3");
  assert.strictEqual(many.truncated, true, "truncated flag set");

  const bare = parseAllYouTubeUrls("youtube.com/watch?v=DDDDDDDDDDD");
  assert.strictEqual(bare.links.length, 1, "bare link still works");
  assert.strictEqual(bare.links[0].videoId, "DDDDDDDDDDD");

  const none = parseAllYouTubeUrls("سلام، لینکی نیست");
  assert.strictEqual(none.links.length, 0, "no links");
  console.log("parseAllYouTubeUrls: PASS");
}

// --- normalizeLangCode ---
assert.strictEqual(normalizeLangCode("en-US"), "en");
assert.strictEqual(normalizeLangCode("AR"), "ar");
assert.strictEqual(normalizeLangCode(""), "en");
assert.strictEqual(normalizeLangCode(null), "en");
assert.strictEqual(normalizeLangCode("xx!!"), "en");
assert.strictEqual(normalizeLangCode("fa"), "fa");
console.log("normalizeLangCode: PASS");

// --- Arabic source via Coarena: prompt must name Arabic, output aligned ---
{
  const cues = Array.from({ length: 30 }, (_, i) => ({
    startMs: i * 4000, endMs: i * 4000 + 3200, text: `Arabic line ${i} some spoken words here`
  }));
  const usage = {};
  const out = await translateCuesToPersian(cues, null, { COARENA_API_KEY: "k" }, usage, "ar");
  assert.strictEqual(usage.sourceLang, "ar");
  assert.ok(S.lastCoarenaSystem.includes("Arabic"), "coarena system prompt names Arabic, got: " + S.lastCoarenaSystem.slice(0, 120));
  assert.strictEqual(out.length, 30);
  for (let i = 0; i < 30; i++) {
    assert.strictEqual(out[i].text, "FA:" + cues[i].text, "aligned at " + i);
    assert.strictEqual(out[i].startMs, cues[i].startMs);
  }
  console.log("Arabic source via Coarena: PASS");
}

// --- Arabic source via Google: endpoint must carry sl=ar ---
{
  S.lastGoogleUrl = null;
  const cues = Array.from({ length: 6 }, (_, i) => ({
    startMs: i * 4000, endMs: i * 4000 + 3200, text: `Arabic google line ${i} with enough words`
  }));
  const usage = {};
  const out = await translateCuesToPersian(cues, null, { TRANSLATION_PROVIDER: "google" }, usage, "ar");
  assert.ok(S.lastGoogleUrl && S.lastGoogleUrl.includes("sl=ar"), "google endpoint uses sl=ar, got: " + S.lastGoogleUrl);
  assert.strictEqual(out.length, 6);
  console.log("Arabic source via Google (sl=ar): PASS");
}

// --- Persian source passthrough: no network, cues unchanged ---
{
  S.fetchCount = 0;
  const cues = [
    { startMs: 0, endMs: 3000, text: "سلام دنیا" },
    { startMs: 3000, endMs: 6000, text: "این یک خط فارسی است" }
  ];
  const usage = {};
  const out = await translateCuesToPersian(cues, null, { COARENA_API_KEY: "k" }, usage, "fa");
  assert.deepStrictEqual(out, cues, "persian cues pass through unchanged");
  assert.strictEqual(usage.chunksByProvider.passthrough, 1);
  assert.strictEqual(S.fetchCount, 0, "passthrough makes no network calls");
  console.log("Persian passthrough: PASS");
}

// --- summarizeTranscript ---
{
  const cues = Array.from({ length: 12 }, (_, i) => ({
    startMs: i * 5000, endMs: i * 5000 + 4000,
    text: `This video explains how the human brain processes memories and learning in detail part ${i}`
  }));
  S.summaryMode = "ok";
  const s = await summarizeTranscript(cues, { COARENA_API_KEY: "k" }, { provider: "coarena", model: "gemini-4-argon" });
  assert.ok(s && s.includes("نکته اول"), "summary returned, got: " + String(s).slice(0, 60));
  S.summaryMode = "fail";
  const s2 = await summarizeTranscript(cues, { COARENA_API_KEY: "k" }, { provider: "coarena", model: "gemini-4-argon" });
  assert.strictEqual(s2, null, "summary failure returns null, never throws");
  const s3 = await summarizeTranscript([{ startMs: 0, endMs: 1000, text: "short" }], { COARENA_API_KEY: "k" }, { provider: "coarena", model: "m" });
  assert.strictEqual(s3, null, "too-short transcript returns null");
  console.log("summarizeTranscript: PASS");
}

// --- formatCoarenaLimits (real /limits shape: data.today.*) ---
{
  const real = { data: { usd_per_day: 5, today: { used_usd: 0.085061, left_usd: 4.914939, requests: 15 } } };
  const txt = formatCoarenaLimits(real);
  assert.ok(txt && txt.includes("0.09") && txt.includes("5") && txt.includes("4.91") && txt.includes("15"), "formats nested limits, got: " + txt);
  const flat = formatCoarenaLimits({ usd_used: 1.25, usd_limit: 5 });
  assert.ok(flat && flat.includes("1.25") && flat.includes("5"), "flat fallback still works");
  assert.strictEqual(formatCoarenaLimits(null), null);
  assert.strictEqual(formatCoarenaLimits({}), null);
  console.log("formatCoarenaLimits: PASS");
}

console.log("ALL MULTILANG/FEATURE TESTS PASSED");
