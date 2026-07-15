import type { TurnActivity } from "@volute/api";
import { icons } from "@volute/ui/icons";

/**
 * Stable key for a collapsed-turn peek popover, used to track which popovers
 * have been revealed (hovered) so their content is mounted lazily.
 */
export function peekKey(
  kind: "chat" | "activity" | "system-event",
  turnId: string,
  itemId: string | number,
): string {
  return `${kind}:${turnId}:${itemId}`;
}

export type ActivityPeekBody =
  | { kind: "iframe"; url: string }
  | { kind: "markdown"; source: string }
  | { kind: "none" };

/**
 * Decide what an activity peek popover should render. Pure — the caller only
 * renders markdown / mounts the iframe when the popover is actually revealed.
 */
export function activityPeekBody(metadata: TurnActivity["metadata"]): ActivityPeekBody {
  const iframeUrl = typeof metadata?.iframeUrl === "string" ? metadata.iframeUrl : "";
  if (iframeUrl) return { kind: "iframe", url: iframeUrl };
  const bodyHtml = typeof metadata?.bodyHtml === "string" ? metadata.bodyHtml : "";
  if (bodyHtml) return { kind: "markdown", source: bodyHtml };
  return { kind: "none" };
}

/** Navigation target for an activity: the document's SPA route. */
export function activityNavUrl(metadata: TurnActivity["metadata"], fallbackMind: string): string {
  if (typeof metadata?.url === "string" && metadata.url) return metadata.url;
  // Rows written before extensions published metadata.url:
  const slug = typeof metadata?.slug === "string" ? metadata.slug : "";
  if (slug) {
    const author = typeof metadata?.author === "string" ? metadata.author : fallbackMind;
    return `/minds/${author}/notes/${slug}`;
  }
  const file = typeof metadata?.file === "string" ? metadata.file : "";
  if (file) return `/minds/${fallbackMind}/pages/${file}`;
  return "";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string is a UUID (e.g. a resolved conversation id vs. a raw channel slug). */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Built-in look for significant lifecycle activities that are published without
 * their own icon/color metadata. Keyed on the stable activity type (not stored
 * metadata) so rows written before any styling — like a mind's one-time sprout —
 * still get their distinct display instead of the note-like default.
 */
const ACTIVITY_TYPE_STYLE: Record<string, { color: string; icon: string; label: string }> = {
  mind_sprouted: { color: "green", icon: icons.mind, label: "sprouted" },
};

/** Presentation for a known lifecycle activity type, or undefined for generic ones. */
export function activityTypeStyle(
  type: string,
): { color: string; icon: string; label: string } | undefined {
  return ACTIVITY_TYPE_STYLE[type];
}

/** Human label for an activity type slug ("note_created" → "note created"). */
export function activityTypeLabel(type: string): string {
  return ACTIVITY_TYPE_STYLE[type]?.label ?? type.replace(/_/g, " ");
}

/** Accent color name for the activity peek button/card. */
export function activityColor(metadata: TurnActivity["metadata"]): string {
  return typeof metadata?.color === "string" ? metadata.color : "yellow";
}

/**
 * Whether a peek popover's content should be mounted. Content mounts on first
 * reveal and stays mounted (frozen) — hidden popovers render nothing (#541).
 */
export function shouldRenderPeek(revealed: ReadonlySet<string>, key: string): boolean {
  return revealed.has(key);
}
