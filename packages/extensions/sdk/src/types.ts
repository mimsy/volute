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
  user_type: "brain" | "mind" | "system";
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
  resolveUser: (c: Context) => User | null;
  getUser: (id: number) => Promise<User | null>;
  getUserByUsername: (username: string) => Promise<User | null>;
  publishActivity: (event: ActivityEvent) => void;
  getMindDir: (name: string) => string | null;
  getSystemsConfig: () => SystemsConfig | null;
  announceToSystem: (text: string) => Promise<void>;
  /** Whether per-mind user isolation is enabled (user isolation mode). */
  isIsolationEnabled: () => boolean;
  /** Get the OS username for a mind under user isolation (e.g. "mind-lyra"). */
  getMindUser: (mindName: string) => string;
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

export type CommandHandler = (
  args: string[],
  ctx: ExtensionContext & { mindName?: string; session?: string; stdin?: string },
) => Promise<{ output: string } | { error: string }>;

export type ExtensionCommand = {
  description: string;
  usage?: string;
  handler: CommandHandler;
};

export type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
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
  initDb?: (db: Database) => void;
  commands?: Record<string, ExtensionCommand>;
  onDaemonStart?: (ctx: ExtensionContext) => void;
  onDaemonStop?: () => void;
  onMindStart?: (mindName: string, ctx: ExtensionContext) => void;
  onMindStop?: (mindName: string) => void;
};
