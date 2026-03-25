# @volute/cli Standalone Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a standalone `@volute/cli` package that can connect to any Volute daemon over the network, without requiring local filesystem access to `~/.volute/`.

**Architecture:** The CLI currently couples to the daemon via two mechanisms: (1) `daemonFetch()` which reads `~/.volute/system/daemon.json` for the daemon address, and (2) three commands that bypass the daemon to query the DB or filesystem directly. We add `VOLUTE_DAEMON_URL` support to `daemonFetch()`, fix the three commands to proxy through the daemon, and create `packages/cli/` that re-exports the CLI entry point with zero local-state dependencies.

**Tech Stack:** TypeScript, Node.js built-ins, `@volute/api` client library

---

## File Structure

**New files:**
- `packages/cli/package.json` — standalone CLI package manifest
- `packages/cli/tsconfig.json` — TypeScript config
- `packages/cli/src/cli.ts` — CLI entry point (similar to `src/cli.ts` but without server-only commands and with remote daemon support)

**Modified files:**
- `src/lib/daemon-client.ts` — add `VOLUTE_DAEMON_URL` support, decouple from `registry.ts`
- `src/commands/export.ts` — replace `findMind()` with daemon API call
- `src/commands/seed-sprout.ts` — replace `findMind()` with daemon API call
- `src/web/api/minds.ts` — add `GET /api/minds/:name/meta` endpoint for CLI mind lookups
- `src/commands/login.ts` — add `VOLUTE_DAEMON_URL`-aware session storage

**Test files:**
- `test/daemon-client.test.ts` — test `VOLUTE_DAEMON_URL` override behavior
- `test/cli-remote.test.ts` — test that CLI commands work with remote URL

---

## Task 1: Add `VOLUTE_DAEMON_URL` to `daemon-client.ts`

The core change: when `VOLUTE_DAEMON_URL` is set, skip reading `daemon.json` and use the URL directly.

**Files:**
- Modify: `src/lib/daemon-client.ts`
- Test: `test/daemon-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/daemon-client.test.ts`:

```typescript
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

describe("daemon-client", () => {
  describe("VOLUTE_DAEMON_URL override", () => {
    let originalUrl: string | undefined;
    let originalHome: string | undefined;

    before(() => {
      originalUrl = process.env.VOLUTE_DAEMON_URL;
      originalHome = process.env.VOLUTE_HOME;
    });

    after(() => {
      if (originalUrl !== undefined) process.env.VOLUTE_DAEMON_URL = originalUrl;
      else delete process.env.VOLUTE_DAEMON_URL;
      if (originalHome !== undefined) process.env.VOLUTE_HOME = originalHome;
      else delete process.env.VOLUTE_HOME;
    });

    it("resolveUrl returns VOLUTE_DAEMON_URL when set", async () => {
      process.env.VOLUTE_DAEMON_URL = "https://mybox.tailnet:1618";
      const { resolveDaemonUrl } = await import("../src/lib/daemon-client.js");
      const url = resolveDaemonUrl();
      assert.equal(url, "https://mybox.tailnet:1618");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "resolveUrl returns VOLUTE_DAEMON_URL"`
Expected: FAIL — `resolveDaemonUrl` not exported

- [ ] **Step 3: Implement `VOLUTE_DAEMON_URL` support**

In `src/lib/daemon-client.ts`, refactor URL resolution into an exported function and add the env var override:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function voluteUserHome(): string {
  return process.env.VOLUTE_USER_HOME ?? resolve(homedir(), ".volute");
}

function voluteSystemDir(): string {
  const home = process.env.VOLUTE_HOME ?? resolve(homedir(), ".volute");
  return resolve(home, "system");
}

// ... existing readSessionFile, readMindSessionFile, readCliSession unchanged ...

/**
 * Resolve the daemon URL.
 * Priority: VOLUTE_DAEMON_URL env var > daemon.json file
 */
export function resolveDaemonUrl(): string {
  const envUrl = process.env.VOLUTE_DAEMON_URL;
  if (envUrl) return envUrl.replace(/\/$/, "");

  const config = readDaemonConfig();
  return buildUrl(config);
}
```

Then update `daemonFetch` to use `resolveDaemonUrl()`:

```typescript
export async function daemonFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = resolveDaemonUrl();
  // ... rest unchanged, but use `url` instead of calling readDaemonConfig + buildUrl ...
}
```

Key: also remove the import of `voluteSystemDir` and `voluteUserHome` from `registry.ts` and inline them (2 one-liner functions). This removes the dependency on `registry.ts` entirely.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern "resolveUrl returns VOLUTE_DAEMON_URL"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass (no regressions from inlining the two functions)

- [ ] **Step 6: Commit**

```
feat: add VOLUTE_DAEMON_URL support to daemon-client

When VOLUTE_DAEMON_URL is set, the CLI connects to that URL directly
instead of reading daemon.json. Also inlines voluteSystemDir and
voluteUserHome to remove the registry.ts dependency.
```

---

## Task 2: Add mind metadata endpoint

The `export` and `seed-sprout` commands call `findMind()` for metadata (template, stage, directory). Add a daemon endpoint that returns this.

**Files:**
- Modify: `src/web/api/minds.ts`
- Test: `test/daemon-e2e.test.ts` (add to existing e2e tests)

- [ ] **Step 1: Check existing mind detail endpoint**

The `GET /api/minds/:name` endpoint already returns mind info. Check if it includes `template` and `stage` fields. Read `src/web/api/minds.ts` to verify. If it already returns all fields that `findMind()` provides (name, port, template, stage, directory), no new endpoint is needed — just use the existing one.

- [ ] **Step 2: If needed, add missing fields to existing endpoint**

If the existing `GET /api/minds/:name` response doesn't include `template` or `stage`, add them. The response type `Mind` from `@volute/api` should already include these.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit (if changes were needed)**

```
feat: include template and stage in mind detail API response
```

---

## Task 3: Fix `export.ts` to use daemon API

Replace direct `findMind()` call with `daemonFetch` to the mind detail endpoint.

**Files:**
- Modify: `src/commands/export.ts`

- [ ] **Step 1: Read current `export.ts` and identify the `findMind()` usage**

The command uses `findMind(name)` to get the mind's template and stage for archive metadata. It also uses `mindDir(name)` for the archive source path.

- [ ] **Step 2: Replace `findMind()` with daemon API call**

Replace:
```typescript
import { findMind, mindDir } from "../lib/registry.js";
const mind = await findMind(name);
```

With:
```typescript
import { daemonFetch } from "../lib/daemon-client.js";
const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}`);
if (!res.ok) {
  console.error(`Mind "${name}" not found`);
  process.exit(1);
}
const mind = await res.json();
```

For `mindDir()`: the export command reads files from the mind's directory. When running remotely, this won't work — the mind's files aren't local. For now, keep `mindDir()` but guard it: if `VOLUTE_DAEMON_URL` is set and the directory doesn't exist locally, error with a clear message that export requires local access. This is an honest limitation — full remote export would need a daemon endpoint that streams the archive.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```
refactor: use daemon API for mind lookup in export command
```

---

## Task 4: Fix `seed-sprout.ts` to use daemon API

Replace direct `findMind()` call with daemon API.

**Files:**
- Modify: `src/commands/seed-sprout.ts`

- [ ] **Step 1: Replace `findMind()` with daemon API call**

The command uses `findMind(mindName)` to verify the mind's stage is "seed". Replace with:

```typescript
const res = await daemonFetch(`/api/minds/${encodeURIComponent(mindName)}`);
if (!res.ok) {
  console.error(`Mind "${mindName}" not found`);
  process.exit(1);
}
const mind = await res.json();
if (mind.stage !== "seed") {
  console.error(`${mindName} is not a seed`);
  process.exit(1);
}
```

The remaining filesystem access (reading SOUL.md, MEMORY.md, avatar) stays — `seed sprout` runs from within the mind's directory (it's called by the seed mind itself, so it always has local access).

- [ ] **Step 2: Remove `findMind` import, add `daemonFetch` if not already imported**

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```
refactor: use daemon API for mind lookup in seed-sprout command
```

---

## Task 5: Update `login.ts` for remote daemon awareness

When `VOLUTE_DAEMON_URL` is set, `login.ts` should also store the daemon URL alongside the session so subsequent commands know where to connect.

**Files:**
- Modify: `src/commands/login.ts`
- Modify: `src/lib/daemon-client.ts` (read stored URL from session)

- [ ] **Step 1: Update login to save daemon URL**

In `login.ts`, when `VOLUTE_DAEMON_URL` is set, include it in the session file:

```typescript
const sessionData: Record<string, string> = { sessionId, username: name };
const daemonUrl = process.env.VOLUTE_DAEMON_URL;
if (daemonUrl) sessionData.daemonUrl = daemonUrl;
writeFileSync(sessionPath, JSON.stringify(sessionData), { mode: 0o600 });
```

- [ ] **Step 2: Update `daemon-client.ts` to read stored URL**

In `resolveDaemonUrl()`, add fallback to stored session URL:

```typescript
export function resolveDaemonUrl(): string {
  // 1. Explicit env var
  const envUrl = process.env.VOLUTE_DAEMON_URL;
  if (envUrl) return envUrl.replace(/\/$/, "");

  // 2. Stored in CLI session (from previous `volute login` with VOLUTE_DAEMON_URL)
  const session = readCliSession();
  if (session?.daemonUrl) return session.daemonUrl;

  // 3. Local daemon.json
  const config = readDaemonConfig();
  return buildUrl(config);
}
```

Update the `CliSession` type:

```typescript
type CliSession = { sessionId: string; username: string; daemonUrl?: string };
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```
feat: persist daemon URL in CLI session for remote connections
```

---

## Task 6: Update setup gate for remote CLI

When connecting to a remote daemon, `isSetupComplete()` reads local config which doesn't exist. The CLI should skip the local setup check when `VOLUTE_DAEMON_URL` is set (the remote daemon handles its own setup).

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Guard setup check**

In `src/cli.ts`, skip the `isSetupComplete()` check when a remote daemon URL is configured:

```typescript
if (!ungatedCommands.has(command)) {
  // Remote CLI doesn't need local setup — the daemon handles it
  const hasRemoteUrl = !!process.env.VOLUTE_DAEMON_URL;
  if (!hasRemoteUrl) {
    // Also check stored session for daemon URL
    // (can't import daemon-client here due to circular — just check the file directly)
  }
  if (!hasRemoteUrl) {
    const { isSetupComplete } = await import("./lib/setup.js");
    if (!isSetupComplete()) {
      console.error("Volute is not set up. Run `volute setup` first.");
      process.exit(1);
    }
  }
}
```

Actually simpler: read the CLI session file inline to check for `daemonUrl`:

```typescript
if (!ungatedCommands.has(command)) {
  let isRemote = !!process.env.VOLUTE_DAEMON_URL;
  if (!isRemote) {
    try {
      const { readFileSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const { resolve } = await import("node:path");
      const sessionPath = resolve(
        process.env.VOLUTE_USER_HOME ?? resolve(homedir(), ".volute"),
        "cli-session.json",
      );
      const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
      if (session.daemonUrl) isRemote = true;
    } catch { /* no session file */ }
  }
  if (!isRemote) {
    const { isSetupComplete } = await import("./lib/setup.js");
    if (!isSetupComplete()) {
      console.error("Volute is not set up. Run `volute setup` first.");
      process.exit(1);
    }
  }
}
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```
fix: skip local setup check when CLI is connected to remote daemon
```

---

## Task 7: Create `packages/cli/` package

The standalone CLI package. It re-uses the same command files from `src/commands/` but has its own entry point that excludes server-only commands (`up`, `down`, `setup`, `update`, `service`).

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/cli.ts`
- Create: `packages/cli/src/lib/daemon-client.ts` — standalone version (no registry.ts import)
- Create: `packages/cli/src/lib/prompt.ts` — copy or re-export

- [ ] **Step 1: Assess build strategy**

Two options:
1. **Bundled** — use `tsup` to bundle the CLI commands + lib into a single file (like the main volute CLI). Zero runtime dependencies on the monorepo.
2. **Source re-export** — `packages/cli/` imports from `../../src/commands/` directly. Only works in the monorepo, not as a standalone npm package.

Go with option 1 (bundled via tsup). This makes `@volute/cli` truly standalone and publishable.

- [ ] **Step 2: Create `packages/cli/package.json`**

```json
{
  "name": "@volute/cli",
  "version": "0.0.1",
  "description": "Volute CLI client — connect to any Volute daemon",
  "type": "module",
  "bin": {
    "volute-cli": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsup src/cli.ts --format esm --target node22 --outDir dist --clean"
  },
  "files": ["dist/"],
  "devDependencies": {
    "tsup": "^8.0.0"
  }
}
```

- [ ] **Step 3: Create `packages/cli/src/cli.ts`**

This is a stripped-down version of `src/cli.ts` that:
- Excludes `up`, `down`, `setup`, `update`, `restart` (daemon restart), `service`, `status`
- Uses `VOLUTE_DAEMON_URL` (required) or stored session URL
- Skips the `isSetupComplete()` gate entirely (remote daemon handles it)

```typescript
#!/usr/bin/env node
process.noDeprecation = true;

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "mind":
    await import("../../../src/commands/mind.js").then((m) => m.run(args));
    break;
  case "seed":
    await import("../../../src/commands/seed-cmd.js").then((m) => m.run(args));
    break;
  case "chat":
    await import("../../../src/commands/chat.js").then((m) => m.run(args));
    break;
  // ... all daemon-proxy commands ...
  case "login":
    await import("../../../src/commands/login.js").then((m) => m.run(args));
    break;
  case "logout":
    await import("../../../src/commands/logout.js").then((m) => m.run(args));
    break;
  case "--help":
  case "-h":
  case undefined:
    console.log(`volute-cli — connect to a remote Volute daemon

Usage: VOLUTE_DAEMON_URL=https://mybox:1618 volute-cli <command>
   or: volute-cli login   (after setting VOLUTE_DAEMON_URL once)

Commands:
  mind    Create, start, stop, and manage minds
  seed    Plant and sprout new minds
  chat    Send messages, manage conversations
  clock   Schedules, timers, sleep/wake
  skill   Browse and manage skills
  env     Environment variables
  config  AI models and providers
  login   Authenticate with the daemon
  logout  Clear saved session
`);
    break;
  default:
    console.error(`Unknown command: ${command}. Run volute-cli --help for usage.`);
    process.exit(1);
}
```

Note: tsup will bundle the imports, pulling in the command files and their dependencies. The key requirement is that after Tasks 1-6, none of those command files import from `registry.ts` (DB) — they only use `daemon-client.ts` (which we've decoupled).

- [ ] **Step 4: Build and test**

```bash
cd packages/cli
npm run build
./dist/cli.js --help
```

Expected: help text prints. No errors about missing modules.

- [ ] **Step 5: Test with a remote daemon**

```bash
VOLUTE_DAEMON_URL=http://localhost:1618 ./dist/cli.js mind list
```

Expected: lists minds from the local daemon (using the URL override).

- [ ] **Step 6: Commit**

```
feat: add @volute/cli standalone remote CLI package
```

---

## Task 8: Verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All 1400+ tests pass

- [ ] **Step 2: Build main project**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Build @volute/cli**

Run: `cd packages/cli && npm run build`
Expected: Clean bundle

- [ ] **Step 4: End-to-end test**

Start a local daemon, then test the standalone CLI against it:

```bash
# Terminal 1: start daemon
volute up

# Terminal 2: test standalone CLI
cd packages/cli
VOLUTE_DAEMON_URL=http://localhost:1618 ./dist/cli.js login
VOLUTE_DAEMON_URL=http://localhost:1618 ./dist/cli.js mind list
```

- [ ] **Step 5: Commit any fixes**
