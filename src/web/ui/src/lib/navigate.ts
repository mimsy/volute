export type Selection =
  | { tab: "system"; kind: "home" }
  | {
      tab: "system";
      kind: "mind";
      name: string;
      section?: string;
    }
  | { tab: "system"; kind: "extension"; extensionId: string; path: string }
  | { tab: "system"; kind: "settings"; section?: string }
  | { tab: "chat"; kind: "home" }
  | { tab: "chat"; kind: "conversation"; conversationId?: string; mindName?: string };

export type Tab = Selection["tab"];

export function parseSelection(): Selection {
  const path = window.location.pathname;
  const search = new URLSearchParams(window.location.search);

  // System tab routes
  if (path === "/settings") return { tab: "system", kind: "settings" };

  const settingsSectionMatch = path.match(/^\/settings\/(.+)$/);
  if (settingsSectionMatch)
    return { tab: "system", kind: "settings", section: settingsSectionMatch[1] };

  // Notes → extension
  if (path === "/notes")
    return { tab: "system", kind: "extension", extensionId: "notes", path: "" };

  const noteMatch = path.match(/^\/notes\/([^/]+)\/(.+)$/);
  if (noteMatch)
    return {
      tab: "system",
      kind: "extension",
      extensionId: "notes",
      path: `${noteMatch[1]}/${noteMatch[2]}`,
    };

  // Extension routes (/ext/<id>/... → extension iframe)
  const extMatch = path.match(/^\/ext\/([^/]+)(?:\/(.*))?$/);
  if (extMatch)
    return { tab: "system", kind: "extension", extensionId: extMatch[1], path: extMatch[2] ?? "" };

  // Mind-scoped note: /minds/:name/notes/:slug → mind page with notes section
  const mindNoteMatch = path.match(/^\/minds\/([^/]+)\/notes\/(.+)$/);
  if (mindNoteMatch)
    return { tab: "system", kind: "mind", name: mindNoteMatch[1], section: "ext:notes:notes" };

  // Mind-scoped page: /minds/:name/pages/:path → mind page with pages section
  const mindPageMatch = path.match(/^\/minds\/([^/]+)\/pages\/(.+)$/);
  if (mindPageMatch)
    return { tab: "system", kind: "mind", name: mindPageMatch[1], section: "ext:pages:pages" };

  // Mind detail pages
  const mindSectionMatch = path.match(/^\/minds\/([^/]+)\/([^/]+)$/);
  if (mindSectionMatch) {
    const rawSection = mindSectionMatch[2];
    // Map legacy "notes" and "pages" sections to extension sections
    const section =
      rawSection === "notes"
        ? "ext:notes:notes"
        : rawSection === "pages"
          ? "ext:pages:pages"
          : rawSection;
    return { tab: "system", kind: "mind", name: mindSectionMatch[1], section };
  }

  const mindMatch = path.match(/^\/minds\/([^/]+)$/);
  if (mindMatch) return { tab: "system", kind: "mind", name: mindMatch[1] };

  // Pages → extension
  if (path === "/pages")
    return { tab: "system", kind: "extension", extensionId: "pages", path: "" };

  const newSiteMatch = path.match(/^\/pages\/([^/]+)$/);
  if (newSiteMatch)
    return { tab: "system", kind: "extension", extensionId: "pages", path: newSiteMatch[1] };

  const newPageMatch = path.match(/^\/pages\/([^/]+)\/(.+)$/);
  if (newPageMatch)
    return {
      tab: "system",
      kind: "extension",
      extensionId: "pages",
      path: `${newPageMatch[1]}/${newPageMatch[2]}`,
    };

  // Legacy /page URLs → same as /pages
  if (path === "/page") return { tab: "system", kind: "extension", extensionId: "pages", path: "" };

  const legacySiteMatch = path.match(/^\/page\/([^/]+)$/);
  if (legacySiteMatch)
    return { tab: "system", kind: "extension", extensionId: "pages", path: legacySiteMatch[1] };

  const legacyPageMatch = path.match(/^\/page\/([^/]+)\/(.+)$/);
  if (legacyPageMatch)
    return {
      tab: "system",
      kind: "extension",
      extensionId: "pages",
      path: `${legacyPageMatch[1]}/${legacyPageMatch[2]}`,
    };

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
    case "extension":
      return selection.path
        ? `/ext/${selection.extensionId}/${selection.path}`
        : `/ext/${selection.extensionId}`;
    case "settings":
      return selection.section ? `/settings/${selection.section}` : "/settings";
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
