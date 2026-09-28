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
    const sessionState = { replyInstructionsFired: false, eventNoteFired: false };
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
  let turnContextForBatch: typeof import("../templates/_base/src/lib/turn-context.js")["turnContextFor"];
  /** Most cases run one message per turn. */
  const turnContextFor = (
    meta: Parameters<typeof turnContextForBatch>[0][number],
    session: Parameters<typeof turnContextForBatch>[1],
    prompts: Parameters<typeof turnContextForBatch>[2],
  ) => turnContextForBatch([meta], session, prompts);
  let prompts: { event_instructions: string; reply_instructions: string };

  before(async () => {
    const dir = composeTemplate(templatesRoot, "codex").composedDir;
    composed.push(dir);
    ({ turnContextFor: turnContextForBatch } = await import(
      resolvePath(dir, "src/lib/turn-context.js")
    ));
    const { loadPrompts } = await import(resolvePath(dir, "src/lib/startup.js"));
    prompts = loadPrompts();
  });

  const newSession = () => ({ eventNoteFired: false, replyInstructionsFired: false });

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
    // A distinct channel per event id: keying this on the channel would re-fire here.
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

  describe("once per session, as claude does (#1199)", () => {
    const alice = { channel: "@alice", sender: "alice" } as never;
    const bob = { channel: "@bob", sender: "bob" } as never;

    it("fires on the session's first message only, not once per channel", () => {
      const session = newSession();
      assert.equal(turnContextFor(alice, session, prompts as never)?.source, "reply-instructions");
      assert.equal(turnContextFor(alice, session, prompts as never), null);
      assert.equal(turnContextFor(bob, session, prompts as never), null);
    });

    it("a system message's note doesn't spend the one firing", () => {
      const session = newSession();
      const system = turnContextFor(
        { channel: "@volute", sender: "volute" } as never,
        session,
        prompts as never,
      );
      assert.match(system?.content ?? "", /no reply is needed/);
      assert.ok(turnContextFor(bob, session, prompts as never)?.content.includes("@bob"));
    });
  });

  describe("a turn folding several messages (#1200)", () => {
    it("is a message turn when any message is real, and names the real channel", () => {
      const ctx = turnContextForBatch(
        [{ channel: "event:schedule:1" }, { channel: "@alice", sender: "alice" }] as never,
        newSession(),
        prompts as never,
      );
      assert.equal(ctx?.source, "reply-instructions");
      assert.ok(ctx?.content.includes("@alice"));
      assert.ok(!ctx?.content.includes("event:"));
    });

    it("is an event turn when every message is an event", () => {
      const ctx = turnContextForBatch(
        [{ channel: "event:schedule:1" }, { channel: "event:schedule:2", isEvent: true }] as never,
        newSession(),
        prompts as never,
      );
      assert.equal(ctx?.source, "event-instructions");
    });
  });
});

/**
 * routes.json's `threads.<name>.replyInstructions` (#1205). The daemon resolves it for each
 * delivery and sends it on the message's meta; every template must then honour it the same
 * way, since a mind that sets `always` because it knows it forgets to reply is asking for
 * exactly this. Each template is driven through its own real entry point: claude's hook,
 * pi's extension, codex's per-run call.
 */
type Entry = {
  channel?: string;
  replyChannel?: string;
  sender?: string;
  replyInstructions?: "once" | "always" | "never";
};
type Fire = (entries: Entry[]) => Promise<string | undefined>;

const modeHarnesses: Record<string, () => Promise<() => Fire>> = {
  claude: async () => {
    const dir = composeTemplate(templatesRoot, "claude").composedDir;
    composed.push(dir);
    const { createReplyInstructionsHook } = await import(
      resolvePath(dir, "src/lib/hooks/reply-instructions.js")
    );
    return () => {
      const pending = new Map<string, Entry>();
      const { hook } = createReplyInstructionsHook(pending, {
        replyInstructionsFired: false,
        eventNoteFired: false,
      });
      return async (entries) => {
        pending.clear();
        for (const [i, e] of entries.entries()) pending.set(`m${i}`, e);
        const out = (await hook({} as never, undefined, {} as never)) as {
          hookSpecificOutput?: { additionalContext?: string };
        };
        return out?.hookSpecificOutput?.additionalContext;
      };
    };
  },
  pi: async () => {
    const dir = composeTemplate(templatesRoot, "pi").composedDir;
    composed.push(dir);
    const { createReplyInstructionsExtension } = await import(
      resolvePath(dir, "src/lib/reply-instructions-extension.js")
    );
    return () => {
      const pending = new Map<string, Entry>();
      let handler: (() => { message?: { content: string } } | undefined) | undefined;
      createReplyInstructionsExtension(pending)({
        on: (event: string, fn: typeof handler) => {
          if (event === "before_agent_start") handler = fn;
        },
      } as never);
      return async (entries) => {
        pending.clear();
        for (const [i, e] of entries.entries()) pending.set(`m${i}`, e);
        return handler?.()?.message?.content;
      };
    };
  },
  codex: async () => {
    const dir = composeTemplate(templatesRoot, "codex").composedDir;
    composed.push(dir);
    const { turnContextFor } = await import(resolvePath(dir, "src/lib/turn-context.js"));
    const { loadPrompts } = await import(resolvePath(dir, "src/lib/startup.js"));
    const prompts = loadPrompts();
    return () => {
      const session = { replyInstructionsFired: false, eventNoteFired: false };
      return async (entries) => turnContextFor(entries, session, prompts)?.content;
    };
  },
};

for (const [template, harness] of Object.entries(modeHarnesses)) {
  describe(`${template} template: routes.json replyInstructions (#1205)`, () => {
    let newSession: () => Fire;
    before(async () => {
      newSession = await harness();
    });

    const alice = (mode?: Entry["replyInstructions"]): Entry => ({
      channel: "@alice",
      sender: "alice",
      ...(mode ? { replyInstructions: mode } : {}),
    });

    it("unset means once: the session's first message only", async () => {
      const fire = newSession();
      assert.match((await fire([alice()])) ?? "", /volute chat send "@alice"/);
      assert.equal(await fire([alice()]), undefined);
    });

    it("once: the session's first message only", async () => {
      const fire = newSession();
      assert.match((await fire([alice("once")])) ?? "", /@alice/);
      assert.equal(await fire([alice("once")]), undefined);
    });

    it("always: every turn with someone to answer", async () => {
      const fire = newSession();
      for (let i = 0; i < 3; i++) {
        assert.match((await fire([alice("always")])) ?? "", /volute chat send "@alice"/);
      }
    });

    it("never: not even the first message", async () => {
      const fire = newSession();
      assert.equal(await fire([alice("never")]), undefined);
      assert.equal(await fire([alice("never")]), undefined);
    });

    it("follows the thread the message came from, not the session's last setting", async () => {
      const fire = newSession();
      assert.ok(await fire([alice("once")]));
      assert.match((await fire([alice("always")])) ?? "", /@alice/);
      assert.equal(await fire([alice("once")]), undefined, "once is spent for the session");
    });

    it("always still never names an event channel on an event turn", async () => {
      const fire = newSession();
      const note = await fire([{ channel: "event:schedule:1", replyInstructions: "always" }]);
      assert.ok(note && !note.includes("volute chat send"), `got: ${note}`);
    });

    it("a batch is reminded of its replyChannel", async () => {
      const fire = newSession();
      const batch = {
        replyChannel: "#garden",
        sender: "alice",
        replyInstructions: "always" as const,
      };
      assert.match((await fire([batch])) ?? "", /volute chat send "#garden"/);
      assert.match((await fire([batch])) ?? "", /#garden/);
    });

    it("a system message's note doesn't spend the once firing", async () => {
      const fire = newSession();
      assert.match(
        (await fire([{ channel: "@volute", sender: "volute" }])) ?? "",
        /no reply is needed/,
      );
      assert.match((await fire([alice()])) ?? "", /@alice/);
    });
  });
}
