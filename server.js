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
  const payload = {
    username: ADMIN_USERNAME,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
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
    if (payload.username !== ADMIN_USERNAME || Number(payload.exp) < Date.now()) {
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

async function visitorExists(email) {
  const { data, error } = await supabase.from("visitors").select("email").eq("email", email).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

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

app.get("/api/access/verify", (req, res) => {
  const visitor = verifyVisitorToken((req.get("x-access-token") || "").trim());
  if (!visitor) return res.status(401).json({ authenticated: false });
  return res.json({ authenticated: true, email: visitor.email });
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

  let exists;
  try {
    exists = await visitorExists(email);
  } catch (error) {
    console.error("visitorExists failed:", error.message);
    return res.status(500).json({ message: "服务异常，请稍后再试。" });
  }
  if (exists) {
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
    if (await visitorExists(email)) {
      pendingCodes.delete(email);
      return res.status(409).json({ message: "该邮箱已注册，请直接登录。" });
    }
    const { error } = await supabase.from("visitors").insert({ email, password_hash: hashPassword(password) });
    if (error) throw error;
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

    return res.json((data || []).map(toListItem));
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

    return res.json(data);
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
