import assert from "node:assert";
const { parseYouTubeUrl, translationCacheKey, generateSrt } = await import("/tmp/test_bundle.mjs");
const ok = [
  ["https://www.youtube.com/watch?v=e7fnVYzW8Ko", "e7fnVYzW8Ko"],
  ["https://youtu.be/e7fnVYzW8Ko?si=abc", "e7fnVYzW8Ko"],
  ["https://www.youtube.com/shorts/e7fnVYzW8Ko", "e7fnVYzW8Ko"],
  ["https://www.youtube.com/live/e7fnVYzW8Ko?feature=share", "e7fnVYzW8Ko"],
  ["https://music.youtube.com/watch?v=e7fnVYzW8Ko&list=RDx", "e7fnVYzW8Ko"],
  ["https://m.youtube.com/watch?v=e7fnVYzW8Ko", "e7fnVYzW8Ko"],
  ["www.youtube.com/watch?v=e7fnVYzW8Ko", "e7fnVYzW8Ko"],
  ["look at this https://youtu.be/e7fnVYzW8Ko please", "e7fnVYzW8Ko"],
  ["https://www.youtube.com/embed/e7fnVYzW8Ko", "e7fnVYzW8Ko"]
];
for (const [input, id] of ok) {
  const r = parseYouTubeUrl(input);
  assert.ok(r && r.videoId === id, `should parse: ${input}`);
}
const bad = [
  "https://www.youtube.com/watch?v=short",
  "https://evil-youtube.com/watch?v=e7fnVYzW8Ko",
  "https://youtube.com.evil.com/watch?v=e7fnVYzW8Ko",
  "https://vimeo.com/12345678901",
  "hello world",
  "",
  "https://www.youtube.com/feed/subscriptions",
  "https://youtu.be/",
  "https://www.youtube.com/watch?v=e7fnVYzW8Ko!"
];
for (const input of bad) {
  assert.strictEqual(parseYouTubeUrl(input), null, `should reject: ${input}`);
}
console.log("parseYouTubeUrl: PASS (9 valid, 9 rejected)");
assert.strictEqual(translationCacheKey("abc", "en", "coarena", "gemini-4-argon"), "fa2:abc:en:coarena:gemini-4-argon");
assert.strictEqual(translationCacheKey("abc", "ar", "coarena", "gemini-4-argon"), "fa2:abc:ar:coarena:gemini-4-argon");
const srt = generateSrt([{ startMs: 0, endMs: 1500, text: "سلام" }, { startMs: 2000, endMs: 2000, text: "x" }]);
assert.ok(srt.includes("00:00:00,000 --> 00:00:01,500"), "srt timing 1");
assert.ok(srt.includes("00:00:02,000 --> 00:00:02,100"), "srt end clamped to start+100");
console.log("cache key + generateSrt edges: PASS");
