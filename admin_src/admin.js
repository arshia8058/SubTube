"use strict";
/* SubTube admin panel — framework-free SPA. All data comes from the
   authenticated /admin/api endpoints; nothing sensitive lives here. */

const I18N = {
  fa: {
    panelTitle: "پنل مدیریت", dashboard: "داشبورد", activity: "گزارش فعالیت", users: "کاربران",
    translations: "ترجمه‌ها", links: "تحلیل لینک‌ها", logout: "خروج", refresh: "به‌روزرسانی",
    searchPlaceholder: "جستجوی سریع…", search: "جستجو",
    totalUsers: "کل کاربران", activeToday: "فعال امروز", totalRequests: "کل درخواست‌ها",
    completed: "موفق", failed: "ناموفق", processing: "در حال انجام", linksToday: "لینک‌های امروز",
    last14: "درخواست‌های ۱۴ روز اخیر", recentActivity: "آخرین فعالیت‌ها",
    user: "کاربر", link: "لینک", source: "منبع", status: "وضعیت", model: "مدل / سرویس",
    cues: "زیرنویس", duration: "مدت", time: "زمان", error: "خطا",
    all: "همه", prev: "قبلی", next: "بعدی", pageOf: (p, n) => `صفحه ${p} از ${n}`,
    noData: "داده‌ای نیست", firstSeen: "اولین فعالیت", lastSeen: "آخرین فعالیت",
    requests: "درخواست‌ها", actions: "عملیات", history: "تاریخچه", block: "مسدود کن", unblock: "رفع مسدودی",
    blocked: "مسدود", back: "بازگشت", userActivity: (u) => `تاریخچه درخواست‌های ${u}`,
    receivedLinks: "لینک‌های دریافتی", invalidLinks: "لینک‌های نامعتبر", topDomains: "دامنه‌های پرتکرار",
    bySource: "به تفکیک منبع", domain: "دامنه", count: "تعداد", outcome: "نتیجه",
    received: "دریافت‌شده", invalid: "نامعتبر",
    login: "ورود", username: "نام کاربری", password: "رمز عبور", loginSub: "ورود مدیر ربات SubTube",
    badCreds: "نام کاربری یا رمز عبور اشتباه است.", tooMany: "تلاش‌های ناموفق زیاد شد؛ چند دقیقه دیگر دوباره تلاش کن.",
    sessionExpired: "نشست شما تمام شده؛ دوباره وارد شو.", genericErr: "خطایی رخ داد؛ دوباره تلاش کن.",
    setupTitle: "راه‌اندازی اولیه مدیر", setupSub: "هنوز مدیر تعریف نشده است. نام کاربری و رمز عبور مدیر را بساز.",
    setupBtn: "ساختن مدیر و ورود", passConfirm: "تکرار رمز عبور", passMismatch: "رمز عبور و تکرارش یکی نیستند.",
    weakPass: "رمز عبور باید دست‌کم ۱۰ نویسه باشد.", badUsername: "نام کاربری باید ۳ تا ۳۲ نویسه (حروف انگلیسی، عدد، . _ -) باشد.",
    linksNote: "ثبت لینک‌ها از زمان راه‌اندازی پنل انجام می‌شود؛ فعالیت‌های قبلی در گزارش فعالیت (بر اساس پردازش‌ها) دیده می‌شوند.",
    telegramId: "شناسه تلگرام"
  },
  en: {
    panelTitle: "Admin Panel", dashboard: "Dashboard", activity: "Activity", users: "Users",
    translations: "Translations", links: "Link Analytics", logout: "Log out", refresh: "Refresh",
    searchPlaceholder: "Quick search…", search: "Search",
    totalUsers: "Total users", activeToday: "Active today", totalRequests: "Total requests",
    completed: "Successful", failed: "Failed", processing: "In progress", linksToday: "Links today",
    last14: "Requests — last 14 days", recentActivity: "Recent activity",
    user: "User", link: "Link", source: "Source", status: "Status", model: "Model / Service",
    cues: "Cues", duration: "Duration", time: "Time", error: "Error",
    all: "All", prev: "Prev", next: "Next", pageOf: (p, n) => `Page ${p} of ${n}`,
    noData: "No data", firstSeen: "First seen", lastSeen: "Last active",
    requests: "Requests", actions: "Actions", history: "History", block: "Block", unblock: "Unblock",
    blocked: "Blocked", back: "Back", userActivity: (u) => `Request history of ${u}`,
    receivedLinks: "Received links", invalidLinks: "Invalid links", topDomains: "Top domains",
    bySource: "By source", domain: "Domain", count: "Count", outcome: "Outcome",
    received: "Received", invalid: "Invalid",
    login: "Log in", username: "Username", password: "Password", loginSub: "SubTube bot admin sign-in",
    badCreds: "Wrong username or password.", tooMany: "Too many failed attempts; try again in a few minutes.",
    sessionExpired: "Your session expired; please log in again.", genericErr: "Something went wrong; try again.",
    setupTitle: "First-run admin setup", setupSub: "No admin exists yet. Create the admin username and password.",
    setupBtn: "Create admin & log in", passConfirm: "Repeat password", passMismatch: "Passwords do not match.",
    weakPass: "Password must be at least 10 characters.", badUsername: "Username must be 3–32 chars (letters, digits, . _ -).",
    linksNote: "Links are recorded since the panel launched; earlier activity is visible in the Activity report (from processed jobs).",
    telegramId: "Telegram ID"
  }
};

const state = {
  lang: localStorage.getItem("st_admin_lang") || "fa",
  csrf: "",
  username: "",
  view: "dashboard",
  activity: { page: 1, status: "", q: "" },
  translations: { page: 1, status: "" },
  users: { page: 1, q: "" },
  userDetail: null,
  userActivity: { page: 1 },
  notice: ""
};
const PAGE_SIZE = 25;
const $app = document.getElementById("app");

const ICON_PATHS = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.15" fill="currentColor" stroke="none"/>',
  group: '<circle cx="9" cy="8.2" r="3.4"/><path d="M3.2 19.2c.7-3.1 3-4.7 5.8-4.7s5.1 1.6 5.8 4.7"/><circle cx="17.2" cy="9.2" r="2.7"/><path d="M16.4 14.6c2.2.3 3.7 1.7 4.2 4.1"/>',
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.4 3.6-5.2 7-5.2s6.2 1.8 7 5.2"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="M6.8 12h4.2M6.8 15.4h7M13.8 12h3.4"/>',
  link: '<path d="M10.2 13.8a5 5 0 0 0 7 0l2.8-2.8a5 5 0 0 0-7-7l-1.6 1.6"/><path d="M13.8 10.2a5 5 0 0 0-7 0L4 13a5 5 0 0 0 7 7l1.6-1.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4-4"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20.2 3.4v4h-4"/>',
  logout: '<path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2.2"/><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8.4 12.3 2.5 2.5 4.8-5.3"/>',
  xcross: '<circle cx="12" cy="12" r="9"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.4 2"/>'
};
function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}
const LOGO_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 5.6v12.8c0 .9 1 1.5 1.8 1L19.4 13a1.15 1.15 0 0 0 0-2L10 4.6c-.8-.5-1.8.1-1.8 1Z" fill="#fff"/></svg>';

function t(key, ...args) {
  const v = I18N[state.lang][key] ?? I18N.fa[key] ?? key;
  return typeof v === "function" ? v(...args) : v;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function num(n) {
  return Number(n ?? 0).toLocaleString(state.lang === "fa" ? "fa-IR" : "en-US");
}
function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(state.lang === "fa" ? "fa-IR" : "en-GB", { timeZone: "Asia/Tehran", dateStyle: "medium", timeStyle: "short" });
  } catch { return iso; }
}
function fmtDuration(sec) {
  if (sec == null) return "—";
  if (sec < 60) return state.lang === "fa" ? `${num(sec)} ثانیه` : `${sec}s`;
  return `${num(Math.floor(sec / 60))}:${String(sec % 60).padStart(2, "0")}`;
}
function statusBadge(st) {
  return `<span class="badge ${esc(st)}"><span class="dot"></span>${esc(t(st) || st)}</span>`;
}
function userLabel(r) {
  const name = r.username ? "@" + r.username : (r.firstName || "—");
  const initial = esc(String(r.username || r.firstName || "?").trim().charAt(0) || "?");
  return `<div class="user-cell"><span class="avatar">${initial}</span><span><div>${esc(name)}</div><div class="faint small">${num(r.telegramId)}${r.firstName ? " · " + esc(r.firstName) : ""}</div></span></div>`;
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.method && opts.method !== "GET") {
    headers["Content-Type"] = "application/json";
    if (state.csrf) headers["X-CSRF-Token"] = state.csrf;
  }
  const res = await fetch(path, { ...opts, headers, credentials: "same-origin" });
  let data = null;
  try { data = await res.json(); } catch { }
  if (res.status === 401 && !path.endsWith("/login") && !path.endsWith("/setup") && !path.endsWith("/me")) {
    state.notice = t("sessionExpired");
    renderAuth(false);
    throw new Error("unauthorized");
  }
  return { status: res.status, data };
}

/* ---------------- auth views ---------------- */
function renderAuth(setupNeeded, errorMsg = "") {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === "fa" ? "rtl" : "ltr";
  const isSetup = !!setupNeeded;
  $app.innerHTML = `
  <div class="auth-wrap"><div class="auth-card">
    <div class="auth-logo"><span class="logo-mark">${LOGO_SVG}</span><span>Sub<span class="logo-accent">Tube</span></span></div>
    <p class="auth-sub">${esc(isSetup ? t("setupTitle") : t("loginSub"))}</p>
    ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ""}
    ${errorMsg ? `<div class="auth-error">${esc(errorMsg)}</div>` : ""}
    <form id="auth-form">
      <div class="field"><label>${esc(t("username"))}</label><input id="auth-user" autocomplete="username" required></div>
      <div class="field"><label>${esc(t("password"))}</label><input id="auth-pass" type="password" autocomplete="${isSetup ? "new-password" : "current-password"}" required></div>
      ${isSetup ? `<div class="field"><label>${esc(t("passConfirm"))}</label><input id="auth-pass2" type="password" autocomplete="new-password" required></div>` : ""}
      <button class="btn block" type="submit">${esc(isSetup ? t("setupBtn") : t("login"))}</button>
    </form>
    ${isSetup ? `<p class="auth-note">${esc(t("setupSub"))}</p>` : ""}
  </div></div>`;
  document.getElementById("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("auth-user").value.trim();
    const password = document.getElementById("auth-pass").value;
    if (isSetup) {
      const pass2 = document.getElementById("auth-pass2").value;
      if (password.length < 10) return renderAuth(true, t("weakPass"));
      if (password !== pass2) return renderAuth(true, t("passMismatch"));
      const { status, data } = await api("/admin/api/setup", { method: "POST", body: JSON.stringify({ username, password }) });
      if (status === 201 && data?.ok) return enterApp(data);
      const msg = data?.error === "bad_username" ? t("badUsername") : data?.error === "too_many_attempts" ? t("tooMany") : t("genericErr");
      return renderAuth(true, msg);
    }
    const { status, data } = await api("/admin/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
    if (status === 200 && data?.ok) return enterApp(data);
    const msg = data?.error === "invalid_credentials" ? t("badCreds") : data?.error === "too_many_attempts" ? t("tooMany") : data?.error === "setup_required" ? t("setupSub") : t("genericErr");
    return renderAuth(false, msg);
  });
}

/* ---------------- app shell ---------------- */
function enterApp(sessionData) {
  state.csrf = sessionData.csrf || state.csrf;
  state.username = sessionData.username || state.username;
  state.notice = "";
  renderShell();
  showView("dashboard");
}
function renderShell() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === "fa" ? "rtl" : "ltr";
  const nav = [
    ["dashboard", "grid", t("dashboard")], ["activity", "list", t("activity")], ["users", "group", t("users")],
    ["translations", "captions", t("translations")], ["links", "link", t("links")]
  ];
  $app.innerHTML = `
  <div class="layout">
    <aside class="sidebar">
      <div class="brand"><span class="logo-mark">${LOGO_SVG}</span><span>Sub<span class="logo-accent">Tube</span></span></div>
      ${nav.map(([v, ic, label]) => `<button class="nav-item ${state.view === v ? "active" : ""}" data-nav="${v}">${icon(ic)} ${esc(label)}</button>`).join("")}
    </aside>
    <main class="main">
      <div class="topbar">
        <h1 id="view-title"></h1>
        <div class="spacer"></div>
        <div class="search-box">${icon("search")}<input id="global-search" placeholder="${esc(t("searchPlaceholder"))}"></div>
        <span class="user-chip">${esc(state.username)}</span>
        <button class="icon-btn" id="refresh-btn" title="${esc(t("refresh"))}">${icon("refresh")}</button>
        <button class="icon-btn" id="lang-toggle">${icon("globe")} ${state.lang === "fa" ? "EN" : "فارسی"}</button>
        <button class="icon-btn" id="logout-btn">${icon("logout")} ${esc(t("logout"))}</button>
      </div>
      <div id="view-body"></div>
    </main>
    <nav class="bottomnav">
      ${nav.map(([v, ic, label]) => `<button class="${state.view === v ? "active" : ""}" data-nav="${v}">${icon(ic)}<span>${esc(label)}</span></button>`).join("")}
    </nav>
  </div>`;
  $app.querySelectorAll("[data-nav]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.nav)));
  document.getElementById("lang-toggle").addEventListener("click", () => {
    state.lang = state.lang === "fa" ? "en" : "fa";
    localStorage.setItem("st_admin_lang", state.lang);
    renderShell();
    showView(state.view);
  });
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("/admin/api/logout", { method: "POST", body: "{}" }).catch(() => { });
    state.csrf = ""; state.username = "";
    renderAuth(false);
  });
  document.getElementById("refresh-btn").addEventListener("click", () => showView(state.view));
  const gs = document.getElementById("global-search");
  gs.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      state.activity.q = gs.value.trim();
      state.activity.page = 1;
      showView("activity");
    }
  });
}

function showView(view) {
  state.view = view;
  state.userDetail = view === "userDetail" ? state.userDetail : (view === "users" ? null : state.userDetail);
  $app.querySelectorAll("[data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === view));
  const titles = { dashboard: t("dashboard"), activity: t("activity"), users: t("users"), translations: t("translations"), links: t("links"), userDetail: t("history") };
  document.getElementById("view-title").textContent = titles[view] || "";
  const body = document.getElementById("view-body");
  body.innerHTML = `<div class="empty">…</div>`;
  if (view === "dashboard") return viewDashboard(body);
  if (view === "activity") return viewJobs(body, state.activity, "activity");
  if (view === "translations") return viewJobs(body, state.translations, "translations");
  if (view === "users") return viewUsers(body);
  if (view === "userDetail") return viewUserDetail(body);
  if (view === "links") return viewLinks(body);
}

/* ---------------- dashboard ---------------- */
async function viewDashboard(body) {
  const [statsRes, chartRes, recentRes] = await Promise.all([
    api("/admin/api/stats"), api("/admin/api/chart"), api("/admin/api/activity?pageSize=8")
  ]);
  const s = statsRes.data || {};
  const days = chartRes.data?.days || [];
  const max = Math.max(1, ...days.map((d) => d.total));
  const W = 700, H = 170, bw = W / Math.max(1, days.length);
  const bars = days.map((d, i) => {
    const x = i * bw + bw * 0.22, w = bw * 0.26;
    const hT = (d.total / max) * (H - 34), hC = (d.completed / max) * (H - 34);
    return `<rect x="${x}" y="${H - 18 - hT}" width="${w}" height="${hT}" rx="3" fill="#7c6cf0" opacity="0.55"><title>${esc(d.date)} — ${esc(t("totalRequests"))}: ${d.total}</title></rect>
            <rect x="${x + w + 2}" y="${H - 18 - hC}" width="${w}" height="${hC}" rx="3" fill="#2dd4bf"><title>${esc(d.date)} — ${esc(t("completed"))}: ${d.completed}</title></rect>
            <text x="${x + w / 2}" y="${H - 3}" font-size="9.5" fill="#5d6c88" text-anchor="middle">${esc(d.date.slice(5))}</text>`;
  }).join("");
  body.innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-top"><span class="card-label">${esc(t("totalUsers"))}</span><span class="icon-chip">${icon("group")}</span></div><div class="card-value">${num(s.totalUsers)}</div></div>
      <div class="card"><div class="card-top"><span class="card-label">${esc(t("activeToday"))}</span><span class="icon-chip teal">${icon("person")}</span></div><div class="card-value">${num(s.activeToday)}</div></div>
      <div class="card"><div class="card-top"><span class="card-label">${esc(t("totalRequests"))}</span><span class="icon-chip">${icon("film")}</span></div><div class="card-value">${num(s.totalRequests)}</div></div>
      <div class="card"><div class="card-top"><span class="card-label">${esc(t("completed"))}</span><span class="icon-chip ok">${icon("check")}</span></div><div class="card-value ok">${num(s.completed)}</div></div>
      <div class="card"><div class="card-top"><span class="card-label">${esc(t("failed"))}</span><span class="icon-chip bad">${icon("xcross")}</span></div><div class="card-value bad">${num(s.failed)}</div></div>
      <div class="card"><div class="card-top"><span class="card-label">${esc(t("processing"))}</span><span class="icon-chip warn">${icon("clock")}</span></div><div class="card-value warn">${num(s.processing)}</div></div>
      <div class="card"><div class="card-top"><span class="card-label">${esc(t("linksToday"))}</span><span class="icon-chip teal">${icon("link")}</span></div><div class="card-value">${num(s.linksToday)}</div></div>
    </div>
    <div class="panel"><h2>${esc(t("last14"))}</h2><div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${bars}</svg></div></div>
    <div class="panel"><h2>${esc(t("recentActivity"))}</h2>${jobsTable(recentRes.data?.rows || [], true)}</div>`;
}

function jobsTable(rows, compact = false) {
  if (!rows.length) return `<div class="empty">${esc(t("noData"))}</div>`;
  return `<div class="table-scroll"><table><thead><tr>
    <th>${esc(t("user"))}</th><th>${esc(t("link"))}</th><th>${esc(t("source"))}</th><th>${esc(t("status"))}</th>
    <th>${esc(t("model"))}</th><th>${esc(t("cues"))}</th><th>${esc(t("duration"))}</th><th>${esc(t("time"))}</th>${compact ? "" : `<th>${esc(t("error"))}</th>`}
  </tr></thead><tbody>
  ${rows.map((r) => `<tr>
    <td data-label="${esc(t("user"))}">${userLabel(r)}</td>
    <td data-label="${esc(t("link"))}" class="link-text small"><a href="${esc(r.videoUrl)}" target="_blank" rel="noopener">${esc(r.domain || "")}/${esc(r.videoId || "")}</a></td>
    <td data-label="${esc(t("source"))}">${esc(r.source || "—")}</td>
    <td data-label="${esc(t("status"))}">${statusBadge(r.status)}</td>
    <td data-label="${esc(t("model"))}" class="small">${esc(r.provider || "—")}${r.model ? " / " + esc(r.model) : ""}</td>
    <td data-label="${esc(t("cues"))}">${r.cueCount == null ? "—" : num(r.cueCount)}</td>
    <td data-label="${esc(t("duration"))}">${esc(fmtDuration(r.durationSec))}</td>
    <td data-label="${esc(t("time"))}" class="small">${esc(fmtTime(r.createdAt))}</td>
    ${compact ? "" : `<td data-label="${esc(t("error"))}" class="err-text">${esc(r.error || "")}</td>`}
  </tr>`).join("")}
  </tbody></table></div>`;
}

function pagerHtml(page, total, pageSize) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return `<div class="pager">
    <button data-pg="prev" ${page <= 1 ? "disabled" : ""}>${esc(t("prev"))}</button>
    <span class="muted">${esc(t("pageOf", num(page), num(pages)))} · ${num(total)}</span>
    <button data-pg="next" ${page >= pages ? "disabled" : ""}>${esc(t("next"))}</button></div>`;
}
function bindPager(body, st, rerender) {
  body.querySelectorAll("[data-pg]").forEach((b) => b.addEventListener("click", () => {
    st.page += b.dataset.pg === "next" ? 1 : -1;
    if (st.page < 1) st.page = 1;
    rerender();
  }));
}

/* ---------------- activity & translations ---------------- */
async function viewJobs(body, st, kind) {
  const params = new URLSearchParams({ page: st.page, pageSize: PAGE_SIZE });
  if (st.status) params.set("status", st.status);
  if (kind === "activity" && st.q) params.set("q", st.q);
  const { data } = await api(`/admin/api/${kind}?${params}`);
  const rows = data?.rows || [];
  const statusTabs = ["", "completed", "failed", "processing"];
  body.innerHTML = `
    <div class="tabs">${statusTabs.map((s) => `<button class="tab ${st.status === s ? "active" : ""}" data-st="${s}">${esc(s === "" ? t("all") : t(s))}</button>`).join("")}</div>
    ${kind === "activity" ? `<div class="toolbar"><input type="text" id="jobs-q" placeholder="${esc(t("searchPlaceholder"))}" value="${esc(st.q)}"><button class="btn ghost small" id="jobs-search">${esc(t("search"))}</button></div>` : ""}
    ${jobsTable(rows)}
    ${pagerHtml(st.page, data?.total || 0, PAGE_SIZE)}`;
  body.querySelectorAll("[data-st]").forEach((b) => b.addEventListener("click", () => { st.status = b.dataset.st; st.page = 1; viewJobs(body, st, kind); }));
  const searchBtn = document.getElementById("jobs-search");
  if (searchBtn) searchBtn.addEventListener("click", () => { st.q = document.getElementById("jobs-q").value.trim(); st.page = 1; viewJobs(body, st, kind); });
  bindPager(body, st, () => viewJobs(body, st, kind));
}

/* ---------------- users ---------------- */
async function viewUsers(body) {
  const st = state.users;
  const params = new URLSearchParams({ page: st.page, pageSize: PAGE_SIZE });
  if (st.q) params.set("q", st.q);
  const { data } = await api(`/admin/api/users?${params}`);
  const rows = data?.rows || [];
  body.innerHTML = `
    <div class="toolbar"><input type="text" id="users-q" placeholder="${esc(t("searchPlaceholder"))} (${esc(t("telegramId"))} / @username)" value="${esc(st.q)}"><button class="btn ghost small" id="users-search">${esc(t("search"))}</button></div>
    ${rows.length ? `<div class="table-scroll"><table><thead><tr>
      <th>${esc(t("user"))}</th><th>${esc(t("requests"))}</th><th>${esc(t("completed"))} / ${esc(t("failed"))}</th>
      <th>${esc(t("firstSeen"))}</th><th>${esc(t("lastSeen"))}</th><th>${esc(t("status"))}</th><th>${esc(t("actions"))}</th>
    </tr></thead><tbody>
    ${rows.map((u) => `<tr>
      <td data-label="${esc(t("user"))}">${userLabel(u)}</td>
      <td data-label="${esc(t("requests"))}">${num(u.totalJobs)}</td>
      <td data-label="${esc(t("completed"))} / ${esc(t("failed"))}">${num(u.successfulJobs)} / ${num(u.failedJobs)}</td>
      <td data-label="${esc(t("firstSeen"))}" class="small">${esc(fmtTime(u.createdAt))}</td>
      <td data-label="${esc(t("lastSeen"))}" class="small">${esc(fmtTime(u.lastActiveAt))}</td>
      <td data-label="${esc(t("status"))}">${u.isBlocked ? `<span class="badge blocked"><span class="dot"></span>${esc(t("blocked"))}</span>` : "—"}</td>
      <td data-label="${esc(t("actions"))}">
        <button class="btn ghost small" data-hist="${u.telegramId}">${esc(t("history"))}</button>
        <button class="btn ${u.isBlocked ? "ghost" : "danger"} small" data-block="${u.telegramId}" data-state="${u.isBlocked ? "1" : "0"}">${esc(u.isBlocked ? t("unblock") : t("block"))}</button>
      </td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">${esc(t("noData"))}</div>`}
    ${pagerHtml(st.page, data?.total || 0, PAGE_SIZE)}`;
  document.getElementById("users-search").addEventListener("click", () => { st.q = document.getElementById("users-q").value.trim(); st.page = 1; viewUsers(body); });
  body.querySelectorAll("[data-hist]").forEach((b) => b.addEventListener("click", () => {
    const u = rows.find((x) => String(x.telegramId) === b.dataset.hist);
    state.userDetail = u;
    state.userActivity.page = 1;
    showView("userDetail");
  }));
  body.querySelectorAll("[data-block]").forEach((b) => b.addEventListener("click", async () => {
    const blocked = b.dataset.state !== "1";
    b.disabled = true;
    const { status, data: d } = await api(`/admin/api/users/${b.dataset.block}/block`, { method: "POST", body: JSON.stringify({ blocked }) });
    if (status === 200 && d?.ok) viewUsers(body); else { b.disabled = false; alert(t("genericErr")); }
  }));
  bindPager(body, st, () => viewUsers(body));
}

async function viewUserDetail(body) {
  const u = state.userDetail;
  if (!u) return showView("users");
  const st = state.userActivity;
  const { data } = await api(`/admin/api/users/${u.telegramId}/activity?page=${st.page}&pageSize=${PAGE_SIZE}`);
  body.innerHTML = `
    <div class="toolbar"><button class="btn ghost small" id="back-users">← ${esc(t("back"))}</button>
    <strong>${esc(t("userActivity", u.username ? "@" + u.username : String(u.telegramId)))}</strong></div>
    ${jobsTable(data?.rows || [])}
    ${pagerHtml(st.page, data?.total || 0, PAGE_SIZE)}`;
  document.getElementById("back-users").addEventListener("click", () => showView("users"));
  bindPager(body, st, () => viewUserDetail(body));
}

/* ---------------- links ---------------- */
async function viewLinks(body) {
  const { data } = await api("/admin/api/links");
  const d = data || { bySource: [], topDomains: [], invalidRecent: [], totals: { received: 0, invalid: 0 } };
  body.innerHTML = `
    <div class="notice">${esc(t("linksNote"))}</div>
    <div class="cards">
      <div class="card"><div class="card-label">${esc(t("receivedLinks"))}</div><div class="card-value">${num(d.totals.received)}</div></div>
      <div class="card"><div class="card-label">${esc(t("invalidLinks"))}</div><div class="card-value bad">${num(d.totals.invalid)}</div></div>
    </div>
    <div class="grid2">
      <div class="panel"><h2>${esc(t("bySource"))}</h2>
        ${d.bySource.length ? `<table><thead><tr><th>${esc(t("source"))}</th><th>${esc(t("outcome"))}</th><th>${esc(t("count"))}</th></tr></thead><tbody>
          ${d.bySource.map((r) => `<tr><td>${esc(r.source)}</td><td>${esc(t(r.outcome) || r.outcome)}</td><td>${num(r.count)}</td></tr>`).join("")}
        </tbody></table>` : `<div class="empty">${esc(t("noData"))}</div>`}
      </div>
      <div class="panel"><h2>${esc(t("topDomains"))}</h2>
        ${d.topDomains.length ? `<table><thead><tr><th>${esc(t("domain"))}</th><th>${esc(t("count"))}</th></tr></thead><tbody>
          ${d.topDomains.map((r) => `<tr><td>${esc(r.domain)}</td><td>${num(r.count)}</td></tr>`).join("")}
        </tbody></table>` : `<div class="empty">${esc(t("noData"))}</div>`}
      </div>
    </div>
    <div class="panel"><h2>${esc(t("invalidLinks"))}</h2>
      ${d.invalidRecent.length ? `<div class="table-scroll"><table><thead><tr><th>${esc(t("user"))}</th><th>${esc(t("link"))}</th><th>${esc(t("time"))}</th></tr></thead><tbody>
        ${d.invalidRecent.map((r) => `<tr><td>${esc(r.username ? "@" + r.username : String(r.telegramId))}</td><td class="link-text small">${esc(r.url)}</td><td class="small">${esc(fmtTime(r.createdAt))}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty">${esc(t("noData"))}</div>`}
    </div>`;
}

/* ---------------- boot ---------------- */
(async function boot() {
  const { status, data } = await api("/admin/api/me");
  if (status === 200 && data?.ok) return enterApp(data);
  renderAuth(!!data?.setupNeeded);
})();
