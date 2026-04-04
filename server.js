const express = require("express");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");

const app = express();
const PORT = 3000;
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");
const ROOT_INDEX = path.join(ROOT_DIR, "index.html");
const PUBLIC_INDEX = path.join(PUBLIC_DIR, "index.html");

app.use(cors());
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

async function ensureProjectsFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(PROJECTS_FILE);
  } catch {
    await fs.writeFile(PROJECTS_FILE, "[]", "utf8");
  }
}

async function readProjects() {
  await ensureProjectsFile();
  const raw = await fs.readFile(PROJECTS_FILE, "utf8");
  const parsed = JSON.parse(raw || "[]");
  return Array.isArray(parsed) ? parsed : [];
}

async function writeProjects(projects) {
  await fs.writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2), "utf8");
}

function formatDate(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

function toListItem(project) {
  return {
    id: project.id,
    title: project.title,
    date: project.date,
    summary: project.summary,
    coverImage: project.coverImage
  };
}

function validateProjectInput(body) {
  const requiredFields = ["title", "summary", "content", "coverImage"];
  const missing = requiredFields.filter((field) => !String(body[field] || "").trim());
  return missing;
}

app.get("/api/projects", async (req, res) => {
  try {
    const projects = await readProjects();
    res.json(projects.map(toListItem));
  } catch (error) {
    res.status(500).json({ message: "Failed to read projects", error: error.message });
  }
});

app.get("/api/projects/:id", async (req, res) => {
  try {
    const projects = await readProjects();
    const project = projects.find((item) => item.id === req.params.id);
    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }
    return res.json(project);
  } catch (error) {
    return res.status(500).json({ message: "Failed to read project", error: error.message });
  }
});

app.post("/api/projects", async (req, res) => {
  try {
    const missing = validateProjectInput(req.body);
    if (missing.length) {
      return res.status(400).json({ message: `Missing fields: ${missing.join(", ")}` });
    }

    const projects = await readProjects();
    const project = {
      id: `project-${Date.now()}`,
      title: req.body.title.trim(),
      date: formatDate(),
      summary: req.body.summary.trim(),
      content: req.body.content.trim(),
      coverImage: req.body.coverImage.trim()
    };

    projects.unshift(project);
    await writeProjects(projects);
    return res.status(201).json(project);
  } catch (error) {
    return res.status(500).json({ message: "Failed to create project", error: error.message });
  }
});

app.put("/api/projects/:id", async (req, res) => {
  try {
    const missing = validateProjectInput(req.body);
    if (missing.length) {
      return res.status(400).json({ message: `Missing fields: ${missing.join(", ")}` });
    }

    const projects = await readProjects();
    const index = projects.findIndex((item) => item.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ message: "Project not found" });
    }

    const updated = {
      ...projects[index],
      title: req.body.title.trim(),
      summary: req.body.summary.trim(),
      content: req.body.content.trim(),
      coverImage: req.body.coverImage.trim(),
      date: req.body.date ? formatDate(req.body.date) : projects[index].date
    };

    projects[index] = updated;
    await writeProjects(projects);
    return res.json(updated);
  } catch (error) {
    return res.status(500).json({ message: "Failed to update project", error: error.message });
  }
});

app.delete("/api/projects/:id", async (req, res) => {
  try {
    const projects = await readProjects();
    const index = projects.findIndex((item) => item.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ message: "Project not found" });
    }

    const [deleted] = projects.splice(index, 1);
    await writeProjects(projects);
    return res.json({ message: "Project deleted", project: deleted });
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

app.get("/", async (req, res) => {
  try {
    await fs.access(ROOT_INDEX);
    return res.sendFile(ROOT_INDEX);
  } catch {
    return res.sendFile(PUBLIC_INDEX);
  }
});

ensureProjectsFile()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize project storage:", error);
    process.exit(1);
  });
