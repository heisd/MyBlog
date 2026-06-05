/* 全局登录态导航项：未登录显示「登录 / 注册」，已登录显示用户名 + 退出。
   登录态以 localStorage 中的访问令牌为准（全站通用），并异步用 verify 校正。 */
(function () {
  "use strict";
  var API_BASE = "https://myblogbackend-njns.onrender.com";
  var VKEY = "visitorAccessToken";
  var AKEY = "adminToken";
  var UKEY = "cachedUsername";

  function navEl() { return document.querySelector(".nav"); }
  function loggedIn() { return !!(localStorage.getItem(VKEY) || localStorage.getItem(AKEY)); }
  function clearAuth() {
    localStorage.removeItem(VKEY);
    localStorage.removeItem(AKEY);
    localStorage.removeItem(UKEY);
  }

  var style = document.createElement("style");
  style.textContent =
    ".nav-auth{display:inline-flex;gap:16px;align-items:center}" +
    ".nav-auth a{color:var(--muted,#6b625b);text-decoration:none;font-size:.96rem;font-weight:700;cursor:pointer}" +
    ".nav-auth a:hover{color:var(--accent-dark,#8e4317)}" +
    ".nav-auth .nav-auth-login{padding:4px 14px;border:1px solid var(--accent,#cc6a2d);border-radius:999px;color:var(--accent-dark,#8e4317)}" +
    ".nav-auth .nav-auth-login:hover{background:rgba(204,106,45,.1)}" +
    ".nav-auth .nav-auth-out{color:#b91c1c}";
  document.head.appendChild(style);

  function render() {
    var nav = navEl();
    if (!nav) return;
    var old = nav.querySelector(".nav-auth");
    if (old) old.remove();

    var wrap = document.createElement("span");
    wrap.className = "nav-auth";

    if (loggedIn()) {
      var name = localStorage.getItem(UKEY) || "我的账号";
      var who = document.createElement("a");
      who.href = "/space";
      who.title = "进入我的空间";
      who.textContent = "👤 " + name;
      var out = document.createElement("a");
      out.className = "nav-auth-out";
      out.href = "#";
      out.textContent = "退出";
      out.addEventListener("click", function (e) {
        e.preventDefault();
        clearAuth();
        // 留在当前页（受登录保护的页面会自行跳到 /welcome）。
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

  // 用 verify 校正登录态与用户名（非阻塞；只在明确 401 时清除，5xx/网络错误时保持原态）。
  function verify() {
    var v = localStorage.getItem(VKEY);
    var a = localStorage.getItem(AKEY);
    var url, headers;
    if (v) { url = API_BASE + "/api/access/verify"; headers = { "X-Access-Token": v }; }
    else if (a) { url = API_BASE + "/api/auth/verify"; headers = { Authorization: "Bearer " + a }; }
    else return;

    fetch(url, { headers: headers })
      .then(function (r) {
        if (r.status === 401) { clearAuth(); render(); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        if (!d || !d.authenticated) return;
        if (d.username) localStorage.setItem(UKEY, d.username);
        render();
      })
      .catch(function () {});
  }

  render();
  verify();
})();
