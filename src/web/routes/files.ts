import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { agentDir, findAgent } from "../../lib/registry.js";

const ALLOWED_FILES = new Set([
  "SOUL.md",
  "MEMORY.md",
  "IDENTITY.md",
  "USER.md",
  "CLAUDE.md",
  "MOLT.md",
]);

const saveFileSchema = z.object({ content: z.string() });

const app = new Hono();

// List markdown files in home/
app.get("/:name/files", async (c) => {
  const name = c.req.param("name");
  const entry = findAgent(name);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  const dir = agentDir(name);
  const homeDir = resolve(dir, "home");
  if (!existsSync(homeDir)) return c.json({ error: "Home directory missing" }, 404);

  const allFiles = await readdir(homeDir);
  const files = allFiles.filter((f) => f.endsWith(".md") && ALLOWED_FILES.has(f));

  return c.json(files);
});

// Read a file
app.get("/:name/files/:filename", async (c) => {
  const name = c.req.param("name");
  const filename = c.req.param("filename");

  if (!ALLOWED_FILES.has(filename)) {
    return c.json({ error: "File not allowed" }, 403);
  }

  const entry = findAgent(name);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  const dir = agentDir(name);
  const filePath = resolve(dir, "home", filename);

  if (!existsSync(filePath)) {
    return c.json({ error: "File not found" }, 404);
  }

  const content = await readFile(filePath, "utf-8");
  return c.json({ filename, content });
});

// Write a file
app.put("/:name/files/:filename", zValidator("json", saveFileSchema), async (c) => {
  const name = c.req.param("name");
  const filename = c.req.param("filename");

  if (!ALLOWED_FILES.has(filename)) {
    return c.json({ error: "File not allowed" }, 403);
  }

  const entry = findAgent(name);
  if (!entry) return c.json({ error: "Agent not found" }, 404);

  const dir = agentDir(name);
  const filePath = resolve(dir, "home", filename);

  const { content } = c.req.valid("json");
  await writeFile(filePath, content);

  return c.json({ ok: true });
});

export default app;
