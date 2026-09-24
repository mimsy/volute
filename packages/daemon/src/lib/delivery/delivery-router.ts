import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChannelContext, ParticipantProfile } from "@volute/api";
import { eq } from "drizzle-orm";
import { MIND_LEVEL_THREAD, recordNotice } from "../chat/system-events.js";
import { getDb } from "../db.js";
import { mindDir, stateDir } from "../mind/registry.js";
import { users } from "../schema.js";
import { clearJsonMap, loadJsonMap, saveJsonMap } from "../util/json-state.js";
import log from "../util/logger.js";

// --- Types ---

export type RoutingRule = {
  /**
   * Glob matched against a system event's match key (e.g. "schedule:*",
   * "webhook:*", "notice:crash") — see `resolveEventRoute`. A rule carrying an
   * `event` key routes environment signals, not channel content; the two planes
   * never cross (#736 / scope boundary #719).
   */
  event?: string;
  thread?: string;
  /** Only `"mind"` (the default) exists; any other value makes the rule unmatchable. */
  destination?: "mind";
  channel?: string;
  sender?: string;
  isDM?: boolean;
  participants?: number;
  /** Who is speaking — see {@link SenderKind}. Unknown values make the rule unmatchable. */
  senderKind?: SenderKind;
  mode?: "all" | "mention";
  batch?: number | BatchConfig;
};

/**
 * What kind of sender a message comes from: a person using Volute (`human`), another mind
 * or the spirit (`mind`), someone reaching the mind from another platform through a bridge,
 * mail, or cloud sync (`bridge`), or the mind itself (`self`). See {@link classifySender}.
 */
export type SenderKind = "human" | "mind" | "bridge" | "self";
export const SENDER_KINDS: readonly SenderKind[] = ["human", "mind", "bridge", "self"];

export type BatchConfig = {
  debounce?: number;
  maxWait?: number;
  triggers?: string[];
};

export type SessionConfig = {
  instructions?: string;
  delivery?: DeliveryMode;
  interrupt?: boolean;
  rateLimit?: RateLimit;
};

/** At most `max` wakes on the thread per `windowMinutes`; wakes beyond that defer. */
export type RateLimit = { max: number; windowMinutes: number };

export type DeliveryMode =
  | "immediate"
  | "batch"
  | "defer"
  | { mode: "batch"; debounce?: number; maxWait?: number; triggers?: string[] }
  | { mode: "defer"; maxWait?: number };

export type RoutingConfig = {
  rules?: RoutingRule[];
  threads?: Record<string, SessionConfig>;
  default?: string;
  gateUnmatched?: boolean;
};

export type ResolvedRoute = {
  session: string;
  matched: boolean;
  mode?: "all" | "mention";
  rule?: RoutingRule;
};

export type ResolvedDeliveryMode =
  | { mode: "immediate" }
  | { mode: "batch"; debounce: number; maxWait: number; triggers?: string[] }
  /** `maxWait` in seconds; undefined = wait for the next turn on the thread, however long. */
  | { mode: "defer"; maxWait?: number };

export type ResolvedSessionConfig = {
  delivery: ResolvedDeliveryMode;
  instructions?: string;
  interrupt: boolean;
  rateLimit?: RateLimit;
};

export type MatchMeta = {
  channel?: string;
  sender?: string;
  isDM?: boolean;
  participantCount?: number;
  senderKind?: SenderKind;
};

// --- Delivery payload ---

export type { ChannelContext, ParticipantProfile };

export interface DeliveryPayload {
  channel: string;
  sender: string | null;
  /**
   * The authenticated principal behind this message (users.id), or null. Set ONLY by
   * callers whose request actually authenticated the sender (the chat API's session or
   * token principal). Bridge, mail, and cloud inbound pass null on purpose: they carry
   * external identities Volute never authenticated, and a null id is what keeps an
   * unvouched sender structurally unable to confer authority (#1017). Never derive it
   * from `sender`, which is display text.
   */
  senderId: number | null;
  content: unknown; // string or content block array
  conversationId?: string;
  session?: string; // explicit target session — skips route matching
  typing?: string[];
  platform?: string;
  isDM?: boolean;
  participants?: string[];
  participantCount?: number;
  participantProfiles?: ParticipantProfile[];
  /** The channel's description, rules, and limits — sent once per channel per session. */
  channelInfo?: ChannelContext;
  /**
   * Stamped on a delivery the moment it is first held (see `DeliveryManager`'s hold
   * check), and persisted with the queue row so the wait survives a daemon restart.
   * Rendered into `content` and stripped at delivery time — it never reaches the mind
   * as a field.
   */
  held?: { at: number; scope: "mind" | "system"; until?: number };
  /**
   * Stamped when the mind's routes.json deferred this message (`delivery: "defer"`, a
   * mention-mode non-mention, or a `rateLimit` overflow) — kept rather than waking the
   * mind, to ride along with its next turn on the thread. `at` is when it arrived. Rendered
   * into `content` and stripped at delivery time, like `held`.
   */
  deferred?: { at: number };
  /**
   * Set when this message's `mind_history` inbound row was deliberately NOT written on
   * arrival, because the mind was over its spend cap and would not see it. The row is
   * written when the message actually reaches the mind — history must not claim a mind
   * heard something it never received (#420). Stripped before the payload is POSTed.
   */
  inboundDeferred?: boolean;
  whileSleeping?: "skip" | "queue" | "trigger-wake";
}

/**
 * The payload as POSTed to a mind process: `senderId` is stripped. It is the daemon's
 * record of the authenticated principal (#1017), and the mind's side of the wire is an
 * untrusted process — a field it could echo back must never exist in a shape that looks
 * authoritative. `held`/`inboundDeferred` are likewise daemon bookkeeping, stripped by
 * `withHeldPreface` on the same boundary.
 */
export type WirePayload = Omit<DeliveryPayload, "senderId">;

export function toWirePayload(payload: DeliveryPayload): WirePayload {
  const { senderId: _senderId, ...wire } = payload;
  return wire;
}

/**
 * Parse a persisted queue-row payload. Normalizes fields added after old rows were
 * written: a legacy row has no `senderId` key, and `undefined` must not survive past
 * the parse boundary — every reader treats null as "nobody vouched" (#1017), and a
 * missing key must mean exactly that, not fall through comparisons as undefined.
 * Throws like JSON.parse on malformed input; callers keep their own catch.
 */
export function parseDeliveryPayload(json: string): DeliveryPayload {
  const payload = JSON.parse(json) as DeliveryPayload;
  payload.senderId ??= null;
  return payload;
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type: string; text?: string }[])
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
  }
  return JSON.stringify(content);
}

// --- Config cache ---

type CachedConfig = { config: RoutingConfig; mtime: number };
const configCache = new Map<string, CachedConfig>();
const statCheckCache = new Map<string, { mtime: number; checkedAt: number }>();
const STAT_TTL_MS = 5_000;

const dlog = log.child("delivery-router");

// Notified when a mind's routes.json changes (explicit cache clear or detected mtime
// change), so held (gated) messages can be re-evaluated against the new rules.
let routesChangeListener: ((mind: string) => void) | undefined;

export function setRoutesChangeListener(fn: ((mind: string) => void) | undefined): void {
  routesChangeListener = fn;
}

function notifyRoutesChanged(mind: string): void {
  if (!routesChangeListener) return;
  try {
    routesChangeListener(mind);
  } catch (err) {
    dlog.warn(`routes change listener failed for ${mind}`, log.errorData(err));
  }
}

// Cache of mind name → directory overrides (e.g. spirits with custom dirs)
const dirOverrides = new Map<string, string>();

/** Register a custom directory for a mind (called when spirits/variants start). */
export function registerMindDir(name: string, dir: string): void {
  dirOverrides.set(name, dir);
}

/**
 * Absolute path of the routes.json the router actually reads for a mind (honouring the
 * spirit/variant directory overrides). Exported so writers — e.g. `acceptChannel` — edit
 * the same file the router loads.
 */
export function routesConfigPath(mindName: string): string {
  const dir = dirOverrides.get(mindName) ?? mindDir(mindName);
  return resolve(dir, "home/.config/routes.json");
}

export function getRoutingConfig(mindName: string): RoutingConfig {
  const path = routesConfigPath(mindName);

  // Skip statSync if we checked recently and have a cached config
  const now = Date.now();
  const statCached = statCheckCache.get(mindName);
  const cached = configCache.get(mindName);
  if (statCached && cached && now - statCached.checkedAt < STAT_TTL_MS) {
    return cached.config;
  }

  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    // No config file — return empty config, don't cache
    configCache.delete(mindName);
    statCheckCache.delete(mindName);
    return {};
  }

  statCheckCache.set(mindName, { mtime, checkedAt: now });

  if (cached && cached.mtime === mtime) {
    return cached.config;
  }

  try {
    const config: RoutingConfig = JSON.parse(readFileSync(path, "utf-8"));
    const changed = cached != null && cached.mtime !== mtime;
    configCache.set(mindName, { config, mtime });
    void reportRoutesConfigProblems(mindName, config);
    // A pre-existing cached config with a different mtime means routes.json actually
    // changed — release any gated messages that the new rules now match.
    if (changed) notifyRoutesChanged(mindName);
    return config;
  } catch (err) {
    dlog.warn(`failed to load routes.json for ${mindName}`, log.errorData(err));
    configCache.delete(mindName);
    return {};
  }
}

// --- Glob matching ---

const globRegexCache = new Map<string, RegExp>();

/**
 * Drop a mind's cached routing config (or every mind's, with no argument).
 *
 * Pass `{ notify: false }` when the caller releases gated messages itself and awaits the
 * result — the listener-driven release runs detached, so leaving it on would race the
 * awaited run and make its counts unreliable.
 */
export function clearConfigCache(mindName?: string, opts?: { notify?: boolean }): void {
  if (mindName) {
    configCache.delete(mindName);
    statCheckCache.delete(mindName);
    // An explicit invalidation typically follows a routes.json write — re-evaluate
    // gated messages against the (about to be reloaded) rules.
    if (opts?.notify !== false) notifyRoutesChanged(mindName);
  } else {
    configCache.clear();
    statCheckCache.clear();
    globRegexCache.clear();
  }
}

function globMatch(pattern: string, value: string): boolean {
  let regex = globRegexCache.get(pattern);
  if (!regex) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    regex = new RegExp(`^${escaped}$`);
    globRegexCache.set(pattern, regex);
  }
  return regex.test(value);
}

// --- Rule matching ---

const GLOB_MATCH_KEYS = new Set(["channel", "sender"]);
const NON_MATCH_KEYS = new Set(["thread", "mode", "batch"]);
const KNOWN_RULE_KEYS = new Set([
  ...GLOB_MATCH_KEYS,
  ...NON_MATCH_KEYS,
  "destination",
  "isDM",
  "participants",
  "senderKind",
  "event",
]);
const KNOWN_THREAD_KEYS = new Set(["instructions", "delivery", "interrupt", "rateLimit"]);

function quoteKeys(keys: string[]): string {
  return keys.map((k) => `"${k}"`).join(", ");
}

/**
 * Everything in a routes.json that the router will silently not do, one sentence each.
 * An unrecognized rule key makes the whole rule unmatchable — with gating on, that
 * diverts the channel's messages into the gate. An unrecognized thread key is simply
 * ignored — which is how the shipped `threads."#*".batch` left channel batching inert
 * for every mind. Catches leftovers from renames and future typos alike.
 */
export function routesConfigProblems(config: RoutingConfig): string[] {
  const problems: string[] = [];
  if (Array.isArray(config.rules)) {
    config.rules.forEach((rule, i) => {
      if (rule == null || typeof rule !== "object") return;
      const where = `rules[${i}] (${JSON.stringify(rule)})`;
      const unknown = Object.keys(rule).filter((k) => !KNOWN_RULE_KEYS.has(k));
      if (unknown.length > 0) {
        problems.push(
          `${where} has unrecognized key(s) ${quoteKeys(unknown)}, so the rule never matches ` +
            `(known rule keys: ${[...KNOWN_RULE_KEYS].join(", ")}).`,
        );
      }
      if ("destination" in rule && rule.destination !== "mind") {
        problems.push(
          `${where} has destination ${JSON.stringify(rule.destination)}, so the rule never ` +
            `matches — "mind" is the only destination (file destinations were removed).`,
        );
      }
      if ("senderKind" in rule && !SENDER_KINDS.includes(rule.senderKind as SenderKind)) {
        problems.push(
          `${where} has senderKind ${JSON.stringify(rule.senderKind)}, so the rule never ` +
            `matches (senderKind is one of: ${SENDER_KINDS.join(", ")}).`,
        );
      }
    });
  }
  if (config.threads != null && typeof config.threads === "object") {
    for (const [pattern, threadConfig] of Object.entries(config.threads)) {
      if (threadConfig == null || typeof threadConfig !== "object") continue;
      const unknown = Object.keys(threadConfig).filter((k) => !KNOWN_THREAD_KEYS.has(k));
      if (unknown.length > 0) {
        problems.push(
          `threads[${JSON.stringify(pattern)}] has unrecognized key(s) ${quoteKeys(unknown)}, ` +
            `which are ignored (known thread keys: ${[...KNOWN_THREAD_KEYS].join(", ")}).`,
        );
      }
      if ("rateLimit" in threadConfig && parseRateLimit(threadConfig.rateLimit) == null) {
        problems.push(
          `threads[${JSON.stringify(pattern)}] has rateLimit ` +
            `${JSON.stringify(threadConfig.rateLimit)}, which is ignored — it needs a "max" ` +
            `of at least 1 and a positive "windowMinutes", e.g. { "max": 6, "windowMinutes": 60 }.`,
        );
      }
      const d = threadConfig.delivery;
      if (
        d === "defer" ||
        (d != null &&
          typeof d === "object" &&
          d.mode === "defer" &&
          !(typeof d.maxWait === "number" && d.maxWait > 0))
      ) {
        problems.push(
          `threads[${JSON.stringify(pattern)}] defers with no "maxWait", so messages here wait ` +
            `until something else wakes this thread — a delivery on it that isn't deferred, an ` +
            `event routed to it, or a wake-up whose backlog includes one. Nothing on this ` +
            `thread alone will ever wake you; add a "maxWait" if you want to hear it eventually.`,
        );
      }
    }
  }
  return problems;
}

/** meta.reason of the notice {@link reportRoutesConfigProblems} sends. */
export const ROUTES_PROBLEMS_REASON = "routes_config_problems";

/**
 * The problems a mind has already been told about, kept in its state dir so a restart,
 * crash-restart or update doesn't tell it again — including a mind that keeps an extra
 * key on purpose. Keyed by the problem sentence; the value is when it was reported.
 */
function reportedProblemsPath(mindName: string): string {
  return resolve(stateDir(mindName), "routes-problems.json");
}

function saveReportedProblems(mindName: string, told: Map<string, number>): void {
  const path = reportedProblemsPath(mindName);
  if (told.size === 0) {
    clearJsonMap(path, told);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  saveJsonMap(path, told);
}

/**
 * Forget that the mind was told about these problems, so they're reported again on the
 * next load if still true — for when the notice that told it is withdrawn unread.
 */
export function forgetReportedRoutesProblems(mindName: string, problems: string[]): void {
  const told = loadJsonMap(reportedProblemsPath(mindName));
  let changed = false;
  for (const p of problems) changed = told.delete(p) || changed;
  if (changed) saveReportedProblems(mindName, told);
}

/**
 * Tell the mind (and the log) about {@link routesConfigProblems}. A daemon log line alone
 * reaches nobody who can act on it: routes.json is the mind's own file, describing what
 * it wants to wake it, and a config that silently does nothing misreports its own attention
 * to it. So the mind gets a next-turn notice naming each problem it hasn't heard about yet.
 * A problem that goes away is forgotten, so one reintroduced later is reported afresh.
 * Returns the notice promise (never rejects) so tests can await it; the router fires and
 * forgets.
 */
export function reportRoutesConfigProblems(mindName: string, config: RoutingConfig): Promise<void> {
  const problems = routesConfigProblems(config);
  const told = loadJsonMap(reportedProblemsPath(mindName));
  const kept = new Map([...told].filter(([p]) => problems.includes(p) || p === MENTION_DEFERS_KEY));
  const unheard = problems.filter((p) => !told.has(p));
  for (const p of unheard) kept.set(p, Date.now());
  // The first time this mind's config is read since mention mode began deferring, and only
  // then: a mind that already had a mention rule set it up expecting the old behaviour.
  const firstLook = !told.has(MENTION_DEFERS_KEY);
  const mentionNote = firstLook && hasMentionRule(config);
  if (firstLook) kept.set(MENTION_DEFERS_KEY, Date.now());
  // Saved before notifying: recording the notice routes it through this same config.
  if (kept.size !== told.size || unheard.length > 0 || firstLook) {
    saveReportedProblems(mindName, kept);
  }

  const sent: Promise<unknown>[] = [];
  if (unheard.length > 0) {
    dlog.warn(`routes.json for ${mindName}: ${unheard.join(" ")}`);
    sent.push(
      recordNotice({
        mind: mindName,
        thread: MIND_LEVEL_THREAD,
        kind: "routes",
        reason: ROUTES_PROBLEMS_REASON,
        detail:
          `Your .config/routes.json has settings that won't do what they might look like ` +
          `they do:\n\n` +
          `${unheard.map((p) => `- ${p}`).join("\n")}\n\n` +
          `Each line says what the router does instead. The volute-mind skill's routing ` +
          `reference describes every field.`,
        meta: { problems: unheard },
      }),
    );
  }
  if (mentionNote) {
    sent.push(
      recordNotice({
        mind: mindName,
        thread: MIND_LEVEL_THREAD,
        kind: "routes",
        reason: ROUTES_MENTION_DEFERS_REASON,
        detail:
          `Your .config/routes.json has a rule with mode "mention". Messages on it that don't ` +
          `mention you used to be dropped from your turns; now they're deferred — kept, and ` +
          `delivered along with your next turn on that thread — so nothing addressed to you ` +
          `is lost. They still don't wake you. The volute-mind skill's routing reference has ` +
          `the details.`,
      }),
    );
  }
  return Promise.all(sent).then(
    () => {},
    (err) => {
      dlog.warn(`failed to notify ${mindName} about routes.json`, log.errorData(err));
    },
  );
}

/** meta.reason of the one-time notice that mention mode now defers instead of dropping. */
export const ROUTES_MENTION_DEFERS_REASON = "routes_mention_defers";
/** Ledger key marking that a mind's config has been checked for the mention-defers notice. */
const MENTION_DEFERS_KEY = "mention-defers";

function hasMentionRule(config: RoutingConfig): boolean {
  return (
    Array.isArray(config.rules) &&
    config.rules.some((r) => r != null && typeof r === "object" && r.mode === "mention")
  );
}

function ruleMatches(rule: RoutingRule, meta: MatchMeta): boolean {
  for (const [key, pattern] of Object.entries(rule)) {
    if (NON_MATCH_KEYS.has(key)) continue;

    if (key === "destination") {
      if (pattern !== "mind") return false;
      continue;
    }

    if (key === "isDM") {
      if (typeof pattern !== "boolean") return false;
      if ((meta.isDM ?? false) !== pattern) return false;
      continue;
    }

    if (key === "participants") {
      if (typeof pattern !== "number") return false;
      if ((meta.participantCount ?? 0) !== pattern) return false;
      continue;
    }

    if (key === "senderKind") {
      if (meta.senderKind === undefined || meta.senderKind !== pattern) return false;
      continue;
    }

    if (typeof pattern !== "string") return false;
    if (!GLOB_MATCH_KEYS.has(key)) return false;
    const value = meta[key as "channel" | "sender"] ?? "";
    if (!globMatch(pattern, value)) return false;
  }
  return true;
}

function expandTemplate(template: string, meta: MatchMeta): string {
  return template
    .replace(/\$\{sender\}/g, meta.sender ?? "unknown")
    .replace(/\$\{channel\}/g, meta.channel ?? "unknown");
}

function sanitizeSessionName(name: string): string {
  return name.replace(/\0/g, "").replace(/[/\\]/g, "-").replace(/\.\./g, "-").slice(0, 100);
}

// --- Route resolution ---

export function resolveRoute(config: RoutingConfig, meta: MatchMeta): ResolvedRoute {
  const fallback = config.default ?? "main";

  if (!config.rules) {
    return { session: fallback, matched: false };
  }

  for (const rule of config.rules) {
    // Event rules (routes.json's environment-signal plane) never match channel
    // content — they're resolved by resolveEventRoute (#736).
    if (typeof rule.event === "string") continue;
    if (ruleMatches(rule, meta)) {
      return {
        session: sanitizeSessionName(expandTemplate(rule.thread ?? fallback, meta)),
        matched: true,
        mode: rule.mode,
        rule,
      };
    }
  }

  return { session: fallback, matched: false };
}

/**
 * Resolve a system event to a target thread through the mind's routes.json.
 *
 * Event rules carry an `event` glob matched against the event's match key (see
 * `eventMatchKey` in system-events). First match wins; the returned thread may be the
 * `$new` sentinel, which the caller expands. Returns undefined when no event rule matches,
 * so the caller keeps its own default thread. This is the sole event-routing plane —
 * channel rules (no `event` key) are ignored here, and event rules are skipped by
 * `resolveRoute`, so the two never cross (#736).
 */
export function resolveEventRoute(config: RoutingConfig, eventKey: string): string | undefined {
  if (!config.rules) return undefined;
  for (const rule of config.rules) {
    if (typeof rule.event !== "string") continue;
    if (globMatch(rule.event, eventKey)) return rule.thread;
  }
  return undefined;
}

/**
 * Whether a resolved route should be gated: the channel is unrouted and gating is on, so
 * the message is held until the mind opts in. A gated message is never delivered to the
 * mind, so callers must NOT record it as inbound history — the mind hasn't seen it (#420).
 * Explicitly-matched rules are never gated.
 */
export function shouldGate(config: RoutingConfig, route: ResolvedRoute): boolean {
  return !route.matched && config.gateUnmatched !== false;
}

// --- Delivery mode resolution ---

export const DEFAULT_BATCH_DEBOUNCE = 5;
export const DEFAULT_BATCH_MAX_WAIT = 120;

function normalizeBatchConfig(batch: number | BatchConfig): BatchConfig {
  if (typeof batch === "number") return { maxWait: batch * 60 };
  return batch;
}

export function resolveDeliveryMode(
  config: RoutingConfig,
  sessionName: string,
  rule?: RoutingRule,
): ResolvedSessionConfig {
  // Rule-level batch config takes priority when no threads config exists
  const ruleBatch = rule?.batch;
  const defaults: ResolvedSessionConfig = {
    delivery: { mode: "immediate" },
    interrupt: false,
  };

  if (!config.threads) {
    if (ruleBatch != null) {
      const batch = normalizeBatchConfig(ruleBatch);
      return {
        delivery: {
          mode: "batch",
          debounce: batch.debounce ?? DEFAULT_BATCH_DEBOUNCE,
          maxWait: batch.maxWait ?? DEFAULT_BATCH_MAX_WAIT,
          triggers: batch.triggers,
        },
        interrupt: false,
      };
    }
    return defaults;
  }

  for (const [pattern, sessionConfig] of Object.entries(config.threads)) {
    if (globMatch(pattern, sessionName)) {
      let delivery: ResolvedDeliveryMode;
      const d = sessionConfig.delivery;

      if (d == null || d === "immediate") {
        delivery = { mode: "immediate" };
      } else if (d === "batch") {
        delivery = {
          mode: "batch",
          debounce: DEFAULT_BATCH_DEBOUNCE,
          maxWait: DEFAULT_BATCH_MAX_WAIT,
        };
      } else if (d === "defer") {
        delivery = { mode: "defer" };
      } else if (d.mode === "defer") {
        delivery = {
          mode: "defer",
          maxWait: typeof d.maxWait === "number" && d.maxWait > 0 ? d.maxWait : undefined,
        };
      } else {
        delivery = {
          mode: "batch",
          debounce: d.debounce ?? DEFAULT_BATCH_DEBOUNCE,
          maxWait: d.maxWait ?? DEFAULT_BATCH_MAX_WAIT,
          triggers: d.triggers,
        };
      }

      return {
        delivery,
        instructions: sessionConfig.instructions,
        interrupt: sessionConfig.interrupt ?? false,
        rateLimit: parseRateLimit(sessionConfig.rateLimit) ?? undefined,
      };
    }
  }

  // No session-level config matched — fall back to rule-level batch
  if (ruleBatch != null) {
    const batch = normalizeBatchConfig(ruleBatch);
    return {
      delivery: {
        mode: "batch",
        debounce: batch.debounce ?? DEFAULT_BATCH_DEBOUNCE,
        maxWait: batch.maxWait ?? DEFAULT_BATCH_MAX_WAIT,
        triggers: batch.triggers,
      },
      interrupt: false,
    };
  }

  return defaults;
}

/** A thread's `rateLimit`, or null when it's missing or malformed (reported as a problem). */
function parseRateLimit(value: unknown): RateLimit | null {
  if (value == null || typeof value !== "object") return null;
  const { max, windowMinutes } = value as Partial<RateLimit>;
  // A max under one would allow no wakes at all — and no moment the window frees one.
  if (typeof max !== "number" || !(Math.floor(max) >= 1)) return null;
  if (typeof windowMinutes !== "number" || !(windowMinutes > 0)) return null;
  return { max: Math.floor(max), windowMinutes };
}

// --- Mentions ---

const mentionRegexCache = new Map<string, RegExp>();

/** Whether `text` names the mind — the test `mode: "mention"` rules apply. */
export function mentionsMind(baseName: string, text: string): boolean {
  let pattern = mentionRegexCache.get(baseName);
  if (!pattern) {
    const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`\\b${escaped}\\b`, "i");
    mentionRegexCache.set(baseName, pattern);
  }
  return pattern.test(text);
}

/**
 * Whether routing, by itself, defers this message rather than letting it wake the mind:
 * the thread's delivery is `defer`, or the matched rule is `mode: "mention"` and the
 * message doesn't mention the mind. (A `rateLimit` overflow also defers, but that depends
 * on recent wakes — see `DeliveryManager.rateLimitFull`.) Returns the deadline in ms from
 * now after which the deferred message flushes on its own, or undefined for "wait for the
 * next turn on the thread".
 */
export function routingDefers(
  baseName: string,
  route: ResolvedRoute,
  sessionConfig: ResolvedSessionConfig,
  payload: Pick<DeliveryPayload, "content" | "sender">,
): { maxWaitMs?: number } | null {
  if (sessionConfig.delivery.mode === "defer") {
    const maxWait = sessionConfig.delivery.maxWait;
    return { maxWaitMs: maxWait != null ? maxWait * 1000 : undefined };
  }
  if (
    route.mode === "mention" &&
    payload.sender &&
    !mentionsMind(baseName, extractTextContent(payload.content))
  ) {
    return {};
  }
  return null;
}

// --- Sender kinds ---

function configUsesSenderKind(config: RoutingConfig): boolean {
  return (
    Array.isArray(config.rules) &&
    config.rules.some((r) => r != null && typeof r === "object" && "senderKind" in r)
  );
}

/**
 * Classify a message's sender for `senderKind` rules. The mind itself is `self`. A sender
 * Volute authenticated (`senderId`) is classified by its `users.user_type` — `puppet`, a
 * bridge stand-in, is `bridge`. An unauthenticated sender carrying a `platform:identifier`
 * name (the `externalSenderName` contract: bridges, mail, cloud sync) is `bridge`; one
 * without it is looked up by username. Anything still unknown is left unclassified, and
 * matches no `senderKind` rule.
 */
export async function classifySender(
  baseName: string,
  sender: string | null | undefined,
  senderId: number | null | undefined,
): Promise<SenderKind | undefined> {
  if (!sender && senderId == null) return undefined;
  if (sender === baseName) return "self";
  try {
    const db = await getDb();
    const row =
      senderId != null
        ? await db
            .select({ username: users.username, user_type: users.user_type })
            .from(users)
            .where(eq(users.id, senderId))
            .get()
        : sender?.includes(":")
          ? undefined
          : await db
              .select({ username: users.username, user_type: users.user_type })
              .from(users)
              .where(eq(users.username, sender!))
              .get();
    if (row) {
      if (row.username === baseName) return "self";
      if (row.user_type === "puppet") return "bridge";
      if (row.user_type === "mind" || row.user_type === "spirit") return "mind";
      if (row.user_type === "human") return "human";
      return undefined;
    }
  } catch (err) {
    dlog.warn(`failed to classify sender ${sender} for ${baseName}`, log.errorData(err));
    return undefined;
  }
  if (senderId == null && sender?.includes(":")) return "bridge";
  return undefined;
}

/**
 * The routing match metadata for a payload. Every caller that resolves a route for a
 * message goes through here, so a `senderKind` rule matches the same way at arrival, at
 * gated release and on the wake flush. The sender lookup only runs when some rule uses it.
 */
export async function matchMetaFor(
  baseName: string,
  config: RoutingConfig,
  payload: Pick<DeliveryPayload, "channel" | "sender" | "senderId" | "isDM" | "participantCount">,
): Promise<MatchMeta> {
  return {
    channel: payload.channel,
    sender: payload.sender ?? undefined,
    isDM: payload.isDM,
    participantCount: payload.participantCount,
    senderKind: configUsesSenderKind(config)
      ? await classifySender(baseName, payload.sender, payload.senderId)
      : undefined,
  };
}
