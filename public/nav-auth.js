/* 全局登录态导航项：未登录显示「登录 / 注册」，已登录显示头像 + 用户名 + 退出。
   登录态以 localStorage 中的访问令牌为准（全站通用），并异步用 profile/verify 校正。 */
(function () {
  "use strict";
  var API_BASE = "https://myblogbackend-njns.onrender.com";
  var VKEY = "visitorAccessToken";
  var AKEY = "adminToken";
  var UKEY = "cachedUsername";
  var AVKEY = "cachedAvatar";
  var unreadCount = 0;

  function navEl() { return document.querySelector(".nav"); }
  function loggedIn() { return !!(localStorage.getItem(VKEY) || localStorage.getItem(AKEY)); }
  function clearAuth() {
    localStorage.removeItem(VKEY);
    localStorage.removeItem(AKEY);
    localStorage.removeItem(UKEY);
    localStorage.removeItem(AVKEY);
  }
  var AVATAR_PH = "data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2064%2064%22%3E%3Crect%20width=%2264%22%20height=%2264%22%20fill=%22%23efe0cd%22/%3E%3Ccircle%20cx=%2232%22%20cy=%2225%22%20r=%2212%22%20fill=%22%23b88c5a%22/%3E%3Cpath%20d=%22M12%2058c0-12%2010-19%2020-19s20%207%2020%2019%22%20fill=%22%23b88c5a%22/%3E%3C/svg%3E";

  var style = document.createElement("style");
  style.textContent =
    ".nav-auth{display:inline-flex;gap:16px;align-items:center}" +
    ".nav-auth a{color:var(--muted,#6b625b);text-decoration:none;font-size:.96rem;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px}" +
    ".nav-auth a:hover{color:var(--accent-dark,#8e4317)}" +
    ".nav-auth .nav-auth-login{padding:4px 14px;border:1px solid var(--accent,#cc6a2d);border-radius:999px;color:var(--accent-dark,#8e4317)}" +
    ".nav-auth .nav-auth-login:hover{background:rgba(204,106,45,.1)}" +
    ".nav-auth .nav-auth-out{color:#b91c1c}" +
    ".nav-av{width:26px;height:26px;border-radius:50%;object-fit:cover;border:1px solid var(--line,#e5dbcf);background:#f0ddc8;flex:none}" +
    ".nav-av-fb{display:inline-flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#cc6a2d,#8e4317);font-weight:800;font-size:.8rem}" +
    ".nav-dm-badge{background:var(--accent,#cc6a2d);color:#fff;border-radius:999px;font-size:.72rem;font-weight:800;padding:1px 7px;margin-left:2px}";
  document.head.appendChild(style);

  function avatarNode() {
    var av = localStorage.getItem(AVKEY);
    var name = localStorage.getItem(UKEY) || "";
    var img = document.createElement("img");
    img.className = "nav-av";
    img.src = av || AVATAR_PH;
    img.alt = name;
    img.onerror = function () { img.onerror = null; img.src = AVATAR_PH; };
    return img;
  }

  function render() {
    var nav = navEl();
    if (!nav) return;
    var old = nav.querySelector(".nav-auth");
    if (old) old.remove();

    var wrap = document.createElement("span");
    wrap.className = "nav-auth";

    if (loggedIn()) {
      // 宠物入口（仅普通账号）
      if (localStorage.getItem(VKEY)) {
        var pet = document.createElement("a");
        pet.href = "/pets";
        pet.title = "我的宠物";
        pet.textContent = "🐾 宠物";
        wrap.appendChild(pet);
      }
      // 私信入口（仅普通账号；管理员无私信）+ 未读小红点
      if (localStorage.getItem(VKEY)) {
        var dm = document.createElement("a");
        dm.href = "/messages";
        dm.title = "私信";
        dm.innerHTML = "✉ 私信" + (unreadCount > 0 ? ' <span class="nav-dm-badge">' + (unreadCount > 99 ? "99+" : unreadCount) + "</span>" : "");
        wrap.appendChild(dm);
      }
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
      // 未读私信数（用于导航栏小红点）
      fetch(API_BASE + "/api/messages/unread-count", { headers: { "X-Access-Token": v } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && typeof d.count === "number") { unreadCount = d.count; render(); } })
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

  // 全站浮动宠物挂件（仅登录的普通账号）。在每个引入 nav-auth 的页面自动注入。
  if (localStorage.getItem(VKEY) && !document.getElementById("pets-widget-js")) {
    var pw = document.createElement("script");
    pw.id = "pets-widget-js";
    pw.src = "/pets-widget.js";
    pw.defer = true;
    document.body.appendChild(pw);
  }
})();
