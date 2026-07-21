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
  user_type: "human" | "mind" | "system";
  display_name: string | null;
  description: string | null;
  avatar: string | null;
};

export type SystemsConfig = {
  apiKey: string;
  system: string;
  apiUrl: string;
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
  getSystemsConfig: () => SystemsConfig | null;
  announceToSystem: (text: string) => Promise<void>;
  /**
   * Queue an ambient, non-interrupting notification for a mind, delivered as context
   * on the mind's next turn (via the notices system). No-op if the target isn't a
   * registered mind — which includes the system spirit, even though the spirit's
   * user row is `user_type: "system"` rather than `"mind"`.
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
