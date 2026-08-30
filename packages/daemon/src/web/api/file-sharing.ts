import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
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
import { refusedSenderMessage } from "./chat.js";

/**
 * Notify a mind about a file-share event. Returns whether the mind has been (or will
 * reliably be) told: delivered now, or queued for a SLEEPING mind's wake flush. A
 * failed POST to an awake mind returns `false` — the pending event only replays on
 * the next wake or restart, which may be arbitrarily far off, so claiming "notified"
 * would recreate the silent-failure shape this fixes. The caller's response carries
 * the result as `notified` so the sender isn't told "File staged" with no hint the
 * recipient never learns of it (#723).
 */
async function notifyMind(mindName: string, message: string): Promise<boolean> {
  const entry = await findMind(mindName);
  if (!entry) return false;
  try {
    const { deliverEvent } = await import("../../lib/chat/system-events.js");
    const result = await deliverEvent(mindName, { type: "file-share", body: message });
    if (result.delivered) return true;
    if (result.id == null) return false;
    const { getSleepManagerIfReady } = await import("../../lib/daemon/sleep-manager.js");
    const { getBaseName } = await import("../../lib/mind/registry.js");
    return getSleepManagerIfReady()?.isSleeping(await getBaseName(mindName)) ?? false;
  } catch (err) {
    log.warn(`[file-sharing] notify mind ${mindName} failed`, log.errorData(err));
    return false;
  }
}

const app = new Hono<AuthEnv>()
  // Send a file to another mind
  .post(
    "/:name/files/send",
    requireSelf(),
    zValidator("json", z.object({ targetMind: z.string().min(1), filePath: z.string().min(1) })),
    async (c) => {
      const senderName = c.req.param("name");
      const senderEntry = await findMind(senderName);
      if (!senderEntry) return c.json({ error: "Sender mind not found" }, 404);

      const body = c.req.valid("json");

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
      const notified = await notifyMind(
        body.targetMind,
        `[file] ${senderName} sent ${filename} (${sizeStr}) — run: volute chat accept ${id}`,
      );

      return c.json({ status: "pending", id, notified }, 200);
    },
  )

  // List pending incoming files
  .get("/:name/files/pending", requireSelf(), async (c) => {
    const name = c.req.param("name");
    if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);
    return c.json(listPending(name));
  })

  // Accept a pending file
  .post(
    "/:name/files/accept",
    requireSelf(),
    zValidator("json", z.object({ id: z.string().min(1), dest: z.string().optional() })),
    async (c) => {
      const name = c.req.param("name");
      const entry = await findMind(name);
      if (!entry) return c.json({ error: "Mind not found" }, 404);

      const body = c.req.valid("json");

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
      const notified = await notifyMind(
        result.sender,
        `[file] ${name} accepted ${result.filename}`,
      );

      return c.json({ ok: true, destPath: result.destPath, notified });
    },
  )

  // Reject a pending file
  .post(
    "/:name/files/reject",
    requireSelf(),
    zValidator("json", z.object({ id: z.string().min(1) })),
    async (c) => {
      const name = c.req.param("name");
      if (!(await findMind(name))) return c.json({ error: "Mind not found" }, 404);

      const body = c.req.valid("json");

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
      const notified = await notifyMind(
        result.sender,
        `[file] ${name} rejected ${result.filename}`,
      );

      return c.json({ ok: true, notified });
    },
  )

  // Stage a file from an external sender (CLI user, not a mind).
  // requireSelf restricts staging into a mind's queue to that mind or an admin
  // (the CLI human-sender path uses the daemon admin token, which is allowed).
  .post(
    "/:name/files/stage",
    requireSelf(),
    zValidator(
      "json",
      z.object({
        // Optional: absent means "me". A caller that cannot name its own volute
        // identity (the CLI knows the OS user, not the volute one) must be able to
        // omit it rather than guess — guessing is what misattributed file offers.
        sender: z.string().min(1).optional(),
        filename: z.string().min(1),
        data: z.string().min(1),
      }),
    ),
    async (c) => {
      const receiverName = c.req.param("name");
      const receiverEntry = await findMind(receiverName);
      if (!receiverEntry) return c.json({ error: "Mind not found" }, 404);

      const body = c.req.valid("json");

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

      // Same rule as POST /api/v1/chat: a caller may only act as itself. This offer is
      // announced to the recipient as "[file] <sender> sent ...", so an unguarded field
      // here misattributes a file exactly the way an unguarded `sender` misattributed a
      // message (#500) — and the message path being guarded while this one wasn't is the
      // "one call site fixed, the other forgotten" shape the guard exists to close.
      const user = c.get("user");
      if (body.sender && user.id !== 0 && body.sender !== user.username) {
        return c.json({ error: refusedSenderMessage(body.sender, user.username) }, 403);
      }
      const senderName = user.id === 0 && body.sender ? body.sender : user.username;

      const sizeStr = formatFileSize(content.length);
      const { id } = stageFile(receiverName, senderName, body.filename, content, body.filename);

      // Notify receiver
      const notified = await notifyMind(
        receiverName,
        `[file] ${senderName} sent ${body.filename} (${sizeStr}) — run: volute chat accept ${id}`,
      );

      return c.json({ status: "pending", id, notified }, 200);
    },
  );

export default app;
