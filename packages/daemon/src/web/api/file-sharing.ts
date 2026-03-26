import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import {
  acceptPending,
  formatFileSize,
  listPending,
  rejectPending,
  stageFile,
  validateFilePath,
} from "../../lib/chat/file-sharing.js";
import { findMind, mindDir } from "../../lib/mind/registry.js";
import log from "../../lib/util/logger.js";
import { type AuthEnv, requireSelf } from "../middleware/auth.js";

async function notifyMind(mindName: string, message: string) {
  const entry = await findMind(mindName);
  if (!entry) return;
  try {
    const { sendSystemMessage } = await import("../../lib/chat/system-chat.js");
    await sendSystemMessage(mindName, message);
  } catch (err) {
    log.warn(`[file-sharing] notify mind ${mindName} failed`, log.errorData(err));
  }
}

const app = new Hono<AuthEnv>()
  // Send a file to another mind
  .post("/:name/files/send", requireSelf(), async (c) => {
    const senderName = c.req.param("name");
    const senderEntry = await findMind(senderName);
    if (!senderEntry) return c.json({ error: "Sender mind not found" }, 404);

    const body = (await c.req.json()) as { targetMind?: string; filePath?: string };
    if (!body.targetMind || !body.filePath) {
      return c.json({ error: "targetMind and filePath are required" }, 400);
    }

    const receiverEntry = await findMind(body.targetMind);
    if (!receiverEntry) return c.json({ error: "Target mind not found" }, 404);

    const pathErr = validateFilePath(body.filePath);
    if (pathErr) return c.json({ error: pathErr }, 400);

    // Read file from sender's home directory
    const senderDir = mindDir(senderName);
    const filePath = resolve(senderDir, "home", body.filePath);

    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    const stat = statSync(filePath, { throwIfNoEntry: false });
    if (!stat) return c.json({ error: `File not found: ${body.filePath}` }, 404);
    if (stat.size > MAX_FILE_SIZE) {
      return c.json(
        {
          error: `File too large (${formatFileSize(stat.size)}, max ${formatFileSize(MAX_FILE_SIZE)})`,
        },
        413,
      );
    }

    let content: Buffer;
    try {
      content = readFileSync(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return c.json({ error: `File not found: ${body.filePath}` }, 404);
      }
      return c.json({ error: `Failed to read file: ${code ?? (err as Error).message}` }, 500);
    }

    const filename = body.filePath;
    const sizeStr = formatFileSize(content.length);

    // Always stage for approval
    const { id } = stageFile(body.targetMind, senderName, filename, content, body.filePath);

    // Notify receiver
    await notifyMind(
      body.targetMind,
      `[file] ${senderName} sent ${filename} (${sizeStr}) — run: volute chat accept ${id}`,
    );

    return c.json({ status: "pending", id }, 200);
  })

  // List pending incoming files
  .get("/:name/files/pending", async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);
    return c.json(listPending(name));
  })

  // Accept a pending file
  .post("/:name/files/accept", async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = (await c.req.json()) as { id?: string; dest?: string };
    if (!body.id) return c.json({ error: "id is required" }, 400);

    if (body.dest) {
      const destErr = validateFilePath(body.dest);
      if (destErr) return c.json({ error: `Invalid dest: ${destErr}` }, 400);
    }

    let result: { sender: string; filename: string; destPath: string };
    try {
      result = acceptPending(name, body.id, mindDir(name), body.dest);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("not found") || message.includes("Invalid pending")) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: `Failed to accept file: ${message}` }, 500);
    }

    // Notify sender that file was accepted
    await notifyMind(result.sender, `[file] ${name} accepted ${result.filename}`);

    return c.json({ ok: true, destPath: result.destPath });
  })

  // Reject a pending file
  .post("/:name/files/reject", async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);

    const body = (await c.req.json()) as { id?: string };
    if (!body.id) return c.json({ error: "id is required" }, 400);

    let result: { sender: string; filename: string };
    try {
      result = rejectPending(name, body.id);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("not found") || message.includes("Invalid pending")) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: `Failed to reject file: ${message}` }, 500);
    }

    // Notify sender that file was rejected
    await notifyMind(result.sender, `[file] ${name} rejected ${result.filename}`);

    return c.json({ ok: true });
  })

  // Stage a file from an external sender (CLI user, not a mind)
  .post("/:name/files/stage", async (c) => {
    const receiverName = c.req.param("name");
    const receiverEntry = await findMind(receiverName);
    if (!receiverEntry) return c.json({ error: "Mind not found" }, 404);

    const body = (await c.req.json()) as {
      sender?: string;
      filename?: string;
      data?: string;
    };
    if (!body.sender || !body.filename || !body.data) {
      return c.json({ error: "sender, filename, and data are required" }, 400);
    }

    const pathErr = validateFilePath(body.filename);
    if (pathErr) return c.json({ error: pathErr }, 400);

    const content = Buffer.from(body.data, "base64");
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    if (content.length > MAX_FILE_SIZE) {
      return c.json(
        {
          error: `File too large (${formatFileSize(content.length)}, max ${formatFileSize(MAX_FILE_SIZE)})`,
        },
        413,
      );
    }

    const sizeStr = formatFileSize(content.length);
    const { id } = stageFile(receiverName, body.sender, body.filename, content, body.filename);

    // Notify receiver
    await notifyMind(
      receiverName,
      `[file] ${body.sender} sent ${body.filename} (${sizeStr}) — run: volute chat accept ${id}`,
    );

    return c.json({ status: "pending", id }, 200);
  });

export default app;
