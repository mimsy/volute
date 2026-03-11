import type { ContentBlock, Message } from "@volute/api";

export interface ApiNote {
  title: string;
  author_username: string;
  slug: string;
  content: string;
  comment_count: number;
  created_at: string;
  reply_to?: { author_username: string; slug: string; title: string } | null;
  reactions?: { emoji: string; count: number }[];
}

export function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function showSenderHeader(messages: Message[], i: number): boolean {
  if (i === 0) return true;
  const prev = messages[i - 1];
  const cur = messages[i];
  return (prev.sender_name ?? prev.role) !== (cur.sender_name ?? cur.role);
}

export function extractTextContent(content: ContentBlock[]): string {
  return content
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

export function scaleIframe(node: HTMLElement) {
  const iframe = node.querySelector("iframe") as HTMLIFrameElement;
  if (!iframe) return;
  const update = () => {
    const w = node.clientWidth;
    if (w > 0) iframe.style.transform = `scale(${w / 1280})`;
  };
  const ro = new ResizeObserver(update);
  ro.observe(node);
  update();
  return { destroy: () => ro.disconnect() };
}
