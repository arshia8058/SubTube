// Offline tests for the re-translate button: rotation, callback data,
// keyboard, and the full callback -> queue wiring with stubbed env/tg.
import assert from "node:assert";

const {
  RETRANSLATE_ROTATION,
  nextRetranslateSettings,
  buildRetranslateCallbackData,
  parseRetranslateCallbackData,
  retranslateKeyboard,
  parseChoiceCallbackData,
  buildQueueMessage,
  handleCallbackQuery
} = await import("/tmp/test_bundle.mjs");

// rotation: luna -> deepseek -> gemini -> luna; unknown -> first entry
{
  assert.deepStrictEqual(nextRetranslateSettings({ provider: "coarena", model: "gpt-6-luna" }), { provider: "coarena", model: "deepseek-v4-1-flash-1017" });
  assert.deepStrictEqual(nextRetranslateSettings({ provider: "coarena", model: "deepseek-v4-1-flash-1017" }), { provider: "gemini", model: "gemini-3.6-flash" });
  assert.deepStrictEqual(nextRetranslateSettings({ provider: "gemini", model: "gemini-3.6-flash" }), { provider: "coarena", model: "gpt-6-luna" });
  assert.deepStrictEqual(nextRetranslateSettings({ provider: "coarena", model: "unknown-model" }), RETRANSLATE_ROTATION[0]);
  assert.deepStrictEqual(nextRetranslateSettings(null), RETRANSLATE_ROTATION[0]);
  assert.deepStrictEqual(nextRetranslateSettings(undefined), RETRANSLATE_ROTATION[0]);
  // every step actually changes the model
  for (const s of RETRANSLATE_ROTATION) {
    const n = nextRetranslateSettings(s);
    assert.ok(n.provider !== s.provider || n.model !== s.model, "next differs");
  }
  console.log("rotation: PASS");
}

// callback data roundtrip + rejection + isolation from the choice parser
{
  const token = "0123abcdef89";
  const data = buildRetranslateCallbackData(token);
  assert.ok(data.length <= 64, "within Telegram limit");
  assert.deepStrictEqual(parseRetranslateCallbackData(data), { token });
  for (const bad of ["", null, undefined, "r:xyz", "r:0123abcdef8", "r:0123abcdef890", "c:srt:0123abcdef89", "x:0123abcdef89"]) {
    assert.strictEqual(parseRetranslateCallbackData(bad), null, `rejects ${bad}`);
  }
  assert.strictEqual(parseChoiceCallbackData(data), null, "choice parser ignores r: data");
  console.log("callback data: PASS");
}

// keyboard shape
{
  const kb = retranslateKeyboard("0123abcdef89");
  assert.strictEqual(kb.inline_keyboard.length, 1);
  assert.strictEqual(kb.inline_keyboard[0].length, 1);
  const btn = kb.inline_keyboard[0][0];
  assert.ok(btn.text.includes("ترجمه دوباره"), "button label");
  assert.deepStrictEqual(parseRetranslateCallbackData(btn.callback_data), { token: "0123abcdef89" });
  console.log("keyboard: PASS");
}

// buildQueueMessage: alt only present when requested (normal jobs unchanged)
{
  const base = { chatId: 1, user: { id: 2 }, messageId: 3, links: [{ videoId: "e7fnVYzW8Ko" }], mode: "srt", truncated: false };
  const plain = buildQueueMessage(base);
  assert.ok(!("alt" in plain), "no alt key for normal jobs");
  const withAlt = buildQueueMessage({ ...base, altSettings: { provider: "gemini", model: "gemini-3.6-flash" } });
  assert.deepStrictEqual(withAlt.alt, { provider: "gemini", model: "gemini-3.6-flash" });
  console.log("buildQueueMessage alt: PASS");
}

// full callback wiring with stubs
function makeStubs() {
  const store = new Map();
  const kv = {
    get: async (k, type) => {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    put: async (k, v) => { store.set(k, String(v)); },
    delete: async (k) => { store.delete(k); }
  };
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        run: async () => ({ success: true }),
        all: async () => ({ results: [] })
      })
    })
  };
  const calls = [];
  const tg = {
    answerCallbackQuery: async (id, text) => { calls.push({ m: "answer", id, text }); return { ok: true }; },
    sendMessage: async (chatId, text, opts) => { calls.push({ m: "send", chatId, text, opts }); return { result: { message_id: 999 } }; },
    editMessageText: async (chatId, mid, text, opts) => { calls.push({ m: "edit", chatId, mid, text, opts }); return { ok: true }; }
  };
  const queuePayloads = [];
  const env = { SUBTITLE_CACHE: kv, DB: db, JOB_QUEUE: { send: async (p) => { queuePayloads.push(p); } } };
  return { store, kv, env, tg, calls, queuePayloads };
}

function cbUpdate(token, fromId) {
  return {
    callback_query: {
      id: "q1",
      from: { id: fromId, first_name: "T" },
      message: { message_id: 7, chat: { id: 555 } },
      data: `r:${token}`
    }
  };
}

{
  const { store, kv, env, tg, calls, queuePayloads } = makeStubs();
  const token = "aaaa1111bbbb";
  await kv.put(`retr:${token}`, JSON.stringify({ videoId: "e7fnVYzW8Ko", canonicalUrl: "https://www.youtube.com/watch?v=e7fnVYzW8Ko", userId: 42, mode: "srt", provider: "coarena", model: "gpt-6-luna" }));
  await handleCallbackQuery(cbUpdate(token, 42), env, tg);
  assert.strictEqual(queuePayloads.length, 1, "one job enqueued");
  const p = queuePayloads[0];
  assert.deepStrictEqual(p.alt, { provider: "coarena", model: "deepseek-v4-1-flash-1017" }, "next model in rotation");
  assert.strictEqual(p.links[0].videoId, "e7fnVYzW8Ko");
  assert.strictEqual(p.mode, "srt");
  assert.strictEqual(store.has(`retr:${token}`), false, "token consumed");
  assert.ok(calls.some((c) => c.m === "answer" && c.text && c.text.includes("شروع شد")), "started toast");
  assert.ok(calls.some((c) => c.m === "edit" && c.opts?.reply_markup?.inline_keyboard?.length === 0), "keyboard removed");
  console.log("callback happy path: PASS");

  // replay: token is gone -> expired, no new enqueue
  calls.length = 0;
  await handleCallbackQuery(cbUpdate(token, 42), env, tg);
  assert.strictEqual(queuePayloads.length, 1, "no second enqueue");
  assert.ok(calls.some((c) => c.m === "answer" && c.text && c.text.includes("منقضی")), "expired toast");
  console.log("callback replay: PASS");
}

{
  const { store, kv, env, tg, calls, queuePayloads } = makeStubs();
  const token = "cccc2222dddd";
  await kv.put(`retr:${token}`, JSON.stringify({ videoId: "e7fnVYzW8Ko", canonicalUrl: "https://www.youtube.com/watch?v=e7fnVYzW8Ko", userId: 42, mode: "both", provider: "gemini", model: "gemini-3.6-flash" }));
  await handleCallbackQuery(cbUpdate(token, 43), env, tg);
  assert.strictEqual(queuePayloads.length, 0, "stranger cannot enqueue");
  assert.strictEqual(store.has(`retr:${token}`), true, "token not consumed by stranger");
  assert.ok(calls.some((c) => c.m === "answer" && c.text && c.text.includes("برای شما نیست")), "not-yours toast");
  // rightful owner with mode both: rotation wraps to luna, mode preserved
  await handleCallbackQuery(cbUpdate(token, 42), env, tg);
  assert.strictEqual(queuePayloads.length, 1);
  assert.deepStrictEqual(queuePayloads[0].alt, { provider: "coarena", model: "gpt-6-luna" });
  assert.strictEqual(queuePayloads[0].mode, "both");
  console.log("callback ownership + wrap: PASS");
}

console.log("test_retranslate: ALL PASS");
