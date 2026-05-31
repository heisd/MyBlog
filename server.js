const express = require("express");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT) || 3000;
const VIDEO_BUCKET = process.env.SUPABASE_VIDEO_BUCKET || "project-videos";
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

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

const CONTACT_TO = process.env.CONTACT_TO || "2284610019@qq.com";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.qq.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const SMTP_SECURE = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === "true"
  : SMTP_PORT === 465;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const CONTACT_FROM = process.env.CONTACT_FROM || SMTP_USER;

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

let mailTransporter = null;
let mailTransporterFailed = false;

function getMailTransporter() {
  if (mailTransporter || mailTransporterFailed) {
    return mailTransporter;
  }

  if (!SMTP_USER || !SMTP_PASS) {
    mailTransporterFailed = true;
    return null;
  }

  try {
    const nodemailer = require("nodemailer");
    mailTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  } catch (error) {
    mailTransporterFailed = true;
    console.error("Failed to create mail transporter:", error.message);
  }

  return mailTransporter;
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) {
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

  if (!entry || now - entry.start > CONTACT_WINDOW_MS) {
    contactAttempts.set(key, { start: now, count: 1 });
    return next();
  }

  entry.count += 1;
  if (entry.count > CONTACT_MAX_MESSAGES) {
    return res.status(429).json({ message: "提交过于频繁，请稍后再试。" });
  }
  return next();
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
  };
}

function validateProjectInput(body) {
  const requiredFields = ["title", "summary", "content", "coverImage"];
  return requiredFields.filter((field) => !String(body[field] || "").trim());
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
  };

  return mimeMap[file.mimetype] || ".mp4";
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

  const transporter = getMailTransporter();
  if (!transporter) {
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

  try {
    await transporter.sendMail({
      from: CONTACT_FROM,
      to: CONTACT_TO,
      replyTo: email && isValidEmail(email) ? email : undefined,
      subject: `博客留言 - 来自 ${name}`,
      text: textBody,
    });

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

app.get("/api/projects", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("projects")
      .select("id, title, date, summary, coverImage, videoUrl")
      .order("date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    return res.json((data || []).map(toListItem));
  } catch (error) {
    return res.status(500).json({ message: "Failed to read projects", error: error.message });
  }
});

app.get("/api/projects/:id", async (req, res) => {
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
    };

    const { data, error } = await supabase
      .from("projects")
      .insert(project)
      .select("*")
      .single();

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
      date: req.body.date ? normalizeDate(req.body.date) : existing.date,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("projects")
      .update(updatedProject)
      .eq("id", req.params.id)
      .select("*")
      .single();

    if (error) {
      throw error;
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

ensureVideoBucket().finally(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});
