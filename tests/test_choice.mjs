// Offline tests for the inline-button choice flow helpers.
import assert from "node:assert";

const {
  buildChoiceCallbackData,
  parseChoiceCallbackData,
  choiceKeyboard,
  choicePromptText,
  makeChoiceToken
} = await import("/tmp/test_bundle.mjs");

// token shape: 12 lowercase hex chars
{
  const t = makeChoiceToken();
  assert.match(t, /^[a-f0-9]{12}$/, "token format");
  assert.notStrictEqual(makeChoiceToken(), makeChoiceToken(), "tokens are random");
  console.log("makeChoiceToken: PASS");
}

// callback data roundtrip for all three modes
{
  const token = "0123abcdef89";
  for (const mode of ["srt", "sum", "both"]) {
    const data = buildChoiceCallbackData(mode, token);
    assert.ok(data.length <= 64, "callback_data within Telegram's 64-byte limit");
    assert.deepStrictEqual(parseChoiceCallbackData(data), { mode, token }, `roundtrip ${mode}`);
  }
  console.log("callback data roundtrip: PASS");
}

// parser rejects garbage and foreign callbacks
{
  for (const bad of ["", null, void 0, "c:xxx:0123abcdef89", "c:srt:XYZ", "c:srt:0123abcdef8", "other:1", "c:both:0123abcdef89:extra"]) {
    assert.strictEqual(parseChoiceCallbackData(bad), null, `rejects: ${bad}`);
  }
  console.log("callback data rejection: PASS");
}

// keyboard: one row, three buttons, labels + valid data
{
  const kb = choiceKeyboard("0123abcdef89");
  assert.strictEqual(kb.inline_keyboard.length, 1, "one row");
  const row = kb.inline_keyboard[0];
  assert.strictEqual(row.length, 3, "three buttons");
  assert.ok(row[0].text.includes("زیرنویس"), "subtitle button");
  assert.ok(row[1].text.includes("خلاصه"), "summary button");
  assert.ok(row[2].text.includes("هر دو"), "both button");
  assert.deepStrictEqual(row.map((b) => parseChoiceCallbackData(b.callback_data).mode), ["srt", "sum", "both"]);
  console.log("choiceKeyboard: PASS");
}

// prompt text differs for single vs multi
{
  const one = choicePromptText([{ videoId: "AAAAAAAAAAA" }]);
  const three = choicePromptText([{ videoId: "A" }, { videoId: "B" }, { videoId: "C" }]);
  assert.ok(one.includes("ویدیو"), "single prompt mentions the video");
  assert.ok(three.includes("3"), "multi prompt mentions the count");
  console.log("choicePromptText: PASS");
}

console.log("ALL CHOICE TESTS PASSED");
