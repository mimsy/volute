import type { Context, Hono, MiddlewareHandler } from "hono";

export type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
};

export type ActivityEvent = {
  type: string;
  mind: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

export type User = {
  id: number;
  username: string;
  role: "admin" | "user" | "pending" | "system";
  user_type: "human" | "mind" | "spirit";
  display_name: string | null;
  description: string | null;
  avatar: string | null;
};

export type SystemsConfig = {
  apiKey: string;
  system: string;
  apiUrl: string;
};

/** A mind as seen by an extension: enough to tell spirits, seeds, and full minds apart. */
export type ExtensionMind = {
  name: string;
  mindType: "mind" | "spirit";
  /** Seeds haven't oriented yet — usually they should be exempt from expectations. */
  stage?: "seed" | "sprouted";
};

export type ExtensionContext = {
  db: Database | null;
  authMiddleware: MiddlewareHandler;
  /**
   * Canonical per-resource authorization guard. Returns middleware that allows
   * admin/system callers and the mind whose (base) name equals the value of the
   * given route param; everyone else gets 403. Extensions should mount this on
   * mind-scoped routes (e.g. `/:author/...`, `/publish/:name`) instead of
   * hand-rolling `user.username === param` checks, so authorization is uniform
   * and statically verifiable.
   */
  requireSelf: (paramName?: string) => MiddlewareHandler;
  resolveUser: (c: Context) => User | null;
  getUser: (id: number) => Promise<User | null>;
  getUserByUsername: (username: string) => Promise<User | null>;
  publishActivity: (event: ActivityEvent) => void;
  /**
   * Resolve a mind's project directory, or null when it doesn't exist on disk.
   * Registry-backed, so it also resolves minds whose directory isn't the
   * path-convention default: the system spirit (which lives under the system
   * dir, never the minds dir) and variants (which live in git worktrees).
   */
  getMindDir: (name: string) => Promise<string | null>;
  /**
   * The mind roster: base minds and the spirit, never variants. Extensions that
   * report on who is *absent* from something need this — a per-extension table
   * only knows the minds that already participate, so absence and health are
   * indistinguishable without the roster to compare against (#802).
   */
  listMinds: () => Promise<ExtensionMind[]>;
  getSystemsConfig: () => SystemsConfig | null;
  /** Post a sender-less automated announcement to the commons (default) channel. */
  announceToCommons: (text: string) => Promise<void>;
  /**
   * Queue an ambient, non-interrupting notification for a mind, delivered as context
   * on the mind's next turn (via the notices system). No-op if the target isn't a
   * registered mind — which includes the system spirit, even though the spirit's
   * user row is `user_type: "spirit"` rather than `"mind"`.
   * Use for low-urgency signals (a comment on a note, a reaction) that shouldn't trigger
   * a turn on their own. Never throws.
   */
  recordNotice: (mindName: string, text: string) => Promise<void>;
  /** Whether per-mind user isolation is enabled (user isolation mode). */
  isIsolationEnabled: () => boolean;
  /** Get the OS username for a mind under user isolation (e.g. "mind-lyra"). */
  getMindUser: (mindName: string) => string;
  /**
   * Name of the system spirit. Under the daemon this mirrors its own
   * `getSpiritName()`, which falls back to "volute" on installs predating spirit
   * naming and so never returns null — an earlier implementation read
   * `setup.spiritName` directly and returned null there, silently killing every
   * spirit-dependent extension path on those systems. The type stays nullable for
   * hosts that embed the SDK without a spirit at all; treat null as "no spirit".
   */
  getSpiritName: () => string | null;
  dataDir: string;
};

export type SystemSection = {
  id: string;
  label: string;
  urlPatterns?: string[];
};

export type MindSection = {
  id: string;
  label: string;
  defaultPath?: string;
};

export type FeedSource = {
  endpoint: string;
  kind?: string;
};

export type ExtensionFeedItem = {
  id: string;
  title: string;
  url: string;
  date: string;
  author?: string;
  icon?: string;
  color?: string;
  bodyHtml: string;
  iframeUrl?: string;
};

/**
 * Why the daemon is asking for turn context.
 *
 * - `"turn"` — before an ordinary turn. "What changed": small, forward-looking,
 *   and paid for on every single turn, so silence is the right answer almost always.
 * - `"wake"` — once, on waking from sleep. Retrospective: the mind has been away, so
 *   a digest of what it missed is appropriate and the budget is correspondingly larger.
 */
export type TurnContextReason = "turn" | "wake";

export type TurnContextOptions = {
  /**
   * Hard character ceiling for this extension's block on this call. A block longer
   * than `budget` is **dropped**, not truncated — a half-sentence in a mind's context
   * is worse than nothing, and dropping keeps the incentive on the extension to
   * summarize rather than to overrun and hope.
   *
   * This is a fair share of what is left, not a per-extension constant: the daemon
   * enforces a *total* cap across all extensions and hands each one
   * `remaining / providers-still-to-ask`. Returning `null` therefore donates your
   * share to the extensions asked after you.
   */
  budget: number;
  reason: TurnContextReason;
};

/**
 * Ambient material for a mind's turn — "here is what is around", as opposed to
 * `recordNotice`, which is directed ("someone acted on your thing").
 *
 * **`null` is the normal return.** This text competes directly with the mind's own
 * thinking for its context window, and a heavy system prompt is what caused
 * compaction thrash in this codebase before. Speak when there is genuinely something
 * new past your own watermark; stay quiet otherwise. Extensions keep their own
 * watermark state in their own DB — the daemon stores none.
 *
 * Present material, never requests: an ambient block a mind can decline without
 * failure is the whole point of the tier (see issue #807, design principle 2).
 *
 * Failures are contained, not propagated: throwing, exceeding `budget`, or running
 * past the daemon's deadline drops this extension from that turn's context and
 * leaves the mind's turn untouched.
 */
export type TurnContextProvider = (
  mindName: string,
  ctx: ExtensionContext,
  opts: TurnContextOptions,
) => Promise<string | null>;

export type ArgDef = {
  name: string;
  required?: boolean;
  description: string;
};

export type FlagDef = {
  type: "string" | "number" | "boolean";
  description: string;
};

export type CommandHandler = (
  parsed: {
    args: Record<string, string | undefined>;
    flags: Record<string, string | number | boolean | undefined>;
    rest: string[];
  },
  ctx: ExtensionContext & { mindName?: string; session?: string; stdin?: string },
) => Promise<{ output: string } | { error: string }>;

export type ExtensionCommand = {
  description: string;
  args?: ArgDef[];
  flags?: Record<string, FlagDef>;
  examples?: string[];
  handler: CommandHandler;
};

export type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  /**
   * A short, mind-facing description shown to minds at session start and in CLI help,
   * written in the platform's voice (invitation, initiative) rather than host-facing
   * marketing copy. Falls back to `description` when absent.
   */
  mindDoc?: string;
  /** SVG icon for this extension (used in system tabs, mind tabs, activity cards, etc.) */
  icon?: string;
  /** CSS color variable name (e.g. "purple", "yellow") used for activity cards and timeline markers */
  color?: string;
  routes: (ctx: ExtensionContext) => Hono;
  publicRoutes?: (ctx: ExtensionContext) => Hono;
  ui?: {
    assetsDir?: string;
    systemSection?: SystemSection;
    mindSections?: MindSection[];
    feedSource?: FeedSource;
  };
  /** Directory containing named skill subdirectories (e.g. skills/notes/, skills/pages/) */
  skillsDir?: string;
  /** Whether these skills should be auto-installed on new minds */
  standardSkill?: boolean;
  /** Skill names (subdirs of skillsDir) installed for the system spirit rather than
   *  the standard mind skill set. Excluded from standardSkill distribution. */
  spiritSkills?: string[];
  initDb?: (db: Database) => void;
  commands?: Record<string, ExtensionCommand>;
  /**
   * Contribute ambient material to a mind's turn. See {@link TurnContextProvider} —
   * the budget is the daemon's to set, and `null` is the normal answer.
   */
  turnContext?: TurnContextProvider;
  onDaemonStart?: (ctx: ExtensionContext) => void;
  /**
   * Fires once per daemon start, after the system spirit's project exists and is
   * registered. Use this — not `onDaemonStart` — for bootstrap that reads or writes
   * the spirit's directory: on a fresh install `onDaemonStart` runs well before the
   * spirit is created, so spirit-dependent work there silently skips the very boot
   * that creates it. Not called when there is no spirit (e.g. setup incomplete).
   */
  onSpiritReady?: (ctx: ExtensionContext) => void | Promise<void>;
  onDaemonStop?: () => void;
  onMindStart?: (mindName: string, ctx: ExtensionContext) => void;
  onMindStop?: (mindName: string) => void;
};
