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

function hashCode(code) {
  return crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(`code:${code}`).digest("hex");
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// 内存状态：待验证验证码 + 各类限流计数 + 一次性表单令牌
const pendingCodes = new Map();
const codeReqByIp = new Map();
const codeReqByEmail = new Map();
const loginByKey = new Map();
const usedFormTokens = new Map();
const usedGrantTokens = new Map();
const assistantByEmail = new Map();
let globalCodeWindow = { start: Date.now(), count: 0 };

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_COOLDOWN_MS = 60 * 1000;
const CODE_MAX_ATTEMPTS = 6;
const CODE_IP_WINDOW_MS = 60 * 60 * 1000;
const CODE_IP_MAX = 8;
const CODE_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const CODE_EMAIL_MAX = 4;
const GLOBAL_CODE_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_CODE_MAX = 80;
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
  for (const [k, v] of pendingCodes) if (now > v.expires) pendingCodes.delete(k);
  for (const map of [codeReqByIp, codeReqByEmail, loginByKey]) {
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

// 是否为「已设密码」的真实注册用户。管理员手动添加的「待认领」会员（空密码占位）不算已注册，
// 以便本人后续用该邮箱注册、认领账号并设置密码（保留会员有效期）。
async function visitorIsRegistered(email) {
  const { data, error } = await supabase.from("visitors").select("password_hash").eq("email", email).maybeSingle();
  if (error) throw error;
  return Boolean(data && data.password_hash);
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
  return res.json({ authenticated: true, email: visitor.email, member: info.member, memberUntil: info.memberUntil });
});

app.post("/api/access/register/request-code", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!isValidEmail(email)) {
    return res.status(400).json({ message: "请输入有效的邮箱地址。" });
  }
  if (!emailConfigured()) {
    return res.status(503).json({ message: "邮件服务未配置，暂时无法发送验证码。" });
  }

  const ip = req.ip || "unknown";
  if (!hitWindow(codeReqByIp, ip, CODE_IP_WINDOW_MS, CODE_IP_MAX)) {
    return res.status(429).json({ message: "请求过于频繁，请稍后再试。" });
  }
  if (!hitWindow(codeReqByEmail, email, CODE_EMAIL_WINDOW_MS, CODE_EMAIL_MAX)) {
    return res.status(429).json({ message: "该邮箱验证码请求过多，请稍后再试。" });
  }

  const now = Date.now();
  if (now - globalCodeWindow.start > GLOBAL_CODE_WINDOW_MS) {
    globalCodeWindow = { start: now, count: 0 };
  }
  if (globalCodeWindow.count >= GLOBAL_CODE_MAX) {
    return res.status(429).json({ message: "系统繁忙，请稍后再试。" });
  }

  if (!(await verifyHuman(req))) {
    return res.status(400).json({ message: "人机验证未通过，请重试。" });
  }

  const existing = pendingCodes.get(email);
  if (existing && now - existing.lastSent < CODE_RESEND_COOLDOWN_MS) {
    return res.status(429).json({ message: "请稍后再请求验证码。" });
  }

  // 只拦截「已设密码」的真实注册用户；管理员手动添加的「待认领」账号（空密码占位）允许发码以便本人注册认领。
  let registered;
  try {
    registered = await visitorIsRegistered(email);
  } catch (error) {
    console.error("visitor lookup failed:", error.message);
    return res.status(500).json({ message: "服务异常，请稍后再试。" });
  }
  if (registered) {
    return res.status(409).json({ message: "该邮箱已注册，请直接登录。" });
  }

  const code = generateCode();
  pendingCodes.set(email, { codeHash: hashCode(code), expires: now + CODE_TTL_MS, attempts: 0, lastSent: now });
  globalCodeWindow.count += 1;

  try {
    await sendEmailMessage({
      to: email,
      subject: "你的注册验证码",
      text: `你正在注册 Heisd.Stark 博客的项目访问账号。\n\n验证码：${code}\n\n10 分钟内有效。如果不是你本人操作，请忽略本邮件。`,
    });
  } catch (error) {
    console.error("Failed to send access code:", error.message);
    pendingCodes.delete(email);
    return res.status(502).json({ message: "验证码发送失败，请稍后再试。" });
  }

  return res.json({ message: "验证码已发送，请查收邮箱。", cooldown: 60 });
});

app.post("/api/access/register", async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code || "").trim();
  const password = String(req.body?.password || "");

  if (!isValidEmail(email)) return res.status(400).json({ message: "邮箱格式不正确。" });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ message: "验证码格式不正确。" });
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ message: "密码长度需为 8~128 位。" });
  }

  const pending = pendingCodes.get(email);
  if (!pending || Date.now() > pending.expires) {
    return res.status(400).json({ message: "验证码不存在或已过期，请重新获取。" });
  }
  if (pending.attempts >= CODE_MAX_ATTEMPTS) {
    pendingCodes.delete(email);
    return res.status(429).json({ message: "尝试次数过多，请重新获取验证码。" });
  }
  pending.attempts += 1;
  if (!constantTimeEqual(hashCode(code), pending.codeHash)) {
    return res.status(400).json({ message: "验证码不正确。" });
  }

  try {
    // 可能存在「管理员手动添加的会员」：账号已建好但密码为空占位，此时允许本人注册认领并设置密码（保留会员有效期）。
    const { data: existing } = await supabase
      .from("visitors")
      .select("email, password_hash")
      .eq("email", email)
      .maybeSingle();
    if (existing) {
      if (existing.password_hash) {
        pendingCodes.delete(email);
        return res.status(409).json({ message: "该邮箱已注册，请直接登录。" });
      }
      const { error } = await supabase
        .from("visitors")
        .update({ password_hash: hashPassword(password) })
        .eq("email", email);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("visitors").insert({ email, password_hash: hashPassword(password) });
      if (error) throw error;
    }
  } catch (error) {
    console.error("Register failed:", error.message);
    return res.status(500).json({ message: "注册失败，请稍后再试。" });
  }

  pendingCodes.delete(email);
  return res.status(201).json({ token: createVisitorToken(email), email });
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

app.get("/projects", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "projects.html"));
});

app.get("/contact", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "contact.html"));
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
