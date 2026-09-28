import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve as resolvePath } from "node:path";
import { after, before, describe, it } from "node:test";
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
let consumeStream: typeof import("../templates/claude/src/lib/stream-consumer.js")["consumeStream"];

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
  ({ consumeStream } = await import(resolvePath(composedDir, "src/lib/stream-consumer.js")));
});

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

const assistant = (text: string) => ({
  type: "assistant",
  message: { usage: {}, content: [{ type: "text", text }] },
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

  it("a message queued before the turn started is not covered: it gets a turn of its own", async () => {
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
