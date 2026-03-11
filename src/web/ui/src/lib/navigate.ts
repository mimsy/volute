export type Selection =
  | { tab: "system"; kind: "home" }
  | {
      tab: "system";
      kind: "mind";
      name: string;
      section?: "info" | "notes" | "pages" | "files" | "settings";
    }
  | { tab: "system"; kind: "mind-note"; mind: string; slug: string }
  | { tab: "system"; kind: "mind-page"; mind: string; path: string }
  | { tab: "system"; kind: "notes" }
  | { tab: "system"; kind: "note"; author: string; slug: string }
  | { tab: "system"; kind: "pages" }
  | { tab: "system"; kind: "site"; name: string }
  | { tab: "system"; kind: "page"; mind: string; path: string }
  | { tab: "chat"; kind: "home" }
  | { tab: "chat"; kind: "conversation"; conversationId?: string; mindName?: string };

export type Tab = Selection["tab"];

export function parseSelection(): Selection {
  const path = window.location.pathname;
  const search = new URLSearchParams(window.location.search);

  // System tab routes
  if (path === "/notes") return { tab: "system", kind: "notes" };

  const noteMatch = path.match(/^\/notes\/([^/]+)\/(.+)$/);
  if (noteMatch) return { tab: "system", kind: "note", author: noteMatch[1], slug: noteMatch[2] };

  // Mind-scoped note: /minds/:name/notes/:slug
  const mindNoteMatch = path.match(/^\/minds\/([^/]+)\/notes\/(.+)$/);
  if (mindNoteMatch)
    return { tab: "system", kind: "mind-note", mind: mindNoteMatch[1], slug: mindNoteMatch[2] };

  // Mind-scoped page: /minds/:name/pages/:path
  const mindPageMatch = path.match(/^\/minds\/([^/]+)\/pages\/(.+)$/);
  if (mindPageMatch)
    return { tab: "system", kind: "mind-page", mind: mindPageMatch[1], path: mindPageMatch[2] };

  // Mind detail pages
  const mindSectionMatch = path.match(/^\/minds\/([^/]+)\/([^/]+)$/);
  if (mindSectionMatch) {
    const section = mindSectionMatch[2] as "info" | "notes" | "pages" | "files" | "settings";
    return { tab: "system", kind: "mind", name: mindSectionMatch[1], section };
  }

  const mindMatch = path.match(/^\/minds\/([^/]+)$/);
  if (mindMatch) return { tab: "system", kind: "mind", name: mindMatch[1] };

  // Pages (new URLs: /pages, /pages/:site, /pages/:site/:path)
  if (path === "/pages") return { tab: "system", kind: "pages" };

  const newSiteMatch = path.match(/^\/pages\/([^/]+)$/);
  if (newSiteMatch) return { tab: "system", kind: "site", name: newSiteMatch[1] };

  const newPageMatch = path.match(/^\/pages\/([^/]+)\/(.+)$/);
  if (newPageMatch)
    return { tab: "system", kind: "page", mind: newPageMatch[1], path: newPageMatch[2] };

  // Legacy /page URLs → same as /pages
  if (path === "/page") return { tab: "system", kind: "pages" };

  const legacySiteMatch = path.match(/^\/page\/([^/]+)$/);
  if (legacySiteMatch) return { tab: "system", kind: "site", name: legacySiteMatch[1] };

  const legacyPageMatch = path.match(/^\/page\/([^/]+)\/(.+)$/);
  if (legacyPageMatch)
    return { tab: "system", kind: "page", mind: legacyPageMatch[1], path: legacyPageMatch[2] };

  // Chat tab routes
  const chatIdMatch = path.match(/^\/chat\/(.+)$/);
  if (chatIdMatch) return { tab: "chat", kind: "conversation", conversationId: chatIdMatch[1] };

  if (path === "/chat") {
    const mind = search.get("mind");
    return mind
      ? { tab: "chat", kind: "conversation", mindName: mind }
      : { tab: "chat", kind: "home" };
  }

  // Legacy /chats URLs
  const legacyChatIdMatch = path.match(/^\/chats\/(.+)$/);
  if (legacyChatIdMatch)
    return { tab: "chat", kind: "conversation", conversationId: legacyChatIdMatch[1] };

  if (path === "/chats") {
    const mind = search.get("mind");
    return mind
      ? { tab: "chat", kind: "conversation", mindName: mind }
      : { tab: "chat", kind: "home" };
  }

  // Default: system home
  return { tab: "system", kind: "home" };
}

export function selectionToPath(selection: Selection): string {
  switch (selection.kind) {
    case "home":
      return selection.tab === "chat" ? "/chat" : "/";
    case "mind":
      return selection.section && selection.section !== "info"
        ? `/minds/${selection.name}/${selection.section}`
        : `/minds/${selection.name}`;
    case "mind-note":
      return `/minds/${selection.mind}/notes/${selection.slug}`;
    case "mind-page":
      return `/minds/${selection.mind}/pages/${selection.path}`;
    case "notes":
      return "/notes";
    case "note":
      return `/notes/${selection.author}/${selection.slug}`;
    case "pages":
      return "/pages";
    case "site":
      return `/pages/${selection.name}`;
    case "page":
      return `/pages/${selection.mind}/${selection.path}`;
    case "conversation":
      if (selection.conversationId) return `/chat/${selection.conversationId}`;
      if (selection.mindName) return `/chat?mind=${selection.mindName}`;
      return "/chat";
    default:
      return "/";
  }
}

export function navigate(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
