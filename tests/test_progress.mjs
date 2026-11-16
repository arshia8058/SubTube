// Tests for the live progress system: tracker math (his worked example),
// success-rate independence, retry no-double-count, total-failure accounting.
import assert from "node:assert";

const bundle = await import("/tmp/test_bundle.mjs");
const {
  createProgressState,
  progressPercents,
  renderProgressText,
  syncProgressFromUsage,
  translateCuesToPersian,
  progressPageHtml
} = bundle;

// ---- 1) the spec's worked example: 500 total, 350 processed, 340 ok, 10 failed
{
  const p = createProgressState({ jobId: 1, videoId: "AAAAAAAAAAA", mode: "srt" });
  p.total = 500;
  p.processed = 350;
  p.succeeded = 340;
  p.failed = 10;
  const { progress, successRate } = progressPercents(p);
  assert.strictEqual(progress, 70, "progress = processed/total");
  assert.strictEqual(successRate, 97, "success rate = succeeded/processed (97.14 -> 97), NOT succeeded/total (68)");
  const txt = renderProgressText(p);
  assert.ok(txt.includes("۷۰\u066A"), "render shows 70% progress");
  assert.ok(!txt.includes("۵۰۰") && !txt.includes("۹۷\u066A") && !txt.includes("/p/") && !txt.includes("مراحل"), "render is minimal per Arshia's request: percent only, no counts/rate/stages/link");
  assert.strictEqual(p.stages.length, 8, "subtitle mode has the 8 stages");
  console.log("tracker math (spec example): PASS");
}

// ---- 2) edge cases: nothing processed yet; done forces 100 even with failures
{
  const p = createProgressState({ jobId: 2, videoId: "AAAAAAAAAAA", mode: "both" });
  p.total = 100;
  let r = progressPercents(p);
  assert.strictEqual(r.progress, 0);
  assert.strictEqual(r.successRate, null, "no rate before anything is processed");
  p.processed = 100;
  p.succeeded = 90;
  p.failed = 10;
  p.status = "done";
  r = progressPercents(p);
  assert.strictEqual(r.progress, 100, "finished job reads 100% even with failed cues");
  assert.strictEqual(r.successRate, 90);
  const sum = createProgressState({ jobId: 3, videoId: "AAAAAAAAAAA", mode: "sum" });
  assert.strictEqual(sum.stages.length, 5, "summary mode has its own honest stage list");
  console.log("tracker edge cases: PASS");
}

// ---- 3) web page shell exists and carries the token safely
{
  const html = progressPageHtml("0123abcdef4567");
  assert.ok(html.includes('data-token="0123abcdef4567"'));
  assert.ok(html.includes("ringFg") && html.includes("/json"), "page polls the JSON endpoint");
  console.log("progress page shell: PASS");
}

// ---- fetch mocks for pipeline integration ----
let geminiCalls = 0;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes("generativelanguage.googleapis.com")) {
    geminiCalls++;
    const body = JSON.parse(options.body);
    const prompt = body.contents[0].parts[0].text;
    const m = prompt.match(/\[\{"id":[\s\S]*\]\s*$/);
    const items = JSON.parse(m[0]);
    if (geminiCalls === 1) {
      // first attempt: malformed rotated plain-array (must be rejected, retried)
      const strs = items.map((it) => "FA:" + it.text);
      const rotated = strs.slice(3).concat(strs.slice(0, 3));
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(rotated) }] } }] }) };
    }
    const good = items.map((it) => ({ id: it.id, fa: "FA:" + it.text }));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(good) }] } }] }) };
  }
  if (u.includes("translate.googleapis.com")) {
    const q = new URLSearchParams(options.body).get("q") || "";
    return { ok: true, status: 200, json: async () => [[["FA:" + q, q]]] };
  }
  throw new Error("unexpected fetch: " + u);
};

const cues30 = Array.from({ length: 30 }, (_, i) => ({
  startMs: i * 4000,
  endMs: i * 4000 + 3000,
  text: `Line number ${i} of the test`
}));

// ---- 4) retry inside a chunk must not double-count cues
{
  geminiCalls = 0;
  const usage = {};
  const out = await translateCuesToPersian(cues30, null, { GEMINI_API_KEY: "test" }, usage, "en");
  assert.strictEqual(out.length, 30);
  assert.ok(geminiCalls >= 2, "the malformed first response was retried");
  const pr = usage.progress;
  assert.ok(pr, "progress recorded on the usage sink");
  assert.strictEqual(pr.processed, 30, "processed counted once despite the retry");
  assert.strictEqual(pr.succeeded, 30);
  assert.strictEqual(pr.failed, 0);
  assert.strictEqual(pr.chunksDone, pr.chunksTotal);
  assert.strictEqual(usage.untranslatedCount, 0);
  // tracker sync mirrors the same numbers
  const p = createProgressState({ jobId: 9, videoId: "AAAAAAAAAAA", mode: "srt" });
  syncProgressFromUsage(p, usage);
  assert.strictEqual(p.total, 30);
  assert.strictEqual(p.succeeded, 30);
  console.log("retry no-double-count: PASS");
}

// ---- 5) total provider failure: everything counted failed, nothing lost
{
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("generativelanguage.googleapis.com")) {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    throw new Error("network down");
  };
  const usage = {};
  const out = await translateCuesToPersian(cues30, null, { GEMINI_API_KEY: "test" }, usage, "en");
  assert.strictEqual(out.length, 30, "job still returns every cue");
  const pr = usage.progress;
  assert.strictEqual(pr.processed, 30, "all cues processed (attempted)");
  assert.strictEqual(pr.succeeded, 0);
  assert.strictEqual(pr.failed, 30);
  assert.strictEqual(usage.untranslatedCount, 30, "untranslated count matches failed count");
  console.log("total-failure accounting: PASS");
}

console.log("ALL PROGRESS TESTS PASSED");
