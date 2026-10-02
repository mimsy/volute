import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve as resolvePath } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeTemplate } from "../packages/daemon/src/lib/template/template.js";

/**
 * The claude template's `done` names the turn it ends and covers every delivery the turn
 * finished — its driver and each message the SDK folded into it — so the daemon can tell a
 * folded turn from one still owed a `done` (#1207). Drives the real composed stream
 * consumer against a capture server standing in for the daemon.
 */

type Captured = { type: string; session?: string; messageId?: string; covers?: string[] };

let composedDir: string;
let server: Server;
let captured: Captured[] = [];
const requested: string[] = [];
type Consumer = typeof import("../templates/claude/src/lib/stream-consumer.js");
let consumeStream: Consumer["consumeStream"];
let resetUuidEchoes: Consumer["resetUuidEchoes"];
let nextQueued: Consumer["nextQueued"];

before(async () => {
  const templatesRoot = resolvePath(fileURLToPath(import.meta.url), "../../templates");
  composedDir = composeTemplate(templatesRoot, "claude").composedDir;
  await new Promise<void>((r) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        requested.push(req.url ?? "");
        if (req.url?.endsWith("/events")) captured.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", r);
  });
  process.env.VOLUTE_DAEMON_PORT = String((server.address() as { port: number }).port);
  process.env.VOLUTE_MIND = "covers-mind";
  ({ consumeStream, resetUuidEchoes, nextQueued } = await import(
    resolvePath(composedDir, "src/lib/stream-consumer.js")
  ));
});

// Each test starts with a CLI not yet known to echo uuids, as an older one wouldn't; one
// that echoes shows it by stamping a frame or listing a result.
beforeEach(() => resetUuidEchoes());

after(() => {
  server?.close();
  if (composedDir) rmSync(composedDir, { recursive: true, force: true });
  delete process.env.VOLUTE_DAEMON_PORT;
  delete process.env.VOLUTE_MIND;
});

async function dones(n: number): Promise<Captured[]> {
  const deadline = Date.now() + 2000;
  while (captured.filter((e) => e.type === "done").length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return captured.filter((e) => e.type === "done");
}

/** A top-level frame; `answers` is the uuid a turn's first frame names (`user_message_uuid`). */
const assistant = (text: string, answers?: string) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { usage: {}, content: [{ type: "text", text }] },
  ...(answers !== undefined && { user_message_uuid: answers }),
});
const result = () => ({ type: "result", subtype: "success", usage: {} });

describe("claude template: a done covers the deliveries its turn finished", () => {
  it("a folded turn's done covers its driver and the folded message; a queued one waits", async () => {
    captured = [];
    const session = {
      name: "main",
      messageIds: [{ id: "d1", seq: 1 }] as { id: string | undefined; seq: number }[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    async function* stream() {
      yield assistant("working on d1");
      session.messageIds.push({ id: "d2", seq: 2 }); // arrives mid-run: the SDK folds it
      yield result();
      session.messageIds.push({ id: "d3", seq: 3 });
      yield assistant("working on d3");
      yield result();
    }
    await consumeStream(stream() as never, session, {
      broadcast: () => {},
      ack: () => {},
    });
    const [first, second] = await dones(2);
    assert.equal(first.messageId, "d1");
    assert.deepEqual(first.covers, ["d1", "d2"]);
    assert.equal(second.messageId, "d3");
    assert.deepEqual(second.covers, ["d3"]);
  });

  it("without the SDK's consumed list, a message queued before the turn started is not covered", async () => {
    captured = [];
    const session = {
      name: "queued",
      messageIds: [
        { id: "d1", seq: 1 },
        { id: "d2", seq: 2 },
      ] as { id: string | undefined; seq: number }[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    async function* stream() {
      yield assistant("working on d1");
      yield result();
    }
    await consumeStream(stream() as never, session, { broadcast: () => {}, ack: () => {} });
    const [done] = await dones(1);
    assert.deepEqual(done.covers, ["d1"]);
    assert.deepEqual(
      session.messageIds.map((e) => e.id),
      ["d2"],
    );
  });
});

describe("claude template: a done covers what the SDK says its run consumed (#1319)", () => {
  type Entry = { id: string | undefined; seq: number; uuid?: string; interrupting?: boolean };
  const consumedResult = (...uuids: string[]) => ({ ...result(), user_message_uuids: uuids });

  it("two deliveries queued before the run, answered in one run: one done covers both", async () => {
    captured = [];
    const acked: number[] = [];
    const session = {
      name: "queued-pair",
      messageIds: [
        { id: "d1", seq: 1, uuid: "u1" },
        { id: "d2", seq: 2, uuid: "u2" },
      ] as Entry[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>([
        ["d1", { channel: "@a" }],
        ["d2", { channel: "@a" }],
      ]),
    };
    let left: (string | undefined)[] = [];
    async function* stream() {
      yield assistant("answering d1 and d2", "u1");
      yield consumedResult("u1", "u2"); // the SDK pulled d2 in between tool rounds
      left = session.messageIds.map((e) => e.id);
      session.messageIds.push({ id: "d3", seq: 3, uuid: "u3" });
      yield assistant("answering d3", "u3");
      yield consumedResult("u3");
    }
    await consumeStream(stream() as never, session, {
      broadcast: () => {},
      ack: (seq) => acked.push(seq),
    });
    const [first, second] = await dones(2);
    assert.deepEqual([first.messageId, first.covers], ["d1", ["d1", "d2"]]);
    assert.deepEqual(left, []);
    // The next turn is tagged with its own delivery, not the leftover one (#700).
    assert.deepEqual([second.messageId, second.covers], ["d3", ["d3"]]);
    assert.deepEqual(acked, [1, 2, 3]);
    assert.equal(session.messageChannels.size, 0);
  });

  it("an entry the run did not consume stays for a run of its own, even one pushed mid-run", async () => {
    captured = [];
    const session = {
      name: "not-consumed",
      messageIds: [
        { id: "d1", seq: 1, uuid: "u1" },
        { id: "d2", seq: 2, uuid: "u2" },
      ] as Entry[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    let left: (string | undefined)[] = [];
    async function* stream() {
      yield assistant("answering d1", "u1");
      session.messageIds.push({ id: "d3", seq: 3, uuid: "u3" });
      yield consumedResult("u1");
      left = session.messageIds.map((e) => e.id);
    }
    await consumeStream(stream() as never, session, { broadcast: () => {}, ack: () => {} });
    const [done] = await dones(1);
    assert.deepEqual(done.covers, ["d1"]);
    assert.deepEqual(left, ["d2", "d3"]);
  });
});

describe("claude template: a turn the SDK ran on its own doesn't take a queued delivery (#1319)", () => {
  type Entry = { id: string | undefined; seq: number; uuid?: string };
  const listing = (...uuids: string[]) => ({ ...result(), user_message_uuids: uuids });

  it("a background turn with no list leaves the queued delivery for the run that answers it", async () => {
    captured = [];
    const acked: number[] = [];
    const session = {
      name: "meta-unlisted",
      messageIds: [{ id: "d0", seq: 0, uuid: "u0" }] as Entry[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    async function* stream() {
      yield assistant("answering d0", "u0");
      yield listing("u0"); // this CLI lists what a run consumed
      session.messageIds.push({ id: "d1", seq: 1, uuid: "u1" });
      yield assistant("a background task finished"); // the SDK's own turn, not d1's
      yield result(); // no list: it ran no message of ours
      yield assistant("answering d1", "u1");
      yield listing("u1");
    }
    await consumeStream(stream() as never, session, {
      broadcast: () => {},
      ack: (seq) => acked.push(seq),
    });
    const [, meta, own] = await dones(3);
    assert.deepEqual([meta.messageId, meta.covers], [undefined, []]);
    assert.deepEqual([own.messageId, own.covers], ["d1", ["d1"]]);
    assert.deepEqual(acked, [0, 1], "d1 acked once, by its own run");
    // The background turn's words are tagged with no delivery; d1's with d1.
    const texts = captured.filter((e) => e.type === "text");
    assert.deepEqual(
      texts.map((e) => e.messageId),
      ["d0", undefined, "d1"],
    );
  });

  it("the background turn takes no driver for the rest of it, whatever it streams", async () => {
    captured = [];
    const session = {
      name: "meta-reshift",
      messageIds: [{ id: "d0", seq: 0, uuid: "u0" }] as Entry[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    let left: (string | undefined)[] = [];
    async function* stream() {
      yield assistant("answering d0", "u0");
      yield listing("u0");
      session.messageIds.push({ id: "d1", seq: 1, uuid: "u1" }, { id: "d2", seq: 2, uuid: "u2" });
      yield assistant("a background task finished");
      yield { type: "user", message: { content: [] } }; // a tool round of its own
      yield assistant("still the SDK's turn");
      yield result();
      left = session.messageIds.map((e) => e.id);
    }
    await consumeStream(stream() as never, session, { broadcast: () => {}, ack: () => {} });
    const [, meta] = await dones(2);
    assert.deepEqual([meta.messageId, meta.covers], [undefined, []]);
    assert.deepEqual(left, ["d1", "d2"]);
    const texts = captured.filter((e) => e.type === "text").map((e) => e.messageId);
    assert.deepEqual(texts, ["d0", undefined, undefined]);
  });

  it("a merged batch's turn names its last member; the done covers them all", async () => {
    captured = [];
    const acked: number[] = [];
    const session = {
      name: "batch",
      messageIds: [
        { id: "d1", seq: 1, uuid: "u1" },
        { id: "d2", seq: 2, uuid: "u2" },
      ] as Entry[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    let left: (string | undefined)[] = [];
    async function* stream() {
      yield assistant("answering both", "u2");
      yield listing("u1", "u2");
      left = session.messageIds.map((e) => e.id);
    }
    await consumeStream(stream() as never, session, {
      broadcast: () => {},
      ack: (seq) => acked.push(seq),
    });
    const [done] = await dones(1);
    assert.equal(done.messageId, "d2");
    assert.deepEqual([...(done.covers ?? [])].sort(), ["d1", "d2"]);
    assert.deepEqual(left, []);
    assert.deepEqual(acked.sort(), [1, 2]);
    assert.deepEqual(
      captured.filter((e) => e.type === "text").map((e) => e.messageId),
      ["d2"],
    );
  });

  it("an entry a listless result handed back isn't taken on timing, or named as the next turn's", async () => {
    captured = [];
    const session = {
      name: "unrun",
      messageIds: [{ id: "d0", seq: 0, uuid: "u0" }] as Entry[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    let atStart: string | undefined;
    let named: string | undefined;
    let left: (string | undefined)[] = [];
    async function* stream() {
      yield assistant("answering d0", "u0");
      yield listing("u0");
      session.messageIds.push({ id: "d1", seq: 1, uuid: "u1" });
      yield { type: "system", subtype: "status" }; // d1 taken on timing
      yield result(); // zeroed: no frame, no list
      session.messageIds.push({ id: "d2", seq: 2, uuid: "u2" });
      named = nextQueued(session.messageIds)?.id; // what the pre-prompt hook names
      yield { type: "system", subtype: "status" };
      atStart = session.currentMessageId;
      yield assistant("answering d2", "u2");
      yield listing("u2");
      left = session.messageIds.map((e) => e.id);
    }
    await consumeStream(stream() as never, session, { broadcast: () => {}, ack: () => {} });
    const [, zeroed, own] = await dones(3);
    assert.deepEqual([zeroed.messageId, zeroed.covers], [undefined, []]);
    assert.equal(named, "d2");
    assert.equal(atStart, "d2", "the next turn is bound to d2 from its first message");
    assert.deepEqual([own.messageId, own.covers], ["d2", ["d2"]]);
    assert.deepEqual(left, ["d1"], "d1 waits for a frame naming it");
  });

  it("a fresh stream (a rotation) still knows the CLI echoes: its first background turn takes nothing", async () => {
    captured = [];
    const session = {
      name: "rotated",
      messageIds: [{ id: "d0", seq: 0, uuid: "u0" }] as Entry[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    async function* first() {
      yield assistant("answering d0", "u0");
      yield listing("u0");
    }
    await consumeStream(first() as never, session, { broadcast: () => {}, ack: () => {} });
    session.messageIds.push({ id: "d1", seq: 1, uuid: "u1" });
    let left: (string | undefined)[] = [];
    async function* second() {
      yield assistant("a background task finished");
      yield result();
      left = session.messageIds.map((e) => e.id);
    }
    await consumeStream(second() as never, session, { broadcast: () => {}, ack: () => {} });
    const [, meta] = await dones(2);
    assert.deepEqual([meta.messageId, meta.covers], [undefined, []]);
    assert.deepEqual(left, ["d1"]);
  });

  it("a turn whose list leaves out the driver didn't answer it", async () => {
    captured = [];
    const session = {
      name: "meta-listed",
      messageIds: [{ id: "d1", seq: 1, uuid: "u1" }] as Entry[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    let left: (string | undefined)[] = [];
    async function* stream() {
      yield assistant("a turn of the SDK's own");
      yield listing("u-not-ours");
      left = session.messageIds.map((e) => e.id);
    }
    await consumeStream(stream() as never, session, { broadcast: () => {}, ack: () => {} });
    const [done] = await dones(1);
    assert.deepEqual([done.messageId, done.covers], [undefined, []]);
    assert.deepEqual(left, ["d1"]);
  });
});

describe("claude template: a consumed list the SDK cut short at 64 (#1319)", () => {
  type Entry = { id: string | undefined; seq: number; uuid?: string };

  it("everything up to the last listed entry was consumed, and what arrived mid-run folded in", async () => {
    captured = [];
    // 70 deliveries queued before the run, merged into one batch: the list names only 64.
    const pre: Entry[] = Array.from({ length: 70 }, (_, i) => ({
      id: `d${i}`,
      seq: i,
      uuid: `u${i}`,
    }));
    const session = {
      name: "capped",
      messageIds: [...pre],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    let left: (string | undefined)[] = [];
    async function* stream() {
      yield assistant("answering them all", "u69"); // a merged batch names its last
      session.messageIds.push({ id: "mid", seq: 100, uuid: "umid" }); // arrived mid-run
      // A full list, as the CLI cuts it: the first 63 it took (d0–d62) and the turn's own,
      // the batch's last (d69). d63–d68 and the mid-run fold are not named.
      yield {
        ...result(),
        user_message_uuids: [...pre.slice(0, 63).map((e) => e.uuid), "u69"],
      };
      left = session.messageIds.map((e) => e.id);
    }
    await consumeStream(stream() as never, session, { broadcast: () => {}, ack: () => {} });
    const [done] = await dones(1);
    assert.equal(done.messageId, "d69", "the turn answers the batch's last, as its frame named");
    assert.deepEqual([...(done.covers ?? [])].sort(), [...pre.map((e) => e.id), "mid"].sort());
    assert.deepEqual(left, [], "none of them is left to drive a later turn");
  });

  it("a full list's unnamed pre-run entries after the last named one wait for their own run", async () => {
    captured = [];
    const pre: Entry[] = Array.from({ length: 66 }, (_, i) => ({
      id: `d${i}`,
      seq: i,
      uuid: `u${i}`,
    }));
    const session = {
      name: "capped-tail",
      messageIds: [...pre],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    let left: (string | undefined)[] = [];
    async function* stream() {
      yield assistant("answering the first 64", "u63");
      // The run took d0–d63 (the list's first 63, and d63 as the turn's own); d64 and d65
      // queued before it and were not taken.
      yield { ...result(), user_message_uuids: pre.slice(0, 64).map((e) => e.uuid) };
      left = session.messageIds.map((e) => e.id);
    }
    await consumeStream(stream() as never, session, { broadcast: () => {}, ack: () => {} });
    const [done] = await dones(1);
    assert.equal(done.covers?.length, 64);
    assert.deepEqual(left, ["d64", "d65"]);
  });
});

describe("claude template: an interrupting message is not folded into the turn it cut off", () => {
  it("the interrupted turn's done leaves it out, and it drives the next turn", async () => {
    captured = [];
    const session = {
      name: "interrupted",
      messageIds: [{ id: "a", seq: 1 }] as {
        id: string | undefined;
        seq: number;
        interrupting?: boolean;
      }[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    async function* stream() {
      yield assistant("working on a");
      session.messageIds.push({ id: "b", seq: 2, interrupting: true });
      yield result(); // a's turn, cut short
      yield assistant("working on b");
      yield result();
    }
    await consumeStream(stream() as never, session, { broadcast: () => {}, ack: () => {} });
    const [first, second] = await dones(2);
    assert.deepEqual([first.messageId, first.covers], ["a", ["a"]]);
    assert.deepEqual([second.messageId, second.covers], ["b", ["b"]]);
  });

  it("a message that arrived after the interrupter queued behind it, and is not folded either", async () => {
    captured = [];
    const session = {
      name: "interrupted-2",
      messageIds: [{ id: "a", seq: 1 }] as {
        id: string | undefined;
        seq: number;
        interrupting?: boolean;
      }[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map<string, { channel: string }>(),
    };
    let left: (string | undefined)[] = [];
    async function* stream() {
      yield assistant("working on a");
      session.messageIds.push({ id: "m", seq: 2, interrupting: true }, { id: "n", seq: 3 });
      yield result(); // a's turn, cut short
      left = session.messageIds.map((e) => e.id);
    }
    await consumeStream(stream() as never, session, { broadcast: () => {}, ack: () => {} });
    const [done] = await dones(1);
    assert.deepEqual(done.covers, ["a"]);
    assert.deepEqual(left, ["m", "n"]);
  });
});

describe("the notices hook names the delivery whose prompt it drains for", () => {
  it("sends the messageId its hook input carries, so the drain is that turn's", async () => {
    const hook = resolvePath(
      fileURLToPath(import.meta.url),
      "../../templates/_base/.init/.local/hooks/pre-prompt/notices.ts",
    );
    await new Promise<void>((done, fail) => {
      const child = execFile(
        process.execPath,
        ["--import", "tsx", hook],
        { env: { ...process.env, VOLUTE_MIND_TOKEN: "t" } },
        (err) => (err ? fail(err) : done()),
      );
      child.stdin?.end(JSON.stringify({ session: "main", messageId: "d7" }));
    });
    const drain = requested.find((u) => u.includes("/history/notices"));
    assert.ok(drain, `requested: ${requested.join(", ")}`);
    assert.match(drain, /[?&]session=main\b/);
    assert.match(drain, /[?&]messageId=d7\b/);
  });
});
