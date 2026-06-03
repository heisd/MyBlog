/* 悬浮 AI 助手（会员专享）。在登录后的页面注入；非会员显示开通提示。 */
(function () {
  "use strict";
  const API_BASE = "https://myblogbackend-njns.onrender.com";

  function accessHeaders() {
    const headers = {};
    const visitor = localStorage.getItem("visitorAccessToken");
    if (visitor) headers["X-Access-Token"] = visitor;
    const admin = localStorage.getItem("adminToken");
    if (admin) headers["Authorization"] = "Bearer " + admin;
    return headers;
  }

  // 未登录则不注入助手（项目页本身会跳转到 /welcome）
  if (!localStorage.getItem("visitorAccessToken") && !localStorage.getItem("adminToken")) return;

  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const style = document.createElement("style");
  style.textContent = `
    .ai-fab{position:fixed;right:18px;bottom:18px;z-index:48;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;
      background:linear-gradient(135deg,#cc6a2d,#8e4317);color:#fff;font-size:24px;box-shadow:0 12px 28px rgba(204,106,45,.45);
      display:flex;align-items:center;justify-content:center;transition:transform 160ms ease,box-shadow 160ms ease;}
    .ai-fab:hover{transform:translateY(-3px) scale(1.05);box-shadow:0 16px 34px rgba(204,106,45,.55);}
    .ai-fab:active{transform:scale(.96);}
    .ai-panel{position:fixed;right:18px;bottom:86px;z-index:48;width:min(92vw,380px);height:min(74vh,560px);
      background:#fffdf8;border:1px solid #e5dbcf;border-radius:20px;box-shadow:0 30px 60px rgba(68,48,30,.28);
      display:none;flex-direction:column;overflow:hidden;font-family:Georgia,"Times New Roman",serif;}
    .ai-panel.open{display:flex;animation:ai-in 200ms ease;}
    @keyframes ai-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
    .ai-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #e5dbcf;background:rgba(204,106,45,.06);}
    .ai-head b{color:#8e4317;font-size:1rem;}
    .ai-head .ai-close{border:none;background:none;font-size:22px;line-height:1;color:#6b625b;cursor:pointer;padding:0 4px;}
    .ai-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f8f4ed;}
    .ai-msg{max-width:86%;padding:10px 13px;border-radius:14px;line-height:1.7;font-size:.95rem;white-space:pre-wrap;word-break:break-word;}
    .ai-msg.user{align-self:flex-end;background:#cc6a2d;color:#fff;border-bottom-right-radius:4px;}
    .ai-msg.bot{align-self:flex-start;background:#fff;border:1px solid #e5dbcf;color:#1f1f1f;border-bottom-left-radius:4px;}
    .ai-msg.sys{align-self:center;color:#6b625b;font-size:.86rem;background:none;text-align:center;}
    .ai-foot{display:flex;gap:8px;padding:12px;border-top:1px solid #e5dbcf;background:#fffdf8;}
    .ai-foot textarea{flex:1;resize:none;border:1px solid #e5dbcf;border-radius:12px;padding:10px 12px;font:inherit;font-size:.95rem;height:42px;max-height:120px;background:#fffefb;color:#1f1f1f;}
    .ai-foot textarea:focus{outline:none;border-color:#cc6a2d;box-shadow:0 0 0 3px rgba(204,106,45,.14);}
    .ai-send{border:none;border-radius:12px;padding:0 16px;background:#cc6a2d;color:#fff;font:inherit;font-weight:700;cursor:pointer;}
    .ai-send:disabled{opacity:.55;cursor:not-allowed;}
    .ai-locked{padding:22px;text-align:center;color:#6b625b;line-height:1.8;}
    .ai-locked a{color:#8e4317;font-weight:700;}
    .ai-cta{display:inline-flex;align-items:center;gap:6px;margin-top:16px;padding:11px 20px;border-radius:999px;
      background:linear-gradient(135deg,#cc6a2d,#8e4317);color:#fff !important;text-decoration:none;font-weight:700;
      box-shadow:0 10px 24px rgba(204,106,45,.4);transition:transform 160ms ease,box-shadow 160ms ease;}
    .ai-cta:hover{transform:translateY(-2px) scale(1.02);box-shadow:0 14px 30px rgba(204,106,45,.5);}
    @media (prefers-reduced-motion: reduce){.ai-fab{transition:none}.ai-panel.open{animation:none}}
  `;
  document.head.appendChild(style);

  const fab = document.createElement("button");
  fab.className = "ai-fab";
  fab.type = "button";
  fab.title = "AI 助手";
  fab.setAttribute("aria-label", "AI 助手");
  fab.textContent = "🤖";

  const panel = document.createElement("div");
  panel.className = "ai-panel";
  panel.innerHTML =
    '<div class="ai-head"><b>AI 助手</b><button class="ai-close" type="button" aria-label="关闭">×</button></div>' +
    '<div class="ai-body" id="ai-body"></div>' +
    '<form class="ai-foot" id="ai-foot"><textarea id="ai-input" placeholder="问我关于这些项目的任何问题…" rows="1"></textarea><button class="ai-send" type="submit">发送</button></form>';

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  const body = panel.querySelector("#ai-body");
  const form = panel.querySelector("#ai-foot");
  const input = panel.querySelector("#ai-input");
  const sendBtn = panel.querySelector(".ai-send");

  let isMember = Boolean(localStorage.getItem("adminToken"));
  let memberChecked = false;
  let memberUntil = null;
  const messages = [];

  function addMsg(role, text) {
    const div = document.createElement("div");
    div.className = "ai-msg " + (role === "user" ? "user" : role === "system" ? "sys" : "bot");
    div.textContent = text;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    return div;
  }

  async function ensureMember() {
    if (memberChecked) return isMember;
    memberChecked = true;
    if (localStorage.getItem("adminToken")) { isMember = true; return true; }
    try {
      const res = await fetch(`${API_BASE}/api/access/verify`, { headers: accessHeaders() });
      if (res.ok) { const d = await res.json(); isMember = Boolean(d.member); memberUntil = d.memberUntil || null; }
    } catch {}
    return isMember;
  }

  function showLocked() {
    body.innerHTML =
      '<div class="ai-locked">🔒 AI 助手是<strong>会员专享</strong>功能。<br>开通会员后即可使用，并可<strong>站内浏览私有仓库源码</strong>。<br>扫码付款 → 点「我已付款」→ 管理员核对后开通。' +
      '<br><a class="ai-cta" href="/welcome">⭐ 去开通会员 →</a></div>';
    input.disabled = true;
    sendBtn.disabled = true;
  }

  function showReady() {
    if (!body.querySelector(".ai-msg")) {
      addMsg("system", "你好！我是这个站点的 AI 助手，可以聊聊这里的机器人、视觉与 AI 项目。");
    }
    input.disabled = false;
    sendBtn.disabled = false;
  }

  async function openPanel() {
    panel.classList.add("open");
    const member = await ensureMember();
    if (member) showReady();
    else showLocked();
    if (member) input.focus();
  }
  function closePanel() { panel.classList.remove("open"); }

  fab.addEventListener("click", () => (panel.classList.contains("open") ? closePanel() : openPanel()));
  panel.querySelector(".ai-close").addEventListener("click", closePanel);

  input.addEventListener("input", () => {
    input.style.height = "42px";
    input.style.height = Math.min(120, input.scrollHeight) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  let busy = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy || !isMember) return;
    const text = input.value.trim();
    if (!text) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = "";
    input.style.height = "42px";
    addMsg("user", text);
    messages.push({ role: "user", content: text });
    const thinking = addMsg("bot", "…");
    try {
      const res = await fetch(`${API_BASE}/api/assistant/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...accessHeaders() },
        body: JSON.stringify({ messages }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { window.location.href = "/welcome"; return; }
      if (res.status === 403) { thinking.remove(); showLocked(); return; }
      if (!res.ok) { thinking.textContent = data.message || "AI 暂时不可用，请稍后再试。"; return; }
      thinking.textContent = data.reply || "（没有返回内容）";
      messages.push({ role: "assistant", content: data.reply || "" });
    } catch {
      thinking.textContent = "网络异常，请稍后再试。";
    } finally {
      busy = false;
      sendBtn.disabled = false;
      body.scrollTop = body.scrollHeight;
    }
  });
})();
