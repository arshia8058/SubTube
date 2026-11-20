// Offline tests for the Rubika front-end (RUBIKA_PLAN.md):
// update normalization, the Rubika client's request shapes, identity
// namespacing (string chat ids -> synthetic numeric uids), the queue
// platform field, and the shared delivery ladder's platform name.
import {
  createRubikaClient, telegramKeyboardToRubika, normalizeRubikaUpdate,
  normalizeRubikaInline, resolvePlatformUid, PLATFORM_UID_BASE,
  routeRubikaUpdate, routeRubikaInline, choiceKeyboard,
  buildChoiceCallbackData, buildQueueMessage, deliverSrt
} from "/tmp/test_bundle.mjs";

let fails = 0;
const ok = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + " " + label); if (!cond) fails++; };

// ---------- telegramKeyboardToRubika ----------
{
  const kb = telegramKeyboardToRubika(choiceKeyboard("abcdef012345"));
  ok(kb && Array.isArray(kb.rows) && kb.rows.length === 1, "choice keyboard converts to one keypad row");
  const btns = kb.rows[0].buttons;
  ok(btns.length === 3, "three choice buttons converted");
  ok(btns[0].id === buildChoiceCallbackData("srt", "abcdef012345") && btns[0].type === "Simple" && typeof btns[0].button_text === "string" && btns[0].button_text.length > 0, "button id carries the choice callback data");
  ok(btns[1].id === buildChoiceCallbackData("sum", "abcdef012345") && btns[2].id === buildChoiceCallbackData("both", "abcdef012345"), "sum/both buttons mapped in order");
  ok(telegramKeyboardToRubika(null) === null, "null markup -> null keypad");
  ok(telegramKeyboardToRubika({ inline_keyboard: [] }) === null, "empty keyboard -> null keypad");
  ok(telegramKeyboardToRubika({ inline_keyboard: [[{ text: "x" }]] }) === null, "button without callback_data is dropped");
}

// ---------- normalizeRubikaUpdate ----------
{
  const start = normalizeRubikaUpdate({ type: "StartedBot", chat_id: "b0ABC", update_time: "1795119060" });
  ok(start && start.kind === "start" && start.chatId === "b0ABC", "StartedBot normalizes to start");
  const msg = normalizeRubikaUpdate({
    type: "NewMessage", chat_id: "b0ABC",
    new_message: { message_id: "1977120966780238101", text: "سلام", sender_type: "User", sender_id: "u0XYZ" }
  });
  ok(msg && msg.kind === "message" && msg.text === "سلام", "NewMessage normalizes to message");
  ok(msg.messageId === "1977120966780238101", "Rubika message id preserved as exact string (no Number coercion)");
  ok(msg.senderId === "u0XYZ", "sender id carried through");
  ok(normalizeRubikaUpdate({ type: "NewMessage", chat_id: "b0ABC", new_message: { message_id: "1" } }) === null, "NewMessage without text -> null");
  ok(normalizeRubikaUpdate({ type: "RemovedMessage", chat_id: "b0ABC" }) === null, "unknown update type -> null");
  ok(normalizeRubikaUpdate({ type: "NewMessage", new_message: { text: "x" } }) === null, "missing chat_id -> null");
  ok(normalizeRubikaUpdate(null) === null && normalizeRubikaUpdate("junk") === null, "non-object update -> null");
}

// ---------- normalizeRubikaInline ----------
{
  const tap = normalizeRubikaInline({
    sender_id: "u0XYZ", text: "", message_id: "1977120967000000001", chat_id: "b0ABC",
    aux_data: { button_id: "c:both:abcdef012345" }
  });
  ok(tap && tap.buttonId === "c:both:abcdef012345" && tap.chatId === "b0ABC", "inline tap normalizes with button id");
  ok(tap.messageId === "1977120967000000001", "inline message id preserved as exact string");
  ok(normalizeRubikaInline({ chat_id: "b0ABC", aux_data: {} }) === null, "tap without button_id -> null");
  ok(normalizeRubikaInline({ aux_data: { button_id: "c:srt:abcdef012345" } }) === null, "tap without chat_id -> null");
  ok(normalizeRubikaInline(null) === null, "null inline message -> null");
}

// ---------- createRubikaClient request shapes (fetch stubbed) ----------
const realFetch = globalThis.fetch;
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const body = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
    calls.push({ url: String(url), body });
    const out = handler(String(url), body, opts);
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}
{
  const calls = stubFetch((url) => {
    if (url.endsWith("/sendMessage")) return { status: "OK", data: { message_id: "555" } };
    if (url.endsWith("/editMessageText")) return { status: "OK", data: {} };
    if (url.endsWith("/editMessageKeypad")) return { status: "OK", data: {} };
    return { status: "ERROR" };
  });
  const rb = createRubikaClient("TESTTOKEN");
  ok(rb.platform === "rubika" && rb.pendKeyPrefix === "pend:rubika:", "client carries platform + pend prefix");

  const sent = await rb.sendMessage("b0ABC", "متن تست", { reply_to_message_id: "1977120966780238101", reply_markup: choiceKeyboard("abcdef012345") });
  ok(sent.ok === true && sent.result?.message_id === "555", "sendMessage maps Rubika reply to { ok, result.message_id }");
  const sm = calls.find((c) => c.url.endsWith("/sendMessage"));
  ok(sm.url === "https://botapi.rubika.ir/v3/TESTTOKEN/sendMessage", "sendMessage posts to /v3/<token>/sendMessage");
  ok(sm.body.chat_id === "b0ABC" && sm.body.text === "متن تست" && sm.body.chat_keypad_type === "None", "sendMessage body shape");
  ok(sm.body.reply_to_message_id === "1977120966780238101", "reply_to_message_id stays an exact string");
  ok(sm.body.inline_keypad?.rows?.[0]?.buttons?.[2]?.id === "c:both:abcdef012345", "sendMessage converts reply_markup to inline_keypad");

  await rb.editMessageText("b0ABC", "999", "ویرایش", { reply_markup: { inline_keyboard: [] } });
  const em = calls.find((c) => c.url.endsWith("/editMessageText"));
  ok(em.body.chat_id === "b0ABC" && em.body.message_id === "999" && em.body.text === "ویرایش", "editMessageText body shape");
  const ek = calls.find((c) => c.url.endsWith("/editMessageKeypad"));
  ok(ek && Array.isArray(ek.body.inline_keypad.rows) && ek.body.inline_keypad.rows.length === 0, "empty Telegram keyboard clears keypad via editMessageKeypad");

  const before = calls.length;
  let threw = false;
  try { await rb.sendDocumentByUrl("b0ABC", "https://example.com/f.srt", "cap", null); } catch { threw = true; }
  ok(threw && calls.length === before, "sendDocumentByUrl throws without any network call (ladder moves to upload)");
  globalThis.fetch = realFetch;
}
{
  const calls = stubFetch((url) => {
    if (url.endsWith("/requestSendFile")) return { status: "OK", data: { upload_url: "https://upload.rubika.ir/abc123" } };
    if (url === "https://upload.rubika.ir/abc123") return { data: { file_id: "FILEID1" } };
    if (url.endsWith("/sendFile")) return { status: "OK", data: { message_id: "777" } };
    return { status: "ERROR" };
  });
  const rb = createRubikaClient("TESTTOKEN");
  const out = await rb.sendSrtDocument("b0ABC", "1\n00:00:00,000 --> 00:00:01,000\nسلام", "عنوان", "42");
  ok(out?.message_id === "777", "sendSrtDocument returns the sendFile result");
  ok(calls.length === 3 && calls[0].url.endsWith("/requestSendFile") && calls[1].url === "https://upload.rubika.ir/abc123" && calls[2].url.endsWith("/sendFile"), "file flow order: requestSendFile -> upload -> sendFile");
  ok(calls[0].body.type === "File", "requestSendFile asks for type File");
  ok(calls[2].body.file_id === "FILEID1" && calls[2].body.chat_id === "b0ABC" && calls[2].body.text === "عنوان" && calls[2].body.reply_to_message_id === "42", "sendFile body carries uploaded file_id + caption");
  globalThis.fetch = realFetch;
}

// ---------- identity: resolvePlatformUid with a fake D1 ----------
function makeFakeDb() {
  const rows = new Map();
  let maxUid = 0;
  const key = (p, e) => `${p}|${e}`;
  function stmt(sql) {
    let args = [];
    const s = {
      bind(...a) { args = a; return s; },
      async first() {
        if (sql.includes("FROM platform_users")) {
          const uid = rows.get(key(args[0], args[1]));
          return uid != null ? { uid } : null;
        }
        return null;
      },
      async run() {
        if (sql.includes("INSERT INTO platform_users")) {
          const [platform, ext, base] = args;
          if (rows.has(key(platform, ext))) throw new Error("PK conflict");
          const uid = Math.max(maxUid, Number(base) - 1) + 1;
          for (const u of rows.values()) if (u === uid) throw new Error("uid conflict");
          rows.set(key(platform, ext), uid);
          maxUid = Math.max(maxUid, uid);
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      async all() { return { results: [] }; }
    };
    return s;
  }
  return { prepare: (sql) => stmt(sql), _rows: rows };
}
{
  const db = makeFakeDb();
  const uid1 = await resolvePlatformUid(db, "rubika", "b0AAA");
  ok(uid1 === PLATFORM_UID_BASE, "first Rubika identity gets the reserved-range base uid");
  ok(Number.isSafeInteger(uid1), "synthetic uid is an exact JS safe integer");
  const uid1again = await resolvePlatformUid(db, "rubika", "b0AAA");
  ok(uid1again === uid1, "same Rubika chat maps to the same uid every time");
  const uid2 = await resolvePlatformUid(db, "rubika", "b0BBB");
  ok(uid2 === PLATFORM_UID_BASE + 1 && uid2 !== uid1, "second Rubika chat gets the next uid");
  const uidOther = await resolvePlatformUid(db, "other", "b0AAA");
  ok(uidOther !== uid1 && uidOther >= PLATFORM_UID_BASE, "same external id on another platform is a different identity");
  ok((await resolvePlatformUid(db, "rubika", "")) === null, "empty external id -> null");
}

// ---------- queue platform field ----------
{
  const user = { id: 123, first_name: "A", username: "a" };
  const links = [{ videoId: "u2MfX-J1_zo", canonicalUrl: "https://www.youtube.com/watch?v=u2MfX-J1_zo" }];
  const tgMsg = buildQueueMessage({ chatId: 42, user, messageId: 7, links, mode: "srt", truncated: false });
  ok(!("platform" in tgMsg), "Telegram queue payload has no platform field (unchanged)");
  const rbMsg = buildQueueMessage({ chatId: "b0ABC", user: { id: PLATFORM_UID_BASE, first_name: "", username: "" }, messageId: "99", links, mode: "both", truncated: false, platform: "rubika" });
  ok(rbMsg.platform === "rubika" && rbMsg.chatId === "b0ABC" && rbMsg.user.id === PLATFORM_UID_BASE, "Rubika queue payload carries platform + string chatId + synthetic uid");
}

// ---------- shared delivery ladder: platform name ----------
{
  const SRT = "1\n00:00:00,000 --> 00:00:01,000\nمتن زیرنویس برای آزمون تحویل";
  const store = new Map();
  const env = { SUBTITLE_CACHE: { put: async (k, v) => { store.set(k, v); }, get: async (k) => store.get(k) ?? null } };
  const sent = [];
  const rbFake = {
    platform: "rubika", platformNameFa: "روبیکا",
    sendDocumentByUrl: async () => { throw new Error("RUBIKA_SEND_DOC_URL_UNSUPPORTED"); },
    sendSrtDocument: async () => { throw new Error("upload fail"); },
    sendMessage: async (chatId, text) => { sent.push(text); return { ok: true }; }
  };
  const how = await deliverSrt(env, rbFake, "b0ABC", SRT, "عنوان ویدیو", null);
  ok(how === "link", "Rubika ladder falls back to the link rung");
  ok(sent.length === 1 && sent[0].includes("روبیکا") && !sent[0].includes("تلگرام"), "link fallback names Rubika, not Telegram");
  ok(/\/f\/[a-f0-9]+\/subtitle\.fa\.srt/.test(sent[0]) && !sent[0].includes("متن زیرنویس برای آزمون"), "link fallback carries the /f/ URL and no subtitle text");
}

// ---------- route handlers smoke test (fake D1 + fake client) ----------
{
  const db = makeFakeDb();
  const kvStore = new Map();
  const env = {
    DB: db,
    SUBTITLE_CACHE: {
      get: async (k) => kvStore.get(k) ?? null,
      put: async (k, v) => { kvStore.set(k, v); },
      delete: async (k) => { kvStore.delete(k); }
    }
  };
  const rbCalls = [];
  const rb = {
    platform: "rubika", platformNameFa: "روبیکا", pendKeyPrefix: "pend:rubika:",
    sendMessage: async (chatId, text, extra) => { rbCalls.push({ chatId, text, extra }); return { ok: true, result: { message_id: "1" } }; },
    editMessageText: async () => ({ ok: true }),
    deleteMessage: async () => ({ ok: true }),
    answerCallbackQuery: async () => ({ ok: true })
  };
  await routeRubikaUpdate({ type: "StartedBot", chat_id: "b0SMOKE" }, env, rb);
  ok(rbCalls.length === 1 && rbCalls[0].chatId === "b0SMOKE" && rbCalls[0].text.includes("خوش آمدی"), "StartedBot -> welcome sent to the Rubika chat");
  ok(db._rows.get("rubika|b0SMOKE") === PLATFORM_UID_BASE, "StartedBot created the identity mapping");

  rbCalls.length = 0;
  await routeRubikaUpdate({ type: "NewMessage", chat_id: "b0SMOKE", new_message: { message_id: "5", text: "سلام", sender_id: "u1", sender_type: "User" } }, env, rb);
  ok(rbCalls.length === 1, "plain text without a link -> exactly one reply (invalid-link message)");

  // A choice tap with no pending entry must end quietly (expired path),
  // not throw and not send anything.
  rbCalls.length = 0;
  await routeRubikaInline({ chat_id: "b0SMOKE", sender_id: "u1", message_id: "6", aux_data: { button_id: "c:srt:abcdef012345" } }, env, rb);
  ok(rbCalls.length === 0, "expired choice tap -> no message sent, no throw");
}

console.log(fails === 0 ? "ALL RUBIKA TESTS PASSED" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
