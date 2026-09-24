import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { type HookCallback, query } from "@anthropic-ai/claude-agent-sdk";
import {
  createBuiltinSubagentModelHook,
  defaultSubagentModel,
} from "../templates/claude/src/lib/subagent-model.js";

describe("claude template subagent model", () => {
  it("defaults an opus- or fable-class mind's subagents to sonnet", () => {
    assert.equal(defaultSubagentModel("claude-opus-4-6"), "sonnet");
    assert.equal(defaultSubagentModel("claude-opus-4-6[1m]"), "sonnet");
    assert.equal(defaultSubagentModel("opus"), "sonnet");
    assert.equal(defaultSubagentModel("claude-fable-5"), "sonnet");
  });

  it("inherits everywhere else: never a cost rise, a family switch, or a model the backend may lack", () => {
    assert.equal(defaultSubagentModel("claude-haiku-4-5"), "inherit");
    assert.equal(defaultSubagentModel("claude-sonnet-4-5"), "inherit");
    assert.equal(defaultSubagentModel("us.anthropic.claude-sonnet-4-5-v1:0"), "inherit");
    assert.equal(defaultSubagentModel("moonshotai/kimi-k2.5"), "inherit");
    assert.equal(defaultSubagentModel(undefined), "inherit");
  });

  // There is no seam to intercept `query()` in a unit test, so pin the source — as
  // session-env-binding.test.ts does. Each line is one path a subagent's model comes from.
  const src = readFileSync(
    resolve(import.meta.dirname, "../templates/claude/src/agent.ts"),
    "utf-8",
  );

  it("lets a mind choose a config-defined subagent's model, the dreamer included", () => {
    assert.match(src, /const subagentModel = defaultSubagentModel\(options\.model\);/);
    assert.match(src, /model: config\.model \?\? subagentModel,/);
  });

  it("covers the SDK's built-in agents, which have no model of their own", () => {
    // The CLI resolves a model-less agent definition (general-purpose) from this env var,
    // else the main loop's model. A mind's own setting of it wins.
    // Set only for a non-inherit default: absent is the CLI's own "inherit".
    assert.match(
      src,
      /const defaultBuiltinSubagents =\s*subagentModel !== "inherit" && !process\.env\.CLAUDE_CODE_SUBAGENT_MODEL;/,
    );
    assert.match(
      src,
      /\.\.\.\(defaultBuiltinSubagents && \{ CLAUDE_CODE_SUBAGENT_MODEL: subagentModel \}\)/,
    );
  });

  it("covers the built-ins defined as inherit, which never read the env var", () => {
    // Registered under the same condition as the env var, with the mind's own agent names.
    assert.match(
      src,
      /\.\.\.\(defaultBuiltinSubagents && \{\s*PreToolUse: \[\s*\{\s*matcher: "Agent",[\s\S]*?createBuiltinSubagentModelHook\(\s*subagentModel,\s*Object\.keys\(agents \?\? \{\}\),\s*resolvePath\(mindHome, "\.claude\/agents"\),\s*\)/,
    );
  });
});

describe("built-in subagent model hook", () => {
  const noAgentsDir = join(mkdtempSync(join(tmpdir(), "subagent-hook-")), "agents");

  async function run(hook: HookCallback, toolInput: Record<string, unknown>) {
    const input = {
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: toolInput,
      tool_use_id: "toolu_1",
      session_id: "s",
      transcript_path: "",
      cwd: "",
    } as any;
    return hook(input, "toolu_1", { signal: new AbortController().signal });
  }

  it("gives a call to Explore or Plan that names no model the default", async () => {
    const hook = createBuiltinSubagentModelHook("sonnet", [], noAgentsDir);
    for (const type of ["Explore", "Plan"]) {
      const call = { subagent_type: type, description: "d", prompt: "p" };
      assert.deepEqual(await run(hook, call), {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { ...call, model: "sonnet" },
        },
      });
    }
  });

  it("keeps a model the call chose", async () => {
    const hook = createBuiltinSubagentModelHook("sonnet", [], noAgentsDir);
    const call = { subagent_type: "Explore", description: "d", prompt: "p", model: "opus" };
    assert.deepEqual(await run(hook, call), {});
  });

  it("leaves other agents to their own definitions and the env var", async () => {
    const hook = createBuiltinSubagentModelHook("sonnet", [], noAgentsDir);
    for (const type of ["general-purpose", "dreamer", undefined]) {
      assert.deepEqual(await run(hook, { subagent_type: type, description: "d", prompt: "p" }), {});
    }
  });

  it("leaves a mind's own agent that shadows a built-in's name alone", async () => {
    const call = { subagent_type: "Explore", description: "d", prompt: "p" };
    const fromConfig = createBuiltinSubagentModelHook("sonnet", ["Explore"], noAgentsDir);
    assert.deepEqual(await run(fromConfig, call), {});

    const agentsDir = join(mkdtempSync(join(tmpdir(), "subagent-hook-")), "agents");
    mkdirSync(join(agentsDir, "search"), { recursive: true });
    writeFileSync(join(agentsDir, "search", "mine.md"), "---\nname: Explore\n---\nMy own.\n");
    const fromFile = createBuiltinSubagentModelHook("sonnet", [], agentsDir);
    assert.deepEqual(await run(fromFile, call), {});
    // Only the shadowed name: Plan is still the built-in.
    assert.equal(
      ((await run(fromFile, { ...call, subagent_type: "Plan" })) as any).hookSpecificOutput
        .updatedInput.model,
      "sonnet",
    );
  });
});

// Drives the bundled CLI against a stub Messages API: the main loop calls one subagent,
// and the stub records the model each request names. This is the resolution order the
// hook depends on — if an SDK bump changes it, these go red.
describe("built-in subagent model, resolved by the bundled CLI", () => {
  const MARKER = "SUBAGENT-TASK-MARKER";

  function stream(res: ServerResponse, model: string, block: any, stop: string) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (data: any) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
    const usage = { input_tokens: 1, output_tokens: 1 };
    send({
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model, content: [], usage },
    });
    if (block.type === "text") {
      send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: block.text },
      });
    } else {
      send({ type: "content_block_start", index: 0, content_block: { ...block, input: {} } });
      send({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    send({ type: "content_block_stop", index: 0 });
    send({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } });
    send({ type: "message_stop" });
    res.end();
  }

  /** The model the subagent's request was sent to. */
  async function subagentModel(call: Record<string, unknown>, hook?: HookCallback) {
    const models: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ input_tokens: 1 }));
        }
        const b = JSON.parse(body);
        const messages = JSON.stringify(b.messages);
        const isMain = (b.tools ?? []).some((t: any) => t.name === "Agent");
        if (!isMain && messages.includes(MARKER)) models.push(b.model);
        if (isMain && !messages.includes("tool_result")) {
          const input = { description: "find it", prompt: `${MARKER} find it`, ...call };
          return stream(
            res,
            b.model,
            { type: "tool_use", id: "toolu_1", name: "Agent", input },
            "tool_use",
          );
        }
        stream(res, b.model, { type: "text", text: "done" }, "end_turn");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const home = mkdtempSync(join(tmpdir(), "subagent-model-"));
    try {
      const q = query({
        prompt: "delegate",
        options: {
          model: "claude-opus-4-6",
          cwd: home,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          env: {
            PATH: process.env.PATH,
            HOME: home,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            ANTHROPIC_API_KEY: "sk-ant-test",
            CLAUDE_CODE_SUBAGENT_MODEL: "sonnet",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
          hooks: hook ? { PreToolUse: [{ matcher: "Agent", hooks: [hook] }] } : {},
        },
      });
      for await (const m of q) if (m.type === "result") break;
    } finally {
      server.close();
    }
    assert.equal(models.length, 1, `expected one subagent request, saw ${models.length}`);
    return models[0];
  }

  const hook = createBuiltinSubagentModelHook(
    "sonnet",
    [],
    join(mkdtempSync(join(tmpdir(), "subagent-cli-")), "agents"),
  );

  it("without the hook, Explore inherits the parent despite the env var", async () => {
    assert.match(await subagentModel({ subagent_type: "Explore" }), /opus/);
  });

  it("with the hook, Explore and Plan run on the default", async () => {
    assert.match(await subagentModel({ subagent_type: "Explore" }, hook), /sonnet/);
    assert.match(await subagentModel({ subagent_type: "Plan" }, hook), /sonnet/);
  });

  it("with the hook, a call's own model still wins", async () => {
    assert.match(await subagentModel({ subagent_type: "Explore", model: "opus" }, hook), /opus/);
  });
});
