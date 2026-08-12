import type { HistoryMessage } from "@volute/api";
import { activityColor, activityNavUrl, activityPeekBody } from "./peek";

export type CardBody =
  | { kind: "iframe"; url: string }
  | { kind: "markdown"; source: string }
  | { kind: "text"; text: string }
  | { kind: "none" };

export type CardIconKind = "chat" | "gear" | "document-lines";

/**
 * Everything a TimelineCard needs to render one expanded timeline item.
 * `icon` is raw SVG markup (sanitized by the card); `iconKind` is a built-in
 * Icon name used when no SVG is provided. `url` is "" when the item has no
 * document to navigate to.
 */
export type CardModel = {
  color: string;
  icon?: string;
  iconKind?: CardIconKind;
  title: string;
  meta?: string;
  body: CardBody;
  url: string;
};

/** History event types that expand into a card (vs. inline text). */
export const CARD_TIER = new Set(["inbound", "outbound", "event", "activity"]);

/**
 * A system event's worded label ("Orientation", "Schedule: morning-check"), stored on the
 * row by the daemon. Falls back to the type segment of the `event:<type>:<id>` channel for
 * rows written before the label was stored.
 */
export function systemEventLabel(
  meta: Record<string, unknown> | null,
  channel: string | null | undefined,
): string {
  if (typeof meta?.label === "string" && meta.label) return meta.label;
  return channel?.split(":")[1] || "event";
}

/**
 * Map a history event (+ parsed metadata) to the shared card model.
 * Returns null for types that render inline rather than as a card.
 */
export function historyEventCardModel(
  event: Pick<HistoryMessage, "type" | "content" | "channel" | "sender">,
  meta: Record<string, unknown> | null,
  mindName: string,
): CardModel | null {
  switch (event.type) {
    case "inbound":
      return {
        color: "blue",
        iconKind: "chat",
        title: event.channel || "message",
        meta: event.sender ?? "user",
        body: { kind: "text", text: event.content ?? "" },
        url: "",
      };
    case "outbound":
      return {
        color: "red",
        iconKind: "chat",
        title: event.channel || "message",
        meta: mindName,
        body: { kind: "text", text: event.content ?? "" },
        url: "",
      };
    case "event":
      // A system event comes from the environment, not a person: gear icon,
      // "system event" tag, no sender, no channel.
      return {
        color: "purple",
        iconKind: "gear",
        title: systemEventLabel(meta, event.channel),
        meta: "system event",
        body: { kind: "text", text: event.content ?? "" },
        url: "",
      };
    case "activity": {
      const icon = typeof meta?.icon === "string" ? meta.icon : undefined;
      return {
        color: activityColor(meta),
        icon,
        iconKind: icon ? undefined : "document-lines",
        title: event.content ?? "",
        meta: typeof meta?.author === "string" ? meta.author : undefined,
        body: activityPeekBody(meta),
        url: activityNavUrl(meta, mindName),
      };
    }
    default:
      return null;
  }
}

/** Body for a Home-feed extension item (which carries iframeUrl/bodyHtml directly). */
export function feedItemBody(item: { iframeUrl?: string; bodyHtml?: string }): CardBody {
  if (item.iframeUrl) return { kind: "iframe", url: item.iframeUrl };
  if (item.bodyHtml) return { kind: "markdown", source: item.bodyHtml };
  return { kind: "none" };
}
