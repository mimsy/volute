import type { ExtensionInfo } from "./extensions";

export type Selection =
  | { tab: "system"; kind: "home" }
  | {
      tab: "system";
      kind: "mind";
      name: string;
      section?: string;
      subpath?: string;
    }
  | { tab: "system"; kind: "extension"; extensionId: string; path: string }
  | { tab: "system"; kind: "settings"; section?: string }
  | { tab: "chat"; kind: "home" }
  | { tab: "chat"; kind: "conversation"; conversationId?: string; mindName?: string };

export type Tab = Selection["tab"];

/**
 * Convert a urlPattern like "/notes/:author/:slug" to a regex.
 * Named params (`:param`) match one path segment; `*` matches the rest.
 */
function patternToRegex(pattern: string): RegExp {
  const parts = pattern.split("/").filter(Boolean);
  const regexParts = parts.map((p) => {
    if (p === "*") return "(.*)";
    if (p.startsWith(":")) return "([^/]+)";
    return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^/${regexParts.join("/")}(?:/(.*))?$`);
}

/**
 * Get the base URL prefix for an extension from its urlPatterns.
 * E.g. for patterns ["/notes", "/notes/:author/:slug"], returns "/notes".
 */
function getExtensionBaseUrl(ext: ExtensionInfo): string | null {
  const patterns = ext.systemSections?.flatMap((s) => s.urlPatterns ?? []);
  if (!patterns?.length) return null;
  // Use the first static segment from the shortest pattern
  const first = patterns[0];
  const firstSegment = first.split("/").filter(Boolean)[0];
  return firstSegment ? `/${firstSegment}` : null;
}

/**
 * Try to match a path against extension system section urlPatterns.
 * Returns the extensionId and captured subpath, or null.
 */
function matchExtensionUrl(
  path: string,
  extensions: ExtensionInfo[],
): { extensionId: string; path: string } | null {
  for (const ext of extensions) {
    if (!ext.systemSections) continue;
    for (const section of ext.systemSections) {
      if (!section.urlPatterns) continue;
      for (const pattern of section.urlPatterns) {
        const regex = patternToRegex(pattern);
        const match = path.match(regex);
        if (match) {
          // Reconstruct the subpath from everything after the first segment
          const firstSegment = pattern.split("/").filter(Boolean)[0];
          const subpath = path.replace(`/${firstSegment}`, "").replace(/^\//, "");
          return { extensionId: ext.id, path: subpath };
        }
      }
    }
  }
  return null;
}

/**
 * Check if a mind section ID corresponds to an extension's mindSection.
 */
function resolveExtensionMindSection(
  sectionId: string,
  extensions: ExtensionInfo[],
): string | null {
  for (const ext of extensions) {
    if (!ext.mindSections) continue;
    for (const ms of ext.mindSections) {
      if (ms.id === sectionId) {
        return `ext:${ext.id}:${ms.id}`;
      }
    }
  }
  return null;
}

export function parseSelection(extensions: ExtensionInfo[] = []): Selection {
  const path = window.location.pathname;
  const search = new URLSearchParams(window.location.search);

  // System tab routes
  if (path === "/settings") return { tab: "system", kind: "settings" };

  const settingsSectionMatch = path.match(/^\/settings\/(.+)$/);
  if (settingsSectionMatch)
    return { tab: "system", kind: "settings", section: settingsSectionMatch[1] };

  // Mind detail pages — must be checked before extension URL patterns
  // because /minds/:name/:section could overlap
  const mindSubpathMatch = path.match(/^\/minds\/([^/]+)\/([^/]+)\/(.+)$/);
  if (mindSubpathMatch) {
    const [, name, sectionId, subpath] = mindSubpathMatch;
    const extSection = resolveExtensionMindSection(sectionId, extensions);
    return { tab: "system", kind: "mind", name, section: extSection ?? sectionId, subpath };
  }

  const mindSectionMatch = path.match(/^\/minds\/([^/]+)\/([^/]+)$/);
  if (mindSectionMatch) {
    const [, name, sectionId] = mindSectionMatch;
    const extSection = resolveExtensionMindSection(sectionId, extensions);
    return { tab: "system", kind: "mind", name, section: extSection ?? sectionId };
  }

  const mindMatch = path.match(/^\/minds\/([^/]+)$/);
  if (mindMatch) return { tab: "system", kind: "mind", name: mindMatch[1] };

  // Dynamic extension URL pattern matching (e.g. /notes, /pages/:site)
  const extUrlMatch = matchExtensionUrl(path, extensions);
  if (extUrlMatch)
    return {
      tab: "system",
      kind: "extension",
      extensionId: extUrlMatch.extensionId,
      path: extUrlMatch.path,
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

/**
 * Convert a Selection to a URL path.
 * For extensions, uses pretty URLs derived from urlPatterns (e.g. /notes, /pages)
 * rather than /ext/<id> paths.
 */
export function selectionToPath(selection: Selection, extensions: ExtensionInfo[] = []): string {
  switch (selection.kind) {
    case "home":
      return selection.tab === "chat" ? "/chat" : "/";
    case "mind": {
      let section = selection.section;
      // Convert ext:pages:pages → pages for clean URLs
      if (section?.startsWith("ext:")) {
        const parts = section.split(":");
        section = parts[2] ?? parts[1];
      }
      const base =
        section && section !== "info"
          ? `/minds/${selection.name}/${section}`
          : `/minds/${selection.name}`;
      return selection.subpath ? `${base}/${selection.subpath}` : base;
    }
    case "extension": {
      const ext = extensions.find((e) => e.id === selection.extensionId);
      const base = ext ? getExtensionBaseUrl(ext) : null;
      if (base) {
        return selection.path ? `${base}/${selection.path}` : base;
      }
      // Fallback for extensions without urlPatterns
      return selection.path
        ? `/ext/${selection.extensionId}/${selection.path}`
        : `/ext/${selection.extensionId}`;
    }
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
