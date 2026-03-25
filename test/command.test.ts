import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { command, subcommands } from "../packages/cli/src/lib/command.js";

describe("command", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("prints help and exits on --help", async () => {
    const exitMock = mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    const cmd = command({
      name: "volute mind create",
      description: "Create a new mind",
      args: [{ name: "name", required: true, description: "Name for the new mind" }],
      flags: {
        template: { type: "string", description: "Template to use" },
      },
      run: async () => {
        throw new Error("should not run");
      },
    });

    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      await cmd.execute(["--help"]);
    } catch {
      // exit mock throws
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("Create a new mind"), "should include description");
    assert.ok(output.includes("--template"), "should include flag");
    assert.ok(output.includes("<name>"), "should include arg");
    assert.equal(exitMock.mock.calls[0]?.arguments[0], 0, "should exit with 0");
  });

  it("prints help and exits on -h", async () => {
    const exitMock = mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    const cmd = command({
      name: "volute test",
      description: "Test command",
      flags: {},
      run: async () => {
        throw new Error("should not run");
      },
    });

    const origLog = console.log;
    console.log = () => {};
    try {
      await cmd.execute(["-h"]);
    } catch {
      // exit mock throws
    } finally {
      console.log = origLog;
    }
    assert.equal(exitMock.mock.calls[0]?.arguments[0], 0);
  });

  it("parses args and flags then calls run", async () => {
    let receivedArgs: unknown;
    const cmd = command({
      name: "volute mind create",
      description: "Create a new mind",
      args: [{ name: "name", required: true, description: "Name for the new mind" }],
      flags: {
        template: { type: "string", description: "Template to use" },
        json: { type: "boolean", description: "Output JSON" },
      },
      run: async (parsed) => {
        receivedArgs = parsed;
      },
    });

    await cmd.execute(["myname", "--template", "claude"]);
    const r = receivedArgs as {
      args: Record<string, string | undefined>;
      flags: Record<string, unknown>;
    };
    assert.equal(r.args.name, "myname");
    assert.equal(r.flags.template, "claude");
    assert.equal(r.flags.json, false);
  });

  it("shows error for missing required arg", async () => {
    const exitMock = mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    const cmd = command({
      name: "volute mind create",
      description: "Create a new mind",
      args: [{ name: "name", required: true, description: "Name for the new mind" }],
      flags: {},
      run: async () => {},
    });

    const origError = console.error;
    const origLog = console.log;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    console.log = () => {};
    try {
      await cmd.execute([]);
    } catch {
      // exit mock throws
    } finally {
      console.error = origError;
      console.log = origLog;
    }
    assert.ok(
      errors.some((e) => e.includes("name")),
      "should mention missing arg",
    );
    assert.equal(exitMock.mock.calls[0]?.arguments[0], 1, "should exit with 1");
  });

  it("passes extra positionals as rest", async () => {
    let receivedRest: string[] = [];
    const cmd = command({
      name: "volute test",
      description: "Test",
      args: [{ name: "first", required: true, description: "First arg" }],
      flags: {},
      run: async ({ rest }) => {
        receivedRest = rest;
      },
    });

    await cmd.execute(["one", "two", "three"]);
    assert.deepStrictEqual(receivedRest, ["two", "three"]);
  });

  it("includes examples in help output", async () => {
    const exitMock = mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    const cmd = command({
      name: "volute test",
      description: "Test",
      flags: {},
      examples: ["volute test foo", "volute test bar"],
      run: async () => {},
    });

    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      await cmd.execute(["--help"]);
    } catch {
      // exit mock throws
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("Examples:"));
    assert.ok(output.includes("volute test foo"));
    assert.ok(output.includes("volute test bar"));
  });
});

describe("subcommands", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("prints help listing all subcommands", () => {
    const cmd = subcommands({
      name: "volute mind",
      description: "Manage minds",
      commands: {
        create: { description: "Create a new mind", run: async () => {} },
        start: { description: "Start a mind", run: async () => {} },
      },
    });

    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      cmd.printHelp();
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("Manage minds"));
    assert.ok(output.includes("create"));
    assert.ok(output.includes("start"));
    assert.ok(output.includes("Create a new mind"));
  });

  it("dispatches to the correct subcommand", async () => {
    let called = "";
    const cmd = subcommands({
      name: "volute mind",
      description: "Manage minds",
      commands: {
        create: {
          description: "Create",
          run: async (args) => {
            called = `create:${args.join(",")}`;
          },
        },
        start: {
          description: "Start",
          run: async (args) => {
            called = `start:${args.join(",")}`;
          },
        },
      },
    });

    await cmd.execute(["create", "myname", "--template", "claude"]);
    assert.equal(called, "create:myname,--template,claude");
  });

  it("shows help on --help", async () => {
    const exitMock = mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    const cmd = subcommands({
      name: "volute mind",
      description: "Manage minds",
      commands: {
        create: { description: "Create a new mind", run: async () => {} },
      },
    });

    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      await cmd.execute(["--help"]);
    } catch {
      // exit mock throws
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("create"));
    assert.equal(exitMock.mock.calls[0]?.arguments[0], 0);
  });

  it("shows error for unknown subcommand", async () => {
    const exitMock = mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    const cmd = subcommands({
      name: "volute mind",
      description: "Manage minds",
      commands: {
        create: { description: "Create", run: async () => {} },
      },
    });

    const origError = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    const origLog = console.log;
    console.log = () => {};
    try {
      await cmd.execute(["bogus"]);
    } catch {
      // exit mock throws
    } finally {
      console.error = origError;
      console.log = origLog;
    }
    assert.ok(errors.some((e) => e.includes("bogus")));
    assert.equal(exitMock.mock.calls[0]?.arguments[0], 1);
  });

  it("exits with 1 when no subcommand provided", async () => {
    const exitMock = mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    const cmd = subcommands({
      name: "volute mind",
      description: "Manage minds",
      commands: {
        create: { description: "Create a new mind", run: async () => {} },
      },
    });

    const origLog = console.log;
    console.log = () => {};
    try {
      await cmd.execute([]);
    } catch {
      // exit mock throws
    } finally {
      console.log = origLog;
    }
    assert.equal(
      exitMock.mock.calls[0]?.arguments[0],
      1,
      "should exit with 1 for missing subcommand",
    );
  });

  it("shows help on -h", async () => {
    const exitMock = mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    const cmd = subcommands({
      name: "volute mind",
      description: "Manage minds",
      commands: {
        create: { description: "Create a new mind", run: async () => {} },
      },
    });

    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      await cmd.execute(["-h"]);
    } catch {
      // exit mock throws
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("create"));
    assert.equal(exitMock.mock.calls[0]?.arguments[0], 0);
  });

  it("includes footer in help", () => {
    const cmd = subcommands({
      name: "volute test",
      description: "Test",
      commands: {
        foo: { description: "Foo", run: async () => {} },
      },
      footer: "Use VOLUTE_MIND to set the default mind.",
    });

    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      cmd.printHelp();
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("VOLUTE_MIND"));
  });
});
