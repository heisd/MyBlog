/* 全站浮动宠物挂件：仅登录的普通账号显示，出现在每个页面左下角，点击进入宠物页。 */
(function () {
  "use strict";
  var API_BASE = "https://myblogbackend-njns.onrender.com";
  var v = localStorage.getItem("visitorAccessToken");
  if (!v) return; // 仅登录普通账号（管理员无宠物）
  if (document.querySelector(".pet-fab")) return; // 防重复注入

  function petArt(sp) {
    var C = { st: "#2f6fb0", esp: "#1f9e8f", linux: "#33333d", arm: "#7a52c7", sensor: "#cc6a2d" };
    var c = C[sp] || C.st;
    var eyes = '<circle cx="41" cy="50" r="6" fill="#fff"/><circle cx="59" cy="50" r="6" fill="#fff"/><circle cx="41.5" cy="51" r="2.6" fill="#15161a"/><circle cx="59.5" cy="51" r="2.6" fill="#15161a"/>';
    var smile = '<path d="M43 62 Q50 68 57 62" stroke="#15161a" stroke-width="2.4" fill="none" stroke-linecap="round"/>';
    var inner = "";
    if (sp === "esp") {
      var bot = ""; for (var x = 28; x <= 68; x += 8) bot += '<rect x="' + x + '" y="78" width="5" height="6" rx="1" fill="#caa23f"/>';
      inner = '<g stroke="' + c + '" stroke-width="2.6" fill="none" stroke-linecap="round"><path d="M32 24 Q50 14 68 24"/><path d="M38 28 Q50 21 62 28"/></g><circle cx="50" cy="31" r="2" fill="' + c + '"/>'
        + bot + '<rect x="24" y="32" width="52" height="48" rx="12" fill="' + c + '"/>'
        + '<rect x="57" y="38" width="13" height="15" rx="2" fill="#15161a" opacity="0.16"/>' + eyes + smile;
    } else if (sp === "linux") {
      inner = '<rect x="18" y="26" width="64" height="52" rx="11" fill="' + c + '"/>'
        + '<rect x="18" y="26" width="64" height="14" rx="11" fill="#000" opacity="0.28"/>'
        + '<circle cx="28" cy="33" r="2.3" fill="#ff5f56"/><circle cx="36" cy="33" r="2.3" fill="#ffbd2e"/><circle cx="44" cy="33" r="2.3" fill="#27c93f"/>'
        + '<text x="33" y="64" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-weight="800" font-size="20" fill="#7CFC9B">&gt;_</text>'
        + '<rect x="60" y="50" width="9" height="15" fill="#7CFC9B" opacity="0.9"/>';
    } else if (sp === "arm") {
      inner = '<polygon points="50,16 82,34 82,66 50,84 18,66 18,34" fill="' + c + '"/>'
        + '<polygon points="50,16 82,34 82,66 50,84 18,66 18,34" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.22"/>'
        + eyes + '<g fill="none" stroke="#fff" stroke-width="2.2" opacity="0.95"><circle cx="50" cy="65" r="7"/><circle cx="50" cy="65" r="2.6"/></g>';
    } else if (sp === "sensor") {
      inner = '<line x1="50" y1="26" x2="50" y2="13" stroke="' + c + '" stroke-width="3"/><circle cx="50" cy="11" r="3.6" fill="' + c + '"/>'
        + '<circle cx="50" cy="57" r="30" fill="' + c + '"/>'
        + '<circle cx="50" cy="57" r="16" fill="#fff"/><circle cx="50" cy="57" r="10" fill="' + c + '"/><circle cx="50" cy="57" r="4" fill="#15161a"/><circle cx="54" cy="52" r="1.8" fill="#fff"/>';
    } else {
      var legs = ""; [34, 50, 66].forEach(function (y) { legs += '<rect x="12" y="' + y + '" width="9" height="6" rx="1.5" fill="#caa23f"/><rect x="79" y="' + y + '" width="9" height="6" rx="1.5" fill="#caa23f"/>'; });
      inner = legs + '<rect x="22" y="22" width="56" height="56" rx="13" fill="' + c + '"/>'
        + '<path d="M44 22 a6 6 0 0 0 12 0" fill="#15161a" opacity="0.22"/>'
        + '<text x="50" y="40" text-anchor="middle" font-family="Georgia,serif" font-weight="800" font-size="12" fill="#fff">ST</text>'
        + eyes + smile;
    }
    return '<svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">' + inner + "</svg>";
  }
  function esc(t) { return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  var style = document.createElement("style");
  style.textContent =
    ".pet-fab{position:fixed;left:18px;bottom:18px;z-index:47;width:58px;height:58px;border-radius:50%;background:#fffdf8;border:1px solid #e5dbcf;box-shadow:0 12px 28px rgba(68,48,30,.28);display:flex;align-items:center;justify-content:center;text-decoration:none;transition:transform .16s ease}" +
    ".pet-fab:hover{transform:translateY(-3px) scale(1.06)}" +
    ".pet-fab .pet-fab-art{width:46px;height:46px;display:block}" +
    ".pet-fab .pet-fab-paw{font-size:24px}" +
    ".pet-fab .pet-fab-badge{position:absolute;top:-4px;right:-4px;background:#cc6a2d;color:#fff;border-radius:999px;font:800 11px Georgia,serif;padding:1px 6px;box-shadow:0 4px 10px rgba(204,106,45,.4)}" +
    ".pet-fab .pet-fab-label{position:absolute;left:66px;bottom:16px;white-space:nowrap;background:#15161a;color:#fff;font:700 12px Georgia,serif;padding:6px 10px;border-radius:10px;opacity:0;transform:translateX(-6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}" +
    ".pet-fab:hover .pet-fab-label{opacity:1;transform:none}" +
    "@media (prefers-reduced-motion: reduce){.pet-fab{transition:none}}";
  document.head.appendChild(style);

  function render(pets) {
    if (document.querySelector(".pet-fab")) return;
    var el = document.createElement("a");
    el.className = "pet-fab";
    el.href = "/pets";
    if (pets && pets.length) {
      var p = pets[0];
      el.innerHTML =
        '<span class="pet-fab-art">' + petArt(p.species) + "</span>" +
        (pets.length > 1 ? '<span class="pet-fab-badge">' + pets.length + "</span>" : "") +
        '<span class="pet-fab-label">Lv.' + p.level + " " + esc(p.name) + " · 我的宠物</span>";
    } else {
      el.classList.add("empty");
      el.innerHTML = '<span class="pet-fab-paw">🐾</span><span class="pet-fab-label">领养一只宠物</span>';
    }
    document.body.appendChild(el);
  }

  fetch(API_BASE + "/api/pets", { headers: { "X-Access-Token": v } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && !d.needsMigration) render(d.pets || []); })
    .catch(function () {});
})();
