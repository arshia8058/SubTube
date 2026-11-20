// ===== Admin panel backend (same Worker, routes under /admin) =====
// Security model:
// - The admin password is only ever stored as a PBKDF2-HMAC-SHA256 hash
//   (100k iterations, per-install random salt). It can come from the
//   Cloudflare secrets ADMIN_USERNAME + ADMIN_PASSWORD_HASH, or from a
//   one-time /admin setup flow that stores the same hash format in D1.
// - Sessions are random 256-bit tokens; only their SHA-256 hash is kept
//   in D1 (admin_sessions) with a fixed 12h expiry. The cookie is
//   HttpOnly + Secure + SameSite=Lax and scoped to Path=/admin.
// - Every /admin/api/* data endpoint requires a valid session; state-
//   changing calls additionally require the per-session CSRF token.
// - Login attempts are rate-limited per IP (admin_login_attempts).
// - All SQL is parameterized; list endpoints are paginated.
const ADMIN_SESSION_TTL_SEC = 12 * 3600;
const ADMIN_LOGIN_WINDOW_SEC = 15 * 60;
const ADMIN_LOGIN_MAX_FAILS = 5;
const ADMIN_COOKIE_NAME = "st_admin";
const ADMIN_DUMMY_HASH = "v1$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ADMIN_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
};
function adminJson(data, status = 200, extraHeaders = {}) {
  return Response.json(data, { status, headers: { ...ADMIN_SECURITY_HEADERS, ...extraHeaders } });
}
function adminText(body, contentType, status = 200) {
  return new Response(body, { status, headers: { ...ADMIN_SECURITY_HEADERS, "Content-Type": contentType } });
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
function randomHex(byteCount) {
  const a = new Uint8Array(byteCount);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(randomHex, "randomHex");
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
__name(bytesToB64, "bytesToB64");
function b64ToBytes(b64) {
  const s = atob(String(b64 || ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
__name(b64ToBytes, "b64ToBytes");
function timingSafeEqualBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
__name(timingSafeEqualBytes, "timingSafeEqualBytes");
async function hashAdminPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return `v1$100000$${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}
__name(hashAdminPassword, "hashAdminPassword");
async function verifyAdminPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 4 || parts[0] !== "v1") return false;
    const iterations = Math.max(1000, Math.min(600000, parseInt(parts[1], 10) || 0));
    const salt = b64ToBytes(parts[2]);
    const expected = b64ToBytes(parts[3]);
    if (!salt.length || expected.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(password)), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
    return timingSafeEqualBytes(new Uint8Array(bits), expected);
  } catch {
    return false;
  }
}
__name(verifyAdminPassword, "verifyAdminPassword");
async function getAdminAuth(env) {
  if (env.ADMIN_USERNAME && env.ADMIN_PASSWORD_HASH) {
    return { username: String(env.ADMIN_USERNAME), hash: String(env.ADMIN_PASSWORD_HASH), source: "secret" };
  }
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'admin_auth' LIMIT 1`).first();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (parsed?.username && parsed?.hash) return { username: String(parsed.username), hash: String(parsed.hash), source: "db" };
    }
  } catch {
  }
  return null;
}
__name(getAdminAuth, "getAdminAuth");
function clientIp(request) {
  return (request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "").split(",")[0].trim().slice(0, 64);
}
__name(clientIp, "clientIp");
async function adminLoginFails(env, ip) {
  try {
    const since = Math.floor(Date.now() / 1000) - ADMIN_LOGIN_WINDOW_SEC;
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM admin_login_attempts WHERE ip = ?1 AND success = 0 AND attempted_at >= ?2`
    ).bind(ip, since).first();
    return Number(row?.cnt || 0);
  } catch {
    return 0;
  }
}
__name(adminLoginFails, "adminLoginFails");
async function recordLoginAttempt(env, ip, username, success) {
  try {
    await env.DB.prepare(
      `INSERT INTO admin_login_attempts (ip, username, success, attempted_at) VALUES (?1, ?2, ?3, ?4)`
    ).bind(ip, String(username || "").slice(0, 64), success ? 1 : 0, Math.floor(Date.now() / 1000)).run();
  } catch {
  }
}
__name(recordLoginAttempt, "recordLoginAttempt");
function adminSessionCookie(token, maxAge) {
  return `${ADMIN_COOKIE_NAME}=${token}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
__name(adminSessionCookie, "adminSessionCookie");
async function createAdminSession(env, request, username) {
  const token = randomHex(32);
  const csrf = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`DELETE FROM admin_sessions WHERE expires_at < ?1`).bind(now).run();
  await env.DB.prepare(
    `INSERT INTO admin_sessions (token_hash, csrf_token, username, created_at, expires_at, ip, user_agent) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(await sha256Hex(token), csrf, username, now, now + ADMIN_SESSION_TTL_SEC, clientIp(request), (request.headers.get("User-Agent") || "").slice(0, 200)).run();
  return { token, csrf };
}
__name(createAdminSession, "createAdminSession");
function parseCookieHeader(request) {
  const out = new Map();
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}
__name(parseCookieHeader, "parseCookieHeader");
async function getAdminSession(request, env) {
  try {
    const token = parseCookieHeader(request).get(ADMIN_COOKIE_NAME);
    if (!token) return null;
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      `SELECT token_hash, csrf_token, username, expires_at FROM admin_sessions WHERE token_hash = ?1 LIMIT 1`
    ).bind(await sha256Hex(token)).first();
    if (!row || Number(row.expires_at) <= now) return null;
    return row;
  } catch {
    return null;
  }
}
__name(getAdminSession, "getAdminSession");
function checkAdminCsrf(request, session) {
  const sent = request.headers.get("X-CSRF-Token") || "";
  if (!sent || !timingSafeEqualStr(sent, session.csrf_token)) return false;
  const origin = request.headers.get("Origin");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return false;
    } catch {
      return false;
    }
  }
  return true;
}
__name(checkAdminCsrf, "checkAdminCsrf");
function tehranDayStartIso(nowMs = Date.now()) {
  const tehran = new Date(nowMs + 3.5 * 3600 * 1000);
  const startUtcMs = Date.UTC(tehran.getUTCFullYear(), tehran.getUTCMonth(), tehran.getUTCDate()) - 3.5 * 3600 * 1000;
  return new Date(startUtcMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}
__name(tehranDayStartIso, "tehranDayStartIso");
function parsePageParams(url) {
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "25", 10) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
__name(parsePageParams, "parsePageParams");
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}
__name(escapeLike, "escapeLike");
function jobRowToApi(r) {
  const domain = extractDomain(r.video_url);
  let durationSec = null;
  if (r.created_at && r.completed_at) {
    const d = Math.round((Date.parse(r.completed_at) - Date.parse(r.created_at)) / 1000);
    if (Number.isFinite(d) && d >= 0) durationSec = d;
  }
  return {
    id: r.id,
    telegramId: r.telegram_id,
    username: r.username || null,
    firstName: r.first_name || null,
    videoUrl: r.video_url,
    videoId: r.video_id,
    domain,
    source: sourceFromDomain(domain),
    status: r.status,
    provider: r.provider || null,
    model: r.model || null,
    cueCount: r.cue_count == null ? null : Number(r.cue_count),
    error: r.error_message || null,
    createdAt: r.created_at,
    completedAt: r.completed_at || null,
    durationSec
  };
}
__name(jobRowToApi, "jobRowToApi");
async function queryJobsPage(env, { page, pageSize, offset, status = "", q = "", telegramId = null }) {
  const where = [];
  const binds = [];
  if (telegramId != null) { where.push("j.telegram_id = ?"); binds.push(Number(telegramId)); }
  if (status && ["processing", "completed", "failed"].includes(status)) { where.push("j.status = ?"); binds.push(status); }
  if (q) {
    const like = "%" + escapeLike(q) + "%";
    where.push("(u.username LIKE ? ESCAPE '\\' OR u.first_name LIKE ? ESCAPE '\\' OR j.video_id LIKE ? ESCAPE '\\' OR CAST(j.telegram_id AS TEXT) = ?)");
    binds.push(like, like, like, q);
  }
  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM jobs j LEFT JOIN users u ON u.telegram_id = j.telegram_id${whereSql}`
  ).bind(...binds).first();
  const res = await env.DB.prepare(
    `SELECT j.id, j.telegram_id, u.username, u.first_name, j.video_url, j.video_id, j.status,
            j.provider, j.model, j.cue_count, j.error_message, j.created_at, j.completed_at
       FROM jobs j LEFT JOIN users u ON u.telegram_id = j.telegram_id${whereSql}
      ORDER BY j.id DESC LIMIT ? OFFSET ?`
  ).bind(...binds, pageSize, offset).all();
  return { rows: (res?.results || []).map(jobRowToApi), total: Number(totalRow?.cnt || 0), page, pageSize };
}
__name(queryJobsPage, "queryJobsPage");
async function handleAdminSetup(request, env) {
  const ip = clientIp(request);
  if ((await adminLoginFails(env, ip)) >= ADMIN_LOGIN_MAX_FAILS * 2) {
    return adminJson({ ok: false, error: "too_many_attempts" }, 429);
  }
  const auth = await getAdminAuth(env);
  if (auth) return adminJson({ ok: false, error: "setup_closed" }, 403);
  let body;
  try { body = await request.json(); } catch { return adminJson({ ok: false, error: "bad_request" }, 400); }
  const username = String(body?.username || "").trim();
  const password = String(body?.password || "");
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return adminJson({ ok: false, error: "bad_username" }, 400);
  if (password.length < 10 || password.length > 200) return adminJson({ ok: false, error: "weak_password" }, 400);
  const hash = await hashAdminPassword(password);
  const res = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('admin_auth', ?1) ON CONFLICT(key) DO NOTHING`
  ).bind(JSON.stringify({ username, hash })).run();
  if (!Number(res?.meta?.changes || 0)) return adminJson({ ok: false, error: "setup_closed" }, 403);
  await recordLoginAttempt(env, ip, username, 1);
  const session = await createAdminSession(env, request, username);
  return adminJson({ ok: true, username, csrf: session.csrf }, 201, { "Set-Cookie": adminSessionCookie(session.token, ADMIN_SESSION_TTL_SEC) });
}
__name(handleAdminSetup, "handleAdminSetup");
async function handleAdminLogin(request, env) {
  const ip = clientIp(request);
  if ((await adminLoginFails(env, ip)) >= ADMIN_LOGIN_MAX_FAILS) {
    return adminJson({ ok: false, error: "too_many_attempts" }, 429);
  }
  let body;
  try { body = await request.json(); } catch { return adminJson({ ok: false, error: "bad_request" }, 400); }
  const username = String(body?.username || "");
  const password = String(body?.password || "");
  const auth = await getAdminAuth(env);
  if (!auth) return adminJson({ ok: false, error: "setup_required" }, 403);
  const userOk = timingSafeEqualStr(username, auth.username);
  const passOk = await verifyAdminPassword(password, userOk ? auth.hash : ADMIN_DUMMY_HASH);
  if (!userOk || !passOk) {
    await recordLoginAttempt(env, ip, username, 0);
    return adminJson({ ok: false, error: "invalid_credentials" }, 401);
  }
  await recordLoginAttempt(env, ip, username, 1);
  const session = await createAdminSession(env, request, auth.username);
  return adminJson({ ok: true, username: auth.username, csrf: session.csrf }, 200, { "Set-Cookie": adminSessionCookie(session.token, ADMIN_SESSION_TTL_SEC) });
}
__name(handleAdminLogin, "handleAdminLogin");
async function handleAdminApi(request, env, url) {
  const sub = url.pathname.slice("/admin/api".length);
  if (request.method === "POST" && sub === "/setup") return handleAdminSetup(request, env);
  if (request.method === "POST" && sub === "/login") return handleAdminLogin(request, env);
  const session = await getAdminSession(request, env);
  if (!session) {
    const auth = await getAdminAuth(env);
    return adminJson({ ok: false, error: "unauthorized", setupNeeded: !auth }, 401);
  }
  if (request.method !== "GET" && !checkAdminCsrf(request, session)) {
    return adminJson({ ok: false, error: "csrf_failed" }, 403);
  }
  if (request.method === "GET" && sub === "/me") {
    return adminJson({ ok: true, username: session.username, csrf: session.csrf_token });
  }
  if (request.method === "POST" && sub === "/logout") {
    try {
      await env.DB.prepare(`DELETE FROM admin_sessions WHERE token_hash = ?1`).bind(session.token_hash).run();
    } catch {
    }
    return adminJson({ ok: true }, 200, { "Set-Cookie": adminSessionCookie("", 0) });
  }
  if (request.method === "GET" && sub === "/stats") {
    const today = tehranDayStartIso();
    const [totalUsers, activeToday, totalRequests, byStatus, linksToday] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM users`).first(),
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE last_active_at >= ?1`).bind(today).first(),
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM jobs`).first(),
      env.DB.prepare(`SELECT status, COUNT(*) AS cnt FROM jobs GROUP BY status`).all(),
      env.DB.prepare(`SELECT COUNT(*) AS cnt FROM link_events WHERE created_at >= ?1 AND outcome = 'received'`).bind(today).first()
    ]);
    const counts = { completed: 0, failed: 0, processing: 0 };
    for (const r of byStatus?.results || []) {
      if (r.status in counts) counts[r.status] = Number(r.cnt || 0);
    }
    return adminJson({
      ok: true,
      totalUsers: Number(totalUsers?.cnt || 0),
      activeToday: Number(activeToday?.cnt || 0),
      totalRequests: Number(totalRequests?.cnt || 0),
      completed: counts.completed,
      failed: counts.failed,
      processing: counts.processing,
      linksToday: Number(linksToday?.cnt || 0)
    });
  }
  if (request.method === "GET" && sub === "/chart") {
    const since = new Date(Date.now() - 16 * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const res = await env.DB.prepare(
      `SELECT date(created_at, '+210 minutes') AS d, COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM jobs WHERE created_at >= ?1 GROUP BY d ORDER BY d`
    ).bind(since).all();
    const byDay = new Map((res?.results || []).map((r) => [r.d, r]));
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const t = new Date(Date.now() - i * 86400 * 1000 + 3.5 * 3600 * 1000);
      const key = t.toISOString().slice(0, 10);
      const r = byDay.get(key);
      days.push({ date: key, total: Number(r?.total || 0), completed: Number(r?.completed || 0), failed: Number(r?.failed || 0) });
    }
    return adminJson({ ok: true, days });
  }
  if (request.method === "GET" && (sub === "/activity" || sub === "/translations")) {
    const { page, pageSize, offset } = parsePageParams(url);
    const data = await queryJobsPage(env, {
      page, pageSize, offset,
      status: url.searchParams.get("status") || "",
      q: (url.searchParams.get("q") || "").trim()
    });
    return adminJson({ ok: true, ...data });
  }
  if (request.method === "GET" && sub === "/users") {
    const { page, pageSize, offset } = parsePageParams(url);
    const q = (url.searchParams.get("q") || "").trim();
    const where = [];
    const binds = [];
    if (q) {
      const like = "%" + escapeLike(q) + "%";
      where.push("(CAST(u.telegram_id AS TEXT) = ? OR u.username LIKE ? ESCAPE '\\' OR u.first_name LIKE ? ESCAPE '\\')");
      binds.push(q, like, like);
    }
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
    const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM users u${whereSql}`).bind(...binds).first();
    const res = await env.DB.prepare(
      `SELECT u.telegram_id, u.username, u.first_name, u.created_at, u.last_active_at, u.is_blocked,
              COALESCE(s.total_jobs, 0) AS total_jobs, COALESCE(s.successful_jobs, 0) AS successful_jobs, COALESCE(s.failed_jobs, 0) AS failed_jobs
         FROM users u LEFT JOIN user_stats s ON s.telegram_id = u.telegram_id${whereSql}
        ORDER BY u.last_active_at DESC LIMIT ? OFFSET ?`
    ).bind(...binds, pageSize, offset).all();
    return adminJson({
      ok: true,
      rows: (res?.results || []).map((r) => ({
        telegramId: r.telegram_id,
        username: r.username || null,
        firstName: r.first_name || null,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
        isBlocked: Number(r.is_blocked || 0) === 1,
        totalJobs: Number(r.total_jobs || 0),
        successfulJobs: Number(r.successful_jobs || 0),
        failedJobs: Number(r.failed_jobs || 0)
      })),
      total: Number(totalRow?.cnt || 0),
      page, pageSize
    });
  }
  const userActivityMatch = sub.match(/^\/users\/(\d+)\/activity$/);
  if (request.method === "GET" && userActivityMatch) {
    const { page, pageSize, offset } = parsePageParams(url);
    const data = await queryJobsPage(env, { page, pageSize, offset, telegramId: Number(userActivityMatch[1]) });
    return adminJson({ ok: true, ...data });
  }
  const blockMatch = sub.match(/^\/users\/(\d+)\/block$/);
  if (request.method === "POST" && blockMatch) {
    let body;
    try { body = await request.json(); } catch { return adminJson({ ok: false, error: "bad_request" }, 400); }
    const blocked = body?.blocked === true;
    const res = await env.DB.prepare(
      `UPDATE users SET is_blocked = ?1, blocked_at = ?2 WHERE telegram_id = ?3`
    ).bind(blocked ? 1 : 0, blocked ? new Date().toISOString().replace(/\.\d{3}Z$/, "Z") : null, Number(blockMatch[1])).run();
    if (!Number(res?.meta?.changes || 0)) return adminJson({ ok: false, error: "user_not_found" }, 404);
    return adminJson({ ok: true, isBlocked: blocked });
  }
  if (request.method === "GET" && sub === "/links") {
    const [bySource, topDomains, invalidRecent, totals] = await Promise.all([
      env.DB.prepare(`SELECT source, outcome, COUNT(*) AS cnt FROM link_events GROUP BY source, outcome ORDER BY cnt DESC`).all(),
      env.DB.prepare(`SELECT domain, COUNT(*) AS cnt FROM link_events WHERE domain IS NOT NULL GROUP BY domain ORDER BY cnt DESC LIMIT 10`).all(),
      env.DB.prepare(`SELECT id, telegram_id, username, url, domain, created_at FROM link_events WHERE outcome = 'invalid' ORDER BY id DESC LIMIT 20`).all(),
      env.DB.prepare(`SELECT outcome, COUNT(*) AS cnt FROM link_events GROUP BY outcome`).all()
    ]);
    const tot = { received: 0, invalid: 0 };
    for (const r of totals?.results || []) {
      if (r.outcome in tot) tot[r.outcome] = Number(r.cnt || 0);
    }
    return adminJson({
      ok: true,
      bySource: (bySource?.results || []).map((r) => ({ source: r.source, outcome: r.outcome, count: Number(r.cnt || 0) })),
      topDomains: (topDomains?.results || []).map((r) => ({ domain: r.domain, count: Number(r.cnt || 0) })),
      invalidRecent: (invalidRecent?.results || []).map((r) => ({
        id: r.id, telegramId: r.telegram_id, username: r.username || null, url: r.url, domain: r.domain, createdAt: r.created_at
      })),
      totals: tot
    });
  }
  return adminJson({ ok: false, error: "not_found" }, 404);
}
__name(handleAdminApi, "handleAdminApi");
async function handleAdminRequest(request, env, url) {
  if (!env.DB) return adminJson({ ok: false, error: "db_unavailable" }, 500);
  const path = url.pathname;
  if (path.startsWith("/admin/api/") || path === "/admin/api") {
    try {
      return await handleAdminApi(request, env, url);
    } catch (err) {
      console.error("[admin] api error:", sanitizeErrorMessage(err));
      return adminJson({ ok: false, error: "server_error" }, 500);
    }
  }
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: ADMIN_SECURITY_HEADERS });
  if (path === "/admin" || path === "/admin/") return adminText(ADMIN_HTML, "text/html; charset=utf-8");
  if (path === "/admin/app.css") return adminText(ADMIN_CSS, "text/css; charset=utf-8");
  if (path === "/admin/app.js") return adminText(ADMIN_JS, "text/javascript; charset=utf-8");
  return new Response("Not Found", { status: 404, headers: ADMIN_SECURITY_HEADERS });
}
__name(handleAdminRequest, "handleAdminRequest");
