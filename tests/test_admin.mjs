// Offline tests for admin-panel support code (stage B: instrumentation).
import assert from "node:assert";

const {
  extractDomain,
  sourceFromDomain,
  logLinkEvent,
  recordJobMeta,
  isUserBlocked,
  handleTelegramUpdate
} = await import("/tmp/test_bundle.mjs");

// domain + source extraction
{
  assert.strictEqual(extractDomain("https://www.youtube.com/watch?v=abc"), "youtube.com");
  assert.strictEqual(extractDomain("https://youtu.be/abc"), "youtu.be");
  assert.strictEqual(extractDomain("https://www.TikTok.com/@x/video/1"), "tiktok.com");
  assert.strictEqual(extractDomain("https://instagram.com/reel/xyz/"), "instagram.com");
  assert.strictEqual(sourceFromDomain("youtube.com"), "YouTube");
  assert.strictEqual(sourceFromDomain("m.youtube.com"), "YouTube");
  assert.strictEqual(sourceFromDomain("youtu.be"), "YouTube");
  assert.strictEqual(sourceFromDomain("instagram.com"), "Instagram");
  assert.strictEqual(sourceFromDomain("x.com"), "X");
  assert.strictEqual(sourceFromDomain("facebook.com"), "Facebook");
  assert.strictEqual(sourceFromDomain("example.org"), "Other");
  assert.strictEqual(sourceFromDomain(null), "Unknown");
  console.log("domain/source: PASS");
}

function makeFakeDb({ blocked = 0, failAll = false } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind: (...args) => ({
          first: async () => {
            if (failAll) throw new Error("db down");
            if (sql.includes("is_blocked")) return { is_blocked: blocked };
            if (sql.includes("FROM settings")) return null;
            if (sql.includes("COUNT(*)")) return { cnt: 0 };
            return null;
          },
          run: async () => {
            if (failAll) throw new Error("db down");
            calls.push({ sql, args });
            return { success: true, meta: { changes: 1, last_row_id: 1 } };
          },
          all: async () => ({ results: [] })
        })
      };
    },
    batch: async () => []
  };
}

function makeKv() {
  const store = new Map();
  return {
    store,
    get: async (k, type) => {
      const v = store.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    put: async (k, v) => { store.set(k, String(v)); },
    delete: async (k) => { store.delete(k); }
  };
}

function makeTg() {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { result: { message_id: 42 } }; },
    editMessageText: async () => ({ ok: true }),
    deleteMessage: async () => ({ ok: true }),
    answerCallbackQuery: async () => ({ ok: true })
  };
}

// helpers are fail-safe and write what the panel expects
{
  const db = makeFakeDb();
  await logLinkEvent(db, { user: { id: 7, username: "ali", first_name: "Ali" }, url: "https://youtu.be/e7fnVYzW8Ko", outcome: "received" });
  const ins = db.calls.find((c) => c.sql.includes("INSERT INTO link_events"));
  assert.ok(ins, "link event inserted");
  assert.strictEqual(ins.args[0], 7);
  assert.strictEqual(ins.args[4], "youtu.be");
  assert.strictEqual(ins.args[5], "YouTube");
  assert.strictEqual(ins.args[6], "received");
  await recordJobMeta(db, 55, { provider: "coarena", model: "gpt-6-luna", cueCount: 120 });
  const upd = db.calls.find((c) => c.sql.includes("UPDATE jobs SET provider"));
  assert.ok(upd, "job meta updated");
  assert.deepStrictEqual(upd.args, [55, "coarena", "gpt-6-luna", 120]);
  // failures never throw
  const bad = makeFakeDb({ failAll: true });
  await logLinkEvent(bad, { user: { id: 1 }, url: "https://x.com/a", outcome: "invalid" });
  await recordJobMeta(bad, 1, { provider: "gemini" });
  await logLinkEvent(null, { user: { id: 1 }, url: "https://x.com/a" });
  console.log("logLinkEvent/recordJobMeta: PASS");
}

// isUserBlocked semantics (fail-open)
{
  assert.strictEqual(await isUserBlocked(makeFakeDb({ blocked: 1 }), 7), true);
  assert.strictEqual(await isUserBlocked(makeFakeDb({ blocked: 0 }), 7), false);
  assert.strictEqual(await isUserBlocked(makeFakeDb({ failAll: true }), 7), false);
  assert.strictEqual(await isUserBlocked(null, 7), false);
  console.log("isUserBlocked: PASS");
}

function msgUpdate(text, id = 7) {
  return { message: { message_id: 5, chat: { id: 100 }, from: { id, first_name: "Ali", username: "ali" }, text } };
}

// blocked users get only the notice — no commands, no link flow
{
  const db = makeFakeDb({ blocked: 1 });
  const tg = makeTg();
  const env = { DB: db, SUBTITLE_CACHE: makeKv() };
  await handleTelegramUpdate(msgUpdate("/start"), env, tg);
  assert.strictEqual(tg.sent.length, 1);
  assert.ok(tg.sent[0].text.includes("مسدود"), "blocked notice for /start");
  tg.sent.length = 0;
  await handleTelegramUpdate(msgUpdate("https://youtu.be/e7fnVYzW8Ko"), env, tg);
  assert.strictEqual(tg.sent.length, 1);
  assert.ok(tg.sent[0].text.includes("مسدود"), "blocked notice for link");
  assert.ok(!db.calls.some((c) => c.sql.includes("INSERT INTO link_events")), "no link event for blocked user");
  console.log("block gate: PASS");
}

// link submissions are logged (received + invalid), normal flow untouched
{
  const db = makeFakeDb({ blocked: 0 });
  const tg = makeTg();
  const kv = makeKv();
  const env = { DB: db, SUBTITLE_CACHE: kv };
  await handleTelegramUpdate(msgUpdate("https://youtu.be/e7fnVYzW8Ko"), env, tg);
  const rec = db.calls.find((c) => c.sql.includes("INSERT INTO link_events"));
  assert.ok(rec, "received event logged");
  assert.strictEqual(rec.args[5], "YouTube");
  assert.strictEqual(rec.args[6], "received");
  assert.ok([...kv.store.keys()].some((k) => k.startsWith("pend:")), "choice prompt still created");
  assert.ok(tg.sent.some((m) => m.opts?.reply_markup), "choice keyboard still sent");

  const db2 = makeFakeDb({ blocked: 0 });
  const tg2 = makeTg();
  const env2 = { DB: db2, SUBTITLE_CACHE: makeKv() };
  await handleTelegramUpdate(msgUpdate("https://example.com/video/1"), env2, tg2);
  const inv = db2.calls.find((c) => c.sql.includes("INSERT INTO link_events"));
  assert.ok(inv, "invalid event logged");
  assert.strictEqual(inv.args[4], "example.com");
  assert.strictEqual(inv.args[5], "Other");
  assert.strictEqual(inv.args[6], "invalid");
  console.log("link logging: PASS");
}

console.log("test_admin (stage B): ALL PASS");

// ================= Stage C: admin panel backend =================
const {
  hashAdminPassword: hashPw,
  verifyAdminPassword: verifyPw,
  handleAdminRequest
} = await import("/tmp/test_bundle.mjs");

// password hashing: salted PBKDF2, never plaintext, verifies correctly
{
  const h1 = await hashPw("correct horse battery");
  const h2 = await hashPw("correct horse battery");
  assert.ok(h1.startsWith("v1$100000$"), "hash format");
  assert.notStrictEqual(h1, h2, "random salt per hash");
  assert.ok(!h1.includes("correct horse"), "no plaintext in hash");
  assert.strictEqual(await verifyPw("correct horse battery", h1), true);
  assert.strictEqual(await verifyPw("wrong password", h1), false);
  assert.strictEqual(await verifyPw("anything", "garbage"), false);
  assert.strictEqual(await verifyPw("anything", ""), false);
  console.log("password hashing: PASS");
}

function makeAdminDb() {
  const settings = new Map();
  const sessions = new Map();
  const attempts = [];
  const users = [
    { telegram_id: 7, username: "ali", first_name: "Ali", created_at: "2026-11-10T10:00:00Z", last_active_at: "2026-11-18T08:00:00Z", is_blocked: 0, blocked_at: null, total_jobs: 3, successful_jobs: 2, failed_jobs: 1 }
  ];
  const jobs = [
    { id: 3, telegram_id: 7, username: "ali", first_name: "Ali", video_url: "https://www.youtube.com/watch?v=e7fnVYzW8Ko", video_id: "e7fnVYzW8Ko", status: "completed", provider: "coarena", model: "gpt-6-luna", cue_count: 218, error_message: null, created_at: "2026-11-18T08:00:00Z", completed_at: "2026-11-18T08:01:30Z" },
    { id: 2, telegram_id: 7, username: "ali", first_name: "Ali", video_url: "https://www.youtube.com/watch?v=POHIwXGSd88", video_id: "POHIwXGSd88", status: "failed", provider: null, model: null, cue_count: null, error_message: "boom", created_at: "2026-11-18T07:00:00Z", completed_at: "2026-11-18T07:00:10Z" }
  ];
  function first(sql, args) {
    if (sql.includes("FROM settings")) {
      const v = settings.get("admin_auth");
      return v ? { value: v } : null;
    }
    if (sql.includes("FROM admin_login_attempts")) {
      return { cnt: attempts.filter((a) => a.ip === args[0] && a.success === 0 && a.at >= args[1]).length };
    }
    if (sql.includes("FROM admin_sessions")) {
      return sessions.get(args[0]) || null;
    }
    if (sql.includes("FROM users WHERE last_active_at")) return { cnt: 1 };
    if (sql.includes("FROM link_events")) return { cnt: 0 };
    if (sql.includes("COUNT(*)") && sql.includes("FROM jobs")) return { cnt: jobs.length };
    if (sql.includes("COUNT(*)") && sql.includes("FROM users")) return { cnt: users.length };
    return null;
  }
  function all(sql) {
    if (sql.includes("GROUP BY status")) return [{ status: "completed", cnt: 1 }, { status: "failed", cnt: 1 }];
    if (sql.includes("FROM jobs j LEFT JOIN users")) return jobs;
    if (sql.includes("LEFT JOIN user_stats")) return users;
    return [];
  }
  function run(sql, args) {
    if (sql.includes("INSERT INTO settings")) {
      if (settings.has("admin_auth")) return { meta: { changes: 0 } };
      settings.set("admin_auth", args[0]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO admin_login_attempts")) {
      attempts.push({ ip: args[0], username: args[1], success: args[2], at: args[3] });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO admin_sessions")) {
      sessions.set(args[0], { token_hash: args[0], csrf_token: args[1], username: args[2], expires_at: args[4] });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM admin_sessions")) {
      if (sql.includes("token_hash")) sessions.delete(args[0]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE users SET is_blocked")) {
      const u = users.find((x) => x.telegram_id === args[2]);
      if (!u) return { meta: { changes: 0 } };
      u.is_blocked = args[0];
      u.blocked_at = args[1];
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }
  return {
    _state: { settings, sessions, attempts, users, jobs },
    prepare(sql) {
      const stmt = (args) => ({
        first: async () => first(sql, args),
        all: async () => ({ results: all(sql, args) }),
        run: async () => ({ success: true, ...run(sql, args) })
      });
      return { bind: (...args) => stmt(args), ...stmt([]) };
    },
    batch: async () => []
  };
}

function req(path, { method = "GET", cookie = "", csrf = "", body = null } = {}) {
  const headers = {};
  if (cookie) headers["Cookie"] = cookie;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  if (body) headers["Content-Type"] = "application/json";
  return new Request("https://subtube-bot.hsdoebc.workers.dev" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
function cookieOf(res) {
  const sc = res.headers.get("Set-Cookie") || "";
  const m = sc.match(/st_admin=([a-f0-9]+)/);
  assert.ok(m, "session cookie present");
  assert.ok(sc.includes("HttpOnly") && sc.includes("Secure") && sc.includes("SameSite=Lax") && sc.includes("Path=/admin"), "cookie flags");
  return "st_admin=" + m[1];
}

// full auth lifecycle on one fake deployment
{
  const env = { DB: makeAdminDb() };
  const url = (r) => new URL(r.url);

  let res = await handleAdminRequest(req("/admin/api/stats"), env, url(req("/admin/api/stats")));
  assert.strictEqual(res.status, 401, "stats requires auth");
  assert.strictEqual((await res.json()).setupNeeded, true, "setup needed before admin exists");

  res = await handleAdminRequest(req("/admin/api/setup", { method: "POST", body: { username: "ad", password: "long-enough-1" } }), env, url(req("/admin/api/setup")));
  assert.strictEqual(res.status, 400, "short username rejected");

  res = await handleAdminRequest(req("/admin/api/setup", { method: "POST", body: { username: "admin", password: "long-enough-1" } }), env, url(req("/admin/api/setup")));
  assert.strictEqual(res.status, 201, "setup succeeds");
  const cookie = cookieOf(res);
  const setupBody = await res.json();
  assert.ok(setupBody.csrf, "csrf issued at setup");

  res = await handleAdminRequest(req("/admin/api/setup", { method: "POST", body: { username: "admin2", password: "long-enough-2" } }), env, url(req("/admin/api/setup")));
  assert.strictEqual(res.status, 403, "setup closes after first admin");

  res = await handleAdminRequest(req("/admin/api/me", { cookie }), env, url(req("/admin/api/me")));
  assert.strictEqual(res.status, 200, "me with session");
  const me = await res.json();
  assert.strictEqual(me.username, "admin");
  assert.strictEqual(me.csrf, setupBody.csrf);

  res = await handleAdminRequest(req("/admin/api/stats", { cookie }), env, url(req("/admin/api/stats")));
  const stats = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(stats.totalUsers, 1);
  assert.strictEqual(stats.completed, 1);
  assert.strictEqual(stats.failed, 1);

  res = await handleAdminRequest(req("/admin/api/activity", { cookie }), env, url(req("/admin/api/activity")));
  const act = await res.json();
  assert.strictEqual(act.rows[0].durationSec, 90, "duration computed");
  assert.strictEqual(act.rows[0].domain, "youtube.com");
  assert.strictEqual(act.rows[0].source, "YouTube");
  assert.strictEqual(act.rows[0].model, "gpt-6-luna");

  // CSRF: state change without token is refused, with token works
  res = await handleAdminRequest(req("/admin/api/users/7/block", { method: "POST", cookie, body: { blocked: true } }), env, url(req("/admin/api/users/7/block")));
  assert.strictEqual(res.status, 403, "block without CSRF refused");
  res = await handleAdminRequest(req("/admin/api/users/7/block", { method: "POST", cookie, csrf: me.csrf, body: { blocked: true } }), env, url(req("/admin/api/users/7/block")));
  assert.strictEqual(res.status, 200, "block with CSRF works");
  assert.strictEqual(env.DB._state.users[0].is_blocked, 1);
  res = await handleAdminRequest(req("/admin/api/users/999/block", { method: "POST", cookie, csrf: me.csrf, body: { blocked: true } }), env, url(req("/admin/api/users/999/block")));
  assert.strictEqual(res.status, 404, "unknown user 404");

  // static assets are served (shell carries no data)
  res = await handleAdminRequest(req("/admin"), env, url(req("/admin")));
  assert.strictEqual(res.status, 200);
  assert.ok((await res.text()).includes("/admin/app.js"), "shell references app.js");
  assert.ok((res.headers.get("Content-Security-Policy") || "").includes("default-src 'self'"), "CSP set");
  res = await handleAdminRequest(req("/admin/app.js"), env, url(req("/admin/app.js")));
  assert.strictEqual(res.status, 200);

  // logout kills the session
  res = await handleAdminRequest(req("/admin/api/logout", { method: "POST", cookie, csrf: me.csrf, body: {} }), env, url(req("/admin/api/logout")));
  assert.strictEqual(res.status, 200);
  res = await handleAdminRequest(req("/admin/api/me", { cookie }), env, url(req("/admin/api/me")));
  assert.strictEqual(res.status, 401, "session gone after logout");
  console.log("admin lifecycle (setup/session/csrf/block/logout): PASS");
}

// login flow + rate limiting on a fresh deployment
{
  const env = { DB: makeAdminDb() };
  const url = (r) => new URL(r.url);
  let res = await handleAdminRequest(req("/admin/api/setup", { method: "POST", body: { username: "boss", password: "super-secret-9" } }), env, url(req("/admin/api/setup")));
  assert.strictEqual(res.status, 201);
  for (let i = 0; i < 5; i++) {
    res = await handleAdminRequest(req("/admin/api/login", { method: "POST", body: { username: "boss", password: "wrong-" + i } }), env, url(req("/admin/api/login")));
    assert.strictEqual(res.status, 401, "bad password 401");
  }
  res = await handleAdminRequest(req("/admin/api/login", { method: "POST", body: { username: "boss", password: "super-secret-9" } }), env, url(req("/admin/api/login")));
  assert.strictEqual(res.status, 429, "rate limited after 5 failures");
  console.log("login rate limit: PASS");
}

// expired sessions are rejected
{
  const env = { DB: makeAdminDb() };
  const url = (r) => new URL(r.url);
  let res = await handleAdminRequest(req("/admin/api/setup", { method: "POST", body: { username: "boss", password: "super-secret-9" } }), env, url(req("/admin/api/setup")));
  const cookie = cookieOf(res);
  for (const s of env.DB._state.sessions.values()) s.expires_at = 1;
  res = await handleAdminRequest(req("/admin/api/me", { cookie }), env, url(req("/admin/api/me")));
  assert.strictEqual(res.status, 401, "expired session rejected");
  console.log("session expiry: PASS");
}

console.log("test_admin (stage C): ALL PASS");
