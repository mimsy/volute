import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, it, mock } from "node:test";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { run } from "../packages/cli/src/commands/send.js";
import { createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { getSpiritName } from "../packages/daemon/src/lib/config/setup.js";
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
import { getParticipants } from "../packages/daemon/src/lib/events/conversations.js";
import {
  addMind,
  addSpirit,
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
import {
  createSession,
  invalidateMindUserCache,
} from "../packages/daemon/src/web/middleware/auth.js";

// A host DMing from the CLI has no mind of its own to hang the conversation on (#1000).
// It used to borrow the *recipient's* name as context and call the mind-scoped
// channels/create route: a human recipient came back "Mind not found", and a mind
// recipient 403'd every host who wasn't an admin.

const MIND = "hostdm-atlas";
const HUMAN = "hostdm-jules";
const HOST = "hostdm-host";
const EXTERNAL = "hostdm-faraway";
const DAEMON_TOKEN = "hostdm-daemon-token";

const SAVED_ENV = { ...process.env };

async function cleanup() {
  revokeMindToken(MIND);
  await clearMind(MIND);
  const db = await getDb();
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(mindHistory).where(eq(mindHistory.mind, MIND));
  await db.delete(turns).where(eq(turns.mind, MIND));
  for (const u of [MIND, HUMAN, HOST, EXTERNAL]) {
    await db.delete(users).where(eq(users.username, u));
  }
  await db.delete(minds).where(eq(minds.name, MIND));
  rmSync(mindDir(MIND), { recursive: true, force: true });
  rmSync(stateDir(MIND), { recursive: true, force: true });
  rmSync(resolve(voluteSystemDir(), "daemon.json"), { force: true });
  rmSync(resolve(voluteSystemDir(), "daemon-token"), { force: true });
  rmSync(resolve(voluteSystemDir(), "cli-session.json"), { force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k];
  }
  Object.assign(process.env, SAVED_ENV);
}

/** Boot the real daemon app with a mind and a human; the CLI talks to it over HTTP. */
async function setup() {
  if (!tryGetMindManager()) initMindManager();

  await addMind(MIND, 14320);
  await getOrCreateMindUser(MIND);
  await createUser(HUMAN, "pw");
  invalidateMindUserCache(MIND);
  mkdirSync(resolve(mindDir(MIND), "home"), { recursive: true });

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
  for (const k of ["VOLUTE_MIND", "VOLUTE_MIND_TOKEN", "VOLUTE_MIND_DIR"]) delete process.env[k];

  return { port, close: () => server.close() };
}

/** Point the CLI at the daemon as an ordinary (non-admin) host with a CLI session. */
async function becomeHost(): Promise<void> {
  const host = await createUser(HOST, "pw");
  // createUser only auto-admins the first human; pin the role so this is explicitly
  // a plain user rather than a "pending" one that 403s everywhere.
  const db = await getDb();
  await db.update(users).set({ role: "user" }).where(eq(users.id, host.id));
  const sessionId = await createSession(host.id);
  process.env.VOLUTE_USER_HOME = voluteSystemDir();
  writeFileSync(
    resolve(voluteSystemDir(), "cli-session.json"),
    JSON.stringify({ sessionId, username: HOST }),
  );
}

function becomeMind(port: number): void {
  process.env.VOLUTE_MIND = MIND;
  process.env.VOLUTE_MIND_TOKEN = generateMindToken(MIND);
  process.env.VOLUTE_MIND_DIR = mindDir(MIND);
  process.env.VOLUTE_DAEMON_PORT = String(port);
  process.env.VOLUTE_DAEMON_HOSTNAME = "127.0.0.1";
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

async function allMessages() {
  const db = await getDb();
  return db.select().from(messages).all();
}

/** Assert a host's DM to `target` went out, in a reused two-party DM, under the host's name. */
async function assertHostDm(target: string, text: string): Promise<void> {
  const r = await runCli([`@${target}`, text]);
  assert.equal(
    r.exitCode,
    undefined,
    `should not exit; errors:\n${r.errors.join("\n")}\nlogs:\n${r.logs.join("\n")}`,
  );
  const sent = (await allMessages()).find((m) => m.content.includes(text));
  assert.ok(sent, "the DM should have been persisted");
  assert.equal(sent.sender_name, HOST);
  const participants = await getParticipants(sent.conversation_id);
  assert.deepEqual(participants.map((p) => p.username).sort(), [HOST, target].sort());

  // A second send reuses the same DM rather than opening another.
  await runCli([`@${target}`, `${text} again`]);
  const again = (await allMessages()).find((m) => m.content.includes(`${text} again`));
  assert.equal(again?.conversation_id, sent.conversation_id);
}

// Serialized: each test stands up its own daemon and cleanup clears every conversation.
describe("chat send @target from a host", { concurrency: 1 }, () => {
  afterEach(cleanup);

  it("refuses a DM to a human plainly, without claiming a mind was missing", async () => {
    const { close } = await setup();
    try {
      await becomeHost();
      const r = await runCli([`@${HUMAN}`, "hello"]);

      assert.equal(r.exitCode, 1);
      const err = r.errors.join("\n");
      assert.doesNotMatch(err, /Mind not found/, err);
      assert.match(err, /Direct messages between people aren't supported yet/, err);
      assert.match(err, /Nothing was sent/, err);
      assert.equal((await allMessages()).length, 0, "nothing should have been persisted");
      const db = await getDb();
      assert.equal((await db.select().from(conversations).all()).length, 0);
    } finally {
      close();
    }
  });

  it("DMs a mind as a non-admin host", async () => {
    const { close } = await setup();
    try {
      await becomeHost();
      await assertHostDm(MIND, "hello mind");
    } finally {
      close();
    }
  });

  // The spirit's users row is user_type "spirit", not "mind" — the one principal every
  // host talks to must still count as the mind a DM needs.
  it("DMs the spirit", async () => {
    const { close } = await setup();
    const spirit = getSpiritName();
    try {
      await addSpirit(spirit, 14321, "claude", mindDir(spirit));
      await getOrCreateMindUser(spirit);
      invalidateMindUserCache(spirit);
      await becomeHost();
      await assertHostDm(spirit, "hello spirit");
    } finally {
      close();
      const db = await getDb();
      await db.delete(minds).where(eq(minds.name, spirit));
    }
  });

  // A mind user with no local registry row: the CLI's isMind() can't see it, so only
  // the server can say whether it may be DMed.
  it("DMs an external mind", async () => {
    const { close } = await setup();
    try {
      await getOrCreateMindUser(EXTERNAL);
      await becomeHost();
      await assertHostDm(EXTERNAL, "hello from afar");
    } finally {
      close();
    }
  });

  // VOLUTE_MIND alone is a host-side convenience, not an identity (#500). A host who
  // exported it must still DM as themselves — not be told the mind is "yourself".
  it("DMs as the host even with VOLUTE_MIND exported", async () => {
    const { close } = await setup();
    try {
      await becomeHost();
      process.env.VOLUTE_MIND = MIND;
      await assertHostDm(MIND, "hello with env");
    } finally {
      close();
    }
  });
});

describe("chat send @human from a mind", { concurrency: 1 }, () => {
  afterEach(cleanup);

  it("still DMs the human in the mind's own context", async () => {
    const { port, close } = await setup();
    try {
      becomeMind(port);
      const r = await runCli([`@${HUMAN}`, "hello human"]);

      assert.equal(r.exitCode, undefined, `should not exit; errors:\n${r.errors.join("\n")}`);
      const sent = (await allMessages()).find((m) => m.content.includes("hello human"));
      assert.ok(sent, "the DM should have been persisted");
      assert.equal(sent.sender_name, MIND);
      const participants = await getParticipants(sent.conversation_id);
      assert.deepEqual(participants.map((p) => p.username).sort(), [HUMAN, MIND].sort());
    } finally {
      close();
    }
  });
});
