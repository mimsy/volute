import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { findMind, mindDir } from "@volute/shared/registry";
import { Hono } from "hono";
import {
  acceptPending,
  addTrust,
  deliverFile,
  formatFileSize,
  isTrustedSender,
  listPending,
  readFileSharingConfig,
  rejectPending,
  removeTrust,
  stageFile,
  validateFilePath,
} from "../../lib/file-sharing.js";
import type { AuthEnv } from "../middleware/auth.js";

async function notifyMind(port: number, message: string, channel: string, sender: string) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: [{ type: "text", text: message }],
        channel,
        sender,
      }),
    });
    if (!res.ok) {
      console.warn(`[file-sharing] notify mind on port ${port} failed: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[file-sharing] notify mind on port ${port} failed:`, err);
  }
}

const app = new Hono<AuthEnv>()
  // Send a file to another mind
  .post("/:name/files/send", async (c) => {
    const senderName = c.req.param("name");
    const senderEntry = findMind(senderName);
    if (!senderEntry) return c.json({ error: "Sender mind not found" }, 404);

    const body = (await c.req.json()) as { targetMind?: string; filePath?: string };
    if (!body.targetMind || !body.filePath) {
      return c.json({ error: "targetMind and filePath are required" }, 400);
    }

    const receiverEntry = findMind(body.targetMind);
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
    } catch {
      return c.json({ error: `File not found: ${body.filePath}` }, 404);
    }

    const receiverDir = mindDir(body.targetMind);
    const filename = body.filePath;
    const sizeStr = formatFileSize(content.length);

    if (isTrustedSender(receiverDir, senderName)) {
      // Trusted: deliver directly
      const config = readFileSharingConfig(receiverDir);
      const destPath = deliverFile(receiverDir, senderName, filename, content, config.inboxPath);

      // Notify receiver
      if (receiverEntry.running) {
        await notifyMind(
          receiverEntry.port,
          `[file] ${senderName} sent ${filename} (${sizeStr}) → ${destPath}`,
          "system:file-sharing",
          senderName,
        );
      }

      return c.json({ status: "delivered", destPath }, 200);
    }

    // Untrusted: stage for approval
    const { id } = stageFile(body.targetMind, senderName, filename, content, body.filePath);

    // Notify receiver
    if (receiverEntry.running) {
      await notifyMind(
        receiverEntry.port,
        `[file] ${senderName} wants to send ${filename} (${sizeStr}) — run: volute file accept ${id}`,
        "system:file-sharing",
        senderName,
      );
    }

    return c.json({ status: "pending", id }, 200);
  })

  // List pending incoming files
  .get("/:name/files/pending", (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);
    return c.json(listPending(name));
  })

  // Accept a pending file
  .post("/:name/files/accept", async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = (await c.req.json()) as { id?: string };
    if (!body.id) return c.json({ error: "id is required" }, 400);

    let result: { sender: string; filename: string; destPath: string };
    try {
      result = acceptPending(name, body.id, mindDir(name));
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes("not found") || message.includes("Invalid pending")) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: `Failed to accept file: ${message}` }, 500);
    }

    // Notify sender that file was accepted
    const senderEntry = findMind(result.sender);
    if (senderEntry?.running) {
      await notifyMind(
        senderEntry.port,
        `[file] ${name} accepted ${result.filename}`,
        "system:file-sharing",
        name,
      );
    }

    return c.json({ ok: true, destPath: result.destPath });
  })

  // Reject a pending file
  .post("/:name/files/reject", async (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);

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
    const senderEntry = findMind(result.sender);
    if (senderEntry?.running) {
      await notifyMind(
        senderEntry.port,
        `[file] ${name} rejected ${result.filename}`,
        "system:file-sharing",
        name,
      );
    }

    return c.json({ ok: true });
  })

  // Add a trusted sender
  .post("/:name/files/trust", async (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);

    const body = (await c.req.json()) as { sender?: string };
    if (!body.sender) return c.json({ error: "sender is required" }, 400);

    addTrust(mindDir(name), body.sender);
    return c.json({ ok: true });
  })

  // Remove a trusted sender
  .delete("/:name/files/trust/:sender", (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.json({ error: "Mind not found" }, 404);

    const sender = c.req.param("sender");
    removeTrust(mindDir(name), sender);
    return c.json({ ok: true });
  });

export default app;
