/* 全局登录态导航项：未登录显示「登录 / 注册」，已登录显示头像 + 用户名 + 退出。
   登录态以 localStorage 中的访问令牌为准（全站通用），并异步用 profile/verify 校正。 */
(function () {
  "use strict";
  var API_BASE = "https://myblogbackend-njns.onrender.com";
  var VKEY = "visitorAccessToken";
  var AKEY = "adminToken";
  var UKEY = "cachedUsername";
  var AVKEY = "cachedAvatar";

  function navEl() { return document.querySelector(".nav"); }
  function loggedIn() { return !!(localStorage.getItem(VKEY) || localStorage.getItem(AKEY)); }
  function clearAuth() {
    localStorage.removeItem(VKEY);
    localStorage.removeItem(AKEY);
    localStorage.removeItem(UKEY);
    localStorage.removeItem(AVKEY);
  }
  function initialChar(name) { var t = String(name || "").trim(); return t ? t[0].toUpperCase() : "👤"; }

  var style = document.createElement("style");
  style.textContent =
    ".nav-auth{display:inline-flex;gap:16px;align-items:center}" +
    ".nav-auth a{color:var(--muted,#6b625b);text-decoration:none;font-size:.96rem;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px}" +
    ".nav-auth a:hover{color:var(--accent-dark,#8e4317)}" +
    ".nav-auth .nav-auth-login{padding:4px 14px;border:1px solid var(--accent,#cc6a2d);border-radius:999px;color:var(--accent-dark,#8e4317)}" +
    ".nav-auth .nav-auth-login:hover{background:rgba(204,106,45,.1)}" +
    ".nav-auth .nav-auth-out{color:#b91c1c}" +
    ".nav-av{width:26px;height:26px;border-radius:50%;object-fit:cover;border:1px solid var(--line,#e5dbcf);background:#f0ddc8;flex:none}" +
    ".nav-av-fb{display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#cc6a2d,#8e4317);font-weight:800;font-size:.8rem}";
  document.head.appendChild(style);

  function avatarNode() {
    var av = localStorage.getItem(AVKEY);
    var name = localStorage.getItem(UKEY) || "";
    if (av) {
      var img = document.createElement("img");
      img.className = "nav-av";
      img.src = av;
      img.alt = name;
      return img;
    }
    var sp = document.createElement("span");
    sp.className = "nav-av nav-av-fb";
    sp.textContent = initialChar(name);
    return sp;
  }

  function render() {
    var nav = navEl();
    if (!nav) return;
    var old = nav.querySelector(".nav-auth");
    if (old) old.remove();

    var wrap = document.createElement("span");
    wrap.className = "nav-auth";

    if (loggedIn()) {
      var who = document.createElement("a");
      who.href = "/space";
      who.title = "进入我的空间";
      who.appendChild(avatarNode());
      var nameSpan = document.createElement("span");
      nameSpan.textContent = localStorage.getItem(UKEY) || "我的账号";
      who.appendChild(nameSpan);

      var out = document.createElement("a");
      out.className = "nav-auth-out";
      out.href = "#";
      out.textContent = "退出";
      out.addEventListener("click", function (e) {
        e.preventDefault();
        clearAuth();
        location.reload();
      });
      wrap.appendChild(who);
      wrap.appendChild(out);
    } else {
      var login = document.createElement("a");
      login.className = "nav-auth-login";
      login.href = "/welcome";
      login.textContent = "登录 / 注册";
      wrap.appendChild(login);
    }
    nav.appendChild(wrap);
  }

  // 校正登录态、用户名与头像（非阻塞；仅在明确 401 时清除，5xx/网络错误保持原态）。
  function refresh() {
    var v = localStorage.getItem(VKEY);
    var a = localStorage.getItem(AKEY);
    if (v) {
      fetch(API_BASE + "/api/access/profile", { headers: { "X-Access-Token": v } })
        .then(function (r) {
          if (r.status === 401) { clearAuth(); render(); return null; }
          return r.ok ? r.json() : null;
        })
        .then(function (d) {
          if (!d) return;
          if (d.username) localStorage.setItem(UKEY, d.username); else localStorage.removeItem(UKEY);
          if (d.avatar) localStorage.setItem(AVKEY, d.avatar); else localStorage.removeItem(AVKEY);
          render();
        })
        .catch(function () {});
      return;
    }
    if (a) {
      fetch(API_BASE + "/api/auth/verify", { headers: { Authorization: "Bearer " + a } })
        .then(function (r) {
          if (r.status === 401) { clearAuth(); render(); return null; }
          return r.ok ? r.json() : null;
        })
        .then(function (d) {
          if (!d || !d.authenticated) return;
          if (d.username) localStorage.setItem(UKEY, d.username);
          localStorage.removeItem(AVKEY);
          render();
        })
        .catch(function () {});
    }
  }

  render();
  refresh();
})();
