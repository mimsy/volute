# Electron App for Volute

## Problem

Volute currently requires CLI familiarity, Node.js, and manual setup to install. This limits adoption to technical users. An Electron app provides a double-click install experience for macOS users while keeping the existing daemon/CLI architecture intact.

## Approach

Electron as a thin launcher and window wrapper. The existing daemon runs as a child process inside the app using a bundled Node.js binary. The web UI renders in a BrowserWindow. No architectural changes to the core — Electron is purely a distribution and lifecycle wrapper.

## App Structure

```
packages/electron/
├── src/
│   ├── main.ts          # Electron main process — lifecycle, tray, window
│   └── daemon.ts        # Daemon child process management
├── resources/
│   └── icon.icns        # macOS app icon
├── package.json
├── tsconfig.json
└── electron-builder.yml
```

New package in the monorepo. Does not modify existing Volute code except for the minimal changes listed below.

## Bundled Payload

Copied into the app's `Contents/Resources/` during build:

- `dist/` — built CLI + daemon JS (from existing `npm run build`)
- `drizzle/` — database migrations
- `templates/` — mind templates (_base, claude, pi)
- `skills/` — built-in skills
- `node_modules/` — production dependencies only
- Standalone Node.js binary (~40MB, downloaded during build)

Estimated app size: 400–500MB (Electron ~120MB + Node ~40MB + node_modules + assets).

**Native modules:** `libsql` (better-sqlite3-compatible) includes prebuilt native binaries. The bundled `node_modules` must include the correct prebuilt binary for the target platform/arch. electron-builder's `afterPack` hook can run `npm rebuild` against the bundled Node's ABI if needed, but since the daemon runs in the bundled Node (not Electron's Node), the standard prebuilds should work.

## Runtime Behavior

### Startup Sequence

1. Electron launches, resolves paths to bundled resources (`process.resourcesPath` in production, local paths in dev)
2. Sets `VOLUTE_HOME` to `~/Library/Application Support/Volute`
3. Spawns daemon: `<bundled-node> <bundled-dist>/daemon.js --port <port> --foreground`
4. Waits for daemon health check
5. Opens BrowserWindow at `http://localhost:<port>`
6. If first launch (setup not complete), web UI shows setup flow

### Environment for Child Processes

The daemon already passes env vars to minds. The Electron main process sets:

- `PATH` prepended with the bundled bin directory: `<app>/Contents/Resources/bin/` containing the `node` binary and a `volute` shell script wrapper
- `VOLUTE_HOME` pointing to app data directory (`~/Library/Application Support/Volute`)
- `VOLUTE_NODE_PATH` pointing to bundled Node binary (`<app>/Contents/Resources/bin/node`)

The bundled bin directory also contains `tsx` (or a wrapper that invokes it via the bundled Node + node_modules), since mind-manager uses `tsx` to run mind servers.

### Port Conflict Handling

The daemon already accepts a `--port` flag. The Electron app picks a port (default 1618) and checks availability before spawning. If occupied, it first tries to health-check the existing process (in case it's an orphaned daemon from a previous crash) — if healthy, reuse it; otherwise pick another port.

### System Tray

- Closing the window hides it; app keeps running in background
- Tray menu: Show Window, mind status list (see below), Quit
- Quit triggers graceful daemon shutdown (SIGTERM)

### Auto-Launch (Future)

Optional "Launch at login" via Electron's `app.setLoginItemSettings()`. Not yet implemented.

### Crash Handling

- Daemon dies → main process restarts it
- Electron crashes → daemon orphaned → next launch detects via health check, reuses it

## Data Directory

**Location:** `~/Library/Application Support/Volute/`

Mirrors the `~/.volute/` structure: `volute.db`, `system/`, `state/`, `minds/`, `skills/`, `extensions/`.

**Coexistence:** Independent from any manual CLI install at `~/.volute/`. No migration or sharing — they're separate installations.

## CLI Access

Minds always have CLI access — the daemon prepends the bundled bin directory to `PATH` in child process environments.

For terminal users, the app offers an "Install CLI Tools" action that creates `/usr/local/bin/volute`:

```sh
#!/bin/sh
export VOLUTE_HOME="$HOME/Library/Application Support/Volute"
exec "/Applications/Volute.app/Contents/Resources/node" \
     "/Applications/Volute.app/Contents/Resources/dist/cli.js" "$@"
```

One-time sudo prompt. Not required for the system to function.

## Changes to Existing Code

### Required

1. **Web-based setup flow** — `volute setup` is currently CLI-only (interactive prompts for system name, install type, service install, optional AI provider). Add API endpoints and a frontend setup wizard so setup works in the browser. This benefits all web UI users, not just Electron. The daemon needs to serve the setup UI even before setup is complete (currently, all API routes require auth which requires a user which requires setup). Key endpoints:
   - `GET /api/setup/status` — is setup complete?
   - `POST /api/setup/configure` — accept setup params, write config, create dirs
   - For the Electron case, the setup type is always "local" with sandbox isolation, so the wizard is simpler than the CLI's full options.

2. **Bundled Node for mind spawning** — `mind-manager.ts` spawns minds via `tsx src/server.ts`. When running inside Electron, the daemon needs to use the bundled Node binary. The Electron main process sets `VOLUTE_NODE_PATH` in the daemon's environment; mind-manager reads it when constructing the spawn command.

### Already Supported (No Changes Needed)

- **`VOLUTE_HOME` env var** — `voluteHome()` in `registry.ts` already checks `process.env.VOLUTE_HOME` and falls back to `~/.volute`. Both `cli.ts` and `daemon.ts` set this at startup if unset. The Electron app just needs to set `VOLUTE_HOME` before spawning the daemon. All downstream path resolution (db, state, minds, skills, extensions) flows through `voluteHome()`, `voluteSystemDir()`, `mindDir()`, and `stateDir()` — no hardcoded paths to fix.

### Not Changed

Daemon, web UI, CLI, templates, skills, migrations, connectors, scheduler, sleep manager — all run as-is.

## Build Pipeline

1. `npm run build` — existing tsup + vite build
2. Build script downloads standalone Node.js binary for macOS arm64 (cached)
3. `tsc` compiles Electron sources
4. `electron-builder` packages everything into `.dmg`
   - `extraResources`: dist, drizzle, templates, skills, node binary, pruned node_modules
   - `mac.target`: dmg
   - `mac.category`: public.app-category.developer-tools

### Code Signing

Implemented via `afterSign` hook in electron-builder. Code signing and notarization run in CI when Apple Developer ID credentials are available; without them, builds are unsigned (users bypass Gatekeeper via right-click → Open).

### CI

GitHub Actions workflow on macOS runner. Publishes `.dmg` to GitHub Releases.

## Deferred / Future Work

- **Auto-update**: Not in v1. Users re-download the `.dmg` for updates. electron-builder supports `electron-updater` for future auto-update via GitHub Releases.
- **Sandbox isolation testing**: `@anthropic-ai/sandbox-runtime` may behave differently when spawned from inside an `.app` bundle. Needs testing; may require adjusting sandbox deny-read paths. If broken, fall back to `isolation: "none"` for Electron installs.
- **Linux/Windows**: Future consideration.
- **Universal binary (arm64 + x64)**: Start with arm64 only; add x64 build matrix later.

## Platform

macOS only (arm64). Other platforms and architectures are future considerations.
