/* global fetch */
"use strict";

// -------- tiny inline SVG icons (no external deps) --------
const ICONS = {
  leaf: '<path d="M11 20A7 7 0 0 1 4 13c0-5 4-9 15-9 0 8-4 16-8 16Z"/><path d="M4 20c2-5 6-8 11-9"/>',
  upload: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="m6 6 2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  box: '<path d="M21 8V16L12 21 3 16V8l9-5 9 5Z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  badge: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
};

function icon(name, size = 16, stroke = 1.6) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
}

// -------- formatting --------
const yen = (n) => "¥" + Math.round(Number(n) || 0).toLocaleString("ja-JP");
function co2fmt(kg) {
  const v = Number(kg) || 0;
  return Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + " t-CO\u2082" : v.toFixed(1) + " kg-CO\u2082";
}
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// -------- fetch helpers --------
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "リクエストに失敗しました。");
  return data;
}

// -------- session cache --------
let _session = null;
async function getSession() {
  if (_session) return _session;
  try {
    _session = await api("/api/session");
  } catch (e) {
    _session = { authed: false };
  }
  return _session;
}

// -------- top navigation --------
async function renderTopbar(active) {
  let logo = "";
  let company = "";
  try {
    const s = await api("/api/settings");
    if (s.settings.logo_data_url) logo = s.settings.logo_data_url;
    company = s.settings.company_name || "";
  } catch (e) {}
  const sess = await getSession();
  const user = sess.user || {};
  const orgName = company || (sess.org && sess.org.name) || "";
  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();

  const logoInner = logo ? `<img src="${esc(logo)}" alt="ロゴ">` : icon("leaf", 18);
  const bar = document.createElement("div");
  bar.className = "topbar";
  bar.innerHTML = `
    <div class="topbar-inner">
      <a class="brand" href="/" aria-label="ホーム">
        <span class="logo-box">${logoInner}</span>
        <span class="brand-txt">
          <div>CO<sub style="font-size:.7em">2</sub>削減サポート</div>
          <div class="brand-sub">${esc(orgName) || "CARBON ADVISOR"}</div>
        </span>
      </a>
      <button class="nav-toggle" id="navToggle" aria-label="メニュー">${icon("menu", 20)}</button>
      <nav class="nav" id="mainNav">
        <a href="/" class="${active === "analyze" ? "active" : ""}">見積診断</a>
        <a href="/products.html" class="${active === "products" ? "active" : ""}">製品DB</a>
        <a href="/settings.html" class="${active === "settings" ? "active" : ""}">設定</a>
        <div class="nav-user">
          <span class="avatar" title="${esc(user.email || "")}">${esc(initial)}</span>
          <span class="nav-user-meta">
            <span class="nav-user-name">${esc(user.name || user.email || "")}</span>
            <span class="nav-user-role">${roleLabel(user.role)}</span>
          </span>
          <a href="#" class="logout" id="logoutLink" title="ログアウト">${icon("logout", 15)}</a>
        </div>
      </nav>
    </div>`;
  document.body.prepend(bar);

  const nt = document.getElementById("navToggle");
  const nav = document.getElementById("mainNav");
  if (nt) nt.addEventListener("click", () => nav.classList.toggle("open"));

  const ll = document.getElementById("logoutLink");
  if (ll)
    ll.addEventListener("click", async (e) => {
      e.preventDefault();
      try { await api("/api/logout", { method: "POST" }); } catch (e2) {}
      window.location.href = "/login.html";
    });
}

function roleLabel(role) {
  return role === "owner" ? "オーナー" : role === "admin" ? "管理者" : "メンバー";
}
