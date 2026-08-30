import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, it, mock } from "node:test";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { run as sendCli } from "../packages/cli/src/commands/send.js";
import {
  createUser,
  getOrCreateMindUser,
  getOrCreateSystemUser,
} from "../packages/daemon/src/lib/auth.js";
import { listPending } from "../packages/daemon/src/lib/chat/file-sharing.js";
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
import {
  addParticipant,
  createChannel,
  createConversation,
  getMessages,
} from "../packages/daemon/src/lib/events/conversations.js";
import {
  addMind,
  addSpirit,
  mindDir,
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

const MIND = "imp-atlas";
const OTHER = "imp-lyra";
const HOST = "imp-host";
const CHANNEL = "imp-commons";
const DAEMON_TOKEN = "imp-daemon-token";

const SAVED_ENV = { ...process.env };

async function cleanup() {
  for (const m of [MIND, OTHER]) {
    revokeMindToken(m);
    await clearMind(m);
  }
  const db = await getDb();
  const convs = await db.select().from(conversations).all();
  for (const c of convs) await db.delete(messages).where(eq(messages.conversation_id, c.id));
  await db.delete(channels);
  await db.delete(conversations);
  for (const m of [MIND, OTHER]) {
    await db.delete(mindHistory).where(eq(mindHistory.mind, m));
    await db.delete(turns).where(eq(turns.mind, m));
    await db.delete(minds).where(eq(minds.name, m));
  }
  for (const u of [MIND, OTHER, HOST]) {
    await db.delete(users).where(eq(users.username, u));
  }
  rmSync(resolve(voluteSystemDir(), "daemon.json"), { force: true });
  rmSync(resolve(voluteSystemDir(), "cli-session.json"), { force: true });
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k];
  }
  Object.assign(process.env, SAVED_ENV);
}

type Fixture = {
  app: { request: typeof fetch };
  dmId: string;
  channelId: string;
  mindToken: string;
  hostSession: string;
};

/** A mind, a second mind, a host admin, and a DM + channel all three share. */
async function setup(): Promise<Fixture> {
  if (!tryGetMindManager()) initMindManager();
  process.env.VOLUTE_DAEMON_TOKEN = DAEMON_TOKEN;

  await addMind(MIND, 14410);
  await addMind(OTHER, 14411);
  const atlas = await getOrCreateMindUser(MIND);
  const lyra = await getOrCreateMindUser(OTHER);
  const host = await createUser(HOST, "pw");
  const db = await getDb();
  await db.update(users).set({ role: "admin" }).where(eq(users.id, host.id));
  invalidateMindUserCache(MIND);
  invalidateMindUserCache(OTHER);

  // GET /api/v1/minds/:name 404s on a missing directory, and the --file validation
  // resolves its target through it.
  mkdirSync(resolve(mindDir(MIND), "home"), { recursive: true });

  const dm = await createConversation({ participantIds: [host.id, atlas.id] });
  const channel = await createChannel(CHANNEL, atlas.id);
  await addParticipant(channel.id, host.id);
  await addParticipant(channel.id, lyra.id);

  const { default: app } = await import("../packages/daemon/src/web/app.js");
  return {
    app: app as never,
    dmId: dm.id,
    channelId: channel.id,
    mindToken: generateMindToken(MIND),
    hostSession: await createSession(host.id),
  };
}

function post(f: Fixture, token: string, path: string, body: unknown) {
  return f.app.request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "http://localhost",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  } as RequestInit);
}

/**
 * Drive the real `chat send` CLI over HTTP against the in-process daemon, either as a
 * mind (mind token + VOLUTE_MIND) or as a host (CLI session, no VOLUTE_MIND).
 */
async function runSendCli(
  f: Fixture,
  who: { asMind: boolean; withExportedMindEnv?: boolean },
  args: string[],
): Promise<{ exitCode?: number; logs: string[]; errors: string[] }> {
  const { default: app } = await import("../packages/daemon/src/web/app.js");
  const server = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  // The CLI reads its identity from process.env, which is process-global — snapshot it
  // so one subtest's "become a host" can't leak into another's "become a mind".
  const envBefore = { ...process.env };
  writeFileSync(
    resolve(voluteSystemDir(), "daemon.json"),
    JSON.stringify({ hostname: "127.0.0.1", port }),
  );
  process.env.VOLUTE_DAEMON_PORT = String(port);
  process.env.VOLUTE_DAEMON_HOSTNAME = "127.0.0.1";
  if (who.asMind) {
    process.env.VOLUTE_MIND = MIND;
    process.env.VOLUTE_MIND_TOKEN = f.mindToken;
  } else {
    for (const k of ["VOLUTE_MIND", "VOLUTE_MIND_TOKEN", "VOLUTE_MIND_DIR"]) delete process.env[k];
    // A host who ran `export VOLUTE_MIND=<mind>` for the mind-scoped commands
    // (`volute clock`, `volute skill`) and never unset it. No mind token: they are
    // still authenticating, and speaking, as themselves.
    if (who.withExportedMindEnv) process.env.VOLUTE_MIND = MIND;
    process.env.VOLUTE_USER_HOME = voluteSystemDir();
    writeFileSync(
      resolve(voluteSystemDir(), "cli-session.json"),
      JSON.stringify({ sessionId: f.hostSession, username: HOST }),
    );
  }

  let exitCode: number | undefined;
  const exitMock = mock.method(process, "exit", (code?: number) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error("exit");
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
    await sendCli(args);
  } catch {
    // the exit mock throws
  } finally {
    console.log = origLog;
    console.error = origErr;
    exitMock.mock.restore();
    if (origStdin) Object.defineProperty(process, "stdin", origStdin);
    server.close();
    for (const k of Object.keys(process.env)) {
      if (!(k in envBefore)) delete process.env[k];
    }
    Object.assign(process.env, envBefore);
  }
  return { exitCode, logs, errors };
}

/**
 * `--sender` was accepted and silently discarded for every caller that isn't the
 * daemon itself, so a message asked for under one name went out under another and
 * nobody was told (#500). It is now refused outright — the authz is unchanged, only
 * the silence is gone.
 */
describe("sending as someone else", { concurrency: 1 }, () => {
  afterEach(cleanup);

  it("refuses a host posting to a channel as a mind, and posts nothing", async () => {
    const f = await setup();
    const res = await post(f, f.hostSession, "/api/v1/chat", {
      conversationId: f.channelId,
      message: "not in my name",
      sender: MIND,
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}`);

    const msgs = await getMessages(f.channelId);
    assert.equal(msgs.length, 0, "a refused send must leave nothing behind");
  });

  it("refuses the same thing in a DM — there was never a DM/channel difference", async () => {
    const f = await setup();
    const res = await post(f, f.hostSession, "/api/v1/chat", {
      conversationId: f.dmId,
      message: "not in my name",
      sender: MIND,
    });
    assert.equal(res.status, 403);
    assert.equal((await getMessages(f.dmId)).length, 0);
  });

  it("says nothing was sent, and suggests only a remedy that works", async () => {
    const f = await setup();
    const res = await post(f, f.hostSession, "/api/v1/chat", {
      conversationId: f.dmId,
      message: "x",
      sender: MIND,
    });
    const { error } = (await res.json()) as { error: string };

    assert.match(error, /Nothing was sent/, error);
    assert.match(error, new RegExp(`authenticated as "${HOST}"`), error);
    // The only instruction is to drop the flag, which is runnable from any shell.
    // Suggesting "run as <them>" would be advice the caller cannot act on.
    assert.ok(!/run (it |the command )?as/i.test(error), `unrunnable advice: ${error}`);
  });

  // The CLI sends `sender` on every message, so this is the path that must not break.
  it("still lets a mind send under its own name", async () => {
    const f = await setup();
    const res = await post(f, f.mindToken, "/api/v1/chat", {
      conversationId: f.channelId,
      message: "hello from me",
      sender: MIND,
    });
    assert.equal(res.status, 200, `a mind's own name is not impersonation: ${await res.text()}`);

    const msgs = await getMessages(f.channelId);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].sender_name, MIND);
  });

  it("still lets a mind send with no sender field at all", async () => {
    const f = await setup();
    const res = await post(f, f.mindToken, "/api/v1/chat", {
      conversationId: f.channelId,
      message: "no sender field",
    });
    assert.equal(res.status, 200);
    assert.equal((await getMessages(f.channelId))[0]?.sender_name, MIND);
  });

  // bridge-outbound writes inbound platform traffic under the platform user's name.
  // That is the one legitimate use of the override and it must survive.
  it("still honours the override for the daemon's own token", async () => {
    const f = await setup();
    const res = await post(f, DAEMON_TOKEN, "/api/v1/chat", {
      conversationId: f.channelId,
      message: "relayed from discord",
      sender: "someone-on-discord",
    });
    assert.equal(res.status, 200, await res.text());
    assert.equal((await getMessages(f.channelId))[0]?.sender_name, "someone-on-discord");
  });

  // The second dead path: channels/create mapped `sender` onto VOLUTE_SENDER, which
  // no driver's createConversation reads. Same silent wrong attribution, so same refusal.
  it("refuses an impersonated sender on channels/create too", async () => {
    const f = await setup();
    const res = await post(f, f.hostSession, `/api/v1/minds/${MIND}/channels/create`, {
      platform: "volute",
      participants: [OTHER],
      sender: OTHER,
    });
    assert.equal(res.status, 403, `expected 403, got ${res.status}: ${await res.text()}`);
  });

  // The refusal is only a fix if the person who typed --sender actually reads it.
  it("shows the refusal to a mind at its terminal, and sends nothing", async () => {
    const f = await setup();
    const r = await runSendCli(f, { asMind: true }, [
      `#${CHANNEL}`,
      "in someone else's name",
      "--sender",
      OTHER,
    ]);

    assert.equal(r.exitCode, 1, "a refused send must exit non-zero");
    const out = r.errors.join("\n");
    assert.match(out, /Refused to send as/, `the refusal must reach the terminal, got: ${out}`);
    assert.match(out, /Nothing was sent/, out);
    assert.equal((await getMessages(f.channelId)).length, 0, "nothing should have been posted");
  });

  // Regression: the CLI used to default the wire `sender` to the OS username, which
  // says nothing about who authenticated to Volute. Sending it made every host whose
  // OS name differs from their Volute name look like an impersonation attempt — the
  // guard would have refused their every message, --sender or not. The OS guess is
  // gone; absent an explicit --sender, the daemon attributes the authenticated user.
  it("lets a host send with no --sender even when their OS name differs", async () => {
    const f = await setup();
    assert.notEqual(userInfo().username, HOST, "fixture assumes the OS user isn't the volute user");

    const r = await runSendCli(f, { asMind: false }, [`#${CHANNEL}`, "posted by a host"]);

    assert.equal(r.exitCode, undefined, `should not exit; errors: ${r.errors.join(" | ")}`);
    const msgs = await getMessages(f.channelId);
    assert.equal(msgs.length, 1, "the host's message should have been posted");
    assert.equal(msgs[0].sender_name, HOST, "attributed to the volute user, not the OS user");
  });

  // The spirit authenticates with a mind token but resolves to the shared system user.
  // If that user's name ever drifted from its VOLUTE_MIND, the guard would 403 the
  // system's own voice on every message — so pin the identity rather than reason about it.
  it("still lets the spirit send under its own name", async () => {
    const f = await setup();
    const spiritName = getSpiritName();
    const systemUser = await getOrCreateSystemUser();
    await addSpirit(spiritName, 14412, "claude", "/tmp/volute-imp-spirit");
    invalidateMindUserCache(spiritName);
    await addParticipant(f.channelId, systemUser.id);

    const res = await post(f, generateMindToken(spiritName), "/api/v1/chat", {
      conversationId: f.channelId,
      message: "the spirit speaks",
      sender: spiritName,
    });
    assert.equal(res.status, 200, `the spirit's own name must not be refused: ${await res.text()}`);
    assert.equal((await getMessages(f.channelId))[0]?.sender_name, spiritName);

    revokeMindToken(spiritName);
    const db = await getDb();
    await db.delete(minds).where(eq(minds.name, spiritName));
  });

  // The file path returns before any /api/v1/chat call, so guarding only the message
  // path left `--sender` working here: `chat send @x --file notes.txt --sender lyra`
  // announced the offer to the recipient as "[file] lyra sent notes.txt".
  it("refuses an impersonated sender on a bare --file too", async () => {
    const f = await setup();
    const filePath = resolve(voluteSystemDir(), "imp-notes.txt");
    writeFileSync(filePath, "the crowded parts");

    const r = await runSendCli(f, { asMind: false }, [
      `@${MIND}`,
      "--file",
      filePath,
      "--sender",
      OTHER,
    ]);

    assert.equal(r.exitCode, 1, `a refused stage must exit non-zero; logs: ${r.logs.join(" | ")}`);
    assert.match(r.errors.join("\n"), /Refused to send as/, r.errors.join("\n"));
    assert.equal(listPending(MIND).length, 0, "nothing should have been staged");
  });

  // `VOLUTE_MIND` is a documented host-side convenience for mind-scoped commands, and
  // `readDaemonConfig()` only switches to the mind token when `VOLUTE_MIND_TOKEN` is set
  // too. Treating the bare env var as an identity claim would 403 such a host on every
  // message — with a refusal telling them to drop a flag they never typed.
  it("lets a host who exported VOLUTE_MIND send as themselves", async () => {
    const f = await setup();
    const r = await runSendCli(f, { asMind: false, withExportedMindEnv: true }, [
      `#${CHANNEL}`,
      "still me",
    ]);

    assert.equal(r.exitCode, undefined, `should not exit; errors: ${r.errors.join(" | ")}`);
    const msgs = await getMessages(f.channelId);
    assert.equal(msgs.length, 1, "the host's message should have been posted");
    assert.equal(msgs[0].sender_name, HOST, "attributed to the host, not the exported mind");
  });

  it("still lets channels/create through under the caller's own name", async () => {
    const f = await setup();
    const res = await post(f, f.mindToken, `/api/v1/minds/${MIND}/channels/create`, {
      platform: "volute",
      participants: [OTHER],
      sender: MIND,
    });
    // Creation itself needs a live daemon to call back into (the volute driver goes
    // over HTTP), which this in-process app has no listener for. What matters here is
    // that the guard let the caller past: not a 403, and no sender refusal.
    assert.notEqual(res.status, 403, "a caller's own name must not be refused");
    const body = await res.text();
    assert.ok(!body.includes("Refused to send as"), `sender guard fired wrongly: ${body}`);
  });
});
