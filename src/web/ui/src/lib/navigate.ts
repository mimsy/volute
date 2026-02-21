export type Selection =
  | { kind: "home" }
  | { kind: "page"; mind: string; path: string }
  | { kind: "conversation"; conversationId?: string; mindName?: string };

export function parseSelection(): Selection {
  const path = window.location.pathname;
  const search = new URLSearchParams(window.location.search);

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
