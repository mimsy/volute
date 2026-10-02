import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
  readAppliedInfrastructureHash,
  readUnreadableWarnedHash,
  type SyncInfrastructureDeps,
  syncAllMindInfrastructure,
  syncMindInfrastructure,
  writeAppliedInfrastructureHash,
  writeUnreadableWarnedHash,
} from "../packages/daemon/src/lib/mind/infrastructure-sync.js";
import { seedInitLedger } from "../packages/daemon/src/lib/mind/init-ledger.js";
import {
  addMind,
  type MindEntry,
  mindDir,
  removeMind,
  stateDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  applyInitFiles,
  backfillInitInfrastructure,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesRoot,
  SHIPPED_HASHES_REL,
} from "../packages/daemon/src/lib/template/template.js";
import {
  computeInfrastructureHash,
  computeTemplateHash,
  hashInfrastructure,
} from "../packages/daemon/src/lib/template/template-hash.js";

const NOTICES = ".local/hooks/pre-prompt/notices.ts";

function write(root: string, rel: string, content: string) {
  const path = resolve(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("hashInfrastructure", () => {
  function fixture(): string {
    const dir = mkdtempSync(resolve(tmpdir(), "volute-infra-hash-"));
    write(dir, ".init/SOUL.md", "soul");
    write(dir, ".init/.config/volute.json", "{}");
    write(dir, `.init/${NOTICES}`, "hook v1");
    write(dir, "src/server.ts", "server");
    return dir;
  }

  it("ignores identity files and non-.init files", () => {
    const dir = fixture();
    const before = hashInfrastructure(dir, null);
    write(dir, ".init/SOUL.md", "a different soul");
    write(dir, ".init/.config/volute.json", '{"x":1}');
    write(dir, "src/server.ts", "a different server");
    assert.equal(hashInfrastructure(dir, null), before);
  });

  it("changes when a .local file changes or is added", () => {
    const dir = fixture();
    const before = hashInfrastructure(dir, null);
    write(dir, `.init/${NOTICES}`, "hook v2");
    const edited = hashInfrastructure(dir, null);
    assert.notEqual(edited, before);
    write(dir, ".init/.local/hooks/pre-prompt/new.ts", "new");
    assert.notEqual(hashInfrastructure(dir, null), edited);
  });

  it("changes when only a file's exec bit changes", () => {
    // A mode fix has to reach existing minds like a content fix does (#1274).
    const dir = fixture();
    const before = hashInfrastructure(dir, null);
    chmodSync(resolve(dir, `.init/${NOTICES}`), 0o755);
    assert.notEqual(hashInfrastructure(dir, null), before);
  });

  it("changes when only the shipped-hash ledger changes", () => {
    // A release that only records an old version as ours makes it refreshable.
    const dir = fixture();
    assert.notEqual(
      hashInfrastructure(dir, Buffer.from('{"a":["1"]}')),
      hashInfrastructure(dir, Buffer.from('{"a":["1","2"]}')),
    );
  });

  it("reads the shipped-hash ledger from the source _base, not the composed tree", () => {
    // composeTemplate strips SHIPPED.json, so reading it from the composed tree would
    // silently hash no ledger at all.
    const root = findTemplatesRoot();
    const ledger = readFileSync(resolve(root, "_base", SHIPPED_HASHES_REL));
    const { composedDir } = composeTemplate(root, "claude");
    try {
      assert.equal(computeInfrastructureHash("claude"), hashInfrastructure(composedDir, ledger));
      assert.notEqual(computeInfrastructureHash("claude"), hashInfrastructure(composedDir, null));
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
  });

  it("is a different hash from the template hash, and stable", () => {
    const infra = computeInfrastructureHash("claude");
    assert.match(infra, /^[a-f0-9]{64}$/);
    assert.equal(computeInfrastructureHash("claude"), infra);
    assert.notEqual(infra, computeTemplateHash("claude"));
  });
});

describe("applied infrastructure hash record", () => {
  it("round-trips, and reads unreadable as unrecorded", () => {
    const name = "infra-record";
    rmSync(stateDir(name), { recursive: true, force: true });
    assert.equal(readAppliedInfrastructureHash(name), null);
    writeAppliedInfrastructureHash(name, "abc");
    assert.equal(readAppliedInfrastructureHash(name), "abc");
    writeUnreadableWarnedHash(name, "def");
    assert.equal(readAppliedInfrastructureHash(name), "abc", "a warning keeps the applied hash");
    assert.equal(readUnreadableWarnedHash(name), "def");
    writeFileSync(resolve(stateDir(name), "init-infrastructure-hash.json"), "{not json");
    assert.equal(readAppliedInfrastructureHash(name), null);
  });
});

describe("syncMindInfrastructure", () => {
  function entry(name: string): MindEntry {
    mkdirSync(resolve(mindDir(name), "home", ".local"), { recursive: true });
    return { name, port: 0, created: "", mindType: "mind", template: "claude" } as MindEntry;
  }

  type Result = { added: string[]; refreshed: string[]; withheld: string[]; unreadable: string[] };
  const empty: Result = { added: [], refreshed: [], withheld: [], unreadable: [] };

  /** Deps backed by an in-memory hash record, so consecutive runs see each other's writes. */
  function spies(opts: {
    applied: string | null;
    result?: Result;
    throws?: boolean;
    chownFailures?: number;
  }) {
    let applied = opts.applied;
    let chownFailures = opts.chownFailures ?? 0;
    let warned: string | null = null;
    const calls = {
      backfill: 0,
      chown: [] as string[],
      recorded: [] as string[],
      warned: [] as string[],
    };
    const deps: SyncInfrastructureDeps = {
      currentHash: () => "current",
      appliedHash: () => applied,
      recordHash: (_name, hash) => {
        applied = hash;
        calls.recorded.push(hash);
      },
      warnedHash: () => warned,
      recordWarned: (_name, hash) => {
        warned = hash;
        calls.warned.push(hash);
      },
      backfill: async () => {
        calls.backfill++;
        if (opts.throws) throw new Error("template missing");
        return opts.result ?? empty;
      },
      chown: async (dir) => {
        calls.chown.push(dir);
        if (chownFailures > 0) {
          chownFailures--;
          throw new Error("chown failed");
        }
      },
    };
    return { deps, calls };
  }

  it("does nothing when the mind already has the current infrastructure", async () => {
    const { deps, calls } = spies({ applied: "current" });
    await syncMindInfrastructure(entry("infra-current"), deps);
    assert.deepEqual(calls, { backfill: 0, chown: [], recorded: [], warned: [] });
  });

  it("backfills, chowns home/.local, and records when the hash moved", async () => {
    const { deps, calls } = spies({
      applied: null,
      result: { ...empty, added: [NOTICES] },
    });
    await syncMindInfrastructure(entry("infra-busy"), deps);
    assert.equal(calls.backfill, 1);
    assert.deepEqual(calls.chown, [resolve(mindDir("infra-busy"), "home", ".local")]);
    assert.deepEqual(calls.recorded, ["current"]);
  });

  it("does not record the hash when the backfill fails, so the next start retries", async () => {
    const { deps, calls } = spies({ applied: "old", throws: true });
    await syncMindInfrastructure(entry("infra-fail"), deps);
    assert.deepEqual(calls, { backfill: 1, chown: [], recorded: [], warned: [] });
  });

  it("retries a failed chown on the next run even though nothing new lands", async () => {
    const e = entry("infra-chown");
    const { deps, calls } = spies({
      applied: "old",
      result: { ...empty, added: [NOTICES] },
      chownFailures: 1,
    });
    await syncMindInfrastructure(e, deps);
    assert.deepEqual(calls.recorded, [], "a failed chown must not record the hash");

    // Second start: the hook is already on disk, so the backfill adds nothing.
    deps.backfill = async () => {
      calls.backfill++;
      return empty;
    };
    await syncMindInfrastructure(e, deps);
    assert.equal(calls.chown.length, 2, "the chown must be retried");
    assert.deepEqual(calls.recorded, ["current"]);
  });

  it("does not record the hash when a file could not be read", async () => {
    const { deps, calls } = spies({
      applied: "old",
      result: { ...empty, unreadable: [NOTICES] },
    });
    await syncMindInfrastructure(entry("infra-unreadable"), deps);
    assert.equal(calls.backfill, 1);
    assert.deepEqual(calls.recorded, []);
  });

  it("retries a permanently unreadable file every start but warns once per hash", async () => {
    // A FIFO the mind planted under `.local/` never becomes readable (#1266).
    const e = entry("infra-unreadable-once");
    const { deps, calls } = spies({
      applied: "old",
      result: { ...empty, unreadable: [NOTICES] },
    });
    await syncMindInfrastructure(e, deps);
    await syncMindInfrastructure(e, deps);
    assert.equal(calls.backfill, 2, "still retried");
    assert.deepEqual(calls.warned, ["current"], "warned once");

    deps.currentHash = () => "next release";
    await syncMindInfrastructure(e, deps);
    assert.deepEqual(calls.warned, ["current", "next release"], "a new hash warns again");
    assert.deepEqual(calls.recorded, []);
  });

  it("skips a registered mind whose directory is gone", async () => {
    const { deps, calls } = spies({ applied: null });
    const e = entry("infra-gone");
    rmSync(mindDir("infra-gone"), { recursive: true, force: true });
    await syncMindInfrastructure(e, deps);
    assert.equal(calls.backfill, 0);
  });
});

describe("syncAllMindInfrastructure", () => {
  const names = ["infra-e2e", "infra-manual", "infra-edited", "infra-stop", "infra-mode"];
  after(async () => {
    for (const name of names) {
      await removeMind(name);
      rmSync(mindDir(name), { recursive: true, force: true });
      rmSync(stateDir(name), { recursive: true, force: true });
    }
  });

  /** A mind as `volute mind create` leaves it, registered, with no infra hash recorded. */
  async function createdMind(name: string, port: number): Promise<string> {
    const dir = mindDir(name);
    await removeMind(name);
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir(name), { recursive: true, force: true });
    const { composedDir, manifest } = composeTemplate(findTemplatesRoot(), "claude");
    try {
      copyTemplateToDir(composedDir, dir, name, manifest);
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
    seedInitLedger(name, applyInitFiles(dir));
    await addMind(name, port, undefined, "claude");
    return resolve(dir, "home");
  }

  it("gives an existing mind a hook it lacks — including an upgrades: manual mind — once", async () => {
    const home = await createdMind("infra-e2e", 49101);
    const manualHome = await createdMind("infra-manual", 49102);
    write(manualHome, ".config/volute.json", JSON.stringify({ upgrades: "manual" }));
    // A mind predating the hook: it isn't there, and no ledger says it was given.
    for (const [name, h] of [
      ["infra-e2e", home],
      ["infra-manual", manualHome],
    ]) {
      rmSync(resolve(h, NOTICES));
      rmSync(resolve(stateDir(name), "init-infrastructure.json"));
    }

    await syncAllMindInfrastructure();

    assert.ok(existsSync(resolve(home, NOTICES)), "the missing hook must be backfilled");
    assert.ok(existsSync(resolve(manualHome, NOTICES)), "manual minds get infrastructure too");
    assert.match(readFileSync(resolve(home, NOTICES), "utf-8"), /history\/notices/);
    assert.equal(readAppliedInfrastructureHash("infra-e2e"), computeInfrastructureHash("claude"));

    // The mind now removes the hook on purpose. The hash is current, so the next start
    // doesn't even look — and the ledger would withhold it if it did.
    rmSync(resolve(home, NOTICES));
    await syncAllMindInfrastructure();
    assert.ok(!existsSync(resolve(home, NOTICES)), "a removal must stay removed");
  });

  it("leaves edited and removed hooks alone when the infrastructure hash moves", async () => {
    const home = await createdMind("infra-edited", 49103);
    write(home, ".local/hooks/pre-prompt/session-activity.ts", "// mine now\n");
    rmSync(resolve(home, NOTICES));
    writeAppliedInfrastructureHash("infra-edited", "an older release");

    await syncAllMindInfrastructure();

    assert.equal(
      readFileSync(resolve(home, ".local/hooks/pre-prompt/session-activity.ts"), "utf-8"),
      "// mine now\n",
    );
    assert.ok(!existsSync(resolve(home, NOTICES)), "the ledger withholds a removal");
    assert.equal(
      readAppliedInfrastructureHash("infra-edited"),
      computeInfrastructureHash("claude"),
    );
  });

  it("restores the exec bit on Volute's own bytes, and leaves an edited shim alone", async () => {
    // An import that dropped modes left `.local/bin/volute` 0644 and off PATH (#1274).
    const home = await createdMind("infra-mode", 49105);
    const shim = resolve(home, ".local/bin/volute");
    chmodSync(shim, 0o644);
    const { refreshed } = await backfillInitInfrastructure(home, "claude", "infra-mode");
    assert.deepEqual(refreshed, [".local/bin/volute"]);
    assert.notEqual(statSync(shim).mode & 0o111, 0, "the wrapper must be executable again");

    writeFileSync(shim, "#!/bin/sh\n# the mind's own wrapper\n");
    chmodSync(shim, 0o644);
    await backfillInitInfrastructure(home, "claude", "infra-mode");
    assert.equal(statSync(shim).mode & 0o777, 0o644, "an edited file's mode is the mind's");
  });

  it("reports a present file the backfill could not read", async () => {
    const home = await createdMind("infra-stop", 49104);
    rmSync(resolve(home, NOTICES));
    mkdirSync(resolve(home, NOTICES)); // a directory where the hook belongs
    const { unreadable } = await backfillInitInfrastructure(home, "claude", "infra-stop");
    assert.deepEqual(unreadable, [NOTICES]);
  });

  it("stops between minds once shutdown begins", async () => {
    const home = await createdMind("infra-stop", 49104);
    rmSync(resolve(home, NOTICES));
    rmSync(resolve(stateDir("infra-stop"), "init-infrastructure.json"));
    await syncAllMindInfrastructure(() => true);
    assert.ok(!existsSync(resolve(home, NOTICES)));
    assert.equal(readAppliedInfrastructureHash("infra-stop"), null);
  });
});
