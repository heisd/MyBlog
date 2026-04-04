const express = require("express");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

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

app.use((req, res, next) => {
  const blocked = ["/server.js", "/package.json", "/data", "/node_modules"];
  if (blocked.some((item) => req.path === item || req.path.startsWith(`${item}/`))) {
    return res.status(404).json({ message: "Not found" });
  }
  return next();
});

app.use(express.static(PUBLIC_DIR, { index: false }));
app.use(express.static(ROOT_DIR, { index: false }));

function formatDate(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
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

function toListItem(project) {
  return {
    id: project.id,
    title: project.title,
    date: project.date,
    summary: project.summary,
    coverImage: project.coverImage,
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

app.post("/api/auth/login", (req, res) => {
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

app.get("/api/projects", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("projects")
      .select("id, title, date, summary, coverImage")
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

    const project = {
      id: await ensureUniqueProjectId(req.body.title),
      title: req.body.title.trim(),
      date: req.body.date ? formatDate(req.body.date) : formatDate(),
      summary: req.body.summary.trim(),
      content: req.body.content.trim(),
      coverImage: req.body.coverImage.trim(),
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
      date: req.body.date ? formatDate(req.body.date) : existing.date,
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
