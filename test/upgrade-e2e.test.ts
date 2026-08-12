import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { createClient } from "@libsql/client";

/**
 * Cross-version upgrade e2e (#830).
 *
 * Nothing else in the suite proves that an *existing installation* survives
 * `volute update` — yet once Volute has outside users, every release is an
 * upgrade executed on a stranger's populated machine, and the update path is
 * the only channel for shipping fixes. This test is the enforcement mechanism
 * behind the "DB always migrates forward" promise (#713).
 *
 * It runs the last published release as a real daemon, populates real state (a
 * mind copied from that release's template, a persisted message, a schedule, DB
 * rows), then boots the working-tree daemon against the *same* VOLUTE_HOME and
 * asserts the state survived the forward migration.
 *
 * The prior release is the published npm artifact — the exact bytes an outsider
 * would have installed — not a rebuild from source. Everything is driven through
 * the daemon HTTP API (stable across these versions) plus a direct read of the
 * migrations table. It runs in its own VOLUTE_HOME under /tmp and never touches
 * the shared per-process test home from test/setup.ts.
 *
 * Skips gracefully (never fails CI) when the prior release can't be obtained:
 * not a git checkout, no prior tag, or npm can't reach the registry.
 */

const REPO_ROOT = process.cwd();

/** Parse "x.y.z" into a comparable tuple; null if not a clean semver. */
function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * The version to upgrade *from*: `VOLUTE_UPGRADE_FROM` if set, else the highest
 * `volute-v*` git tag strictly below the working-tree version. Deterministic —
 * it reads local tags, not the npm registry. Returns null (→ skip) when there's
 * no git, no tags, or no release older than HEAD (a fresh repo / first release).
 */
function resolvePriorVersion(): string | null {
  if (process.env.VOLUTE_UPGRADE_FROM) return process.env.VOLUTE_UPGRADE_FROM;

  const current = parseVersion(
    JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8")).version,
  );
  if (!current) return null;

  let tags: string;
  try {
    tags = execFileSync("git", ["tag", "--list", "volute-v*"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
  } catch {
    return null; // not a git checkout
  }

  const candidates = tags
    .split("\n")
    .map((t) => t.trim().replace(/^volute-v/, ""))
    .map((v) => ({ v, parsed: parseVersion(v) }))
    .filter((c): c is { v: string; parsed: [number, number, number] } => c.parsed !== null)
    .filter((c) => compareVersion(c.parsed, current) < 0)
    .sort((a, b) => compareVersion(a.parsed, b.parsed));

  return candidates.length > 0 ? candidates[candidates.length - 1].v : null;
}

// Strip GIT_* env vars that hook runners (e.g. pre-push) inject, so spawned
// git/npm operations target the scratch dirs, not the parent repo.
const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("GIT_") && v !== undefined) cleanEnv[k] = v;
}
// A dummy key so the created mind is treated as credentialed (mind creation is
// refused on a providerless system, #606). Deterministic across hosts.
if (!cleanEnv.ANTHROPIC_API_KEY) cleanEnv.ANTHROPIC_API_KEY = "sk-ant-e2e-dummy-key";

const PRIOR_VERSION = resolvePriorVersion();

/**
 * Why the 0.57.0-migration assertions below need a gate: `PRIOR_VERSION` tracks the
 * latest release, so from 0.57.1 onward the prior release already *contains* those
 * migrations and their "pre-migration shape" premises are false by construction.
 * Reason string (null = the assertions apply), so each skip says why out loud.
 *
 * This gate narrows *when* those assertions run, never *what* they assert: pointed
 * at a pre-0.57.0 prior (`VOLUTE_UPGRADE_FROM=0.56.0`) every one of them still runs
 * unchanged, and still fails if its migration were reverted.
 */
const PRE_057_SKIP: string | null = (() => {
  const prior = PRIOR_VERSION ? parseVersion(PRIOR_VERSION) : null;
  if (!prior) return "prior version unparseable — cannot establish a pre-0.57.0 baseline";
  return compareVersion(prior, [0, 57, 0]) < 0
    ? null
    : `prior ${PRIOR_VERSION} already carries the 0.57.0 migrations (needs VOLUTE_UPGRADE_FROM=0.56.0)`;
})();

const MIND = "upgrade-mind";
const TOKEN = `upgrade-e2e-token-${process.pid}`;
const DAEMON_PORT = 18100 + Math.floor(Math.random() * 700);
const MIND_BASE_PORT = 18900 + Math.floor(Math.random() * 90);
const BASE_URL = `http://127.0.0.1:${DAEMON_PORT}`;

const tmpRoot = process.platform === "darwin" ? "/tmp" : tmpdir();
const SCRATCH = resolve(tmpRoot, `volute-upgrade-e2e-${process.pid}`);
const HOME_DIR = resolve(SCRATCH, "home");
const INSTALL_PREFIX = resolve(SCRATCH, "prior");
const MIND_DIR = resolve(HOME_DIR, "minds", MIND);
const DB_PATH = resolve(HOME_DIR, "system", "volute.db");
const PAGES_DB_PATH = resolve(HOME_DIR, "system", "extension-data", "pages", "data.db");

// A second mind created *after* the upgrade — its "has joined" is the announcement
// the migrated spirit must receive (assertion: commons delivery, #817).
const NEW_MIND = "commons-newcomer";
// The commons page seeded under the pre-migration `_system` identity.
const COMMONS_PAGE_FILE = "e2e-commons-note.html";

function req(path: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  headers.set("Origin", BASE_URL);
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

async function waitForHealth(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE_URL}/api/health`)).ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`daemon did not become healthy within ${timeoutMs}ms`);
}

async function waitForMindRunning(timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "unknown";
  while (Date.now() < deadline) {
    try {
      const res = await req(`/api/v1/minds/${MIND}`);
      last = ((await res.json()) as { status?: string }).status ?? "unknown";
      if (last === "running") return;
    } catch {
      // daemon may briefly refuse a connection during a long sync block
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`mind did not reach running within ${timeoutMs}ms (last status: ${last})`);
}

function listeningPids(port: number): number[] {
  try {
    return execFileSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((p) => Number.parseInt(p, 10));
  } catch {
    // lsof exits non-zero when nothing is listening
    return [];
  }
}

/** SIGTERM a daemon child and wait for it to exit (SIGKILL fallback). */
async function stopDaemon(proc: ChildProcess): Promise<void> {
  if (proc.killed) return;
  proc.kill("SIGTERM");
  await new Promise<void>((resolveExit) => {
    proc.on("exit", () => resolveExit());
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      resolveExit();
    }, 8000);
  });
}

/**
 * Reap anything still listening on a port. `node ... daemon.js` and `npx tsx`
 * both hand off to a grandchild whose listening socket can outlive the SIGTERM
 * we send to the process we spawned; left unreaped it fails the next bind. Same
 * hazard applies to the mind server's own port.
 */
async function reapPort(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (listeningPids(port).length === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const pid of listeningPids(port)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/** Migrations recorded in the scratch DB (a direct read, independent of the daemon). */
async function appliedMigrationCount(): Promise<number> {
  const client = createClient({ url: `file:${DB_PATH}` });
  try {
    const r = await client.execute("SELECT count(*) AS n FROM __drizzle_migrations");
    return Number(r.rows[0].n);
  } finally {
    client.close();
  }
}

/** Migration files shipped by the working tree (what a full migration should reach). */
function headMigrationCount(): number {
  return readdirSync(resolve(REPO_ROOT, "drizzle")).filter((f) => f.endsWith(".sql")).length;
}

/**
 * Raw libsql read/write against a scratch DB file. The in-process getDb() is bound
 * to the per-process test home (test/setup.ts), so it can't see this scratch
 * VOLUTE_HOME — the migration assertions and prior-state seeding must go straight to
 * the file, exactly like appliedMigrationCount() above.
 */
async function queryDb<T = Record<string, unknown>>(
  dbPath: string,
  sql: string,
  args: (string | number | null)[] = [],
): Promise<T[]> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const r = await client.execute({ sql, args });
    return r.rows as unknown as T[];
  } finally {
    client.close();
  }
}

// State captured while the prior release is running, verified after the upgrade.
let conversationId = "";
let skipReason: string | null = PRIOR_VERSION ? null : "no prior release tag found";
let priorDaemon: ChildProcess | undefined;
let headDaemon: ChildProcess | undefined;

// The prior release's pre-migration shapes, captured off the scratch DB after the
// prior daemon stops (files unlocked) and before the HEAD daemon runs its
// migrations. These are both the step-0 premise (0.56.0 predates all three
// migrations) and the inputs the post-upgrade assertions compare against.
let priorChannelName: string | null = null;
let priorHadIsDefaultColumn = true;
let priorSpiritRole: string | null = null;
let priorSpiritUserType: string | null = null;
// null once the prior `_system` pages row is seeded; otherwise the reason the pages
// data-migration assertion must skip (never assert vacuously on an unseeded shape).
let pagesSeedReason: string | null = null;

describe("cross-version upgrade e2e", { timeout: 600000 }, () => {
  before(async () => {
    if (!PRIOR_VERSION) return; // nothing to do; every it() will skip

    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(resolve(HOME_DIR, "system"), { recursive: true });
    mkdirSync(INSTALL_PREFIX, { recursive: true });

    // 1. Install the previous *published* release into a scratch prefix — the
    //    exact artifact an outsider would have on disk. A registry failure
    //    (offline CI, unpublished version) degrades to a graceful skip.
    writeFileSync(
      resolve(INSTALL_PREFIX, "package.json"),
      JSON.stringify({ name: "volute-upgrade-e2e-prior", private: true }),
    );
    try {
      execFileSync(
        "npm",
        [
          "install",
          `volute@${PRIOR_VERSION}`,
          "--no-audit",
          "--no-fund",
          "--prefer-offline",
          "--loglevel=error",
        ],
        { cwd: INSTALL_PREFIX, stdio: "pipe", timeout: 300000, env: cleanEnv },
      );
    } catch (err) {
      skipReason = `could not install volute@${PRIOR_VERSION}: ${(err as Error).message.slice(0, 200)}`;
      return;
    }
    const priorDaemonJs = resolve(INSTALL_PREFIX, "node_modules", "volute", "dist", "daemon.js");
    if (!existsSync(priorDaemonJs)) {
      skipReason = `installed volute@${PRIOR_VERSION} has no dist/daemon.js`;
      return;
    }
    // Canonicalize: on macOS the scratch dir is under /tmp → /private/tmp, and the
    // daemon's own "am I the entry module?" guard compares `import.meta.url`
    // (realpath'd) against `file://<argv[1]>`. Passing the /tmp path makes them
    // differ, so the daemon loads but never boots and exits 0 in silence.
    const priorDaemonEntry = realpathSync(priorDaemonJs);

    // Config both versions accept: setup complete + a configured model so mind
    // creation isn't refused (#606). config.json is host-readable and carries no
    // secrets.
    writeFileSync(
      resolve(HOME_DIR, "system", "config.json"),
      JSON.stringify({
        setup: { type: "local", isolation: "none" },
        ai: { models: ["anthropic:claude-sonnet-4-5"] },
      }),
    );

    const daemonEnv = {
      ...cleanEnv,
      VOLUTE_HOME: HOME_DIR,
      VOLUTE_USER_HOME: HOME_DIR,
      VOLUTE_DAEMON_TOKEN: TOKEN,
      VOLUTE_BASE_PORT: String(MIND_BASE_PORT),
    };

    // 2. Boot the prior release and populate real state through its API.
    priorDaemon = spawn("node", [priorDaemonEntry, "--port", String(DAEMON_PORT), "--foreground"], {
      cwd: INSTALL_PREFIX,
      stdio: ["ignore", "pipe", "pipe"],
      env: daemonEnv,
    });
    priorDaemon.on("error", (e) => process.stderr.write(`[prior-daemon] spawn error: ${e}\n`));
    priorDaemon.on("exit", (code, sig) =>
      process.stderr.write(`[prior-daemon] exit code=${code} sig=${sig}\n`),
    );
    // Consume BOTH streams: the daemon logs heavily to stdout in the foreground,
    // and an unconsumed pipe buffer fills and blocks its writes, deadlocking
    // startup before it ever binds.
    priorDaemon.stdout?.on("data", (d: Buffer) => process.stderr.write(`[prior-daemon] ${d}`));
    priorDaemon.stderr?.on("data", (d: Buffer) => process.stderr.write(`[prior-daemon] ${d}`));
    await waitForHealth();

    const version = (await (await fetch(`${BASE_URL}/api/health`)).json()) as { version?: string };
    assert.equal(version.version, PRIOR_VERSION, "prior daemon should report the prior version");

    // Create a mind from the prior release's template.
    const createRes = await req("/api/v1/minds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: MIND }),
    });
    assert.ok(
      createRes.status === 200 || createRes.status === 201,
      `create mind: ${createRes.status} ${await createRes.text()}`,
    );
    assert.ok(existsSync(MIND_DIR), "mind directory should exist after create");

    // Disable scheduled sleep so the shared mind never auto-sleeps mid-run.
    const cfgPath = resolve(MIND_DIR, "home", ".config", "volute.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    cfg.sleep = { ...(cfg.sleep ?? {}), enabled: false };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    // Install the mind's dependencies so its server can start.
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline"], {
      cwd: MIND_DIR,
      stdio: "pipe",
      timeout: 180000,
      env: cleanEnv,
    });
    await waitForHealth(); // the long sync install may have dropped keep-alives

    // A schedule (persisted to the mind's volute.json).
    const schedRes = await req(`/api/v1/minds/${MIND}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "e2e-morning", cron: "0 8 * * *", message: "good morning" }),
    });
    assert.equal(schedRes.status, 201, `add schedule: ${await schedRes.clone().text()}`);

    // A message (persisted to the DB), captured by conversation id for read-back.
    const chatRes = await req("/api/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetMind: MIND,
        sender: "e2e-visitor",
        message: "hello before upgrade",
      }),
    });
    assert.equal(chatRes.status, 200, `send message: ${await chatRes.clone().text()}`);
    conversationId = ((await chatRes.json()) as { conversationId: string }).conversationId;
    assert.ok(conversationId, "chat should return a conversation id");

    // Start the mind and let it come up, so the registry records running:true —
    // that's what the working-tree daemon auto-restores after the upgrade.
    const startRes = await req(`/api/v1/minds/${MIND}/start`, { method: "POST" });
    assert.equal(startRes.status, 200, `start mind: ${await startRes.clone().text()}`);
    await waitForMindRunning();

    // 3-4. Shut the prior daemon down (leaving state on disk) and bring the
    //      working-tree daemon up on the same VOLUTE_HOME — the update + restart.
    await stopDaemon(priorDaemon);
    priorDaemon = undefined;
    await reapPort(DAEMON_PORT);
    await reapPort(MIND_BASE_PORT);

    // --- Both daemons are down, so the scratch DB files are unlocked. Capture the
    //     prior release's pre-migration shapes (step 0) and seed the pages migration
    //     input, before the HEAD daemon runs its migrations against this state. ---

    // channels: 0.56.0 predates the `is_default` column; its sole default channel is
    // named "system" (ensureSystemChannel), created without any default marker.
    const chanCols = await queryDb<{ name: string }>(DB_PATH, "PRAGMA table_info(channels)");
    priorHadIsDefaultColumn = chanCols.some((c) => c.name === "is_default");
    // Capture by the same identity the 0002 migration keys on (name in system/#system),
    // not "the only channel", so an unrelated channel can't perturb the premise.
    const chanRows = await queryDb<{ name: string }>(
      DB_PATH,
      "SELECT name FROM channels WHERE name IN ('system', '#system')",
    );
    priorChannelName = chanRows.length === 1 ? chanRows[0].name : null;

    // users: 0.56.0 writes the spirit (the shared system user) as role='system',
    // user_type='system' — the shape all three 0.57.0 migrations move off of.
    const spiritRows = await queryDb<{ role: string; user_type: string }>(
      DB_PATH,
      "SELECT role, user_type FROM users WHERE user_type IN ('system', 'spirit')",
    );
    if (spiritRows.length === 1) {
      priorSpiritRole = spiritRows[0].role;
      priorSpiritUserType = spiritRows[0].user_type;
    }

    // pages: seed a commons page under the OLD `_system` identity so the pages
    // extension's initDb data-migration (`_system` → `_commons`, #819) has real
    // pre-existing data to move. This is a DIRECT libsql INSERT, NOT the real publish
    // path: publishing a commons page through the 0.56.0 API needs a git worktree +
    // spirit pipeline not worth standing up here, and the brief sanctions the insert
    // fallback. A paired page_comments row gives the page a thread, so HEAD's on-boot
    // syncSystemPages tombstones the (disk-absent) page instead of deleting an orphan
    // — leaving the row present under the migrated `_commons` mind, which is what the
    // assertion checks. The 301-redirect assertion is a pure route and needs none of
    // this seeding.
    if (!existsSync(PAGES_DB_PATH)) {
      pagesSeedReason = `prior pages DB absent at ${PAGES_DB_PATH}`;
    } else {
      try {
        await queryDb(
          PAGES_DB_PATH,
          "INSERT INTO published_pages (mind, file, author) VALUES ('_system', ?, ?)",
          [COMMONS_PAGE_FILE, "e2e"],
        );
        await queryDb(
          PAGES_DB_PATH,
          "INSERT INTO page_comments (mind, file, author_id, content) VALUES ('_system', ?, ?, ?)",
          [COMMONS_PAGE_FILE, 1, "e2e thread keeper"],
        );
      } catch (err) {
        pagesSeedReason = `could not seed prior pages _system row: ${(err as Error).message.slice(0, 200)}`;
      }
    }

    headDaemon = spawn(
      "npx",
      ["tsx", "packages/daemon/src/daemon.ts", "--port", String(DAEMON_PORT), "--foreground"],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: daemonEnv },
    );
    headDaemon.on("error", (e) => process.stderr.write(`[head-daemon] spawn error: ${e}\n`));
    headDaemon.on("exit", (code, sig) =>
      process.stderr.write(`[head-daemon] exit code=${code} sig=${sig}\n`),
    );
    headDaemon.stdout?.on("data", (d: Buffer) => process.stderr.write(`[head-daemon] ${d}`));
    headDaemon.stderr?.on("data", (d: Buffer) => process.stderr.write(`[head-daemon] ${d}`));
    await waitForHealth();
  });

  after(async () => {
    if (priorDaemon) await stopDaemon(priorDaemon);
    if (headDaemon) await stopDaemon(headDaemon);
    await reapPort(DAEMON_PORT);
    await reapPort(MIND_BASE_PORT);
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it("migrations apply forward and the mind's state survives the upgrade", async (t) => {
    if (skipReason) return t.skip(skipReason);

    // After migration squash (#713), the prior release may have more migrations
    // applied than HEAD ships (HEAD has 1 idempotent baseline; prior had 20).
    // The baseline runs as a no-op on existing installs, so we just verify the
    // DB is healthy with at least the HEAD count applied.
    const [applied, minExpected] = [await appliedMigrationCount(), headMigrationCount()];
    assert.ok(
      applied >= minExpected,
      `expected at least ${minExpected} applied migrations (working-tree drizzle/), found ${applied}`,
    );

    // The mind the prior release created starts and responds under the new code.
    await waitForMindRunning();

    // History survived: the message stored by the prior daemon reads back.
    const msgsRes = await req(`/api/v1/minds/${MIND}/conversations/${conversationId}/messages`);
    assert.equal(msgsRes.status, 200, `read messages: ${await msgsRes.clone().text()}`);
    const { items } = (await msgsRes.json()) as {
      items: { content: { type: string; text?: string }[] }[];
    };
    const text = items
      .flatMap((m) => m.content)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    assert.match(text, /hello before upgrade/, `message text lost: ${text}`);

    // Config + schedules survived: the mind's volute.json still carries the
    // schedule the prior release added.
    const schedRes = await req(`/api/v1/minds/${MIND}/schedules`);
    assert.equal(schedRes.status, 200, `read schedules: ${await schedRes.clone().text()}`);
    const schedules = (await schedRes.json()) as { id: string }[];
    assert.ok(
      schedules.some((s) => s.id === "e2e-morning"),
      `schedule lost across upgrade: ${JSON.stringify(schedules.map((s) => s.id))}`,
    );
  });

  it("volute mind upgrade of the prior-release template succeeds", async (t) => {
    if (skipReason) return t.skip(skipReason);

    // Upgrade the mind's on-disk template (copied from the prior release) to the
    // working tree's. The merge is the assertion; a failed `npm install` step
    // afterwards (e.g. an unpublished dep in an offline environment) surfaces as
    // a non-fatal warning and doesn't mean the upgrade merge failed.
    const res = await req(`/api/v1/minds/${MIND}/upgrade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200, `upgrade: ${res.status} ${await res.clone().text()}`);
    const body = (await res.json()) as { ok?: boolean; conflicts?: boolean; warning?: string };
    assert.equal(body.ok, true, `upgrade not ok: ${JSON.stringify(body)}`);
    assert.notEqual(body.conflicts, true, "template upgrade should not conflict");
    if (body.warning) process.stderr.write(`[upgrade-e2e] upgrade warning: ${body.warning}\n`);
  });

  // ---------------------------------------------------------------------------
  // 0.57.0 (milestone 9) is almost entirely migrations against live data. The
  // per-PR unit tests prove each migration on a fresh DB; the following assert the
  // same three migrations + the redirect + the spirit announcement landed on the
  // *real pre-existing* 0.56.0 state seeded above — the proof a fresh-DB test can't
  // give. Each is written to FAIL if its migration were reverted, and to SKIP (never
  // fail) wherever the harness itself skips.
  //
  // The three that read a *pre-migration* shape carry `PRE_057_SKIP`: they are
  // assertions about the 0.56.0 → 0.57.0 boundary specifically, and a prior release
  // at or past 0.57.0 arrives already migrated. The two that seed their own input
  // (pages redirect, `_system` → `_commons` rows) stay ungated — they exercise HEAD's
  // live behaviour against data this test writes, whatever the prior version is.
  // ---------------------------------------------------------------------------

  it("prior 0.56.0 carried the pre-migration shapes (premise)", async (t) => {
    if (skipReason) return t.skip(skipReason);
    if (PRE_057_SKIP) return t.skip(PRE_057_SKIP);

    // If any of these drift, the upgrade assertions below would pass vacuously
    // against an already-new shape — so fail loudly here rather than silently.
    assert.equal(
      priorHadIsDefaultColumn,
      false,
      "0.56.0 channels should predate the is_default column",
    );
    assert.ok(
      priorChannelName === "system" || priorChannelName === "#system",
      `expected a single legacy default channel named system/#system, got ${JSON.stringify(priorChannelName)}`,
    );
    assert.equal(
      priorSpiritUserType,
      "system",
      "0.56.0 should write the spirit as user_type='system'",
    );
    assert.equal(priorSpiritRole, "system", "0.56.0 should write the spirit as role='system'");
  });

  it("channels: is_default backfilled onto the one default channel, name preserved", async (t) => {
    if (skipReason) return t.skip(skipReason);
    if (PRE_057_SKIP) return t.skip(PRE_057_SKIP);

    // Needs no seeding — the prior boot auto-created the default channel; the 0002
    // migration marks it.
    const rows = await queryDb<{ name: string; is_default: number }>(
      DB_PATH,
      "SELECT name, is_default FROM channels",
    );
    const defaults = rows.filter((r) => Number(r.is_default) === 1);
    assert.equal(
      defaults.length,
      1,
      `exactly one channel should carry is_default=1, got ${JSON.stringify(rows)}`,
    );
    // Marked, never renamed: the flag lands on the exact legacy name 0.56.0 created.
    assert.equal(
      defaults[0].name,
      priorChannelName,
      `default channel was renamed across upgrade (prior name: ${priorChannelName})`,
    );
  });

  it("users: the spirit's role and user_type migrate to 'spirit'", async (t) => {
    if (skipReason) return t.skip(skipReason);
    // Gated even though it would pass against a 0.57.0 prior: that prior writes the
    // spirit as 'spirit' already, so the assertion would hold without any migration
    // having run — a pass that proves nothing is the thing this file refuses.
    if (PRE_057_SKIP) return t.skip(PRE_057_SKIP);

    // Needs no seeding — the prior boot auto-created the spirit. Drizzle 0001 moves
    // user_type 'system' → 'spirit'; the daemon.ts boot-migration then moves role.
    const rows = await queryDb<{ role: string; user_type: string }>(
      DB_PATH,
      "SELECT role, user_type FROM users WHERE user_type = 'spirit'",
    );
    assert.equal(rows.length, 1, `exactly one spirit user expected, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0].user_type, "spirit", "0001 should rewrite user_type 'system' → 'spirit'");
    assert.equal(rows[0].role, "spirit", "the boot-migration should rewrite the spirit's role");
    const legacy = await queryDb(DB_PATH, "SELECT 1 FROM users WHERE user_type = 'system'");
    assert.equal(legacy.length, 0, "no user_type='system' rows should survive the upgrade");
  });

  it("pages: legacy _system URLs 301-redirect to _commons", async (t) => {
    if (skipReason) return t.skip(skipReason);

    // A pure route (no DB dependency), so it always asserts. redirect:"manual" is
    // mandatory — a real fetch auto-follows the 301 and hides it. 0.56.0 served
    // _system content here; HEAD redirects, so this fails if the redirect is reverted.
    const res = await fetch(`${BASE_URL}/ext/pages/public/_system/${COMMONS_PAGE_FILE}`, {
      redirect: "manual",
    });
    assert.equal(res.status, 301, `expected a 301 for a legacy _system URL, got ${res.status}`);
    assert.equal(
      res.headers.get("location"),
      `/ext/pages/public/_commons/${COMMONS_PAGE_FILE}`,
      "the _system URL should redirect to its _commons equivalent",
    );
  });

  it("pages: persisted _system commons rows migrate to _commons", async (t) => {
    if (skipReason) return t.skip(skipReason);
    if (pagesSeedReason) return t.skip(`pages row migration not asserted: ${pagesSeedReason}`);

    // The seeded `_system` row must have moved to `_commons` (initDb data-migration),
    // and no `_system` row may remain.
    const rows = await queryDb<{ mind: string }>(
      PAGES_DB_PATH,
      "SELECT mind FROM published_pages WHERE file = ?",
      [COMMONS_PAGE_FILE],
    );
    assert.ok(rows.length >= 1, "the seeded commons page row should survive the upgrade");
    assert.ok(
      rows.every((r) => r.mind === "_commons"),
      `seeded _system row not migrated to _commons: ${JSON.stringify(rows)}`,
    );
    const stragglers = await queryDb(
      PAGES_DB_PATH,
      "SELECT 1 FROM published_pages WHERE mind = '_system'",
    );
    assert.equal(stragglers.length, 0, "no published_pages rows should remain under _system");
  });

  it("spirit receives a commons announcement when a new mind joins", async (t) => {
    if (skipReason) return t.skip(skipReason);

    // The announcement is delivered to commons *participants*; the migrated spirit
    // becomes one via the HEAD boot's spirit bootstrap (or already was, having joined
    // #system under 0.56.0). Wait for that membership, then skip — not fail — if it
    // never establishes in this environment: that's a bootstrap gap, not the delivery
    // regression this guards. What #817 added is spirit *inclusion* in
    // announceToCommons (isMind excludes the spirit user_type), so: given membership,
    // does a sender-less announcement reach the spirit? — reverting #817 fails this.
    let joined = false;
    for (let i = 0; i < 120 && !joined; i++) {
      const m = await queryDb(
        DB_PATH,
        `SELECT 1 FROM conversation_participants cp
           JOIN users u ON u.id = cp.user_id
           JOIN channels ch ON ch.conversation_id = cp.conversation_id
          WHERE ch.is_default = 1 AND u.user_type = 'spirit'`,
      );
      joined = m.length > 0;
      if (!joined) await new Promise((r) => setTimeout(r, 500));
    }
    if (!joined) return t.skip("spirit never joined the commons channel in this environment");

    // Derive the spirit's name from the DB rather than hardcoding the "volute"
    // default — mind_history keys on the registry name, which equals the spirit
    // user's username, so this stays correct even if the house named its spirit.
    const spiritUser = await queryDb<{ username: string }>(
      DB_PATH,
      "SELECT username FROM users WHERE user_type = 'spirit'",
    );
    const spiritName = spiritUser[0]?.username ?? "volute";

    // Read the default channel's name post-upgrade rather than reusing the captured
    // prior name: this test is about *delivery*, not about the rename, and the prior
    // name is only meaningful when the prior predates 0.57.0. Preservation of that
    // name across the upgrade is the (gated) channels assertion's job.
    const defaultChannel = await queryDb<{ name: string }>(
      DB_PATH,
      "SELECT name FROM channels WHERE is_default = 1",
    );
    assert.equal(
      defaultChannel.length,
      1,
      `expected exactly one default channel, got ${JSON.stringify(defaultChannel)}`,
    );
    const channelSlug = `#${defaultChannel[0].name}`; // delivery slug follows the channel's name

    // Trigger "X has joined" by creating a fresh sprouted mind through the API.
    const createRes = await req("/api/v1/minds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: NEW_MIND }),
    });
    assert.ok(
      createRes.status === 200 || createRes.status === 201,
      `create ${NEW_MIND}: ${createRes.status} ${await createRes.text()}`,
    );

    // Delivery is fire-and-forget; poll the spirit's inbound history for the row.
    let row: { sender: string | null; channel: string | null; content: string | null } | undefined;
    for (let i = 0; i < 100 && !row; i++) {
      const inbound = await queryDb<{
        sender: string | null;
        channel: string | null;
        content: string | null;
      }>(DB_PATH, "SELECT sender, channel, content FROM mind_history WHERE mind = ? AND type = ?", [
        spiritName,
        "inbound",
      ]);
      row = inbound.find((r) => r.content?.includes(`${NEW_MIND} has joined`));
      if (!row) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(row, `spirit did not receive the '${NEW_MIND} has joined' announcement`);
    assert.equal(
      row!.sender,
      null,
      "the announcement must be sender-less — never the spirit's voice",
    );
    assert.equal(row!.channel, channelSlug, "announcement delivered on the wrong channel slug");
  });
});
