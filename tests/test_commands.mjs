// Offline tests for the bot-commands feature: menu list integrity (only real
// commands), /status and /history rendering, and the /cancel flag mechanism.
import {
  BOT_COMMANDS, cancelKey, throwIfCancelled, statusIconForJob,
  renderHistoryMessage, renderStatusMessage
} from "/tmp/test_bundle.mjs";

let fails = 0;
const ok = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + " " + label); if (!cond) fails++; };

// --- Menu list: only real commands, valid shape, no duplicates ---
const names = BOT_COMMANDS.map((c) => c.command);
ok(new Set(names).size === names.length, "no duplicate commands");
ok(names.every((n) => /^[a-z]{1,32}$/.test(n)), "command names valid for Telegram");
ok(BOT_COMMANDS.every((c) => c.description.length >= 1 && c.description.length <= 256), "descriptions within 1..256 chars");
for (const real of ["start", "help", "about", "translate", "status", "cancel", "history", "usage", "stats"]) {
  ok(names.includes(real), `menu includes real command /${real}`);
}
for (const fake of ["settings", "language"]) {
  ok(!names.includes(fake), `menu excludes unimplemented /${fake}`);
}

// --- Cancel flag ---
ok(cancelKey(42) === "cancel:42", "cancelKey format");
const store = new Map();
const env = { SUBTITLE_CACHE: { get: async (k) => (store.has(k) ? store.get(k) : null) } };
let threw = null;
try { await throwIfCancelled(env, 42); } catch (e) { threw = e; }
ok(threw === null, "no flag -> no throw");
store.set("cancel:42", "1");
try { await throwIfCancelled(env, 42); } catch (e) { threw = e; }
ok(threw && threw.code === "JOB_CANCELLED", "flag set -> JOB_CANCELLED thrown");
ok(threw && /لغو/.test(threw.userMessage), "cancel error carries the Persian user message");
let threwOther = null;
try { await throwIfCancelled(env, 99); } catch (e) { threwOther = e; }
ok(threwOther === null, "another user's job is unaffected by the flag");

// --- /history rendering ---
ok(/ثبت نشده/.test(renderHistoryMessage([])), "empty history -> friendly prompt");
const hist = renderHistoryMessage([
  { video_id: "AAAAAAAAAAA", status: "completed", error_message: null, created_at: "2026-11-15T10:00:00Z" },
  { video_id: "BBBBBBBBBBB", status: "failed", error_message: "cancelled_by_user", created_at: "2026-11-15T11:00:00Z" },
  { video_id: "CCCCCCCCCCC", status: "failed", error_message: "boom", created_at: "2026-11-15T12:00:00Z" },
  { video_id: "DDDDDDDDDDD", status: "processing", error_message: null, created_at: "2026-11-15T13:00:00Z" }
]);
ok(hist.includes("AAAAAAAAAAA") && hist.includes("✅"), "completed row with check icon");
ok(hist.includes("🚫"), "cancelled row uses the no-entry icon");
ok(statusIconForJob({ status: "failed", error_message: "x" }) === "❌", "plain failure icon");
ok(statusIconForJob({ status: "processing" }) === "🔄", "processing icon");

// --- /status rendering ---
ok(/پردازش فعالی نداری/.test(renderStatusMessage(null, null)), "no active job -> honest message");
const early = renderStatusMessage({ video_id: "XXXXXXXXXXX" }, null);
ok(early.includes("XXXXXXXXXXX") && early.includes("مراحل اولیه"), "job without snapshot -> early-stage text");
const live = renderStatusMessage(
  { video_id: "YYYYYYYYYYY" },
  { progress: 70, successRate: 97, total: 500, processed: 350, succeeded: 340, failed: 10, token: "0123456789abcdef" }
);
ok(!live.includes("/p/"), "status no longer includes the web link (Arshia asked for percent-focused display)");
ok(live.includes("۷۰٪") || live.includes("70"), "status shows the real progress percent");
ok(live.includes("۳۴۰") || live.includes("340"), "status shows the succeeded count");

console.log(fails === 0 ? "ALL COMMAND TESTS PASSED" : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
