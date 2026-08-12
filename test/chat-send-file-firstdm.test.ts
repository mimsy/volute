import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { run } from "../packages/cli/src/commands/send.js";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { listPending } from "../packages/daemon/src/lib/chat/file-sharing.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  generateMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { clearMind } from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  getMessages,
  listConversationsForUser,
} from "../packages/daemon/src/lib/events/conversations.js";
import {
  addMind,
  mindDir,
  stateDir,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  conversations,
  messages,
  mindHistory,
  minds,
  turns,
  users,
} from "../packages/daemon/src/lib/schema.js";
import { invalidateMindUserCache } from "../packages/daemon/src/web/middleware/auth.js";

const SENDER = "fdm-atlas";
const RECEIVER = "fdm-lyra";
const DAEMON_TOKEN = "fdm-daemon-token";

const SAVED_ENV = { ...process.env };

async function cleanup() {
  revokeMindToken(SENDER);
  await clearMind(SENDER);
  const db = await getDb();
  const convs = await db.select().from(conversations).all();
  for (const c of convs) {
    await db.delete(messages).where(eq(messages.conversation_id, c.id));
  }
  await db.delete(conversations);
  for (const m of [SENDER, RECEIVER]) {
    await db.delete(mindHistory).where(eq(mindHistory.mind, m));
    await db.delete(turns).where(eq(turns.mind, m));
    await db.delete(users).where(eq(users.username, m));
    await db.delete(minds).where(eq(minds.name, m));
    rmSync(mindDir(m), { recursive: true, force: true });
    rmSync(stateDir(m), { recursive: true, force: true });
  }
  rmSync(resolve(voluteSystemDir(), "daemon.json"), { force: true });
  rmSync(resolve(voluteSystemDir(), "daemon-token"), { force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k];
  }
  Object.assign(process.env, SAVED_ENV);
}

/** Where the wrapped fetch handler injects a canned failure, if any. */
type FailMode = "send" | "create" | "stage" | "held";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Boot the real daemon HTTP app, register a sender + receiver mind with the
 * sender holding a home-directory file, and return the request-order log plus a
 * teardown. The daemon-side volute driver (invoked by channels/create) reaches
 * the daemon over HTTP, so daemon.json + the daemon-token file must exist.
 *
 * `fail` injects a canned failure at one step to exercise the ordering guard's
 * failure paths — the whole reason the reorder exists (#691).
 */
async function setup(fail?: FailMode) {
  if (!tryGetMindManager()) initMindManager();

  await addMind(SENDER, 14210);
  await addMind(RECEIVER, 14211);
  const atlas = await getOrCreateMindUser(SENDER);
  await getOrCreateMindUser(RECEIVER);
  invalidateMindUserCache(SENDER);

  const senderHome = resolve(mindDir(SENDER), "home");
  mkdirSync(senderHome, { recursive: true });
  writeFileSync(resolve(senderHome, "isobar-notes.txt"), "the crowded parts");
  // The receiver needs a home dir so GET /api/v1/minds/<receiver> (the --file target
  // check) resolves it as a real mind, exactly as a provisioned mind would.
  mkdirSync(resolve(mindDir(RECEIVER), "home"), { recursive: true });

  const { default: app } = await import("../packages/daemon/src/web/app.js");

  // Record the order the CLI hits the daemon (message-send vs file-stage) and
  // optionally short-circuit one step with a canned failure. Wrapping app.fetch
  // (rather than app.use) avoids mutating the shared singleton app.
  const requestLog: string[] = [];
  const fetchHandler = (req: Request, ...rest: unknown[]) => {
    const p = new URL(req.url).pathname;
    const isStage = p.includes("/files/send") || p.includes("/files/stage");
    const isChat = p === "/api/v1/chat";
    const isCreate = p.includes("/channels/create");
    if (isStage) requestLog.push("stage");
    if (isChat) requestLog.push("send");

    if (fail === "send" && isChat) return jsonResponse({ error: "Conversation not found" }, 404);
    if (fail === "create" && isCreate) {
      return jsonResponse({ error: "conversation create failed" }, 500);
    }
    if (fail === "stage" && isStage) return jsonResponse({ error: "disk full" }, 500);
    if (fail === "held" && isChat) {
      return jsonResponse({ ok: true, held: true, notice: "held: a peer just posted" }, 200);
    }
    return (app.fetch as (r: Request, ...a: unknown[]) => Response | Promise<Response>)(
      req,
      ...rest,
    );
  };

  const server = serve({ fetch: fetchHandler as typeof app.fetch, port: 0 });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  process.env.VOLUTE_DAEMON_TOKEN = DAEMON_TOKEN;
  writeFileSync(
    resolve(voluteSystemDir(), "daemon.json"),
    JSON.stringify({ hostname: "127.0.0.1", port }),
  );
  writeFileSync(resolve(voluteSystemDir(), "daemon-token"), DAEMON_TOKEN);

  const token = generateMindToken(SENDER);
  process.env.VOLUTE_MIND = SENDER;
  process.env.VOLUTE_MIND_TOKEN = token;
  process.env.VOLUTE_MIND_DIR = mindDir(SENDER);
  process.env.VOLUTE_DAEMON_PORT = String(port);
  process.env.VOLUTE_DAEMON_HOSTNAME = "127.0.0.1";

  return { atlasId: atlas.id, requestLog, close: () => server.close() };
}

interface CliResult {
  logs: string[];
  errors: string[];
  /** True when the command called process.exit (mocked to throw). */
  exited: boolean;
  /** The code passed to process.exit, when it exited. */
  exitCode?: number;
}

async function runCli(args: string[]): Promise<CliResult> {
  let exitCode: number | undefined;
  const exitMock = mock.method(process, "exit", (code?: number) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error(`process.exit(${code})`);
  });
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errors.push(a.join(" "));

  // A message-less send reads stdin; under the test runner stdin never reaches
  // EOF, so feed an already-ended stream (a spawned mind gets EOF immediately).
  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: Readable.from([]), configurable: true });

  let exited = false;
  try {
    await run(args);
  } catch {
    exited = true;
  } finally {
    console.log = origLog;
    console.error = origErr;
    exitMock.mock.restore();
    if (origStdin) Object.defineProperty(process, "stdin", origStdin);
  }
  return { logs, errors, exited, exitCode };
}

async function messageDelivered(atlasId: number, text: string): Promise<boolean> {
  const convs = await listConversationsForUser(atlasId);
  for (const conv of convs) {
    const msgs = await getMessages(conv.id);
    if (msgs.some((m) => JSON.stringify(m.content).includes(text))) return true;
  }
  return false;
}

const NOTES = "Sharing my isobar notes.";

describe("chat send --file to a first-time DM", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("stages the file AND delivers the message when no DM exists yet", async () => {
    const { atlasId, close } = await setup();
    try {
      const { logs, errors, exited } = await runCli([
        `@${RECEIVER}`,
        NOTES,
        "--file",
        "isobar-notes.txt",
      ]);
      assert.equal(exited, false, `CLI should not exit; stderr: ${errors.join(" | ")}`);
      assert.ok(
        logs.some((l) => l.includes("File staged")),
        `expected file to be staged, got: ${logs.join(" | ")}`,
      );
      assert.ok(
        await messageDelivered(atlasId, NOTES),
        `the accompanying message must be delivered; stderr: ${errors.join(" | ")}`,
      );
    } finally {
      close();
    }
  });

  it("sends the message before staging the file", async () => {
    const { requestLog, close } = await setup();
    try {
      await runCli([`@${RECEIVER}`, NOTES, "--file", "isobar-notes.txt"]);
      // Message send must be dispatched before the file is staged: otherwise a send
      // failure would strand the file offer with no accompanying message (#691).
      assert.deepEqual(
        requestLog,
        ["send", "stage"],
        `expected message send before file stage, got: ${JSON.stringify(requestLog)}`,
      );
      assert.equal(listPending(RECEIVER).length, 1, "file should be staged after the send");
    } finally {
      close();
    }
  });

  it("does not stage the file when the message send fails, and exits loudly", async () => {
    const { requestLog, close } = await setup("send");
    try {
      const { errors, exited, exitCode } = await runCli([
        `@${RECEIVER}`,
        NOTES,
        "--file",
        "isobar-notes.txt",
      ]);
      assert.equal(exited, true, "a failed send must abort the command");
      assert.equal(exitCode, 1, "a failed send must exit non-zero");
      assert.ok(
        errors.some((e) => e.includes("Conversation not found")),
        `the daemon error must reach stderr, got: ${errors.join(" | ")}`,
      );
      // The reorder's whole point: no file is staged when the message never posted.
      assert.ok(!requestLog.includes("stage"), `file must not be staged, got: ${requestLog}`);
      assert.equal(listPending(RECEIVER).length, 0, "no file should be pending");
    } finally {
      close();
    }
  });

  it("does not stage the file when the DM conversation cannot be created", async () => {
    const { requestLog, close } = await setup("create");
    try {
      const { exited, exitCode } = await runCli([
        `@${RECEIVER}`,
        NOTES,
        "--file",
        "isobar-notes.txt",
      ]);
      assert.equal(exited, true, "a failed create must abort the command");
      assert.equal(exitCode, 1);
      assert.ok(!requestLog.includes("stage"), `file must not be staged, got: ${requestLog}`);
      assert.equal(listPending(RECEIVER).length, 0, "no file should be pending");
    } finally {
      close();
    }
  });

  it("skips staging on a held send and tells the sender the file was not staged", async () => {
    const { requestLog, close } = await setup("held");
    try {
      const { logs, exited } = await runCli([`@${RECEIVER}`, NOTES, "--file", "isobar-notes.txt"]);
      assert.equal(exited, false, "a held send is not an error");
      assert.ok(!requestLog.includes("stage"), `file must not be staged, got: ${requestLog}`);
      assert.equal(listPending(RECEIVER).length, 0, "no file should be pending after a hold");
      assert.ok(
        logs.some((l) => l.includes("held: a peer just posted")),
        `the hold notice must be shown, got: ${logs.join(" | ")}`,
      );
      assert.ok(
        logs.some((l) => l.includes("was not staged") && l.includes("--file")),
        `the sender must be told the file was not staged, got: ${logs.join(" | ")}`,
      );
    } finally {
      close();
    }
  });

  it("reports the message was sent when staging fails after a delivered message", async () => {
    const { atlasId, close } = await setup("stage");
    try {
      const { errors, exited, exitCode } = await runCli([
        `@${RECEIVER}`,
        NOTES,
        "--file",
        "isobar-notes.txt",
      ]);
      assert.equal(exited, true, "a staging failure exits non-zero");
      assert.equal(exitCode, 1);
      // The message already went out — the error must say so (a blind retry dupes it).
      assert.ok(
        errors.some((e) => e.includes("message was delivered")),
        `staging error must note the message was delivered, got: ${errors.join(" | ")}`,
      );
      assert.ok(
        await messageDelivered(atlasId, NOTES),
        "the message must have been delivered before the staging failure",
      );
      assert.equal(listPending(RECEIVER).length, 0, "the failed file must not be pending");
    } finally {
      close();
    }
  });

  it("prints the send confirmation before a post-send staging failure under --wait", async () => {
    const { atlasId, close } = await setup("stage");
    try {
      const { logs, errors, exited } = await runCli([
        `@${RECEIVER}`,
        NOTES,
        "--file",
        "isobar-notes.txt",
        "--wait",
      ]);
      assert.equal(exited, true, "a staging failure exits even under --wait");
      // Under --wait the sent-confirmation is normally suppressed; with --file it must
      // still print, so a staging failure can't hide that the message went out (#691).
      assert.ok(
        logs.some((l) => l.includes("Message sent") || l.includes("[volute:outbound")),
        `the send confirmation must print before staging, got: ${logs.join(" | ")}`,
      );
      assert.ok(
        errors.some((e) => e.includes("message was delivered")),
        `staging error must note delivery, got: ${errors.join(" | ")}`,
      );
      assert.ok(await messageDelivered(atlasId, NOTES), "the message must have been delivered");
    } finally {
      close();
    }
  });

  it("rejects --file to a channel before sending anything", async () => {
    const { requestLog, close } = await setup();
    try {
      const { errors, exited, exitCode } = await runCli([
        "#some-channel",
        NOTES,
        "--file",
        "isobar-notes.txt",
      ]);
      assert.equal(exited, true, "a channel + --file must be rejected");
      assert.equal(exitCode, 1);
      assert.ok(
        errors.some((e) => e.includes("--file can only attach")),
        `expected the mind-DM-only constraint, got: ${errors.join(" | ")}`,
      );
      assert.deepEqual(requestLog, [], "nothing should be sent or staged");
      assert.equal(listPending(RECEIVER).length, 0);
    } finally {
      close();
    }
  });

  it("rejects --image and --file together without a message", async () => {
    const { requestLog, close } = await setup();
    try {
      const png = resolve(mindDir(SENDER), "home", "pic.png");
      writeFileSync(png, "extension is what loadImage checks");
      const { errors, exited } = await runCli([
        `@${RECEIVER}`,
        "--image",
        png,
        "--file",
        "isobar-notes.txt",
      ]);
      assert.equal(exited, true, "image + file without a message must be rejected");
      assert.ok(
        errors.some((e) => e.includes("image and a file")),
        `expected the image+file constraint, got: ${errors.join(" | ")}`,
      );
      assert.deepEqual(requestLog, [], "nothing should be sent or staged");
    } finally {
      close();
    }
  });

  it("stages directly for a bare --file with no message", async () => {
    const { requestLog, close } = await setup();
    try {
      const { logs, exited } = await runCli([`@${RECEIVER}`, "--file", "isobar-notes.txt"]);
      assert.equal(exited, false, `bare --file should not exit; got logs: ${logs.join(" | ")}`);
      // No message means no send — the file is staged directly, nothing to order.
      assert.deepEqual(
        requestLog,
        ["stage"],
        `expected stage only, got: ${JSON.stringify(requestLog)}`,
      );
      assert.equal(listPending(RECEIVER).length, 1, "the file should be staged");
    } finally {
      close();
    }
  });
});
