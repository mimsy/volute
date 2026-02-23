export type Selection =
  | { kind: "home" }
  | { kind: "pages" }
  | { kind: "site"; name: string }
  | { kind: "page"; mind: string; path: string }
  | { kind: "conversation"; conversationId?: string; mindName?: string };

export function parseSelection(): Selection {
  const path = window.location.pathname;
  const search = new URLSearchParams(window.location.search);

  if (path === "/page" || path === "/pages") return { kind: "pages" };

  const siteMatch = path.match(/^\/page(?:s)?\/([^/]+)$/);
  if (siteMatch) return { kind: "site", name: siteMatch[1] };

  const pageMatch = path.match(/^\/page\/([^/]+)\/(.+)$/);
  if (pageMatch) return { kind: "page", mind: pageMatch[1], path: pageMatch[2] };

  const chatIdMatch = path.match(/^\/chats?\/(.+)$/);
  if (chatIdMatch) return { kind: "conversation", conversationId: chatIdMatch[1] };

  if (path === "/chats" || path === "/chat") {
    const mind = search.get("mind");
    return mind ? { kind: "conversation", mindName: mind } : { kind: "conversation" };
  }

  // Old URLs → home
  return { kind: "home" };
}

export function selectionToPath(selection: Selection): string {
  switch (selection.kind) {
    case "pages":
      return "/page";
    case "site":
      return `/page/${selection.name}`;
    case "page":
      return `/page/${selection.mind}/${selection.path}`;
    case "conversation":
      if (selection.conversationId) return `/chats/${selection.conversationId}`;
      if (selection.mindName) return `/chats?mind=${selection.mindName}`;
      return "/chats";
    default:
      return "/";
  }
}

export function navigate(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
