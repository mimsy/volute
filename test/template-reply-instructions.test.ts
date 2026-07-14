import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeTemplate } from "../packages/daemon/src/lib/template/template.js";

/**
 * The regression guard for the bug this whole change exists to fix.
 *
 * A system event is not a message: nobody sent it and nothing awaits a reply. But the pi and
 * codex templates injected reply instructions naming the event's synthetic `event:<type>:<id>`
 * channel, telling the mind to `volute chat send event:orientation:1`. The seed "lucy" obeyed,
 * the send was rejected ("Direct sends to event channels are no longer supported"), and she
 * spent her first turn confused about a message no one had sent her.
 *
 * These tests drive the REAL template code, not a model of it. Each template's reply-instruction
 * path lives in modules that only resolve once `_base` and the template overlay are layered
 * together at mind-create time, so we compose each template into a temp dir (as `volute mind
 * create` does) and import what actually ships. Asserting on the helpers in event-turn.ts is
 * not enough — it proves the rule is correct, not that any template obeys it.
 *
 * Each template must hold three properties:
 *   1. an event turn NEVER produces reply instructions, and never names an `event:` channel;
 *   2. the event note fires at most once per session (it states a standing fact, also in
 *      VOLUTE.md — repeating it every event would be noise);
 *   3. a real message still gets its reply instructions, naming the sender's channel — an
 *      event must not consume or suppress them.
 */

const templatesRoot = resolvePath(fileURLToPath(import.meta.url), "../../templates");
const composed: string[] = [];

/** Nothing the mind is told on an event turn may look like a reply target. */
function assertNotReplyable(content: string | undefined) {
  assert.ok(content, "expected the mind to receive the event note");
  assert.ok(!content.includes("event:"), `event note must not name an event channel: ${content}`);
  assert.ok(
    !/volute chat send/.test(content),
    `event note must not tell the mind to send anything: ${content}`,
  );
}

after(() => {
  for (const dir of composed) rmSync(dir, { recursive: true, force: true });
});

describe("claude template: reply instructions vs system events", () => {
  let createReplyInstructionsHook: typeof import("../templates/claude/src/lib/hooks/reply-instructions.js")["createReplyInstructionsHook"];

  before(async () => {
    const dir = composeTemplate(templatesRoot, "claude").composedDir;
    composed.push(dir);
    ({ createReplyInstructionsHook } = await import(
      resolvePath(dir, "src/lib/hooks/reply-instructions.js")
    ));
  });

  function setup() {
    const messageChannels = new Map<string, { channel: string; sender?: string }>();
    const sessionState = {
      replyInstructionsFired: false,
      replyInstructionsMode: "once" as const,
      eventNoteFired: false,
    };
    const { hook } = createReplyInstructionsHook(messageChannels, sessionState);
    // The SDK passes input/toolUseId/options; this hook reads none of them.
    const fire = async (): Promise<string | undefined> => {
      const out = (await hook({} as never, undefined, {} as never)) as {
        hookSpecificOutput?: { additionalContext?: string };
      };
      return out?.hookSpecificOutput?.additionalContext;
    };
    return { messageChannels, sessionState, fire };
  }

  it("an event turn gets the event note, never reply instructions", async () => {
    const { messageChannels, fire } = setup();
    messageChannels.set("m1", { channel: "event:orientation:1" });
    assertNotReplyable(await fire());
  });

  it("the event note fires once per session, not on every event", async () => {
    const { messageChannels, fire } = setup();
    messageChannels.set("m1", { channel: "event:orientation:1" });
    assert.ok(await fire());

    messageChannels.clear();
    messageChannels.set("m2", { channel: "event:schedule:42" });
    assert.equal(await fire(), undefined, "second event must not repeat the note");
  });

  it("a real message still gets reply instructions naming its channel", async () => {
    const { messageChannels, fire } = setup();
    messageChannels.set("m1", { channel: "@alice", sender: "alice" });
    const content = await fire();
    assert.ok(content?.includes("@alice"), `expected reply instructions for @alice: ${content}`);
  });

  it("an event queued alongside a message does not steal the message's reply instructions", async () => {
    // The race a prior review caught: `/message` returns before the turn runs, so an event and
    // a message can both be pending when the hook fires. Deriving event-ness from a
    // last-write-wins session flag would classify this turn by whichever arrived last — and a
    // real message turn would silently lose its reply instructions.
    const { messageChannels, fire } = setup();
    messageChannels.set("m1", { channel: "event:schedule:42" });
    messageChannels.set("m2", { channel: "@alice", sender: "alice" });

    const content = await fire();
    assert.ok(content?.includes("@alice"), "a waiting person still gets reply instructions");
    assert.ok(!content.includes("event:"), "and is never told to reply to the event channel");
  });

  it("an event turn after the note has fired stays silent rather than falling through to reply instructions", async () => {
    const { messageChannels, sessionState, fire } = setup();
    sessionState.eventNoteFired = true;
    messageChannels.set("m1", { channel: "event:orientation:1" });
    assert.equal(await fire(), undefined);
  });
});

describe("pi template: reply instructions vs system events", () => {
  let createReplyInstructionsExtension: typeof import("../templates/pi/src/lib/reply-instructions-extension.js")["createReplyInstructionsExtension"];

  before(async () => {
    const dir = composeTemplate(templatesRoot, "pi").composedDir;
    composed.push(dir);
    ({ createReplyInstructionsExtension } = await import(
      resolvePath(dir, "src/lib/reply-instructions-extension.js")
    ));
  });

  /** Drive the real extension: capture its `before_agent_start` handler and fire it. */
  function setup() {
    const messageChannels = new Map<string, { channel: string; sender?: string }>();
    const factory = createReplyInstructionsExtension(messageChannels);
    let handler:
      | (() => { message?: { customType: string; content: string } } | undefined)
      | undefined;
    factory({
      on: (event: string, fn: () => { message?: { customType: string; content: string } }) => {
        if (event === "before_agent_start") handler = fn;
      },
    } as never);
    assert.ok(handler, "extension should register a before_agent_start handler");
    const fire = () => handler?.()?.message;
    return { messageChannels, fire };
  }

  it("an event turn gets the event note, never reply instructions", () => {
    // This is the exact shape of the lucy bug: pi took the first pending entry blindly, so
    // the only channel on the turn — the event's — became the advertised reply target.
    const { messageChannels, fire } = setup();
    messageChannels.set("m1", { channel: "event:orientation:1" });

    const message = fire();
    assertNotReplyable(message?.content);
    assert.notEqual(message?.customType, "reply-instructions", "the event path is not a reply");
  });

  it("the event note fires once per session, not on every event", () => {
    const { messageChannels, fire } = setup();
    messageChannels.set("m1", { channel: "event:orientation:1" });
    assert.ok(fire());

    messageChannels.clear();
    messageChannels.set("m2", { channel: "event:schedule:42" });
    assert.equal(fire(), undefined, "second event must not repeat the note");
  });

  it("a real message still gets reply instructions naming its channel", () => {
    const { messageChannels, fire } = setup();
    messageChannels.set("m1", { channel: "@alice", sender: "alice" });
    assert.ok(fire()?.content.includes("@alice"));
  });

  it("an event queued alongside a message does not steal the message's reply instructions", () => {
    const { messageChannels, fire } = setup();
    messageChannels.set("m1", { channel: "event:schedule:42" });
    messageChannels.set("m2", { channel: "@alice", sender: "alice" });

    const content = fire()?.content;
    assert.ok(content?.includes("@alice"), "a waiting person still gets reply instructions");
    assert.ok(!content.includes("event:"), "and is never told to reply to the event channel");
  });
});

describe("codex template: reply instructions vs system events", () => {
  let turnContextFor: typeof import("../templates/codex/src/lib/turn-context.js")["turnContextFor"];
  let prompts: { event_instructions: string; reply_instructions: string };

  before(async () => {
    const dir = composeTemplate(templatesRoot, "codex").composedDir;
    composed.push(dir);
    ({ turnContextFor } = await import(resolvePath(dir, "src/lib/turn-context.js")));
    const { loadPrompts } = await import(resolvePath(dir, "src/lib/startup.js"));
    prompts = loadPrompts();
  });

  const newSession = () => ({ eventNoteFired: false, firstMessagePerChannel: new Set<string>() });

  it("an event turn gets the event note, never reply instructions", () => {
    const session = newSession();
    const ctx = turnContextFor(
      { channel: "event:orientation:1", isEvent: true } as never,
      session,
      prompts as never,
    );
    assert.equal(ctx?.source, "event-instructions");
    assertNotReplyable(ctx?.content);
  });

  it("recognizes an event by channel shape even without the isEvent flag", () => {
    const session = newSession();
    const ctx = turnContextFor(
      { channel: "event:schedule:42" } as never,
      session,
      prompts as never,
    );
    assert.equal(ctx?.source, "event-instructions");
  });

  it("the event note fires once per session, not on every event", () => {
    const session = newSession();
    assert.ok(
      turnContextFor({ channel: "event:orientation:1" } as never, session, prompts as never),
    );
    // A distinct channel per event id: keying this on firstMessagePerChannel would re-fire here.
    assert.equal(
      turnContextFor({ channel: "event:schedule:42" } as never, session, prompts as never),
      null,
      "second event must not repeat the note",
    );
  });

  it("a real message still gets reply instructions naming its channel", () => {
    const session = newSession();
    const ctx = turnContextFor(
      { channel: "@alice", sender: "alice" } as never,
      session,
      prompts as never,
    );
    assert.equal(ctx?.source, "reply-instructions");
    assert.ok(ctx?.content.includes("@alice"));
  });

  it("an event does not consume a later message's reply instructions", () => {
    const session = newSession();
    turnContextFor({ channel: "event:orientation:1" } as never, session, prompts as never);
    const ctx = turnContextFor(
      { channel: "@alice", sender: "alice" } as never,
      session,
      prompts as never,
    );
    assert.equal(ctx?.source, "reply-instructions");
    assert.ok(ctx?.content.includes("@alice"));
  });
});
