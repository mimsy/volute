import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, it, mock } from "node:test";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { run } from "../packages/cli/src/commands/send.js";
import { createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
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
  addParticipant,
  createChannel,
  getMessages,
} from "../packages/daemon/src/lib/events/conversations.js";
import {
  addMind,
  mindDir,
  stateDir,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  channels,
  conversations,
  messages,
  mindHistory,
  minds,
  turns,
  users,
} from "../packages/daemon/src/lib/schema.js";
import {
  createSession,
  invalidateMindUserCache,
} from "../packages/daemon/src/web/middleware/auth.js";

const SENDER = "wait-atlas";
const HUMAN = "wait-jules";
const CHANNEL = "wait-tideline";
const ADMIN = "wait-host";
const DAEMON_TOKEN = "wait-daemon-token";

const SAVED_ENV = { ...process.env };

async function cleanup() {
  revokeMindToken(SENDER);
  await clearMind(SENDER);
  const db = await getDb();
  const convs = await db.select().from(conversations).all();
  for (const c of convs) {
    await db.delete(messages).where(eq(messages.conversation_id, c.id));
  }
  await db.delete(channels);
  await db.delete(conversations);
  await db.delete(mindHistory).where(eq(mindHistory.mind, SENDER));
  await db.delete(turns).where(eq(turns.mind, SENDER));
  for (const u of [SENDER, HUMAN, ADMIN]) {
    await db.delete(users).where(eq(users.username, u));
  }
  await db.delete(minds).where(eq(minds.name, SENDER));
  rmSync(mindDir(SENDER), { recursive: true, force: true });
  rmSync(stateDir(SENDER), { recursive: true, force: true });
  rmSync(resolve(voluteSystemDir(), "daemon.json"), { force: true });
  rmSync(resolve(voluteSystemDir(), "daemon-token"), { force: true });
  rmSync(resolve(voluteSystemDir(), "cli-session.json"), { force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k];
  }
  Object.assign(process.env, SAVED_ENV);
}

/**
 * Boot the real daemon app with a sending mind, a human user, and a channel both
 * belong to. The CLI then talks to it over HTTP exactly as a mind's shell would.
 */
async function setup() {
  if (!tryGetMindManager()) initMindManager();

  await addMind(SENDER, 14310);
  const atlas = await getOrCreateMindUser(SENDER);
  const jules = await createUser(HUMAN, "pw");
  invalidateMindUserCache(SENDER);

  mkdirSync(resolve(mindDir(SENDER), "home"), { recursive: true });

  // A channel the sending mind belongs to, so the CLI's channel lookup resolves a
  // mind participant to use as the request's context mind.
  const channel = await createChannel(CHANNEL, atlas.id);
  await addParticipant(channel.id, jules.id);

  const { default: app } = await import("../packages/daemon/src/web/app.js");
  const server = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  process.env.VOLUTE_DAEMON_TOKEN = DAEMON_TOKEN;
  writeFileSync(
    resolve(voluteSystemDir(), "daemon.json"),
    JSON.stringify({ hostname: "127.0.0.1", port }),
  );
  // The daemon-side volute driver (invoked by channels/create) calls back over
  // HTTP and reads its own token from disk.
  writeFileSync(resolve(voluteSystemDir(), "daemon-token"), DAEMON_TOKEN);

  const token = generateMindToken(SENDER);
  process.env.VOLUTE_MIND = SENDER;
  process.env.VOLUTE_MIND_TOKEN = token;
  process.env.VOLUTE_MIND_DIR = mindDir(SENDER);
  process.env.VOLUTE_DAEMON_PORT = String(port);
  process.env.VOLUTE_DAEMON_HOSTNAME = "127.0.0.1";

  return { channelId: channel.id, close: () => server.close() };
}

/**
 * Re-point the CLI at the daemon as a *host* would reach it: an admin with a
 * logged-in CLI session and no VOLUTE_MIND. `setup()` must have run first.
 */
async function becomeHost(channelId: string): Promise<void> {
  const admin = await createUser(ADMIN, "pw");
  // createUser only auto-admins the *first* human; the channel's human member was
  // created before this one, so promote explicitly or the session lands as
  // "pending" and every request 403s.
  const db = await getDb();
  await db.update(users).set({ role: "admin" }).where(eq(users.id, admin.id));
  // A host posting to a channel is a member of it; /api/v1/chat 404s a non-participant.
  await addParticipant(channelId, admin.id);
  const sessionId = await createSession(admin.id);
  for (const k of ["VOLUTE_MIND", "VOLUTE_MIND_TOKEN", "VOLUTE_MIND_DIR"]) delete process.env[k];
  process.env.VOLUTE_USER_HOME = voluteSystemDir();
  writeFileSync(
    resolve(voluteSystemDir(), "cli-session.json"),
    JSON.stringify({ sessionId, username: ADMIN }),
  );
}

interface CliResult {
  logs: string[];
  errors: string[];
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

  const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: Readable.from([]), configurable: true });

  try {
    await run(args);
  } catch {
    // the exit mock throws
  } finally {
    console.log = origLog;
    console.error = origErr;
    exitMock.mock.restore();
    if (origStdin) Object.defineProperty(process, "stdin", origStdin);
  }
  return { logs, errors, exitCode };
}

/**
 * --wait on a target that will never reply. The send itself succeeds; the old
 * behavior exited 1 with "--wait is only supported when sending to a mind",
 * which a mind reading the exit code reads as "my message failed" (#500).
 */
// Serialized: each test stands up its own daemon and the shared afterEach clears
// every conversation, so concurrent subtests would wipe each other's fixtures.
describe("chat send --wait on a target with no reply to follow", { concurrency: 1 }, () => {
  afterEach(cleanup);

  it("exits 0 on a channel post and says the message went out", async () => {
    const { channelId, close } = await setup();
    try {
      const r = await runCli([`#${CHANNEL}`, "the tide is in", "--wait"]);

      assert.equal(r.exitCode, undefined, `should not call process.exit, got ${r.exitCode}`);
      const out = r.logs.join("\n");
      assert.match(out, /Nothing to wait for/, `expected a plain note, got:\n${out}`);
      assert.match(out, /channel post has no single reply/, out);
      assert.ok(
        !r.errors.some((e) => e.includes("only supported when sending to a mind")),
        `should not report the send as an error, got: ${r.errors.join(" | ")}`,
      );

      const msgs = await getMessages(channelId);
      assert.ok(
        msgs.some((m) => JSON.stringify(m.content).includes("the tide is in")),
        "the channel post should have been persisted",
      );
    } finally {
      close();
    }
  });

  it("exits 0 on a DM to a human and confirms the send", async () => {
    const { close } = await setup();
    try {
      const r = await runCli([`@${HUMAN}`, "are you about?", "--wait"]);

      assert.equal(r.exitCode, undefined, `should not call process.exit, got ${r.exitCode}`);
      const out = r.logs.join("\n");
      // The confirmation must print here: no reply follows to stand in for it.
      // In a mind's compact output that confirmation is the outbound marker.
      assert.match(out, /\[volute:outbound:\d+\]/, `expected the send confirmation, got:\n${out}`);
      assert.match(out, /Nothing to wait for/, out);
      assert.match(out, new RegExp(`@${HUMAN} isn't a mind`), out);

      const db = await getDb();
      const rows = await db.select().from(messages).all();
      assert.ok(
        rows.some((m) => m.content.includes("are you about?")),
        "the DM should have been persisted",
      );
    } finally {
      close();
    }
  });

  // `chat read` resolves its mind from --mind or VOLUTE_MIND. A host has neither,
  // so a bare suggestion would exit 1 the moment they copied it.
  it("offers a runnable chat read command to a host with no VOLUTE_MIND", async () => {
    const { channelId, close } = await setup();
    try {
      await becomeHost(channelId);
      const r = await runCli([`#${CHANNEL}`, "posted by a host", "--wait"]);

      const out = r.logs.join("\n");
      assert.equal(
        r.exitCode,
        undefined,
        `should not exit; logs:\n${out}\nerrors:\n${r.errors.join("\n")}`,
      );
      assert.match(out, /Nothing to wait for/, out);
      assert.match(
        out,
        new RegExp(`volute chat read "#${CHANNEL}" --mind ${SENDER}`),
        `the suggested command must name a mind for a host to run it, got:\n${out}`,
      );
    } finally {
      close();
    }
  });
});
