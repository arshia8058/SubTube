// Offline tests for cue normalization, SRT wrapping and SRT analysis.
// The timing patterns here mirror what the live diag measured on real
// videos (YouTube window timing: each cue ends where the cue after next
// starts; Supadata chunk blocks of ~200 chars / ~15 s).
import assert from "node:assert";

const {
  normalizeCues,
  wrapSubtitleText,
  generateSrt,
  analyzeCues,
  analyzeSrt
} = await import("/tmp/test_bundle.mjs");

// 1) YouTube window timing: end_i == start_{i+2} must become end_i == start_{i+1}
{
  const raw = [
    { startMs: 200, endMs: 4400, text: "50,000 years ago," },
    { startMs: 2100, endMs: 6400, text: "somewhere on the African Savannah," },
    { startMs: 4400, endMs: 8700, text: "there was a man" },
    { startMs: 6400, endMs: 9000, text: "the rest of his tribe" }
  ];
  const out = normalizeCues(raw);
  assert.strictEqual(out.length, 4);
  assert.deepStrictEqual(out.map((c) => [c.startMs, c.endMs]), [[200, 2100], [2100, 4400], [4400, 6400], [6400, 9000]]);
  const s = analyzeCues(out);
  assert.strictEqual(s.overlapPairs, 0, "no overlaps after normalize");
  assert.strictEqual(s.unsortedPairs, 0);
  console.log("window-timing repair: PASS");
}

// 2) unsorted input is sorted by start
{
  const out = normalizeCues([
    { startMs: 5000, endMs: 6000, text: "second" },
    { startMs: 1000, endMs: 2000, text: "first" }
  ]);
  assert.deepStrictEqual(out.map((c) => c.text), ["first", "second"]);
  console.log("sorting: PASS");
}

// 3) duplicates: contiguous same text merges; a later repeat after other
// dialogue is real speech and must be kept
{
  const out = normalizeCues([
    { startMs: 0, endMs: 2000, text: "hello" },
    { startMs: 2100, endMs: 4000, text: "hello" },
    { startMs: 5000, endMs: 6000, text: "world" },
    { startMs: 9000, endMs: 10000, text: "hello" }
  ]);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0].endMs, 4000, "contiguous duplicate extends");
  assert.strictEqual(out[2].text, "hello", "later repeat preserved");
  console.log("dedupe: PASS");
}

// 4) same start: longer (more complete) text wins
{
  const out = normalizeCues([
    { startMs: 1000, endMs: 2000, text: "partial" },
    { startMs: 1000, endMs: 2500, text: "partial and complete" },
    { startMs: 3000, endMs: 4000, text: "next" }
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].text, "partial and complete");
  assert.strictEqual(out[0].endMs, 2500);
  console.log("same-start merge: PASS");
}

// 5) roll-up: repeated first line stripped; flattened prefix stripped
{
  const out = normalizeCues([
    { startMs: 0, endMs: 2000, text: "line one" },
    { startMs: 2000, endMs: 4000, text: "line one\nline two" },
    { startMs: 4000, endMs: 6000, text: "a longer previous sentence here" },
    { startMs: 6000, endMs: 8000, text: "a longer previous sentence here plus new words" }
  ]);
  assert.strictEqual(out.length, 4);
  assert.strictEqual(out[1].text, "line two");
  assert.strictEqual(out[3].text, "plus new words");
  console.log("roll-up strip: PASS");
}

// 6) duration cap 7s + zero/negative duration repair + empty dropped
{
  const out = normalizeCues([
    { startMs: 0, endMs: 20000, text: "very long display" },
    { startMs: 30000, endMs: 29000, text: "broken timing" },
    { startMs: 40000, endMs: 41000, text: "   " }
  ]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].endMs - out[0].startMs, 7000);
  assert.ok(out[1].endMs > out[1].startMs);
  console.log("duration cap/repair: PASS");
}

// 7) idempotence: normalizing twice changes nothing
{
  const raw = [
    { startMs: 200, endMs: 4400, text: "50,000 years ago," },
    { startMs: 2100, endMs: 6400, text: "somewhere on the African Savannah," },
    { startMs: 4400, endMs: 8700, text: "there was a man" }
  ];
  assert.deepStrictEqual(normalizeCues(normalizeCues(raw)), normalizeCues(raw));
  console.log("idempotence: PASS");
}

// 8) wrapping: short stays one line; long becomes exactly 2 balanced lines
{
  assert.strictEqual(wrapSubtitleText("short line"), "short line");
  const fa = "این یک جمله نسبتاً طولانی فارسی است که باید در دو خط نمایش داده شود تا خوانا بماند";
  const wrapped = wrapSubtitleText(fa);
  const lines = wrapped.split("\n");
  assert.strictEqual(lines.length, 2, "long Persian text wraps to 2 lines");
  // Word boundaries cannot be split, so the best achievable split of this
  // sentence has a 43-char line; the wrapper must return the most balanced
  // word-boundary split (minimize the longer line).
  assert.ok([...lines[0]].length <= 45 && [...lines[1]].length <= 45, `balanced split: ${lines.map((l) => [...l].length)}`);
  assert.strictEqual(lines.join(" "), fa, "no words lost or reordered");
  const en = "This is a fairly long English sentence that should be split across two lines for readability";
  const w2 = wrapSubtitleText(en).split("\n");
  assert.strictEqual(w2.length, 2);
  assert.strictEqual(w2.join(" "), en);
  console.log("wrapSubtitleText: PASS");
}

// 9) end-to-end shape: 25 window-timed cues -> SRT with zero overlaps, <=2 lines
{
  const raw = [];
  for (let i = 0; i < 25; i++) {
    raw.push({ startMs: i * 2000, endMs: (i + 2) * 2000, text: `Caption number ${i} with some extra words to make it longer` });
  }
  const srt = generateSrt(normalizeCues(raw));
  const st = analyzeSrt(srt);
  assert.strictEqual(st.blocks, 25);
  assert.strictEqual(st.seqOk, true);
  assert.strictEqual(st.overlaps, 0);
  assert.strictEqual(st.nonMonotonic, 0);
  assert.strictEqual(st.over2Lines, 0);
  assert.strictEqual(st.badTiming, 0);
  console.log("generateSrt + analyzeSrt: PASS");
}

console.log("ALL SRT-FIX TESTS PASSED");
