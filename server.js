const express = require("express");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

// Render 容器没有 IPv6 出网能力，而 smtp.qq.com 等主机会解析到 IPv6 地址，
// 导致连接报 ENETUNREACH。强制 DNS 优先返回 IPv4，避免走 IPv6。
if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT) || 3000;
const VIDEO_BUCKET = process.env.SUPABASE_VIDEO_BUCKET || "project-videos";
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const IMAGE_BUCKET = process.env.SUPABASE_IMAGE_BUCKET || "project-covers";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const ROOT_INDEX = path.join(ROOT_DIR, "index.html");
const PUBLIC_INDEX = path.join(PUBLIC_DIR, "index.html");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function normalizeOrigin(origin) {
  return String(origin || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

// Turn an allowlist entry into a matcher. Entries may contain "*" wildcards
// (e.g. "https://*.vercel.app") so a single rule can cover production plus
// every Vercel preview deployment. Matching is case-insensitive and ignores
// a trailing slash, which are the two most common CORS_ORIGIN footguns.
function buildOriginMatcher(pattern) {
  const normalized = normalizeOrigin(pattern);
  if (!normalized.includes("*")) {
    return (origin) => origin === normalized;
  }
  const escaped = normalized
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  const regex = new RegExp(`^${escaped}$`);
  return (origin) => regex.test(origin);
}

const originMatchers = allowedOrigins.map(buildOriginMatcher);

function isAllowedOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  return originMatchers.some((match) => match(normalized));
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  return ["true", "1", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const CONTACT_TO = process.env.CONTACT_TO || "2284610019@qq.com";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.qq.com";
const SMTP_PORT = parsePort(process.env.SMTP_PORT, 465);
const SMTP_SECURE = parseBoolean(process.env.SMTP_SECURE, SMTP_PORT === 465);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const CONTACT_FROM = process.env.CONTACT_FROM || SMTP_USER;

// Resend（HTTP 邮件 API，走 HTTPS，绕过 Render 免费版对 SMTP 端口的封锁）。
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "MyBlog <onboarding@resend.dev>";

// 访客访问门禁（注册/登录看项目）相关配置。
const ACCESS_FROM = process.env.ACCESS_FROM || RESEND_FROM;
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || "";
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || "";

// Brevo（HTTP 邮件 API；验证「单个发件邮箱」即可给任意收件人发信，无需自有域名）。
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_SENDER = process.env.BREVO_SENDER || CONTACT_TO;
const BREVO_SENDER_NAME = process.env.BREVO_SENDER_NAME || "Heisd.Stark";

// AI 助手（会员专享）：OpenAI 兼容的 Chat Completions 接口（OpenAI/DeepSeek/Kimi 等均可）。
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

// 站内只读源码浏览（会员专享）：用服务端 GitHub Token 拉取私有仓库内容，访客不接触 GitHub。
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

if (
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY ||
  !ADMIN_USERNAME ||
  !ADMIN_PASSWORD ||
  !ADMIN_SESSION_SECRET
) {
  console.error(
    "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_USERNAME, ADMIN_PASSWORD, or ADMIN_SESSION_SECRET."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_VIDEO_BYTES,
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
  },
});

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_DOCUMENT_BYTES,
  },
});

let mailTransporter = null;
let mailTransporterFailed = false;

async function getMailTransporter() {
  if (mailTransporter || mailTransporterFailed) {
    return mailTransporter;
  }

  if (!SMTP_USER || !SMTP_PASS) {
    mailTransporterFailed = true;
    return null;
  }

  try {
    const nodemailer = require("nodemailer");

    // Render 容器没有 IPv6 出网，而 nodemailer 用 dns.resolve4(c-ares) 解析，
    // 该环境下常拿不到 A 记录、只剩 AAAA，于是连 IPv6 报 ENETUNREACH。
    // 这里改用 dns.lookup（系统解析器 getaddrinfo，在容器里更可靠）强取一个
    // IPv4 直接作为 host 传入，并用 servername 保留主机名做 SNI / 证书校验。
    let host = SMTP_HOST;
    let servername;
    try {
      const resolved = await dns.promises.lookup(SMTP_HOST, { family: 4 });
      if (resolved && resolved.address) {
        host = resolved.address;
        servername = SMTP_HOST;
      }
    } catch (lookupError) {
      console.warn(
        "IPv4 lookup for SMTP host failed, falling back to hostname:",
        lookupError.message
      );
    }

    mailTransporter = nodemailer.createTransport({
      host,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      ...(servername ? { servername } : {}),
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // 加超时，避免 SMTP 配错/被拦时 sendMail 默认要卡 2 分钟，
      // 让请求快速失败并回退到前端的 mailto 兜底。
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  } catch (error) {
    mailTransporterFailed = true;
    console.error("Failed to create mail transporter:", error.message);
  }

  return mailTransporter;
}

function contactEmailConfigured() {
  return Boolean(RESEND_API_KEY) || Boolean(SMTP_USER && SMTP_PASS);
}

async function sendViaResend({ to, subject, text, replyTo }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        detail = "";
      }
      throw new Error(`Resend API ${response.status}: ${detail.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaBrevo({ to, subject, text, replyTo }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const recipients = (Array.isArray(to) ? to : [to]).map((email) => ({ email }));
    const body = {
      sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER },
      to: recipients,
      subject,
      textContent: text,
    };
    if (replyTo) body.replyTo = { email: replyTo };

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        detail = "";
      }
      throw new Error(`Brevo API ${response.status}: ${detail.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// 统一发信入口：优先 Brevo（单发件人验证即可发任意收件人），其次 Resend，最后 SMTP。
async function sendEmailMessage({ to, subject, text, replyTo }) {
  if (BREVO_API_KEY) {
    await sendViaBrevo({ to, subject, text, replyTo });
    return;
  }
  if (RESEND_API_KEY) {
    await sendViaResend({ to, subject, text, replyTo });
    return;
  }
  const transporter = await getMailTransporter();
  if (!transporter) {
    throw new Error("Email transport not configured");
  }
  await transporter.sendMail({ from: CONTACT_FROM, to, replyTo, subject, text });
}

function emailConfigured() {
  return Boolean(BREVO_API_KEY) || Boolean(RESEND_API_KEY) || Boolean(SMTP_USER && SMTP_PASS);
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || !allowedOrigins.length || isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json({ limit: "1mb" }));

app.use(express.static(PUBLIC_DIR, { index: false }));

function formatDate(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

function normalizeDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signTokenPayload(encodedPayload) {
  return crypto
    .createHmac("sha256", ADMIN_SESSION_SECRET)
    .update(encodedPayload)
    .digest("base64url");
}

function createAdminToken() {
  // 管理员令牌不设过期时间（长期有效）；如需作废可更换 ADMIN_SESSION_SECRET 使旧令牌全部失效。
  const payload = {
    username: ADMIN_USERNAME,
    iat: Date.now(),
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = signTokenPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyAdminToken(token) {
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = String(token).split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signTokenPayload(encodedPayload);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (payload.username !== ADMIN_USERNAME) {
      return null;
    }
    // 仅当令牌带 exp 时才校验过期（旧令牌仍按原过期时间处理；新令牌长期有效）。
    if (payload.exp && Number(payload.exp) < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function readBearerToken(req) {
  const authorization = req.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return authorization.slice(7).trim();
}

function requireAdmin(req, res, next) {
  const session = verifyAdminToken(readBearerToken(req));
  if (!session) {
    return res.status(401).json({ message: "Authentication required" });
  }
  req.adminSession = session;
  return next();
}

// ===== 访客访问门禁：注册(邮箱+验证码) → 设密码 → 登录；人机验证 + 防刷 =====

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function createVisitorToken(email) {
  const payload = { type: "visitor", email, exp: Date.now() + 1000 * 60 * 60 * 24 * 14 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signTokenPayload(encoded)}`;
}

function verifyVisitorToken(token) {
  if (!token) return null;
  const [encoded, signature] = String(token).split(".");
  if (!encoded || !signature) return null;
  if (!constantTimeEqual(signature, signTokenPayload(encoded))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload.type !== "visitor" || !payload.email || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// 项目数据要求「访客已登录」或「管理员」其一。
function requireVisitor(req, res, next) {
  const visitor = verifyVisitorToken((req.get("x-access-token") || "").trim());
  if (visitor) {
    req.visitor = visitor;
    return next();
  }
  const admin = verifyAdminToken(readBearerToken(req));
  if (admin) {
    req.adminSession = admin;
    return next();
  }
  return res.status(401).json({ message: "需要登录后才能查看项目", code: "ACCESS_REQUIRED" });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 内存状态：各类限流计数 + 一次性表单令牌
const registerByIp = new Map();
const loginByKey = new Map();
const usedFormTokens = new Map();
const usedGrantTokens = new Map();
const assistantByEmail = new Map();

const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX = 8;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAIL_MAX = 12;

function hitWindow(map, key, windowMs, max) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.start > windowMs) {
    map.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

setInterval(() => {
  const now = Date.now();
  for (const map of [registerByIp, loginByKey]) {
    for (const [k, v] of map) if (now - v.start > 60 * 60 * 1000) map.delete(k);
  }
  for (const [k, expiry] of usedFormTokens) if (now > expiry) usedFormTokens.delete(k);
  for (const [k, expiry] of usedGrantTokens) if (now > expiry) usedGrantTokens.delete(k);
}, 10 * 60 * 1000).unref();

// 内置人机验证（无 Turnstile 时）：签名表单令牌，含时间陷阱 + 一次性
function issueFormToken() {
  const payload = { t: Date.now(), n: crypto.randomBytes(8).toString("hex") };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signTokenPayload(`form:${encoded}`)}`;
}

function verifyFormToken(token) {
  const [encoded, sig] = String(token || "").split(".");
  if (!encoded || !sig) return false;
  if (!constantTimeEqual(sig, signTokenPayload(`form:${encoded}`))) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  const age = Date.now() - Number(payload.t || 0);
  if (age < 2500 || age > 15 * 60 * 1000) return false; // 太快=机器人；太旧=过期
  if (usedFormTokens.has(token)) return false; // 一次性，防重放
  usedFormTokens.set(token, Date.now() + 15 * 60 * 1000);
  return true;
}

// 一键开通令牌：用户点「我已付款」后，邮件给管理员私人邮箱发一个签名链接，管理员核对到账后点击即开通。
// 安全：HMAC 签名（不可伪造）+ 7 天有效期 + 一次性（防重放）+ 只发到管理员邮箱。令牌仅授权「对该邮箱开通」，月数由管理员在确认页选择。
function signGrantToken(email, plan) {
  const payload = { t: "grant", email, plan: String(plan || "").slice(0, 60), exp: Date.now() + 7 * 24 * 60 * 60 * 1000, n: crypto.randomBytes(8).toString("hex") };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signTokenPayload(`grant:${encoded}`)}`;
}
function verifyGrantToken(token) {
  const [encoded, sig] = String(token || "").split(".");
  if (!encoded || !sig) return null;
  if (!constantTimeEqual(sig, signTokenPayload(`grant:${encoded}`))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload.t !== "grant" || !payload.email || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// 人机验证：配了 Turnstile 用 Turnstile，否则用内置（蜜罐 + 表单令牌）
async function verifyHuman(req) {
  if (String(req.body?.website || "").trim()) return false; // 蜜罐字段必须为空

  if (TURNSTILE_SECRET_KEY) {
    const token = String(req.body?.turnstileToken || "");
    if (!token) return false;
    try {
      const params = new URLSearchParams();
      params.append("secret", TURNSTILE_SECRET_KEY);
      params.append("response", token);
      if (req.ip) params.append("remoteip", req.ip);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      const data = await resp.json().catch(() => ({}));
      return Boolean(data.success);
    } catch {
      return false;
    }
  }

  return verifyFormToken(req.body?.formToken);
}

// 会员判定（订阅制）：member_until 在未来则为有效会员（列未迁移时按非会员处理）。
async function getMemberInfo(email) {
  try {
    const { data, error } = await supabase
      .from("visitors")
      .select("member_until")
      .eq("email", email)
      .maybeSingle();
    if (error) {
      if (isMissingColumn(error)) return { member: false, memberUntil: null };
      throw error;
    }
    const raw = data && data.member_until ? data.member_until : null;
    const active = raw ? new Date(raw).getTime() > Date.now() : false;
    return { member: active, memberUntil: raw };
  } catch (error) {
    console.error("getMemberInfo failed:", error.message);
    return { member: false, memberUntil: null };
  }
}

async function visitorIsMember(email) {
  return (await getMemberInfo(email)).member;
}

// 授予/续费会员 months 个月（在现有有效期基础上叠加）。账号不存在则用空密码占位创建（手动添加会员，本人后续注册认领）。
// 列未迁移时抛出 code=MIGRATION_REQUIRED。
async function grantMembershipMonths(email, months) {
  months = Math.max(1, Math.min(24, Number(months) || 1));
  const { data: existing, error: e1 } = await supabase
    .from("visitors")
    .select("email, member_until")
    .eq("email", email)
    .maybeSingle();
  if (e1) {
    if (isMissingColumn(e1)) { const err = new Error("MIGRATION_REQUIRED"); err.code = "MIGRATION_REQUIRED"; throw err; }
    throw e1;
  }
  let base = Date.now();
  if (existing && existing.member_until && new Date(existing.member_until).getTime() > base) {
    base = new Date(existing.member_until).getTime();
  }
  const memberUntil = new Date(base + months * 30 * 24 * 60 * 60 * 1000).toISOString();
  let data, error;
  if (existing) {
    ({ data, error } = await supabase
      .from("visitors")
      .update({ member_until: memberUntil })
      .eq("email", email)
      .select("email, member_until")
      .maybeSingle());
  } else {
    ({ data, error } = await supabase
      .from("visitors")
      .insert({ email, password_hash: "", member_until: memberUntil })
      .select("email, member_until")
      .maybeSingle());
  }
  if (error) {
    if (isMissingColumn(error)) { const err = new Error("MIGRATION_REQUIRED"); err.code = "MIGRATION_REQUIRED"; throw err; }
    throw error;
  }
  return {
    email: data.email,
    memberUntil: data.member_until,
    member: data.member_until ? new Date(data.member_until).getTime() > Date.now() : false,
    pending: !existing,
  };
}

// 该请求能否看到私有仓库链接：管理员可见，或访客为会员。
async function canSeeRepo(req) {
  if (req.adminSession) return true;
  if (req.visitor) return await visitorIsMember(req.visitor.email);
  return false;
}

// 对外项目对象按是否会员决定 repoUrl 可见性。
function gateRepo(item, allowed) {
  if (allowed) return { ...item, repoLocked: false };
  return { ...item, repoUrl: null, repoLocked: Boolean(item.repoUrl) };
}

// ===== 站内只读源码浏览（会员专享）=====

// 会员中间件：登录 + 有效会员（或管理员）才放行。
function requireMember(req, res, next) {
  const visitor = verifyVisitorToken((req.get("x-access-token") || "").trim());
  const admin = verifyAdminToken(readBearerToken(req));
  if (!visitor && !admin) {
    return res.status(401).json({ message: "需要登录后才能查看", code: "ACCESS_REQUIRED" });
  }
  if (admin) {
    req.adminSession = admin;
    return next();
  }
  req.visitor = visitor;
  visitorIsMember(visitor.email)
    .then((isMember) => {
      if (!isMember) return res.status(403).json({ message: "源码浏览为会员专享功能。", code: "MEMBER_ONLY" });
      return next();
    })
    .catch(() => res.status(500).json({ message: "服务异常，请稍后再试。" }));
}

function parseGitHubRepo(url) {
  const match = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(String(url || ""));
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

async function getProjectRepo(id) {
  const { data, error } = await supabase.from("projects").select("repoUrl").eq("id", id).maybeSingle();
  if (error) {
    if (isMissingColumn(error)) return null;
    throw error;
  }
  return data && data.repoUrl ? parseGitHubRepo(data.repoUrl) : null;
}

async function githubApi(path, { raw = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
        "User-Agent": "Heisd-Blog",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const repoTreeCache = new Map();

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.start > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}, LOGIN_WINDOW_MS).unref();

function loginRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || "unknown";
  const entry = loginAttempts.get(key);

  if (!entry || now - entry.start > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { start: now, count: 1 });
    return next();
  }

  entry.count += 1;
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ message: "Too many login attempts, please try again later." });
  }
  return next();
}

const CONTACT_WINDOW_MS = 60 * 60 * 1000;
const CONTACT_MAX_MESSAGES = 5;
const contactAttempts = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of contactAttempts) {
    if (now - entry.start > CONTACT_WINDOW_MS) {
      contactAttempts.delete(key);
    }
  }
}, CONTACT_WINDOW_MS).unref();

function contactRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || "unknown";
  const entry = contactAttempts.get(key);

  if (
    entry &&
    now - entry.start <= CONTACT_WINDOW_MS &&
    entry.count >= CONTACT_MAX_MESSAGES
  ) {
    return res.status(429).json({ message: "提交过于频繁，请稍后再试。" });
  }
  return next();
}

function recordContactSend(req) {
  const now = Date.now();
  const key = req.ip || "unknown";
  const entry = contactAttempts.get(key);

  if (!entry || now - entry.start > CONTACT_WINDOW_MS) {
    contactAttempts.set(key, { start: now, count: 1 });
    return;
  }

  entry.count += 1;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

// 注册仅允许常见邮箱服务商（Gmail / Outlook / QQ / 163），避免一次性邮箱注册。
const ALLOWED_EMAIL_DOMAINS = new Set(["gmail.com", "outlook.com", "hotmail.com", "qq.com", "163.com"]);
function isAllowedEmailDomain(value) {
  const email = String(value || "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return ALLOWED_EMAIL_DOMAINS.has(email.slice(at + 1));
}

// ===== 用户名（论坛身份）：站内唯一标识。2~20 位，允许中文 / 字母 / 数字 / 下划线 / 连字符。=====
function normalizeUsername(value) {
  return String(value || "").trim();
}
function isValidUsername(value) {
  return /^[一-龥A-Za-z0-9_-]{2,20}$/.test(String(value || "").trim());
}
// 保留名：避免冒充管理员 / 官方身份。
const RESERVED_USERNAMES = new Set(["admin", "administrator", "root", "system", "管理员", "管理", "系统", "官方"]);
function isReservedUsername(value) {
  return RESERVED_USERNAMES.has(String(value || "").trim().toLowerCase());
}

// 读取某账号的用户名（未设置或列未迁移时返回 null）。
async function getUsername(email) {
  try {
    const { data, error } = await supabase
      .from("visitors")
      .select("username")
      .eq("email", email)
      .maybeSingle();
    if (error) {
      if (isMissingColumn(error)) return null;
      throw error;
    }
    return data && data.username ? data.username : null;
  } catch (error) {
    console.error("getUsername failed:", error.message);
    return null;
  }
}

// 头像：允许清空、图片 data URL（客户端已压缩为小尺寸方图）或 https 链接，限长约 220KB。
function isValidAvatar(value) {
  if (!value) return true;
  const s = String(value);
  if (s.length > 300000) return false;
  return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(s) || /^https:\/\/[^\s]+$/i.test(s);
}

// 批量取作者资料（用户名 → { avatar, bio }），供论坛展示头像；列/表缺失时静默降级为空。
async function fetchAuthorProfiles(emails) {
  const uniq = Array.from(new Set((emails || []).filter(Boolean)));
  if (!uniq.length) return {};
  try {
    const { data, error } = await supabase
      .from("visitors")
      .select("email, username, avatar_url, bio")
      .in("email", uniq);
    if (error) return {};
    const map = {};
    const emailToUser = {};
    for (const v of data || []) {
      if (v.username) { map[v.username] = { avatar: v.avatar_url || null, bio: v.bio || null, petLevel: 0 }; emailToUser[v.email] = v.username; }
    }
    // 作者宠物最高等级（用于论坛头像旁的训练师称号小挂件）。
    try {
      const { data: pets } = await supabase.from("pets").select("owner_email, level").in("owner_email", uniq);
      if (Array.isArray(pets)) {
        for (const p of pets) {
          const u = emailToUser[p.owner_email];
          if (u && map[u] && p.level > map[u].petLevel) map[u].petLevel = p.level;
        }
      }
    } catch {}
    return map;
  } catch {
    return {};
  }
}

// 论坛表尚未创建时的容错（未执行 forum 迁移）。
// 42P01 = undefined_table；PGRST205 = 表不在 PostgREST schema cache。
function isMissingForumTable(error) {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /forum_posts|forum_replies|forum_post_likes|forum_follows|forum_messages|does not exist|could not find the table/i.test(
    `${error.message || ""} ${error.details || ""}`
  );
}

// 论坛列表用：把正文压成一行摘要。
function makeExcerpt(text, maxLen = 140) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen).trim()}…`;
}

// 帖子状态：draft（仅作者「我的空间」可见）/ published（公开在论坛）。
function normalizeForumStatus(value) {
  return value === "draft" ? "draft" : "published";
}

// 解析「当前发帖人」：登录访客取其用户名；管理员以站点管理员身份发帖。
// key 是点赞等「每人一次」场景的稳定身份（访客用邮箱，管理员用固定标记）。
async function getForumActor(req) {
  if (req.visitor) {
    return { email: req.visitor.email, key: req.visitor.email, username: await getUsername(req.visitor.email), isAdmin: false };
  }
  if (req.adminSession) {
    return { email: null, key: "__admin__", username: ADMIN_USERNAME, isAdmin: true };
  }
  return null;
}

function toListItem(project) {
  return {
    id: project.id,
    title: project.title,
    date: project.date,
    summary: project.summary,
    coverImage: project.coverImage,
    videoUrl: project.videoUrl,
    repoUrl: project.repoUrl || null,
    repoLocked: false,
    tags: Array.isArray(project.tags) ? project.tags : [],
    status: project.status === "draft" ? "draft" : "published",
    pinned: Boolean(project.pinned),
  };
}

function validateProjectInput(body) {
  const requiredFields = ["title", "summary", "content", "coverImage"];
  return requiredFields.filter((field) => !String(body[field] || "").trim());
}

// 标签归一化：支持数组或「逗号/顿号/中文逗号」分隔的字符串；去重、去空、限长。
function normalizeTags(value) {
  let list = [];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === "string") {
    list = value.split(/[,，、]/);
  }
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const tag = String(item).trim().slice(0, 24);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
    if (result.length >= 12) break;
  }
  return result;
}

// 数据库还没加 tags/status/pinned 列时的容错判断（兼容未执行迁移的情况）。
// 42703 = undefined_column（select）；PGRST204 = 列不在 schema cache（insert/update）。
function isMissingColumn(error) {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  return /(tags|status|pinned|repourl)/i.test(`${error.message || ""} ${error.details || ""}`);
}

function normalizeStatus(value) {
  return value === "draft" ? "draft" : "published";
}

async function ensureUniqueProjectId(title) {
  const base = slugify(title) || `project-${Date.now()}`;
  const { data, error } = await supabase
    .from("projects")
    .select("id")
    .like("id", `${base}%`);

  if (error) {
    throw error;
  }

  const ids = new Set((data || []).map((item) => item.id));
  if (!ids.has(base)) {
    return base;
  }

  return `${base}-${Date.now()}`;
}

function guessFileExtension(file) {
  const byName = path.extname(file.originalname || "").toLowerCase();
  if (byName) {
    return byName;
  }

  const mimeMap = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/ogg": ".ogg",
    "video/quicktime": ".mov",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
  };

  if (mimeMap[file.mimetype]) {
    return mimeMap[file.mimetype];
  }
  return String(file.mimetype || "").startsWith("image/") ? ".png" : ".mp4";
}

async function ensureVideoBucket() {
  const { data, error } = await supabase.storage.listBuckets();
  if (error) {
    console.error("Failed to list storage buckets:", error.message);
    return;
  }

  const exists = (data || []).some((bucket) => bucket.name === VIDEO_BUCKET);
  if (exists) {
    return;
  }

  const { error: createError } = await supabase.storage.createBucket(VIDEO_BUCKET, {
    public: true,
    fileSizeLimit: MAX_VIDEO_BYTES,
    allowedMimeTypes: ["video/mp4", "video/webm", "video/ogg", "video/quicktime"],
  });

  if (createError) {
    console.error("Failed to create video bucket:", createError.message);
  }
}

async function ensureImageBucket() {
  const { data, error } = await supabase.storage.listBuckets();
  if (error) {
    console.error("Failed to list storage buckets:", error.message);
    return;
  }

  const exists = (data || []).some((bucket) => bucket.name === IMAGE_BUCKET);
  if (exists) {
    return;
  }

  const { error: createError } = await supabase.storage.createBucket(IMAGE_BUCKET, {
    public: true,
    fileSizeLimit: MAX_IMAGE_BYTES,
    allowedMimeTypes: [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "image/avif",
    ],
  });

  if (createError) {
    console.error("Failed to create image bucket:", createError.message);
  }
}

function escapeHtmlText(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 把纯文本（.txt 或 PDF 抽取出的文字）转成 HTML 段落，并做转义。
function plainTextToHtml(text) {
  const paragraphs = String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paragraphs
    .map((p) => `<p>${escapeHtmlText(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

// 给 h1-h3 注入 id（便于目录跳转），并收集大纲（目录）。
function addHeadingAnchors(html) {
  const outline = [];
  let index = 0;
  const withIds = String(html || "").replace(
    /<h([1-3])([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (match, level, attrs, inner) => {
      const text = htmlToPlainText(inner).trim();
      if (!text) {
        return match;
      }
      const id = `doc-heading-${index++}`;
      outline.push({ level: Number(level), text, id });
      if (/\sid\s*=/i.test(attrs)) {
        return match;
      }
      return `<h${level}${attrs} id="${id}">${inner}</h${level}>`;
    }
  );
  return { html: withIds, outline };
}

function buildTocHtml(outline) {
  if (outline.length < 2) {
    return "";
  }
  const items = outline
    .map(
      (h) =>
        `<li style="margin-left:${(h.level - 1) * 16}px;"><a href="#${h.id}">${escapeHtmlText(h.text)}</a></li>`
    )
    .join("");
  return `<nav class="toc"><strong>目录</strong><ul>${items}</ul></nav>\n`;
}

function deriveSummary(plainText, maxLen = 120) {
  const firstPara =
    String(plainText || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) || "";
  const cleaned = firstPara.replace(/\s+/g, " ").trim();
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen).trim()}…`;
}

// 取第一个 <p> 段落的纯文本，作为摘要来源（跳过标题）。
function firstParagraphText(html) {
  const match = String(html || "").match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return match ? htmlToPlainText(match[1]) : "";
}

function clipText(text, maxLen) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen).trim()}…`;
}

// 识别文档前部显式标注的「标题：xxx」「摘要：xxx」等（中英文、半/全角冒号），
// 也支持标签独占一行、值在下一行的写法。
function detectLabeled(plainText, labels) {
  const lines = String(plainText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 15);
  const alt = labels.join("|");
  const inlineRe = new RegExp(`^(?:${alt})\\s*[:：]\\s*(.+)$`, "i");
  const bareRe = new RegExp(`^(?:${alt})\\s*[:：]?\\s*$`, "i");
  for (let i = 0; i < lines.length; i += 1) {
    const inline = lines[i].match(inlineRe);
    if (inline && inline[1].trim()) {
      return inline[1].trim();
    }
    if (bareRe.test(lines[i]) && lines[i + 1]) {
      return lines[i + 1].trim();
    }
  }
  return "";
}

// 轻量健康检查端点：不访问数据库，专供 UptimeRobot 等保活监控定时 ping，
// 让 Render 免费实例保持唤醒，避免闲置休眠后的冷启动。
app.get("/healthz", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: Date.now() });
});

// 数据库保活端点：做一次极轻量的查询（select 一行），让 Supabase 免费项目
// 不因闲置（约 7 天）而休眠。用 UptimeRobot 等定时访问此地址，可同时保活
// 后端（实例被唤醒）和数据库（产生查询活动）。
app.get("/healthz/db", async (req, res) => {
  try {
    const { error } = await supabase.from("projects").select("id").limit(1);
    if (error) {
      throw error;
    }
    return res.json({ status: "ok", db: "ok", timestamp: Date.now() });
  } catch (error) {
    console.error("DB keep-alive failed:", error.message);
    return res.status(503).json({ status: "error", db: "down", error: error.message });
  }
});

app.post("/api/auth/login", loginRateLimit, (req, res) => {
  const username = req.body?.username;
  const password = req.body?.password;

  if (!constantTimeEqual(username, ADMIN_USERNAME) || !constantTimeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ message: "Invalid username or password" });
  }

  return res.json({
    token: createAdminToken(),
    username: ADMIN_USERNAME,
  });
});

app.get("/api/auth/verify", (req, res) => {
  const session = verifyAdminToken(readBearerToken(req));
  if (!session) {
    return res.status(401).json({ authenticated: false });
  }

  return res.json({
    authenticated: true,
    username: session.username,
    expiresAt: session.exp,
  });
});

app.post("/api/auth/logout", (req, res) => {
  return res.json({ success: true });
});

app.post("/api/contact", contactRateLimit, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim();
  const message = String(req.body?.message || "").trim();

  if (!name || !message) {
    return res.status(400).json({ message: "请填写你的称呼和留言内容。" });
  }

  if (name.length > 120 || message.length > 5000) {
    return res.status(400).json({ message: "留言内容过长，请精简后再提交。" });
  }

  if (email && !isValidEmail(email)) {
    return res.status(400).json({ message: "邮箱格式不正确，请检查后重试。" });
  }

  if (!contactEmailConfigured()) {
    return res.status(503).json({
      message: "在线发送暂未配置，请通过邮箱直接联系。",
      fallbackEmail: CONTACT_TO,
    });
  }

  const submittedAt = new Date().toISOString();
  const textBody = [
    `来自博客的新留言`,
    `时间：${submittedAt}`,
    `称呼：${name}`,
    `邮箱：${email || "未提供"}`,
    ``,
    `留言内容：`,
    message,
  ].join("\n");

  const subject = `博客留言 - 来自 ${name}`;
  const replyTo = email || undefined;

  try {
    await sendEmailMessage({ to: CONTACT_TO, subject, text: textBody, replyTo });
    recordContactSend(req);
    return res.status(201).json({ message: "留言已发送，感谢你的联系！" });
  } catch (error) {
    console.error("Failed to send contact email:", error.message);
    return res.status(502).json({
      message: "留言发送失败，请稍后重试或直接邮件联系。",
      fallbackEmail: CONTACT_TO,
    });
  }
});

app.post("/api/uploads/video", requireAdmin, upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No video file uploaded" });
    }

    if (!String(req.file.mimetype || "").startsWith("video/")) {
      return res.status(400).json({ message: "Only video files are allowed" });
    }

    const filePath = `${Date.now()}-${slugify(path.parse(req.file.originalname).name || "video")}${guessFileExtension(
      req.file
    )}`;

    const { error: uploadError } = await supabase.storage
      .from(VIDEO_BUCKET)
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      throw uploadError;
    }

    const { data } = supabase.storage.from(VIDEO_BUCKET).getPublicUrl(filePath);
    return res.status(201).json({
      path: filePath,
      videoUrl: data.publicUrl,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to upload video", error: error.message });
  }
});

app.post("/api/uploads/image", requireAdmin, imageUpload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No image file uploaded" });
    }

    if (!String(req.file.mimetype || "").startsWith("image/")) {
      return res.status(400).json({ message: "Only image files are allowed" });
    }

    const filePath = `${Date.now()}-${slugify(path.parse(req.file.originalname).name || "cover")}${guessFileExtension(
      req.file
    )}`;

    const { error: uploadError } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      throw uploadError;
    }

    const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(filePath);
    return res.status(201).json({
      path: filePath,
      imageUrl: data.publicUrl,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to upload image", error: error.message });
  }
});

// 文档导入：上传 .md/.markdown/.txt/.docx/.pdf，自动解析为 HTML，并提取目录/摘要/标题。
// 文件本身不入库，只返回解析结果供后台填充表单。
app.post("/api/uploads/document", requireAdmin, documentUpload.single("document"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No document uploaded" });
    }

    const ext = path.extname(req.file.originalname || "").toLowerCase();
    let rawHtml = "";

    if (ext === ".md" || ext === ".markdown") {
      const { marked } = require("marked");
      rawHtml = marked.parse(req.file.buffer.toString("utf8"));
    } else if (ext === ".txt") {
      rawHtml = plainTextToHtml(req.file.buffer.toString("utf8"));
    } else if (ext === ".docx") {
      const mammoth = require("mammoth");
      const result = await mammoth.convertToHtml({ buffer: req.file.buffer });
      rawHtml = result.value || "";
    } else if (ext === ".pdf") {
      const { PDFParse } = require("pdf-parse");
      const parser = new PDFParse({ data: req.file.buffer });
      try {
        const parsed = await parser.getText();
        rawHtml = plainTextToHtml(parsed.text || "");
      } finally {
        await parser.destroy();
      }
    } else {
      return res
        .status(400)
        .json({ message: "仅支持 .md / .markdown / .txt / .docx / .pdf 文件" });
    }

    const { html: htmlWithIds, outline } = addHeadingAnchors(rawHtml);
    const toc = buildTocHtml(outline);
    const plain = htmlToPlainText(htmlWithIds);

    // 识别优先级：文档显式标注 > 首个标题 / 首段 > 文件名兜底。
    const labeledTitle = detectLabeled(plain, ["标题", "题目", "title"]);
    const labeledSummary = detectLabeled(plain, [
      "摘要",
      "简介",
      "内容简介",
      "abstract",
      "summary",
    ]);
    const baseName = path.parse(req.file.originalname || "").name;

    const title = clipText(
      labeledTitle || (outline[0] && outline[0].text) || baseName || deriveSummary(plain, 60),
      120
    );
    const summary = labeledSummary
      ? clipText(labeledSummary, 160)
      : deriveSummary(firstParagraphText(htmlWithIds) || plain);

    return res.status(201).json({
      html: toc + htmlWithIds,
      outline: outline.map(({ level, text }) => ({ level, text })),
      summary,
      title,
    });
  } catch (error) {
    console.error("Failed to import document:", error.message);
    return res
      .status(500)
      .json({ message: "文档解析失败，请确认文件格式是否正确。", error: error.message });
  }
});

app.get("/api/access/config", (req, res) => {
  const config = {
    turnstileSiteKey: TURNSTILE_SITE_KEY || null,
    emailConfigured: emailConfigured(),
    contactEmail: CONTACT_TO,
  };
  if (!TURNSTILE_SITE_KEY) {
    config.formToken = issueFormToken();
  }
  return res.json(config);
});

app.get("/api/access/verify", async (req, res) => {
  const visitor = verifyVisitorToken((req.get("x-access-token") || "").trim());
  if (!visitor) return res.status(401).json({ authenticated: false });
  const info = await getMemberInfo(visitor.email);
  const username = await getUsername(visitor.email);
  return res.json({ authenticated: true, email: visitor.email, username, member: info.member, memberUntil: info.memberUntil });
});

// 设置用户名：供「老账号 / 管理员手动开通后本人认领」但尚未设置用户名的登录用户使用。
// 用户名一经设定即作为站内唯一身份，不在此处修改（如需改名请联系管理员）。
app.post("/api/access/username", requireVisitor, async (req, res) => {
  if (!req.visitor) {
    return res.status(400).json({ message: "请使用账号登录后再设置用户名。" });
  }
  const username = normalizeUsername(req.body?.username);
  if (!isValidUsername(username)) {
    return res.status(400).json({ message: "用户名需为 2~20 位的中文、字母、数字、下划线或连字符。" });
  }
  if (isReservedUsername(username)) {
    return res.status(400).json({ message: "该用户名为保留名，请换一个。" });
  }
  try {
    const { data: row, error: selErr } = await supabase
      .from("visitors")
      .select("username")
      .eq("email", req.visitor.email)
      .maybeSingle();
    if (selErr) {
      if (isMissingColumn(selErr)) {
        return res.status(409).json({ message: "请先在 Supabase 执行 visitors.username 迁移。", code: "MIGRATION_REQUIRED" });
      }
      throw selErr;
    }
    if (row && row.username) {
      return res.json({ username: row.username, already: true });
    }

    const { data: taken, error: takenErr } = await supabase
      .from("visitors")
      .select("email")
      .eq("username", username)
      .maybeSingle();
    if (takenErr && !isMissingColumn(takenErr)) throw takenErr;
    if (taken && taken.email !== req.visitor.email) {
      return res.status(409).json({ message: "该用户名已被使用，请换一个。" });
    }

    const { error } = await supabase
      .from("visitors")
      .update({ username })
      .eq("email", req.visitor.email);
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ message: "该用户名已被使用，请换一个。" });
      }
      if (isMissingColumn(error)) {
        return res.status(409).json({ message: "请先在 Supabase 执行 visitors.username 迁移。", code: "MIGRATION_REQUIRED" });
      }
      throw error;
    }
    return res.json({ username });
  } catch (error) {
    console.error("Set username failed:", error.message);
    return res.status(500).json({ message: "设置用户名失败，请稍后再试。" });
  }
});

// 个人资料：读取（含头像 / 自我介绍）。
app.get("/api/access/profile", requireVisitor, async (req, res) => {
  if (!req.visitor) {
    return res.json({ email: null, username: ADMIN_USERNAME, avatar: null, bio: null, isAdmin: true });
  }
  try {
    let { data, error } = await supabase
      .from("visitors")
      .select("email, username, avatar_url, bio, member_until")
      .eq("email", req.visitor.email)
      .maybeSingle();
    if (error && isMissingColumn(error)) {
      ({ data, error } = await supabase
        .from("visitors")
        .select("email, username, member_until")
        .eq("email", req.visitor.email)
        .maybeSingle());
    }
    if (error) throw error;
    const memberUntil = data && data.member_until ? data.member_until : null;
    return res.json({
      email: data ? data.email : req.visitor.email,
      username: data ? data.username || null : null,
      avatar: data ? data.avatar_url || null : null,
      bio: data ? data.bio || null : null,
      member: memberUntil ? new Date(memberUntil).getTime() > Date.now() : false,
      memberUntil,
    });
  } catch (error) {
    console.error("Get profile failed:", error.message);
    return res.status(500).json({ message: "加载资料失败，请稍后再试。" });
  }
});

// 个人资料：更新头像 / 自我介绍（仅访客本人）。
app.post("/api/access/profile", requireVisitor, async (req, res) => {
  if (!req.visitor) {
    return res.status(403).json({ message: "管理员资料无需在此设置。" });
  }
  if (!hitWindow(forumWriteByEmail, `profile:${req.visitor.email}`, FORUM_WINDOW_MS, 40)) {
    return res.status(429).json({ message: "操作过于频繁，请稍后再试。" });
  }

  const body = req.body || {};
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, "avatar")) {
    const avatar = body.avatar ? String(body.avatar) : null;
    if (avatar && !isValidAvatar(avatar)) {
      return res.status(400).json({ message: "头像格式不支持或过大，请换一张图片（会自动压缩为小尺寸）。" });
    }
    patch.avatar_url = avatar;
  }
  if (Object.prototype.hasOwnProperty.call(body, "bio")) {
    const bio = String(body.bio || "").trim();
    if (bio.length > 500) return res.status(400).json({ message: "自我介绍不超过 500 字。" });
    patch.bio = bio || null;
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ message: "没有要更新的内容。" });
  }

  try {
    const { data, error } = await supabase
      .from("visitors")
      .update(patch)
      .eq("email", req.visitor.email)
      .select("email, username, avatar_url, bio")
      .maybeSingle();
    if (error) {
      if (isMissingColumn(error)) {
        return res.status(409).json({ message: "请先在 Supabase 执行 visitors 头像 / 简介迁移。", code: "MIGRATION_REQUIRED" });
      }
      throw error;
    }
    if (!data) return res.status(404).json({ message: "账号不存在。" });
    return res.json({ email: data.email, username: data.username || null, avatar: data.avatar_url || null, bio: data.bio || null });
  } catch (error) {
    console.error("Update profile failed:", error.message);
    return res.status(500).json({ message: "保存资料失败，请稍后再试。" });
  }
});

app.post("/api/access/register", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const username = normalizeUsername(req.body?.username);

  if (!isValidEmail(email)) return res.status(400).json({ message: "邮箱格式不正确。" });
  if (!isAllowedEmailDomain(email)) {
    return res.status(400).json({ message: "仅支持 Gmail / Outlook / QQ / 163 邮箱注册。" });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ message: "用户名需为 2~20 位的中文、字母、数字、下划线或连字符。" });
  }
  if (isReservedUsername(username)) {
    return res.status(400).json({ message: "该用户名为保留名，请换一个。" });
  }
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ message: "密码长度需为 8~128 位。" });
  }

  const ip = req.ip || "unknown";
  if (!hitWindow(registerByIp, ip, REGISTER_WINDOW_MS, REGISTER_MAX)) {
    return res.status(429).json({ message: "注册过于频繁，请稍后再试。" });
  }

  if (!(await verifyHuman(req))) {
    return res.status(400).json({ message: "人机验证未通过，请重试。" });
  }

  try {
    // 仅允许「已获后台审批」的邮箱注册：管理员预先放行后会生成空密码占位账号，本人在此设置密码认领（保留会员有效期）。
    const { data: existing } = await supabase
      .from("visitors")
      .select("email, password_hash")
      .eq("email", email)
      .maybeSingle();
    if (!existing) {
      return res.status(403).json({
        message: `该邮箱尚未获批。请先用此邮箱发邮件到 ${CONTACT_TO} 申请开通，管理员通过后即可在此设置密码完成注册。`,
        fallbackEmail: CONTACT_TO,
      });
    }
    if (existing.password_hash) {
      return res.status(409).json({ message: "该邮箱已注册，请直接登录。" });
    }

    // 用户名唯一性预检（真正的唯一性由数据库 lower(username) 唯一索引兜底）。
    const { data: taken, error: takenErr } = await supabase
      .from("visitors")
      .select("email")
      .eq("username", username)
      .maybeSingle();
    if (takenErr) {
      if (isMissingColumn(takenErr)) {
        return res.status(409).json({ message: "请先在 Supabase 执行 visitors.username 迁移。", code: "MIGRATION_REQUIRED" });
      }
      throw takenErr;
    }
    if (taken && taken.email !== email) {
      return res.status(409).json({ message: "该用户名已被使用，请换一个。" });
    }

    const { error } = await supabase
      .from("visitors")
      .update({ password_hash: hashPassword(password), username })
      .eq("email", email);
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ message: "该用户名已被使用，请换一个。" });
      }
      if (isMissingColumn(error)) {
        return res.status(409).json({ message: "请先在 Supabase 执行 visitors.username 迁移。", code: "MIGRATION_REQUIRED" });
      }
      throw error;
    }
  } catch (error) {
    console.error("Register failed:", error.message);
    return res.status(500).json({ message: "注册失败，请稍后再试。" });
  }

  return res.status(201).json({ token: createVisitorToken(email), email, username });
});

app.post("/api/access/login", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!isValidEmail(email) || !password) {
    return res.status(400).json({ message: "请输入邮箱和密码。" });
  }

  const ip = req.ip || "unknown";
  const ipOk = hitWindow(loginByKey, `ip:${ip}`, LOGIN_FAIL_WINDOW_MS, LOGIN_FAIL_MAX);
  const emailOk = hitWindow(loginByKey, `email:${email}`, LOGIN_FAIL_WINDOW_MS, LOGIN_FAIL_MAX);
  if (!ipOk || !emailOk) {
    return res.status(429).json({ message: "尝试过于频繁，请稍后再试。" });
  }

  if (!(await verifyHuman(req))) {
    return res.status(400).json({ message: "人机验证未通过，请重试。" });
  }

  let row;
  try {
    const { data, error } = await supabase
      .from("visitors")
      .select("email, password_hash")
      .eq("email", email)
      .maybeSingle();
    if (error) throw error;
    row = data;
  } catch (error) {
    console.error("Login query failed:", error.message);
    return res.status(500).json({ message: "服务异常，请稍后再试。" });
  }

  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ message: "邮箱或密码不正确。" });
  }

  return res.json({ token: createVisitorToken(email), email });
});

// 会员支付：用户扫码付款后点「我已付款」，给管理员发邮件去后台手动开通（人工收款 + 手动开通）。
const paymentNotifyByEmail = new Map();
app.post("/api/access/payment-notify", requireVisitor, async (req, res) => {
  const email = req.visitor ? req.visitor.email : req.adminSession ? `${ADMIN_USERNAME}(管理员)` : "";
  const plan = String(req.body?.plan || "").slice(0, 60);
  const note = String(req.body?.note || "").slice(0, 500);

  if (req.visitor) {
    // 每个账号限频，避免反复点。
    if (!hitWindow(paymentNotifyByEmail, req.visitor.email, 60 * 60 * 1000, 5)) {
      return res.status(429).json({ message: "提交过于频繁，请稍后再试，或直接联系管理员。" });
    }
  }

  if (!emailConfigured()) {
    return res.status(503).json({ message: "暂未配置通知邮箱，请直接联系管理员开通。", fallbackEmail: CONTACT_TO });
  }

  // 仅对真实访客邮箱生成「一键开通」链接（管理员自测时不需要）。
  const baseUrl = process.env.BACKEND_PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  const grantLink = req.visitor
    ? `${baseUrl}/api/admin/grant?token=${encodeURIComponent(signGrantToken(req.visitor.email, plan))}`
    : "";

  const lines = [
    "有用户报告已完成会员付款。请先在微信/支付宝核对是否收到对应金额，再开通。",
    "",
    `账号邮箱：${email}`,
    `选择套餐：${plan || "（未填写）"}`,
    `用户备注：${note || "（无）"}`,
    `提交时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
  ];
  if (grantLink) {
    lines.push("✅ 确认收到钱后，点下面这个「一键开通」链接（可选 1/3/12 个月，7 天内有效、一次性）：");
    lines.push(grantLink);
    lines.push("");
  }
  lines.push("或手动操作：打开 /admin → 会员管理 → 给该邮箱「+N 个月」。若用户尚未注册，可直接「手动添加会员」。");

  try {
    await sendEmailMessage({
      to: CONTACT_TO,
      subject: `【会员开通申请】${email}`,
      text: lines.join("\n"),
      replyTo: req.visitor ? req.visitor.email : undefined,
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error("Payment notify failed:", error.message);
    return res.status(502).json({ message: "通知发送失败，请稍后再试或直接联系管理员。", fallbackEmail: CONTACT_TO });
  }
});

// 一键开通：确认页（管理员从邮件点开）。令牌即授权，无需登录后台。GET 不产生副作用，避免邮件预取误触发。
function grantHtmlPage(title, inner) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
  :root{--accent:#cc6a2d;--accent-dark:#8e4317;--ink:#2b241d;--muted:#6b625b;--line:#e5dbcf;}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    background:linear-gradient(180deg,#f8f4ed,#f4efe7);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
  .card{width:100%;max-width:440px;background:#fffdfa;border:1px solid var(--line);border-radius:18px;
    box-shadow:0 24px 60px rgba(68,48,30,.16);padding:28px;}
  h1{margin:0 0 6px;font-size:1.3rem;color:var(--accent-dark);}
  .sub{color:var(--muted);font-size:.92rem;line-height:1.7;margin:0 0 18px;}
  .kv{background:#f8f4ed;border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 18px;font-size:.95rem;line-height:1.9;word-break:break-all;}
  .kv b{color:var(--accent-dark);}
  .btns{display:flex;gap:10px;flex-wrap:wrap;}
  .btns button{flex:1 1 120px;padding:13px 14px;border:none;border-radius:12px;cursor:pointer;font:inherit;font-weight:800;
    color:#fff;background:linear-gradient(135deg,#cc6a2d,#8e4317);box-shadow:0 10px 24px rgba(204,106,45,.36);
    transition:transform 150ms ease,box-shadow 150ms ease,opacity 150ms ease;}
  .btns button:hover{transform:translateY(-2px);box-shadow:0 14px 30px rgba(204,106,45,.46);}
  .btns button:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none;}
  .note{margin:16px 0 0;font-size:.84rem;color:var(--muted);line-height:1.7;}
  .ok{color:#2f6b30;font-weight:800;}
  .err{color:#b3271e;font-weight:800;}
  #msg{margin-top:16px;font-size:.95rem;line-height:1.7;min-height:1.2em;}
</style></head><body><div class="card">${inner}</div></body></html>`;
}

app.get("/api/admin/grant", (req, res) => {
  const token = String(req.query.token || "");
  const payload = verifyGrantToken(token);
  res.set("Content-Type", "text/html; charset=utf-8");
  if (!payload) {
    return res.status(400).send(grantHtmlPage("链接无效", `<h1>链接无效或已过期</h1>
      <p class="sub">这个一键开通链接无法识别，可能已过期（7 天）、已被使用，或被改动过。<br>请到后台「会员管理」手动为该用户开通。</p>`));
  }
  const email = escapeHtmlText(payload.email);
  const plan = escapeHtmlText(payload.plan || "未填写");
  return res.send(grantHtmlPage("确认开通会员", `
    <h1>确认开通会员</h1>
    <p class="sub">请先确认你已在<strong>微信 / 支付宝收到对应金额</strong>，再选择开通时长。</p>
    <div class="kv"><b>付款用户：</b>${email}<br><b>用户选择：</b>${plan}</div>
    <p class="sub" style="margin-bottom:10px;">为该用户开通：</p>
    <div class="btns">
      <button data-m="1">开通 1 个月</button>
      <button data-m="3">开通 3 个月</button>
      <button data-m="12">开通 12 个月</button>
    </div>
    <div id="msg"></div>
    <p class="note">链接 7 天内有效、一次性。开通后会在现有有效期上叠加。若金额不符，请勿点击，改用后台手动操作。</p>
    <script>
      var token=${JSON.stringify(token)};
      var btns=document.querySelectorAll('.btns button');
      var msg=document.getElementById('msg');
      btns.forEach(function(b){b.addEventListener('click',function(){
        var months=Number(b.getAttribute('data-m'));
        btns.forEach(function(x){x.disabled=true;});
        msg.textContent='正在开通…';msg.className='';
        fetch('/api/admin/grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,months:months})})
          .then(function(r){return r.json();})
          .then(function(d){
            if(d&&d.ok){msg.innerHTML='<span class="ok">✅ 已为 '+d.email+' 开通 '+d.months+' 个月会员，有效期至 '+new Date(d.memberUntil).toLocaleDateString('zh-CN')+'。</span>'+(d.pending?'<br><span class="note">该用户尚未注册，已建「待认领」会员账号，本人用此邮箱注册设密码后即可登录。</span>':'');}
            else{msg.innerHTML='<span class="err">'+((d&&d.message)||'开通失败')+'</span>';btns.forEach(function(x){x.disabled=false;});}
          })
          .catch(function(){msg.innerHTML='<span class="err">网络异常，请重试。</span>';btns.forEach(function(x){x.disabled=false;});});
      });});
    </script>`));
});

app.post("/api/admin/grant", async (req, res) => {
  const token = String(req.body?.token || "");
  const months = Math.max(1, Math.min(24, Number(req.body?.months) || 1));
  const payload = verifyGrantToken(token);
  if (!payload) return res.status(400).json({ ok: false, message: "链接无效或已过期。" });
  if (usedGrantTokens.has(token)) {
    return res.status(409).json({ ok: false, message: "该链接已使用过。如需再次开通，请到后台「会员管理」手动操作。" });
  }
  // 先抢占标记（防并发重复开通），失败再回滚以便重试。
  usedGrantTokens.set(token, Number(payload.exp) || Date.now() + 7 * 24 * 60 * 60 * 1000);
  try {
    const result = await grantMembershipMonths(payload.email, months);
    return res.json({ ok: true, months, ...result });
  } catch (error) {
    usedGrantTokens.delete(token);
    if (error.code === "MIGRATION_REQUIRED") {
      return res.status(409).json({ ok: false, message: "请先在 Supabase 执行 visitors.member_until 迁移。" });
    }
    console.error("Grant via link failed:", error.message);
    return res.status(500).json({ ok: false, message: "开通失败，请稍后再试或到后台手动操作。" });
  }
});

// 后台：审批放行一个邮箱（建「待认领」普通账号，不开通会员）。
// 用户用注册邮箱发邮件申请后，管理员在此放行；本人随后用该邮箱设置密码完成注册。
app.post("/api/admin/visitors", requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) return res.status(400).json({ message: "邮箱不正确。" });
  if (!isAllowedEmailDomain(email)) {
    return res.status(400).json({ message: "仅支持 Gmail / Outlook / QQ / 163 邮箱。" });
  }
  try {
    const { data: existing, error: selErr } = await supabase
      .from("visitors")
      .select("email, password_hash")
      .eq("email", email)
      .maybeSingle();
    if (selErr) throw selErr;
    if (existing) {
      if (existing.password_hash) {
        return res.status(409).json({ message: "该邮箱已注册。" });
      }
      // 已是「待认领」占位账号，视为已放行（幂等）。
      return res.json({ email, pending: true, approved: true });
    }
    const { error } = await supabase.from("visitors").insert({ email, password_hash: "" });
    if (error) throw error;
    return res.status(201).json({ email, pending: true, approved: true });
  } catch (error) {
    console.error("Approve visitor failed:", error.message);
    return res.status(500).json({ message: "放行失败，请稍后再试。", error: error.message });
  }
});

// 后台：会员管理（列出访客、授予/续费/取消会员）
app.get("/api/admin/visitors", requireAdmin, async (req, res) => {
  try {
    let { data, error } = await supabase
      .from("visitors")
      .select("email, member_until, created_at, password_hash")
      .order("created_at", { ascending: false });
    if (error && isMissingColumn(error)) {
      ({ data, error } = await supabase
        .from("visitors")
        .select("email, created_at, password_hash")
        .order("created_at", { ascending: false }));
    }
    if (error) throw error;
    const now = Date.now();
    return res.json(
      (data || []).map((v) => ({
        email: v.email,
        createdAt: v.created_at,
        memberUntil: v.member_until || null,
        member: v.member_until ? new Date(v.member_until).getTime() > now : false,
        // 密码为空 = 管理员手动添加、本人尚未注册认领。
        pending: !v.password_hash,
      }))
    );
  } catch (error) {
    console.error("List visitors failed:", error.message);
    return res.status(500).json({ message: "加载会员失败。", error: error.message });
  }
});

app.patch("/api/admin/visitors/:email", requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.params.email);
  if (!isValidEmail(email)) return res.status(400).json({ message: "邮箱不正确。" });

  try {
    // 取消会员资格（保留账号）：仅对已存在用户置空 member_until。
    if (req.body?.revoke) {
      const { data, error } = await supabase
        .from("visitors")
        .update({ member_until: null })
        .eq("email", email)
        .select("email")
        .maybeSingle();
      if (error) {
        if (isMissingColumn(error)) return res.status(409).json({ message: "请先在 Supabase 执行 visitors.member_until 迁移。" });
        throw error;
      }
      if (!data) return res.status(404).json({ message: "用户不存在。" });
      return res.json({ email: data.email, memberUntil: null, member: false });
    }

    // 授予 / 续费（账号不存在则占位创建）。
    const result = await grantMembershipMonths(email, req.body?.extendMonths);
    return res.json(result);
  } catch (error) {
    if (error.code === "MIGRATION_REQUIRED") {
      return res.status(409).json({ message: "请先在 Supabase 执行 visitors.member_until 迁移。" });
    }
    console.error("Update visitor failed:", error.message);
    return res.status(500).json({ message: "操作失败。", error: error.message });
  }
});

// 删除会员账号（连同会员资格一并移除；该邮箱可重新注册）。
app.delete("/api/admin/visitors/:email", requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.params.email);
  if (!isValidEmail(email)) return res.status(400).json({ message: "邮箱不正确。" });
  try {
    const { data, error } = await supabase
      .from("visitors")
      .delete()
      .eq("email", email)
      .select("email")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ message: "用户不存在。" });
    // 顺手清理该用户在论坛留下的点赞，避免删号后点赞数虚高（论坛表不存在时忽略）。
    const { error: likeErr } = await supabase.from("forum_post_likes").delete().eq("user_key", email);
    if (likeErr && !isMissingForumTable(likeErr)) {
      console.warn("Cleanup likes for deleted visitor failed:", likeErr.message);
    }
    return res.json({ email: data.email, deleted: true });
  } catch (error) {
    console.error("Delete visitor failed:", error.message);
    return res.status(500).json({ message: "删除失败。", error: error.message });
  }
});

// AI 助手（会员专享）：代理到 OpenAI 兼容接口
app.post("/api/assistant/chat", requireVisitor, async (req, res) => {
  const allowed = req.adminSession ? true : req.visitor ? await visitorIsMember(req.visitor.email) : false;
  if (!allowed) {
    return res.status(403).json({ message: "AI 助手为会员专享功能。", code: "MEMBER_ONLY" });
  }
  if (!LLM_API_KEY) {
    return res.status(503).json({ message: "AI 助手尚未配置。" });
  }

  const key = req.visitor ? req.visitor.email : "admin";
  if (!hitWindow(assistantByEmail, key, 60 * 60 * 1000, 40)) {
    return res.status(429).json({ message: "提问有点频繁，请稍后再聊。" });
  }

  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const safe = incoming
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!safe.length || safe[safe.length - 1].role !== "user") {
    return res.status(400).json({ message: "消息为空。" });
  }

  const system = {
    role: "system",
    content:
      "你是 Heisd.Stark 个人博客的 AI 助手，主要帮助会员了解站点上的机器人控制、计算机视觉与 AI 项目，并解答相关技术问题。回答简洁、友好、使用中文。",
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${LLM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: LLM_MODEL, messages: [system, ...safe], temperature: 0.5, max_tokens: 800 }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!resp.ok) {
      let detail = "";
      try { detail = await resp.text(); } catch {}
      throw new Error(`LLM ${resp.status}: ${detail.slice(0, 200)}`);
    }
    const data = await resp.json();
    const reply = data?.choices?.[0]?.message?.content || "（暂时没有返回内容）";
    return res.json({ reply });
  } catch (error) {
    console.error("Assistant failed:", error.message);
    return res.status(502).json({ message: "AI 助手暂时不可用，请稍后再试。" });
  }
});

// 源码浏览（会员专享）：项目私有仓库的文件树
app.get("/api/projects/:id/repo/tree", requireMember, async (req, res) => {
  if (!GITHUB_TOKEN) {
    return res.status(503).json({ message: "源码浏览尚未配置（缺少 GitHub Token）。" });
  }
  let repo;
  try {
    repo = await getProjectRepo(req.params.id);
  } catch (error) {
    console.error("getProjectRepo failed:", error.message);
    return res.status(500).json({ message: "读取项目失败。" });
  }
  if (!repo) {
    return res.status(404).json({ message: "该项目未设置 GitHub 仓库链接。" });
  }

  const cacheKey = `${repo.owner}/${repo.repo}`;
  const cached = repoTreeCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    return res.json(cached.value);
  }

  try {
    const metaResp = await githubApi(`/repos/${repo.owner}/${repo.repo}`);
    if (!metaResp.ok) {
      return res
        .status(metaResp.status === 404 ? 404 : 502)
        .json({ message: "无法访问该仓库，请检查仓库地址与 GitHub Token 权限。" });
    }
    const meta = await metaResp.json();
    const branch = meta.default_branch || "main";

    const treeResp = await githubApi(
      `/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
    if (!treeResp.ok) {
      return res.status(502).json({ message: "读取文件树失败。" });
    }
    const treeData = await treeResp.json();
    const entries = (treeData.tree || [])
      .filter((e) => e && e.path && (e.type === "blob" || e.type === "tree"))
      .slice(0, 4000)
      .map((e) => ({ path: e.path, type: e.type === "tree" ? "dir" : "file", size: e.size || 0 }));

    const value = { repo: cacheKey, branch, truncated: Boolean(treeData.truncated), entries };
    repoTreeCache.set(cacheKey, { value, expires: Date.now() + 5 * 60 * 1000 });
    return res.json(value);
  } catch (error) {
    console.error("repo tree failed:", error.message);
    return res.status(502).json({ message: "读取仓库失败，请稍后再试。" });
  }
});

// 源码浏览（会员专享）：单个文件内容（只读，不提供下载）
app.get("/api/projects/:id/repo/file", requireMember, async (req, res) => {
  if (!GITHUB_TOKEN) {
    return res.status(503).json({ message: "源码浏览尚未配置（缺少 GitHub Token）。" });
  }
  const path = String(req.query.path || "").replace(/^\/+/, "");
  if (!path || path.includes("..")) {
    return res.status(400).json({ message: "路径不合法。" });
  }
  let repo;
  try {
    repo = await getProjectRepo(req.params.id);
  } catch (error) {
    return res.status(500).json({ message: "读取项目失败。" });
  }
  if (!repo) {
    return res.status(404).json({ message: "该项目未设置 GitHub 仓库链接。" });
  }

  try {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const resp = await githubApi(`/repos/${repo.owner}/${repo.repo}/contents/${encodedPath}`);
    if (!resp.ok) {
      return res.status(resp.status === 404 ? 404 : 502).json({ message: "读取文件失败。" });
    }
    const data = await resp.json();
    if (Array.isArray(data)) {
      return res.status(400).json({ message: "这是一个目录。" });
    }
    const size = data.size || 0;
    if (size > 400 * 1024) {
      return res.json({ path, tooLarge: true, size });
    }
    let content = "";
    if (data.encoding === "base64" && data.content) {
      content = Buffer.from(data.content, "base64").toString("utf8");
    }
    if (content.includes("\u0000")) {
      return res.json({ path, binary: true, size });
    }
    return res.json({ path, content, size });
  } catch (error) {
    console.error("repo file failed:", error.message);
    return res.status(502).json({ message: "读取文件失败，请稍后再试。" });
  }
});

// 公开列表：仅返回已发布项目，置顶优先，再按日期倒序。
app.get("/api/projects", requireVisitor, async (req, res) => {
  try {
    let { data, error } = await supabase
      .from("projects")
      .select("id, title, date, summary, coverImage, videoUrl, repoUrl, tags, status, pinned")
      .neq("status", "draft")
      .order("pinned", { ascending: false, nullsFirst: false })
      .order("date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    // 若数据库尚未执行 tags/status/pinned 迁移，回退到基础查询，避免列表整体报错。
    if (error && isMissingColumn(error)) {
      ({ data, error } = await supabase
        .from("projects")
        .select("id, title, date, summary, coverImage, videoUrl")
        .order("date", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false }));
    }

    if (error) {
      throw error;
    }

    const allowed = await canSeeRepo(req);
    return res.json((data || []).map(toListItem).map((item) => gateRepo(item, allowed)));
  } catch (error) {
    console.error("Failed to read projects:", error.message);
    return res.status(500).json({ message: "Failed to read projects", error: error.message });
  }
});

// 后台列表（需登录）：返回全部项目（含草稿），置顶优先，再按日期倒序。
app.get("/api/admin/projects", requireAdmin, async (req, res) => {
  try {
    let { data, error } = await supabase
      .from("projects")
      .select("id, title, date, summary, coverImage, videoUrl, repoUrl, tags, status, pinned")
      .order("pinned", { ascending: false, nullsFirst: false })
      .order("date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (error && isMissingColumn(error)) {
      ({ data, error } = await supabase
        .from("projects")
        .select("id, title, date, summary, coverImage, videoUrl")
        .order("date", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false }));
    }

    if (error) {
      throw error;
    }

    return res.json((data || []).map(toListItem));
  } catch (error) {
    console.error("Failed to read admin projects:", error.message);
    return res.status(500).json({ message: "Failed to read projects", error: error.message });
  }
});

app.get("/api/projects/:id", requireVisitor, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return res.status(404).json({ message: "Project not found" });
    }

    const allowed = await canSeeRepo(req);
    return res.json(gateRepo(data, allowed));
  } catch (error) {
    console.error("Failed to read project:", error.message);
    return res.status(500).json({ message: "Failed to read project", error: error.message });
  }
});

app.post("/api/projects", requireAdmin, async (req, res) => {
  try {
    const missing = validateProjectInput(req.body);
    if (missing.length) {
      return res.status(400).json({ message: `Missing fields: ${missing.join(", ")}` });
    }

    if (req.body.date && !normalizeDate(req.body.date)) {
      return res.status(400).json({ message: "Invalid date" });
    }

    const project = {
      id: await ensureUniqueProjectId(req.body.title),
      title: req.body.title.trim(),
      date: req.body.date ? normalizeDate(req.body.date) : formatDate(),
      summary: req.body.summary.trim(),
      content: req.body.content.trim(),
      coverImage: req.body.coverImage.trim(),
      videoUrl: String(req.body.videoUrl || "").trim() || null,
      repoUrl: String(req.body.repoUrl || "").trim() || null,
      tags: normalizeTags(req.body.tags),
      status: normalizeStatus(req.body.status),
      pinned: Boolean(req.body.pinned),
    };

    let { data, error } = await supabase
      .from("projects")
      .insert(project)
      .select("*")
      .single();

    // 尚未执行 tags/status/pinned/repoUrl 迁移时，去掉这些新字段再保存（项目仍可创建）。
    if (error && isMissingColumn(error)) {
      const { tags, status, pinned, repoUrl, ...base } = project;
      ({ data, error } = await supabase.from("projects").insert(base).select("*").single());
    }

    if (error) {
      throw error;
    }

    return res.status(201).json(data);
  } catch (error) {
    return res.status(500).json({ message: "Failed to create project", error: error.message });
  }
});

app.put("/api/projects/:id", requireAdmin, async (req, res) => {
  try {
    const missing = validateProjectInput(req.body);
    if (missing.length) {
      return res.status(400).json({ message: `Missing fields: ${missing.join(", ")}` });
    }

    if (req.body.date && !normalizeDate(req.body.date)) {
      return res.status(400).json({ message: "Invalid date" });
    }

    const { data: existing, error: readError } = await supabase
      .from("projects")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (readError) {
      throw readError;
    }

    if (!existing) {
      return res.status(404).json({ message: "Project not found" });
    }

    const updatedProject = {
      title: req.body.title.trim(),
      summary: req.body.summary.trim(),
      content: req.body.content.trim(),
      coverImage: req.body.coverImage.trim(),
      videoUrl: String(req.body.videoUrl || "").trim() || null,
      repoUrl: String(req.body.repoUrl || "").trim() || null,
      tags: normalizeTags(req.body.tags),
      status: normalizeStatus(req.body.status),
      pinned: Boolean(req.body.pinned),
      date: req.body.date ? normalizeDate(req.body.date) : existing.date,
      updated_at: new Date().toISOString(),
    };

    let { data, error } = await supabase
      .from("projects")
      .update(updatedProject)
      .eq("id", req.params.id)
      .select("*")
      .single();

    if (error && isMissingColumn(error)) {
      const { tags, status, pinned, repoUrl, ...base } = updatedProject;
      ({ data, error } = await supabase
        .from("projects")
        .update(base)
        .eq("id", req.params.id)
        .select("*")
        .single());
    }

    if (error) {
      throw error;
    }

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: "Failed to update project", error: error.message });
  }
});

// 轻量更新置顶/草稿状态（不需要重传全文），供后台列表的快捷开关使用。
app.patch("/api/projects/:id", requireAdmin, async (req, res) => {
  try {
    const patch = { updated_at: new Date().toISOString() };
    if (typeof req.body.pinned === "boolean") {
      patch.pinned = req.body.pinned;
    }
    if (req.body.status === "draft" || req.body.status === "published") {
      patch.status = req.body.status;
    }
    if (Object.keys(patch).length <= 1) {
      return res.status(400).json({ message: "没有可更新的状态字段（pinned / status）。" });
    }

    const { data, error } = await supabase
      .from("projects")
      .update(patch)
      .eq("id", req.params.id)
      .select("*")
      .maybeSingle();

    if (error) {
      if (isMissingColumn(error)) {
        return res
          .status(409)
          .json({ message: "请先在 Supabase 执行 status / pinned 迁移后再使用置顶/草稿功能。" });
      }
      throw error;
    }

    if (!data) {
      return res.status(404).json({ message: "Project not found" });
    }

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: "Failed to update project", error: error.message });
  }
});

app.delete("/api/projects/:id", requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("projects")
      .delete()
      .eq("id", req.params.id)
      .select("*")
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return res.status(404).json({ message: "Project not found" });
    }

    return res.json({ message: "Project deleted", project: data });
  } catch (error) {
    return res.status(500).json({ message: "Failed to delete project", error: error.message });
  }
});

// ===== 论坛：有账号的用户可发表文章 / 帖子并互相讨论（登录即可，管理员亦可参与）=====

const forumWriteByEmail = new Map();
const FORUM_WINDOW_MS = 60 * 60 * 1000;
const FORUM_POST_MAX = 30; // 每小时每账号最多发帖数
const FORUM_REPLY_MAX = 120; // 每小时每账号最多回复数

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of forumWriteByEmail) if (now - v.start > FORUM_WINDOW_MS) forumWriteByEmail.delete(k);
}, FORUM_WINDOW_MS).unref();

// 帖子列表（含每帖回复数）。倒序，最多 200 条。
app.get("/api/forum/posts", requireVisitor, async (req, res) => {
  try {
    // 公开论坛仅展示「已发布」帖子；草稿只在作者的「我的空间」可见。
    let { data, error } = await supabase
      .from("forum_posts")
      .select("id, author_email, author_username, title, content, created_at, updated_at")
      .neq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(200);
    // status 列未迁移时回退到不带过滤的查询（旧库全部视为已发布）。
    if (error && isMissingColumn(error)) {
      ({ data, error } = await supabase
        .from("forum_posts")
        .select("id, author_email, author_username, title, content, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(200));
    }
    if (error) {
      if (isMissingForumTable(error)) return res.json({ posts: [], needsMigration: true });
      throw error;
    }

    const posts = data || [];
    const me = await getForumActor(req);
    const counts = {};
    const likeCounts = {};
    const likedByMe = new Set();
    if (posts.length) {
      const ids = posts.map((p) => p.id);
      const { data: reps, error: repErr } = await supabase
        .from("forum_replies")
        .select("post_id")
        .in("post_id", ids);
      if (!repErr && Array.isArray(reps)) {
        for (const r of reps) counts[r.post_id] = (counts[r.post_id] || 0) + 1;
      }
      const { data: likes, error: likeErr } = await supabase
        .from("forum_post_likes")
        .select("post_id, user_key")
        .in("post_id", ids);
      if (!likeErr && Array.isArray(likes)) {
        for (const l of likes) {
          likeCounts[l.post_id] = (likeCounts[l.post_id] || 0) + 1;
          if (me && l.user_key === me.key) likedByMe.add(l.post_id);
        }
      }
    }

    const canDelete = (email) => Boolean(me && (me.isAdmin || (me.email && email === me.email)));
    const authors = await fetchAuthorProfiles(posts.map((p) => p.author_email));
    return res.json({
      authors,
      posts: posts.map((p) => ({
        id: p.id,
        authorUsername: p.author_username,
        title: p.title,
        excerpt: makeExcerpt(p.content),
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        replyCount: counts[p.id] || 0,
        likeCount: likeCounts[p.id] || 0,
        liked: likedByMe.has(p.id),
        canDelete: canDelete(p.author_email),
      })),
    });
  } catch (error) {
    console.error("List forum posts failed:", error.message);
    return res.status(500).json({ message: "加载帖子失败，请稍后再试。" });
  }
});

// 帖子详情 + 全部回复。
app.get("/api/forum/posts/:id", requireVisitor, async (req, res) => {
  try {
    const { data: post, error } = await supabase
      .from("forum_posts")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) {
      if (isMissingForumTable(error)) return res.status(404).json({ message: "帖子不存在。" });
      throw error;
    }
    if (!post) return res.status(404).json({ message: "帖子不存在。" });

    const me = await getForumActor(req);
    const isOwner = Boolean(me && (me.isAdmin || (me.email && post.author_email === me.email)));
    // 草稿只对作者本人 / 管理员可见，其余一律按「不存在」处理。
    if (post.status === "draft" && !isOwner) {
      return res.status(404).json({ message: "帖子不存在。" });
    }

    const { data: replies, error: repErr } = await supabase
      .from("forum_replies")
      .select("*")
      .eq("post_id", post.id)
      .order("created_at", { ascending: true });
    if (repErr) throw repErr;

    const { data: likes, error: likeErr } = await supabase
      .from("forum_post_likes")
      .select("user_key")
      .eq("post_id", post.id);
    if (likeErr && !isMissingForumTable(likeErr)) throw likeErr;
    const likeRows = Array.isArray(likes) ? likes : [];
    const likeCount = likeRows.length;
    const liked = Boolean(me && likeRows.some((l) => l.user_key === me.key));

    const canDelete = (email) => Boolean(me && (me.isAdmin || (me.email && email === me.email)));
    const authors = await fetchAuthorProfiles([post.author_email, ...(replies || []).map((r) => r.author_email)]);
    return res.json({
      authors,
      post: {
        id: post.id,
        authorUsername: post.author_username,
        title: post.title,
        content: post.content,
        status: post.status === "draft" ? "draft" : "published",
        createdAt: post.created_at,
        updatedAt: post.updated_at,
        likeCount,
        liked,
        canEdit: isOwner,
        canDelete: canDelete(post.author_email),
      },
      replies: (replies || []).map((r) => ({
        id: r.id,
        authorUsername: r.author_username,
        content: r.content,
        createdAt: r.created_at,
        canDelete: canDelete(r.author_email),
      })),
    });
  } catch (error) {
    console.error("Read forum post failed:", error.message);
    return res.status(500).json({ message: "加载帖子失败，请稍后再试。" });
  }
});

// 发表新帖（发表文章 / 讨论主题）。
app.post("/api/forum/posts", requireVisitor, async (req, res) => {
  const actor = await getForumActor(req);
  if (!actor) return res.status(401).json({ message: "需要登录。" });
  if (!actor.username) {
    return res.status(403).json({ message: "请先设置用户名后再发帖。", code: "USERNAME_REQUIRED" });
  }
  const title = String(req.body?.title || "").trim();
  const content = String(req.body?.content || "").trim();
  const status = normalizeForumStatus(req.body?.status);
  if (!title || !content) return res.status(400).json({ message: "请填写标题和内容。" });
  if (title.length > 120) return res.status(400).json({ message: "标题不超过 120 字。" });
  if (content.length > 20000) return res.status(400).json({ message: "内容过长（上限 20000 字）。" });

  const key = actor.email || "admin";
  if (!hitWindow(forumWriteByEmail, `post:${key}`, FORUM_WINDOW_MS, FORUM_POST_MAX)) {
    return res.status(429).json({ message: "操作过于频繁，请稍后再试。" });
  }

  try {
    const row = { author_email: actor.email, author_username: actor.username, title, content, status };
    let { data, error } = await supabase
      .from("forum_posts")
      .insert(row)
      .select("id, author_username, title, content, status, created_at, updated_at")
      .single();
    // status 列未迁移时去掉该字段重试（仍可创建，按已发布处理）。
    if (error && isMissingColumn(error)) {
      const { status: _omit, ...base } = row;
      ({ data, error } = await supabase
        .from("forum_posts")
        .insert(base)
        .select("id, author_username, title, content, created_at, updated_at")
        .single());
    }
    if (error) {
      if (isMissingForumTable(error)) {
        return res.status(409).json({ message: "论坛功能尚未初始化，请先在 Supabase 执行 forum 迁移。", code: "MIGRATION_REQUIRED" });
      }
      throw error;
    }
    return res.status(201).json({
      id: data.id,
      authorUsername: data.author_username,
      title: data.title,
      content: data.content,
      status: data.status === "draft" ? "draft" : "published",
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      canEdit: true,
      canDelete: true,
    });
  } catch (error) {
    console.error("Create forum post failed:", error.message);
    return res.status(500).json({ message: "保存失败，请稍后再试。" });
  }
});

// 编辑自己的帖子（标题 / 正文 / 发布状态）。作者本人或管理员可改。
app.put("/api/forum/posts/:id", requireVisitor, async (req, res) => {
  const actor = await getForumActor(req);
  if (!actor) return res.status(401).json({ message: "需要登录。" });
  if (!actor.username) {
    return res.status(403).json({ message: "请先设置用户名。", code: "USERNAME_REQUIRED" });
  }
  const title = String(req.body?.title || "").trim();
  const content = String(req.body?.content || "").trim();
  const status = normalizeForumStatus(req.body?.status);
  if (!title || !content) return res.status(400).json({ message: "请填写标题和内容。" });
  if (title.length > 120) return res.status(400).json({ message: "标题不超过 120 字。" });
  if (content.length > 20000) return res.status(400).json({ message: "内容过长（上限 20000 字）。" });

  try {
    const { data: existing, error: selErr } = await supabase
      .from("forum_posts")
      .select("author_email")
      .eq("id", req.params.id)
      .maybeSingle();
    if (selErr) {
      if (isMissingForumTable(selErr)) return res.status(404).json({ message: "帖子不存在。" });
      throw selErr;
    }
    if (!existing) return res.status(404).json({ message: "帖子不存在。" });
    if (!actor.isAdmin && !(actor.email && existing.author_email === actor.email)) {
      return res.status(403).json({ message: "只能编辑自己的文章。" });
    }

    const patch = { title, content, status, updated_at: new Date().toISOString() };
    let { data, error } = await supabase
      .from("forum_posts")
      .update(patch)
      .eq("id", req.params.id)
      .select("id, author_username, title, content, status, created_at, updated_at")
      .single();
    if (error && isMissingColumn(error)) {
      const { status: _omit, ...base } = patch;
      ({ data, error } = await supabase
        .from("forum_posts")
        .update(base)
        .eq("id", req.params.id)
        .select("id, author_username, title, content, created_at, updated_at")
        .single());
    }
    if (error) throw error;
    return res.json({
      id: data.id,
      authorUsername: data.author_username,
      title: data.title,
      content: data.content,
      status: data.status === "draft" ? "draft" : "published",
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      canEdit: true,
      canDelete: true,
    });
  } catch (error) {
    console.error("Update forum post failed:", error.message);
    return res.status(500).json({ message: "保存失败，请稍后再试。" });
  }
});

// 我的空间：列出当前用户自己的全部帖子（含草稿）。
app.get("/api/forum/mine", requireVisitor, async (req, res) => {
  const actor = await getForumActor(req);
  if (!actor) return res.status(401).json({ message: "需要登录。" });
  try {
    let query = supabase
      .from("forum_posts")
      .select("id, author_email, author_username, title, content, status, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(300);
    // 访客按邮箱归属；管理员归属为「无邮箱」的管理员帖子。
    query = actor.isAdmin ? query.is("author_email", null) : query.eq("author_email", actor.email);
    let { data, error } = await query;
    if (error && isMissingColumn(error)) {
      let q2 = supabase
        .from("forum_posts")
        .select("id, author_email, author_username, title, content, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(300);
      q2 = actor.isAdmin ? q2.is("author_email", null) : q2.eq("author_email", actor.email);
      ({ data, error } = await q2);
    }
    if (error) {
      if (isMissingForumTable(error)) return res.json({ posts: [], needsMigration: true });
      throw error;
    }
    const posts = data || [];
    const counts = {};
    const likeCounts = {};
    if (posts.length) {
      const ids = posts.map((p) => p.id);
      const { data: reps } = await supabase.from("forum_replies").select("post_id").in("post_id", ids);
      if (Array.isArray(reps)) for (const r of reps) counts[r.post_id] = (counts[r.post_id] || 0) + 1;
      const { data: likes } = await supabase.from("forum_post_likes").select("post_id").in("post_id", ids);
      if (Array.isArray(likes)) for (const l of likes) likeCounts[l.post_id] = (likeCounts[l.post_id] || 0) + 1;
    }
    return res.json({
      posts: posts.map((p) => ({
        id: p.id,
        title: p.title,
        excerpt: makeExcerpt(p.content),
        status: p.status === "draft" ? "draft" : "published",
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        replyCount: counts[p.id] || 0,
        likeCount: likeCounts[p.id] || 0,
      })),
    });
  } catch (error) {
    console.error("List my posts failed:", error.message);
    return res.status(500).json({ message: "加载我的文章失败，请稍后再试。" });
  }
});

// 获取自己某篇文章的可编辑原文（含草稿）。
app.get("/api/forum/mine/:id", requireVisitor, async (req, res) => {
  const actor = await getForumActor(req);
  if (!actor) return res.status(401).json({ message: "需要登录。" });
  try {
    const { data: post, error } = await supabase
      .from("forum_posts")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) {
      if (isMissingForumTable(error)) return res.status(404).json({ message: "文章不存在。" });
      throw error;
    }
    if (!post) return res.status(404).json({ message: "文章不存在。" });
    if (!actor.isAdmin && !(actor.email && post.author_email === actor.email)) {
      return res.status(403).json({ message: "只能编辑自己的文章。" });
    }
    return res.json({
      id: post.id,
      title: post.title,
      content: post.content,
      status: post.status === "draft" ? "draft" : "published",
      createdAt: post.created_at,
      updatedAt: post.updated_at,
    });
  } catch (error) {
    console.error("Read my post failed:", error.message);
    return res.status(500).json({ message: "加载文章失败，请稍后再试。" });
  }
});

// 用户公开主页：头像 + 自我介绍 + TA 已发布的文章（需登录查看）。
app.get("/api/users/:username", requireVisitor, async (req, res) => {
  const username = String(req.params.username || "").trim();
  if (!username) return res.status(404).json({ message: "用户不存在。" });
  try {
    let { data: v, error: vErr } = await supabase
      .from("visitors")
      .select("email, username, avatar_url, bio, created_at")
      .eq("username", username)
      .maybeSingle();
    if (vErr && isMissingColumn(vErr)) {
      ({ data: v, error: vErr } = await supabase
        .from("visitors")
        .select("email, username, created_at")
        .eq("username", username)
        .maybeSingle());
    }
    if (vErr) throw vErr;
    if (!v) return res.status(404).json({ message: "用户不存在。" });

    let { data: posts, error: pErr } = await supabase
      .from("forum_posts")
      .select("id, title, content, created_at")
      .eq("author_username", v.username)
      .neq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(100);
    if (pErr && isMissingColumn(pErr)) {
      ({ data: posts, error: pErr } = await supabase
        .from("forum_posts")
        .select("id, title, content, created_at")
        .eq("author_username", v.username)
        .order("created_at", { ascending: false })
        .limit(100));
    }
    if (pErr) {
      if (isMissingForumTable(pErr)) posts = [];
      else throw pErr;
    }
    posts = posts || [];

    const counts = {};
    const likeCounts = {};
    let totalReplies = 0;
    let totalLikes = 0;
    if (posts.length) {
      const ids = posts.map((p) => p.id);
      const { data: reps } = await supabase.from("forum_replies").select("post_id").in("post_id", ids);
      if (Array.isArray(reps)) for (const r of reps) counts[r.post_id] = (counts[r.post_id] || 0) + 1;
      const { data: likes } = await supabase.from("forum_post_likes").select("post_id").in("post_id", ids);
      if (Array.isArray(likes)) for (const l of likes) likeCounts[l.post_id] = (likeCounts[l.post_id] || 0) + 1;
      for (const p of posts) { totalReplies += counts[p.id] || 0; totalLikes += likeCounts[p.id] || 0; }
    }

    // 关注信息（关注表未迁移时全部按 0 / false 降级）。
    const viewerEmail = req.visitor ? req.visitor.email : null;
    const isSelf = Boolean(viewerEmail && v.email && viewerEmail === v.email);
    let followers = 0, followingCount = 0, isFollowing = false, followsYou = false;
    try {
      const fc = await supabase.from("forum_follows").select("*", { count: "exact", head: true }).eq("following_username", v.username);
      if (!fc.error) followers = fc.count || 0;
      if (v.email) {
        const gc = await supabase.from("forum_follows").select("*", { count: "exact", head: true }).eq("follower_email", v.email);
        if (!gc.error) followingCount = gc.count || 0;
      }
      if (viewerEmail && !isSelf) {
        const { data: rel } = await supabase.from("forum_follows").select("follower_email").eq("follower_email", viewerEmail).eq("following_username", v.username).maybeSingle();
        isFollowing = !!rel;
        const viewerUsername = await getUsername(viewerEmail);
        if (viewerUsername && v.email) {
          const { data: rel2 } = await supabase.from("forum_follows").select("follower_email").eq("follower_email", v.email).eq("following_username", viewerUsername).maybeSingle();
          followsYou = !!rel2;
        }
      }
    } catch {}
    const isMutual = isFollowing && followsYou;

    let petLevel = 0;
    try {
      const { data: petRows } = await supabase.from("pets").select("level").eq("owner_email", v.email);
      if (Array.isArray(petRows)) for (const p of petRows) if (p.level > petLevel) petLevel = p.level;
    } catch {}

    return res.json({
      user: {
        username: v.username,
        avatar: v.avatar_url || null,
        bio: v.bio || null,
        joinedAt: v.created_at || null,
        postCount: posts.length,
        petLevel,
        totalLikes,
        totalReplies,
        followers,
        following: followingCount,
        isFollowing,
        followsYou,
        isMutual,
        isSelf,
        canFollow: Boolean(viewerEmail && !isSelf),
        canMessage: Boolean(viewerEmail && !isSelf && isMutual),
      },
      posts: posts.map((p) => ({
        id: p.id,
        title: p.title,
        excerpt: makeExcerpt(p.content),
        createdAt: p.created_at,
        replyCount: counts[p.id] || 0,
        likeCount: likeCounts[p.id] || 0,
      })),
    });
  } catch (error) {
    console.error("Get user profile failed:", error.message);
    return res.status(500).json({ message: "加载用户主页失败，请稍后再试。" });
  }
});

// 关注 / 取消关注（切换）。仅登录访客可操作，不能关注自己。
app.post("/api/users/:username/follow", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.status(403).json({ message: "请用账号登录后再关注。" });
  const username = String(req.params.username || "").trim();
  if (!username) return res.status(404).json({ message: "用户不存在。" });
  if (!hitWindow(forumWriteByEmail, `follow:${req.visitor.email}`, FORUM_WINDOW_MS, 200)) {
    return res.status(429).json({ message: "操作过于频繁，请稍后再试。" });
  }
  try {
    const { data: target, error: tErr } = await supabase
      .from("visitors").select("email, username").eq("username", username).maybeSingle();
    if (tErr) throw tErr;
    if (!target) return res.status(404).json({ message: "用户不存在。" });
    if (target.email === req.visitor.email) return res.status(400).json({ message: "不能关注自己。" });

    const { data: existing, error: eErr } = await supabase
      .from("forum_follows")
      .select("follower_email")
      .eq("follower_email", req.visitor.email)
      .eq("following_username", target.username)
      .maybeSingle();
    if (eErr) {
      if (isMissingForumTable(eErr)) return res.status(409).json({ message: "关注功能尚未初始化，请先在 Supabase 执行 follows 迁移。", code: "MIGRATION_REQUIRED" });
      throw eErr;
    }

    let following;
    if (existing) {
      const { error } = await supabase.from("forum_follows").delete()
        .eq("follower_email", req.visitor.email).eq("following_username", target.username);
      if (error) throw error;
      following = false;
    } else {
      const { error } = await supabase.from("forum_follows")
        .insert({ follower_email: req.visitor.email, following_username: target.username });
      if (error && error.code !== "23505") throw error;
      following = true;
    }
    const { count } = await supabase.from("forum_follows")
      .select("*", { count: "exact", head: true }).eq("following_username", target.username);
    return res.json({ following, followers: count || 0 });
  } catch (error) {
    console.error("Follow toggle failed:", error.message);
    return res.status(500).json({ message: "操作失败，请稍后再试。" });
  }
});

// 关注动态：我关注的人最新发布的文章。
app.get("/api/feed", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.json({ posts: [], authors: {} }); // 管理员无关注流
  try {
    const { data: follows, error: fErr } = await supabase
      .from("forum_follows").select("following_username").eq("follower_email", req.visitor.email);
    if (fErr) {
      if (isMissingForumTable(fErr)) return res.json({ posts: [], authors: {}, needsMigration: true });
      throw fErr;
    }
    const names = (follows || []).map((f) => f.following_username);
    if (!names.length) return res.json({ posts: [], authors: {} });

    let { data: posts, error: pErr } = await supabase
      .from("forum_posts")
      .select("id, author_email, author_username, title, content, created_at")
      .in("author_username", names)
      .neq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(50);
    if (pErr && isMissingColumn(pErr)) {
      ({ data: posts, error: pErr } = await supabase
        .from("forum_posts")
        .select("id, author_email, author_username, title, content, created_at")
        .in("author_username", names)
        .order("created_at", { ascending: false })
        .limit(50));
    }
    if (pErr) throw pErr;
    posts = posts || [];

    const counts = {};
    const likeCounts = {};
    if (posts.length) {
      const ids = posts.map((p) => p.id);
      const { data: reps } = await supabase.from("forum_replies").select("post_id").in("post_id", ids);
      if (Array.isArray(reps)) for (const r of reps) counts[r.post_id] = (counts[r.post_id] || 0) + 1;
      const { data: likes } = await supabase.from("forum_post_likes").select("post_id").in("post_id", ids);
      if (Array.isArray(likes)) for (const l of likes) likeCounts[l.post_id] = (likeCounts[l.post_id] || 0) + 1;
    }
    const authors = await fetchAuthorProfiles(posts.map((p) => p.author_email));
    return res.json({
      authors,
      posts: posts.map((p) => ({
        id: p.id,
        authorUsername: p.author_username,
        title: p.title,
        excerpt: makeExcerpt(p.content),
        createdAt: p.created_at,
        replyCount: counts[p.id] || 0,
        likeCount: likeCounts[p.id] || 0,
      })),
    });
  } catch (error) {
    console.error("Feed failed:", error.message);
    return res.status(500).json({ message: "加载关注动态失败，请稍后再试。" });
  }
});

// ===== 私信（1 对 1 直接消息）=====

// 按用户名取账号（含资料），用于私信寻址。
async function getVisitorByUsername(username) {
  let { data, error } = await supabase
    .from("visitors").select("email, username, avatar_url, bio").eq("username", username).maybeSingle();
  if (error && isMissingColumn(error)) {
    ({ data, error } = await supabase.from("visitors").select("email, username").eq("username", username).maybeSingle());
  }
  if (error) throw error;
  return data || null;
}

// 是否互相关注（私信门禁）：A→B 且 B→A 都存在。follows 表缺失或任一方缺失则视为否。
async function mutualFollow(emailA, usernameA, emailB, usernameB) {
  if (!emailA || !emailB || !usernameA || !usernameB) return false;
  try {
    const aToB = await supabase.from("forum_follows")
      .select("follower_email", { count: "exact", head: true })
      .eq("follower_email", emailA).eq("following_username", usernameB);
    if (aToB.error) { if (isMissingForumTable(aToB.error)) return false; throw aToB.error; }
    if (!aToB.count) return false;
    const bToA = await supabase.from("forum_follows")
      .select("follower_email", { count: "exact", head: true })
      .eq("follower_email", emailB).eq("following_username", usernameA);
    if (bToA.error) { if (isMissingForumTable(bToA.error)) return false; throw bToA.error; }
    return (bToA.count || 0) > 0;
  } catch (error) {
    console.error("mutualFollow failed:", error.message);
    return false;
  }
}

// 私信实时推送（SSE）：email -> 该用户所有打开的连接。
const sseClients = new Map();
function sseSend(email, event, dataObj) {
  const set = sseClients.get(email);
  if (!set || !set.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(dataObj || {})}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch {}
  }
}

// 发送私信。
app.post("/api/messages", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.status(403).json({ message: "请用账号登录后再发私信。" });
  const to = String(req.body?.to || "").trim();
  const content = String(req.body?.content || "").trim();
  if (!to) return res.status(400).json({ message: "缺少收件人。" });
  if (!content) return res.status(400).json({ message: "请填写私信内容。" });
  if (content.length > 4000) return res.status(400).json({ message: "私信内容过长（上限 4000 字）。" });
  if (!hitWindow(forumWriteByEmail, `dm:${req.visitor.email}`, FORUM_WINDOW_MS, 120)) {
    return res.status(429).json({ message: "发送过于频繁，请稍后再试。" });
  }
  try {
    const peer = await getVisitorByUsername(to);
    if (!peer) return res.status(404).json({ message: "对方用户不存在。" });
    if (peer.email === req.visitor.email) return res.status(400).json({ message: "不能给自己发私信。" });
    // 私信门禁：需互相关注。
    const myUsername = await getUsername(req.visitor.email);
    if (!myUsername) return res.status(403).json({ message: "请先设置用户名。", code: "USERNAME_REQUIRED" });
    if (!(await mutualFollow(req.visitor.email, myUsername, peer.email, peer.username))) {
      return res.status(403).json({ message: "需要与对方互相关注后才能发私信。", code: "NOT_MUTUAL" });
    }
    const { data, error } = await supabase
      .from("forum_messages")
      .insert({ sender_email: req.visitor.email, recipient_email: peer.email, content })
      .select("id, content, created_at")
      .single();
    if (error) {
      if (isMissingForumTable(error)) return res.status(409).json({ message: "私信功能尚未初始化，请先在 Supabase 执行 messages 迁移。", code: "MIGRATION_REQUIRED" });
      throw error;
    }
    sseSend(peer.email, "message", { from: myUsername }); // 实时推给对方
    return res.status(201).json({ id: data.id, content: data.content, createdAt: data.created_at, mine: true });
  } catch (error) {
    console.error("Send message failed:", error.message);
    return res.status(500).json({ message: "发送失败，请稍后再试。" });
  }
});

// 会话列表：与我相关的每个对话方的最新一条 + 未读数。
app.get("/api/messages", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.json({ conversations: [] });
  const me = req.visitor.email;
  try {
    let { data, error } = await supabase
      .from("forum_messages")
      .select("sender_email, recipient_email, content, created_at, read_at, deleted_by_sender, deleted_by_recipient")
      .or(`sender_email.eq.${me},recipient_email.eq.${me}`)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error && isMissingColumn(error)) {
      ({ data, error } = await supabase
        .from("forum_messages")
        .select("sender_email, recipient_email, content, created_at, read_at")
        .or(`sender_email.eq.${me},recipient_email.eq.${me}`)
        .order("created_at", { ascending: false })
        .limit(500));
    }
    if (error) {
      if (isMissingForumTable(error)) return res.json({ conversations: [], needsMigration: true });
      throw error;
    }
    // 过滤掉「我已删除」的消息（不影响对方）。
    const rows = (data || []).filter((m) =>
      !((m.sender_email === me && m.deleted_by_sender) || (m.recipient_email === me && m.deleted_by_recipient))
    );
    const byPeer = new Map();
    for (const m of rows) {
      const peer = m.sender_email === me ? m.recipient_email : m.sender_email;
      if (!byPeer.has(peer)) {
        byPeer.set(peer, { peerEmail: peer, lastContent: m.content, lastAt: m.created_at, mine: m.sender_email === me, unread: 0 });
      }
      if (m.recipient_email === me && !m.read_at) {
        byPeer.get(peer).unread += 1;
      }
    }
    // 解析对话方资料
    const peers = Array.from(byPeer.keys());
    const profiles = {};
    if (peers.length) {
      let pr = await supabase.from("visitors").select("email, username, avatar_url").in("email", peers);
      if (pr.error && isMissingColumn(pr.error)) pr = await supabase.from("visitors").select("email, username").in("email", peers);
      if (!pr.error) for (const v of pr.data || []) profiles[v.email] = { username: v.username || null, avatar: v.avatar_url || null };
    }
    const conversations = Array.from(byPeer.values())
      .map((c) => ({
        username: (profiles[c.peerEmail] && profiles[c.peerEmail].username) || null,
        avatar: (profiles[c.peerEmail] && profiles[c.peerEmail].avatar) || null,
        lastMessage: makeExcerpt(c.lastContent, 60),
        lastAt: c.lastAt,
        mine: c.mine,
        unread: c.unread,
      }))
      .filter((c) => c.username) // 对方账号还在
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    return res.json({ conversations });
  } catch (error) {
    console.error("List conversations failed:", error.message);
    return res.status(500).json({ message: "加载私信失败，请稍后再试。" });
  }
});

// 未读私信总数（导航栏小红点用）。
app.get("/api/messages/unread-count", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.json({ count: 0 });
  try {
    const { count, error } = await supabase
      .from("forum_messages")
      .select("*", { count: "exact", head: true })
      .eq("recipient_email", req.visitor.email)
      .is("read_at", null);
    if (error) {
      if (isMissingForumTable(error)) return res.json({ count: 0 });
      throw error;
    }
    return res.json({ count: count || 0 });
  } catch (error) {
    console.error("Unread count failed:", error.message);
    return res.json({ count: 0 });
  }
});

// 与某人的会话内容 + 将对方发来的未读标记为已读。
app.get("/api/messages/:username", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.status(403).json({ message: "请用账号登录后查看私信。" });
  const me = req.visitor.email;
  try {
    const peer = await getVisitorByUsername(String(req.params.username || "").trim());
    if (!peer) return res.status(404).json({ message: "对方用户不存在。" });
    if (peer.email === me) return res.status(400).json({ message: "这是你自己。" });

    let { data, error } = await supabase
      .from("forum_messages")
      .select("id, sender_email, content, created_at, deleted_by_sender, deleted_by_recipient")
      .in("sender_email", [me, peer.email])
      .in("recipient_email", [me, peer.email])
      .order("created_at", { ascending: true })
      .limit(500);
    if (error && isMissingColumn(error)) {
      ({ data, error } = await supabase
        .from("forum_messages")
        .select("id, sender_email, content, created_at")
        .in("sender_email", [me, peer.email])
        .in("recipient_email", [me, peer.email])
        .order("created_at", { ascending: true })
        .limit(500));
    }
    if (error) {
      if (isMissingForumTable(error)) {
        const myU0 = await getUsername(me);
        const canMsg0 = await mutualFollow(me, myU0, peer.email, peer.username);
        return res.json({ peer: { username: peer.username, avatar: peer.avatar_url || null, bio: peer.bio || null }, messages: [], canMessage: canMsg0 });
      }
      throw error;
    }

    // 标记对方发来的未读为已读（不阻塞返回）。
    supabase.from("forum_messages").update({ read_at: new Date().toISOString() })
      .eq("recipient_email", me).eq("sender_email", peer.email).is("read_at", null)
      .then(() => {}, () => {});

    // 过滤掉「我已删除」的消息（仅影响我这一侧）。
    const visible = (data || []).filter((m) =>
      !((m.sender_email === me && m.deleted_by_sender) || (m.sender_email !== me && m.deleted_by_recipient))
    );
    const myU = await getUsername(me);
    const canMessage = await mutualFollow(me, myU, peer.email, peer.username);

    return res.json({
      peer: { username: peer.username, avatar: peer.avatar_url || null, bio: peer.bio || null },
      canMessage,
      messages: visible.map((m) => ({ id: m.id, content: m.content, createdAt: m.created_at, mine: m.sender_email === me })),
    });
  } catch (error) {
    console.error("Read conversation failed:", error.message);
    return res.status(500).json({ message: "加载会话失败，请稍后再试。" });
  }
});

// 撤回（发件人，双方移除）/ 删除（仅从自己一侧隐藏；两侧都删则彻底移除）。
app.delete("/api/messages/:id", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.status(403).json({ message: "请用账号登录。" });
  const me = req.visitor.email;
  const scope = String(req.body?.scope || "me");
  try {
    let { data: m, error } = await supabase
      .from("forum_messages")
      .select("id, sender_email, recipient_email, deleted_by_sender, deleted_by_recipient")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error && isMissingColumn(error)) {
      ({ data: m, error } = await supabase
        .from("forum_messages")
        .select("id, sender_email, recipient_email")
        .eq("id", req.params.id)
        .maybeSingle());
    }
    if (error) {
      if (isMissingForumTable(error)) return res.status(404).json({ message: "消息不存在。" });
      throw error;
    }
    if (!m) return res.status(404).json({ message: "消息不存在。" });

    const isSender = m.sender_email === me;
    const isRecipient = m.recipient_email === me;
    if (!isSender && !isRecipient) return res.status(403).json({ message: "无权操作这条消息。" });

    if (scope === "recall") {
      if (!isSender) return res.status(403).json({ message: "只能撤回自己发送的消息。" });
      const { error: dErr } = await supabase.from("forum_messages").delete().eq("id", m.id);
      if (dErr) throw dErr;
      const myUsername = await getUsername(me);
      sseSend(m.recipient_email, "message", { from: myUsername }); // 通知对方移除
      return res.json({ deleted: true, recalled: true });
    }

    // scope = "me"：仅从自己一侧隐藏；若两侧都已隐藏则彻底删除。
    const patch = {};
    if (isSender) patch.deleted_by_sender = true;
    if (isRecipient) patch.deleted_by_recipient = true;
    const bothHidden =
      (m.deleted_by_sender || patch.deleted_by_sender) && (m.deleted_by_recipient || patch.deleted_by_recipient);
    if (bothHidden) {
      const { error: dErr } = await supabase.from("forum_messages").delete().eq("id", m.id);
      if (dErr) throw dErr;
      return res.json({ deleted: true });
    }
    const { error: uErr } = await supabase.from("forum_messages").update(patch).eq("id", m.id);
    if (uErr) {
      if (isMissingColumn(uErr)) return res.status(409).json({ message: "请先在 Supabase 执行 messages 撤回/删除 迁移。", code: "MIGRATION_REQUIRED" });
      throw uErr;
    }
    return res.json({ deleted: true });
  } catch (error) {
    console.error("Delete message failed:", error.message);
    return res.status(500).json({ message: "操作失败，请稍后再试。" });
  }
});

// 「正在输入」信号：推给对方（仅普通账号）。
app.post("/api/messages/typing", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.json({ ok: false });
  const to = String(req.body?.to || "").trim();
  if (!to) return res.json({ ok: false });
  try {
    const peer = await getVisitorByUsername(to);
    if (!peer || peer.email === req.visitor.email) return res.json({ ok: false });
    const myUsername = await getUsername(req.visitor.email);
    if (myUsername) sseSend(peer.email, "typing", { from: myUsername });
    return res.json({ ok: true });
  } catch {
    return res.json({ ok: false });
  }
});

// 私信实时推送（SSE）。EventSource 不能带自定义头，令牌通过 ?token= 传入。
app.get("/api/stream", (req, res) => {
  const visitor = verifyVisitorToken(String(req.query.token || "").trim());
  if (!visitor) return res.status(401).end();
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  res.write(": connected\n\n");

  let set = sseClients.get(visitor.email);
  if (!set) { set = new Set(); sseClients.set(visitor.email, set); }
  set.add(res);

  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
  req.on("close", () => {
    clearInterval(ping);
    const s = sseClients.get(visitor.email);
    if (s) { s.delete(res); if (!s.size) sseClients.delete(visitor.email); }
  });
});

// ===== 宠物系统（5 个系列，领养时随机分配）=====
const PET_SPECIES = ["st", "esp", "linux", "arm", "sensor", "robotarm"];
const PET_MAX = 6;
const PET_ACTION_EXP = { feed: 8, play: 12, train: 20 };
// 稀有度 + 随机权重（稀有系列更难抽到）。
const PET_RARITY = { st: "common", esp: "common", sensor: "common", linux: "rare", arm: "rare", robotarm: "epic" };
const PET_WEIGHTS = { st: 28, esp: 28, sensor: 24, linux: 9, arm: 8, robotarm: 3 };
const FEED_COOLDOWN_MS = 30 * 60 * 1000; // 喂食冷却 30 分钟
const CHECKIN_REWARD = 30;               // 每日签到给每只宠物的经验
const MOOD_DECAY_PER_HOUR = 4;           // 心情每小时衰减
const MOOD_GAIN = { feed: 12, play: 15, train: 8, pet: 10 };

// 按距上次心情变化的时间衰减后的当前心情（0-100）。
function effectiveMood(p) {
  const base = p && typeof p.mood === "number" ? p.mood : 80;
  if (!p || !p.mood_at) return Math.max(0, Math.min(100, base));
  const hours = (Date.now() - new Date(p.mood_at).getTime()) / 3600000;
  return Math.max(0, Math.min(100, Math.round(base - hours * MOOD_DECAY_PER_HOUR)));
}

function weightedSpecies() {
  let total = 0;
  for (const s of PET_SPECIES) total += PET_WEIGHTS[s] || 1;
  let r = Math.random() * total;
  for (const s of PET_SPECIES) { r -= PET_WEIGHTS[s] || 1; if (r < 0) return s; }
  return PET_SPECIES[0];
}
function isMissingPetsTable(error) {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /\bpets\b|does not exist|could not find the table/i.test(`${error.message || ""} ${error.details || ""}`);
}
function petGrow(level, exp) {
  while (level < 99 && exp >= level * 100) { exp -= level * 100; level += 1; }
  if (level >= 99) { level = 99; exp = Math.min(exp, 99 * 100); }
  return { level, exp };
}
function serializePet(p) {
  return {
    id: p.id, species: p.species, name: p.name, level: p.level, exp: p.exp,
    need: p.level * 100, rarity: PET_RARITY[p.species] || "common",
    mood: effectiveMood(p), createdAt: p.created_at, lastFedAt: p.last_fed_at || null,
  };
}
// 今天是否已签到（按 UTC 日期比较）。
function isSameUtcDay(ts) {
  if (!ts) return false;
  return new Date(ts).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
}

// 我的宠物列表。
app.get("/api/pets", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.json({ pets: [] }); // 管理员无宠物
  try {
    const { data, error } = await supabase
      .from("pets").select("*").eq("owner_email", req.visitor.email).order("created_at", { ascending: true });
    if (error) {
      if (isMissingPetsTable(error)) return res.json({ pets: [], needsMigration: true });
      throw error;
    }
    let checkinDone = false;
    try {
      const { data: vrow } = await supabase.from("visitors").select("last_checkin_at").eq("email", req.visitor.email).maybeSingle();
      if (vrow) checkinDone = isSameUtcDay(vrow.last_checkin_at);
    } catch {}
    return res.json({ pets: (data || []).map(serializePet), checkinDone });
  } catch (error) {
    console.error("List pets failed:", error.message);
    return res.status(500).json({ message: "加载宠物失败，请稍后再试。" });
  }
});

// 领养：系列随机分配，用户只起名字。
app.post("/api/pets", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.status(403).json({ message: "请用账号登录后再领养。" });
  const name = String(req.body?.name || "").trim();
  if (name.length < 1 || name.length > 20) return res.status(400).json({ message: "宠物名字需为 1~20 字。" });
  try {
    const { count, error: cErr } = await supabase
      .from("pets").select("*", { count: "exact", head: true }).eq("owner_email", req.visitor.email);
    if (cErr) {
      if (isMissingPetsTable(cErr)) return res.status(409).json({ message: "宠物功能尚未初始化，请先在 Supabase 执行 pets 迁移。", code: "MIGRATION_REQUIRED" });
      throw cErr;
    }
    if ((count || 0) >= PET_MAX) return res.status(400).json({ message: `最多只能拥有 ${PET_MAX} 只宠物。` });

    const species = weightedSpecies();
    const { data, error } = await supabase
      .from("pets").insert({ owner_email: req.visitor.email, species, name }).select("*").single();
    if (error) {
      if (isMissingPetsTable(error)) return res.status(409).json({ message: "宠物功能尚未初始化，请先在 Supabase 执行 pets 迁移。", code: "MIGRATION_REQUIRED" });
      throw error;
    }
    return res.status(201).json(serializePet(data));
  } catch (error) {
    console.error("Adopt pet failed:", error.message);
    return res.status(500).json({ message: "领养失败，请稍后再试。" });
  }
});

// 互动：喂食 / 玩耍 / 训练 → 加经验、升级。
app.post("/api/pets/:id/action", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.status(403).json({ message: "请登录。" });
  const action = String(req.body?.action || "").trim();
  const gain = PET_ACTION_EXP[action];
  if (!gain) return res.status(400).json({ message: "未知操作。" });
  if (!hitWindow(forumWriteByEmail, `pet:${req.visitor.email}`, FORUM_WINDOW_MS, 600)) {
    return res.status(429).json({ message: "互动太频繁，让宠物歇会儿吧。" });
  }
  try {
    const { data: pet, error } = await supabase.from("pets").select("*").eq("id", req.params.id).maybeSingle();
    if (error) { if (isMissingPetsTable(error)) return res.status(404).json({ message: "宠物不存在。" }); throw error; }
    if (!pet || pet.owner_email !== req.visitor.email) return res.status(404).json({ message: "宠物不存在。" });

    // 喂食冷却。
    if (action === "feed" && pet.last_fed_at) {
      const elapsed = Date.now() - new Date(pet.last_fed_at).getTime();
      if (elapsed < FEED_COOLDOWN_MS) {
        const remainMin = Math.max(1, Math.ceil((FEED_COOLDOWN_MS - elapsed) / 60000));
        return res.status(429).json({ message: `宠物还不饿，约 ${remainMin} 分钟后再喂吧。`, code: "FEED_COOLDOWN" });
      }
    }

    const grown = petGrow(pet.level, pet.exp + gain);
    const patch = { level: grown.level, exp: grown.exp };
    if (action === "feed") patch.last_fed_at = new Date().toISOString();
    patch.mood = Math.max(0, Math.min(100, effectiveMood(pet) + (MOOD_GAIN[action] || 5)));
    patch.mood_at = new Date().toISOString();
    let { data, error: uErr } = await supabase.from("pets").update(patch).eq("id", pet.id).select("*").single();
    if (uErr && isMissingColumn(uErr)) { // mood 列未迁移时去掉再存
      const { mood, mood_at, ...base } = patch;
      ({ data, error: uErr } = await supabase.from("pets").update(base).eq("id", pet.id).select("*").single());
    }
    if (uErr) throw uErr;
    return res.json({ pet: serializePet(data), gained: gain, leveledUp: grown.level > pet.level });
  } catch (error) {
    console.error("Pet action failed:", error.message);
    return res.status(500).json({ message: "操作失败，请稍后再试。" });
  }
});

// 改名。
app.patch("/api/pets/:id", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.status(403).json({ message: "请登录。" });
  const name = String(req.body?.name || "").trim();
  if (name.length < 1 || name.length > 20) return res.status(400).json({ message: "宠物名字需为 1~20 字。" });
  try {
    const { data: pet, error } = await supabase.from("pets").select("owner_email").eq("id", req.params.id).maybeSingle();
    if (error) { if (isMissingPetsTable(error)) return res.status(404).json({ message: "宠物不存在。" }); throw error; }
    if (!pet || pet.owner_email !== req.visitor.email) return res.status(404).json({ message: "宠物不存在。" });
    const { data, error: uErr } = await supabase.from("pets").update({ name }).eq("id", req.params.id).select("*").single();
    if (uErr) throw uErr;
    return res.json(serializePet(data));
  } catch (error) {
    console.error("Rename pet failed:", error.message);
    return res.status(500).json({ message: "改名失败，请稍后再试。" });
  }
});

// 放生。
app.delete("/api/pets/:id", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.status(403).json({ message: "请登录。" });
  try {
    const { data: pet, error } = await supabase.from("pets").select("owner_email").eq("id", req.params.id).maybeSingle();
    if (error) { if (isMissingPetsTable(error)) return res.status(404).json({ message: "宠物不存在。" }); throw error; }
    if (!pet || pet.owner_email !== req.visitor.email) return res.status(404).json({ message: "宠物不存在。" });
    const { error: dErr } = await supabase.from("pets").delete().eq("id", req.params.id);
    if (dErr) throw dErr;
    return res.json({ released: true });
  } catch (error) {
    console.error("Release pet failed:", error.message);
    return res.status(500).json({ message: "操作失败，请稍后再试。" });
  }
});

// 每日签到：每天一次，给自己的每只宠物加经验。
app.post("/api/pets/checkin", requireVisitor, async (req, res) => {
  if (!req.visitor) return res.status(403).json({ message: "请登录。" });
  try {
    let { data: vrow, error: vErr } = await supabase
      .from("visitors").select("last_checkin_at").eq("email", req.visitor.email).maybeSingle();
    if (vErr) {
      if (isMissingColumn(vErr)) return res.status(409).json({ message: "请先在 Supabase 执行 visitors.last_checkin_at 迁移。", code: "MIGRATION_REQUIRED" });
      throw vErr;
    }
    if (vrow && isSameUtcDay(vrow.last_checkin_at)) {
      return res.status(409).json({ message: "今天已经签到过啦，明天再来～", code: "ALREADY" });
    }
    const { error: uErr } = await supabase.from("visitors").update({ last_checkin_at: new Date().toISOString() }).eq("email", req.visitor.email);
    if (uErr) {
      if (isMissingColumn(uErr)) return res.status(409).json({ message: "请先在 Supabase 执行 visitors.last_checkin_at 迁移。", code: "MIGRATION_REQUIRED" });
      throw uErr;
    }
    // 给每只宠物加经验。
    let pets = [];
    const { data: petRows, error: pErr } = await supabase.from("pets").select("*").eq("owner_email", req.visitor.email);
    if (pErr && !isMissingPetsTable(pErr)) throw pErr;
    for (const p of petRows || []) {
      const grown = petGrow(p.level, p.exp + CHECKIN_REWARD);
      const { data: np } = await supabase.from("pets").update({ level: grown.level, exp: grown.exp }).eq("id", p.id).select("*").single();
      if (np) pets.push(serializePet(np));
    }
    return res.json({ checkedIn: true, reward: CHECKIN_REWARD, pets });
  } catch (error) {
    console.error("Checkin failed:", error.message);
    return res.status(500).json({ message: "签到失败，请稍后再试。" });
  }
});

// 在帖子下回复（讨论）。
app.post("/api/forum/posts/:id/replies", requireVisitor, async (req, res) => {
  const actor = await getForumActor(req);
  if (!actor) return res.status(401).json({ message: "需要登录。" });
  if (!actor.username) {
    return res.status(403).json({ message: "请先设置用户名后再回复。", code: "USERNAME_REQUIRED" });
  }
  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ message: "请填写回复内容。" });
  if (content.length > 5000) return res.status(400).json({ message: "回复过长（上限 5000 字）。" });

  const key = actor.email || "admin";
  if (!hitWindow(forumWriteByEmail, `reply:${key}`, FORUM_WINDOW_MS, FORUM_REPLY_MAX)) {
    return res.status(429).json({ message: "回复过于频繁，请稍后再试。" });
  }

  try {
    const { data: post, error: pErr } = await supabase
      .from("forum_posts")
      .select("id, author_email, status")
      .eq("id", req.params.id)
      .maybeSingle();
    if (pErr) {
      if (isMissingForumTable(pErr)) return res.status(404).json({ message: "帖子不存在。" });
      if (!isMissingColumn(pErr)) throw pErr;
    }
    if (!post) return res.status(404).json({ message: "帖子不存在。" });
    // 草稿不可被他人回复。
    const ownerOnly = post.status === "draft" && !(actor.isAdmin || (actor.email && post.author_email === actor.email));
    if (ownerOnly) return res.status(404).json({ message: "帖子不存在。" });

    const { data, error } = await supabase
      .from("forum_replies")
      .insert({ post_id: post.id, author_email: actor.email, author_username: actor.username, content })
      .select("id, author_username, content, created_at")
      .single();
    if (error) throw error;
    return res.status(201).json({
      id: data.id,
      authorUsername: data.author_username,
      content: data.content,
      createdAt: data.created_at,
      canDelete: true,
    });
  } catch (error) {
    console.error("Create reply failed:", error.message);
    return res.status(500).json({ message: "回复失败，请稍后再试。" });
  }
});

// 点赞 / 取消点赞（切换）。每个账号对每帖只算一次；登录即可（无需用户名）。
app.post("/api/forum/posts/:id/like", requireVisitor, async (req, res) => {
  const actor = await getForumActor(req);
  if (!actor) return res.status(401).json({ message: "需要登录。" });

  const key = actor.key;
  if (!hitWindow(forumWriteByEmail, `like:${key}`, FORUM_WINDOW_MS, 300)) {
    return res.status(429).json({ message: "操作过于频繁，请稍后再试。" });
  }

  try {
    const { data: post, error: pErr } = await supabase
      .from("forum_posts")
      .select("id, author_email, status")
      .eq("id", req.params.id)
      .maybeSingle();
    if (pErr) {
      if (isMissingForumTable(pErr)) return res.status(404).json({ message: "帖子不存在。" });
      if (!isMissingColumn(pErr)) throw pErr;
    }
    if (!post) return res.status(404).json({ message: "帖子不存在。" });
    // 草稿不可被他人点赞。
    if (post.status === "draft" && !(actor.isAdmin || (actor.email && post.author_email === actor.email))) {
      return res.status(404).json({ message: "帖子不存在。" });
    }

    // 已点过赞则取消，否则新增（toggle）。
    const { data: existing, error: exErr } = await supabase
      .from("forum_post_likes")
      .select("user_key")
      .eq("post_id", post.id)
      .eq("user_key", key)
      .maybeSingle();
    if (exErr) {
      if (isMissingForumTable(exErr)) {
        return res.status(409).json({ message: "论坛功能尚未初始化，请先在 Supabase 执行 forum 迁移。", code: "MIGRATION_REQUIRED" });
      }
      throw exErr;
    }

    let liked;
    if (existing) {
      const { error } = await supabase
        .from("forum_post_likes")
        .delete()
        .eq("post_id", post.id)
        .eq("user_key", key);
      if (error) throw error;
      liked = false;
    } else {
      const { error } = await supabase
        .from("forum_post_likes")
        .insert({ post_id: post.id, user_key: key });
      // 并发下可能已被插入（主键冲突），按「已点赞」处理即可。
      if (error && error.code !== "23505") throw error;
      liked = true;
    }

    const { count, error: cErr } = await supabase
      .from("forum_post_likes")
      .select("*", { count: "exact", head: true })
      .eq("post_id", post.id);
    if (cErr) throw cErr;

    return res.json({ liked, likeCount: count || 0 });
  } catch (error) {
    console.error("Toggle like failed:", error.message);
    return res.status(500).json({ message: "操作失败，请稍后再试。" });
  }
});

// 删除帖子（作者本人或管理员）。回复随之级联删除。
app.delete("/api/forum/posts/:id", requireVisitor, async (req, res) => {
  const actor = await getForumActor(req);
  if (!actor) return res.status(401).json({ message: "需要登录。" });
  try {
    const { data: post, error } = await supabase
      .from("forum_posts")
      .select("author_email")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) {
      if (isMissingForumTable(error)) return res.status(404).json({ message: "帖子不存在。" });
      throw error;
    }
    if (!post) return res.status(404).json({ message: "帖子不存在。" });
    if (!actor.isAdmin && !(actor.email && post.author_email === actor.email)) {
      return res.status(403).json({ message: "只能删除自己的帖子。" });
    }
    const { error: delErr } = await supabase.from("forum_posts").delete().eq("id", req.params.id);
    if (delErr) throw delErr;
    return res.json({ deleted: true });
  } catch (error) {
    console.error("Delete forum post failed:", error.message);
    return res.status(500).json({ message: "删除失败，请稍后再试。" });
  }
});

// 删除回复（作者本人或管理员）。
app.delete("/api/forum/replies/:id", requireVisitor, async (req, res) => {
  const actor = await getForumActor(req);
  if (!actor) return res.status(401).json({ message: "需要登录。" });
  try {
    const { data: reply, error } = await supabase
      .from("forum_replies")
      .select("author_email")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) {
      if (isMissingForumTable(error)) return res.status(404).json({ message: "回复不存在。" });
      throw error;
    }
    if (!reply) return res.status(404).json({ message: "回复不存在。" });
    if (!actor.isAdmin && !(actor.email && reply.author_email === actor.email)) {
      return res.status(403).json({ message: "只能删除自己的回复。" });
    }
    const { error: delErr } = await supabase.from("forum_replies").delete().eq("id", req.params.id);
    if (delErr) throw delErr;
    return res.json({ deleted: true });
  } catch (error) {
    console.error("Delete reply failed:", error.message);
    return res.status(500).json({ message: "删除失败，请稍后再试。" });
  }
});

app.get("/projects", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "projects.html"));
});

app.get("/contact", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "contact.html"));
});

app.get("/forum", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "forum.html"));
});

app.get("/space", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "space.html"));
});

app.get("/u/:username", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "user.html"));
});

app.get("/messages", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "messages.html"));
});

app.get("/pets", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "pets.html"));
});

app.get("/welcome", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "welcome.html"));
});

app.get("/project/:id", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "project-detail.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.get("/editor", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "editor.html"));
});

app.get("/admin-login", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin-login.html"));
});

app.get("/", async (req, res) => {
  try {
    await fs.access(ROOT_INDEX);
    return res.sendFile(ROOT_INDEX);
  } catch {
    return res.sendFile(PUBLIC_INDEX);
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ message: "Not found" });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const status = err.status || err.statusCode || 500;
  return res.status(status).json({ message: err.message || "Internal server error" });
});

Promise.allSettled([ensureVideoBucket(), ensureImageBucket()]).finally(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});
