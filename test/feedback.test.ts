import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, ExtensionContext } from "@volute/extensions";
import Database from "libsql";

import { createCommands } from "../packages/extensions/feedback/src/commands.js";
import { initDb } from "../packages/extensions/feedback/src/db.js";
import { getFeedback } from "../packages/extensions/feedback/src/feedback.js";
import { provisionSpiritSchedule } from "../packages/extensions/feedback/src/spirit-schedule.js";

type Call = { method: string; url: string; body: Record<string, unknown> | null; auth: string };

describe("feedback extension", () => {
  let db: ExtDb;
  let notices: [string, string][];
  let calls: Call[];
  let answer: { status: number; data: unknown };

  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({
      method: init.method ?? "GET",
      url,
      body: init.body ? JSON.parse(init.body as string) : null,
      auth: (init.headers as Record<string, string>).Authorization,
    });
    return new Response(JSON.stringify(answer.data), { status: answer.status });
  }) as unknown as typeof fetch;

  const commands = createCommands(fakeFetch);

  function run(
    name: string,
    as: { mind?: string; privileged?: boolean; stdin?: string },
    args: Record<string, string> = {},
    flags: Record<string, string | number | boolean> = {},
  ) {
    const ctx = {
      db,
      mindName: as.mind,
      privileged: as.privileged ?? false,
      stdin: as.stdin,
      recordNotice: async (mind: string, text: string) => {
        notices.push([mind, text]);
      },
      listMinds: async () => [
        { name: "wren", mindType: "mind" },
        { name: "volute", mindType: "spirit" },
      ],
    } as unknown as Parameters<(typeof commands)[string]["handler"]>[1];
    return commands[name].handler({ args, flags, rest: [] }, ctx) as Promise<{
      output?: string;
      error?: string;
    }>;
  }

  const spirit = { mind: "volute", privileged: true };

  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    notices = [];
    calls = [];
    answer = {
      status: 201,
      data: { number: 7, title: "t", html_url: "https://github.com/mimsy/volute/issues/7" },
    };
  });

  afterEach(() => db.close());

  it("records a mind's report and shows it in its own list", async () => {
    const sent = await run("send", { mind: "wren" }, { text: "clock add only says invalid" });
    assert.match(sent.output ?? "", /Feedback #1 recorded/);
    assert.equal(getFeedback(db, 1)?.about, "volute");
    const mine = await run("list", { mind: "wren" });
    assert.match(mine.output ?? "", /\[1\].*waiting for review/);
    assert.match((await run("list", { mind: "lark" })).output ?? "", /haven't sent/);
  });

  it("takes the report from stdin and an area from --about", async () => {
    await run(
      "send",
      { mind: "wren", stdin: "pages write drops the title\n" },
      {},
      { about: "Pages" },
    );
    const item = getFeedback(db, 1);
    assert.equal(item?.content, "pages write drops the title");
    assert.equal(item?.about, "pages");
  });

  it("refuses an empty report, an overlong one, and an eleventh unreviewed one", async () => {
    assert.match((await run("send", { mind: "wren" })).error ?? "", /Usage/);
    assert.match(
      (await run("send", { mind: "wren" }, { text: "x".repeat(4001) })).error ?? "",
      /4000/,
    );
    for (let i = 0; i < 10; i++) await run("send", { mind: "wren" }, { text: `report ${i}` });
    assert.match(
      (await run("send", { mind: "wren" }, { text: "one more" })).error ?? "",
      /waiting/,
    );
  });

  it("keeps review to privileged callers", async () => {
    await run("send", { mind: "wren" }, { text: "a report" });
    for (const [name, args] of [
      ["pending", {}],
      ["issues", {}],
      ["file", { ids: "1" }],
      ["dismiss", { id: "1", reason: "no" }],
      ["setup", {}],
    ] as const) {
      const res = await run(name, { mind: "wren", stdin: "x" }, args, { title: "t" });
      assert.match(res.error ?? "", /Forbidden/, name);
    }
    assert.equal(getFeedback(db, 1)?.status, "pending");
    assert.equal(calls.length, 0);
  });

  it("shows the spirit what is waiting and whether it can file", async () => {
    assert.equal((await run("pending", spirit)).output, "No feedback waiting.");
    await run("send", { mind: "wren" }, { text: "a report" });
    const out = (await run("pending", spirit)).output ?? "";
    assert.match(out, /1 waiting\. GitHub token: not set\. Areas: volute → mimsy\/volute/);
    assert.match(out, /\[1\] from wren, about volute/);
  });

  it("won't file without a token, and stores one without echoing it", async () => {
    await run("send", { mind: "wren" }, { text: "a report" });
    const res = await run("file", { ...spirit, stdin: "body" }, { ids: "1" }, { title: "t" });
    assert.match(res.error ?? "", /No GitHub token/);
    const set = await run("setup", { ...spirit, stdin: "ghp_secretsecretsecretsecret\n" });
    assert.match(set.output ?? "", /GitHub token: set/);
    assert.doesNotMatch(set.output ?? "", /ghp_/);
  });

  it("files several reports as one issue and tells each mind", async () => {
    await run("setup", { ...spirit, stdin: "tok" });
    await run("send", { mind: "wren" }, { text: "first" });
    await run("send", { mind: "lark" }, { text: "second" });
    const res = await run(
      "file",
      { ...spirit, stdin: "What was run, what came back." },
      { ids: "1,2" },
      { title: "clock add: name the rejected field" },
    );
    assert.equal(res.output, "Filed: https://github.com/mimsy/volute/issues/7");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://api.github.com/repos/mimsy/volute/issues");
    assert.equal(calls[0].auth, "Bearer tok");
    assert.equal(calls[0].body?.title, "clock add: name the rejected field");
    assert.deepEqual(calls[0].body?.labels, ["mind-feedback"]);
    assert.match(
      calls[0].body?.body as string,
      /^What was run, what came back\.\n\n---\n_Filed by .* 2 minds' reports\._$/,
    );
    assert.equal(getFeedback(db, 1)?.status, "filed");
    assert.equal(getFeedback(db, 2)?.issue_url, "https://github.com/mimsy/volute/issues/7");
    assert.deepEqual(
      notices.map(([m]) => m),
      ["wren", "lark"],
    );
    assert.match(notices[0][1], /#1 was filed: https:\/\/github\.com/);
    assert.match(
      (await run("file", { ...spirit, stdin: "x" }, { ids: "1" }, { title: "t" })).error ?? "",
      /already filed/,
    );
  });

  it("adds a report to an existing issue as a comment", async () => {
    await run("setup", { ...spirit, stdin: "tok" });
    await run("send", { mind: "wren" }, { text: "again" });
    answer = { status: 201, data: { html_url: "https://github.com/mimsy/volute/issues/7#c1" } };
    const res = await run("file", { ...spirit, stdin: "A second case." }, { ids: "1" }, { on: 7 });
    assert.equal(res.output, "Filed: https://github.com/mimsy/volute/issues/7#c1");
    assert.equal(calls[0].url, "https://api.github.com/repos/mimsy/volute/issues/7/comments");
  });

  it("routes an extension's feedback to the repository set for it", async () => {
    await run("setup", { ...spirit, stdin: "tok" }, {}, { repo: "garden=someone/garden" });
    await run("send", { mind: "wren" }, { text: "about the garden" }, { about: "garden" });
    await run("send", { mind: "wren" }, { text: "about nothing known" }, { about: "mystery" });
    await run("file", { ...spirit, stdin: "body" }, { ids: "1" }, { title: "t" });
    assert.equal(calls[0].url, "https://api.github.com/repos/someone/garden/issues");
    const lost = await run("file", { ...spirit, stdin: "body" }, { ids: "2" }, { title: "t" });
    assert.match(lost.error ?? "", /No repository is set for "mystery".*volute, garden/);
    await run("file", { ...spirit, stdin: "body" }, { ids: "2" }, { title: "t", about: "volute" });
    assert.equal(calls[1].url, "https://api.github.com/repos/mimsy/volute/issues");
    assert.match(
      (await run("setup", spirit, {}, { repo: "not a repo" })).error ?? "",
      /owner\/name/,
    );
  });

  it("refuses text carrying a credential or a mind's name, and leaves the report waiting", async () => {
    await run("setup", { ...spirit, stdin: "tok" });
    await run("send", { mind: "wren" }, { text: "a report" });
    const leak = await run(
      "file",
      { ...spirit, stdin: "it printed sk-ant-abc123def456" },
      { ids: "1" },
      { title: "t" },
    );
    assert.match(leak.error ?? "", /credential/);
    const named = await run(
      "file",
      { ...spirit, stdin: "Wren ran the command" },
      { ids: "1" },
      { title: "t" },
    );
    assert.match(named.error ?? "", /names a mind on this system \(wren\)/);
    assert.equal(calls.length, 0);
    assert.equal(getFeedback(db, 1)?.status, "pending");
    // The spirit's own name isn't a mind's, and a word that happens to be a name can pass.
    const ok = await run(
      "file",
      { ...spirit, stdin: "volute sang like a wren" },
      { ids: "1" },
      { title: "t", "names-ok": true },
    );
    assert.match(ok.output ?? "", /^Filed/);
  });

  it("leaves a report waiting when GitHub refuses", async () => {
    await run("setup", { ...spirit, stdin: "tok" });
    await run("send", { mind: "wren" }, { text: "a report" });
    answer = { status: 403, data: { message: "Resource not accessible by personal access token" } };
    const res = await run("file", { ...spirit, stdin: "body" }, { ids: "1" }, { title: "t" });
    assert.match(res.error ?? "", /Not filed: GitHub answered 403: Resource not accessible/);
    assert.equal(getFeedback(db, 1)?.status, "pending");
    assert.equal(notices.length, 0);
  });

  it("lists open feedback issues without pull requests", async () => {
    await run("setup", { ...spirit, stdin: "tok" });
    answer = {
      status: 200,
      data: [
        { number: 7, title: "clock add", html_url: "u" },
        { number: 8, title: "a pr", html_url: "u", pull_request: {} },
      ],
    };
    const res = await run("issues", spirit);
    assert.equal(res.output, "  #7 clock add");
    assert.match(calls[0].url, /\/repos\/mimsy\/volute\/issues\?labels=mind-feedback&state=open/);
  });

  it("dismisses with a reason the mind is sent", async () => {
    await run("send", { mind: "wren" }, { text: "a report" });
    const res = await run("dismiss", spirit, {
      id: "1",
      reason: "That is how it is meant to work.",
    });
    assert.equal(res.output, "Dismissed #1");
    assert.deepEqual(notices, [
      ["wren", "Your feedback #1 wasn't filed: That is how it is meant to work."],
    ]);
    assert.match((await run("list", { mind: "wren" })).output ?? "", /not filed: That is how/);
  });
});

describe("feedback spirit schedule", () => {
  let db: ExtDb;
  let spiritDir: string;
  let configPath: string;

  const ctx = (dir: string | null) =>
    ({
      db,
      getSpiritName: () => "volute",
      getMindDir: async () => dir,
    }) as unknown as ExtensionContext;
  const schedules = () =>
    (JSON.parse(readFileSync(configPath, "utf-8")).schedules ?? []) as {
      id: string;
      script: string;
    }[];

  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    spiritDir = mkdtempSync(join(tmpdir(), "feedback-spirit-"));
    mkdirSync(resolve(spiritDir, "home/.config"), { recursive: true });
    configPath = resolve(spiritDir, "home/.config/volute.json");
  });

  afterEach(() => {
    db.close();
    rmSync(spiritDir, { recursive: true, force: true });
  });

  it("adds the daily review once, beside what is there", async () => {
    writeFileSync(configPath, JSON.stringify({ schedules: [{ id: "other" }] }));
    await provisionSpiritSchedule(ctx(spiritDir));
    assert.deepEqual(
      schedules().map((s) => s.id),
      ["other", "feedback-review"],
    );
    assert.equal(schedules()[1].script, "volute feedback pending");
  });

  it("respects a deleted schedule", async () => {
    writeFileSync(configPath, JSON.stringify({}));
    await provisionSpiritSchedule(ctx(spiritDir));
    writeFileSync(configPath, JSON.stringify({ schedules: [] }));
    await provisionSpiritSchedule(ctx(spiritDir));
    assert.deepEqual(schedules(), []);
  });

  it("waits for a spirit that isn't there yet", async () => {
    await provisionSpiritSchedule(ctx(null));
    writeFileSync(configPath, JSON.stringify({}));
    await provisionSpiritSchedule(ctx(spiritDir));
    assert.equal(schedules().length, 1);
  });
});
