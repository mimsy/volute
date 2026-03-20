import type { ExtensionInfo } from "./extensions";

export type Selection =
  | { kind: "home" }
  | {
      kind: "mind";
      name: string;
      section?: string;
      subpath?: string;
    }
  | { kind: "extension"; extensionId: string; path: string }
  | { kind: "settings"; section?: string }
  | { kind: "shared-files" }
  | { kind: "system-chat" }
  | { kind: "system-history" }
  | { kind: "channel"; slug: string };

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
  const patterns = ext.systemSection?.urlPatterns;
  if (!patterns?.length) return null;
  const firstSegment = patterns[0].split("/").filter(Boolean)[0];
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
    const section = ext.systemSection;
    if (!section?.urlPatterns) continue;
    for (const pattern of section.urlPatterns) {
      const regex = patternToRegex(pattern);
      const match = path.match(regex);
      if (match) {
        const firstSegment = pattern.split("/").filter(Boolean)[0];
        const subpath = path.replace(`/${firstSegment}`, "").replace(/^\//, "");
        return { extensionId: ext.id, path: subpath };
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

  if (path === "/shared-files") return { kind: "shared-files" };
  if (path === "/system/chat") return { kind: "system-chat" };
  if (path === "/history") return { kind: "system-history" };
  if (path === "/settings") return { kind: "settings" };

  const settingsSectionMatch = path.match(/^\/settings\/(.+)$/);
  if (settingsSectionMatch) return { kind: "settings", section: settingsSectionMatch[1] };

  // Mind detail pages — must be checked before extension URL patterns
  // because /minds/:name/:section could overlap
  const mindSubpathMatch = path.match(/^\/minds\/([^/]+)\/([^/]+)\/(.+)$/);
  if (mindSubpathMatch) {
    const [, name, sectionId, subpath] = mindSubpathMatch;
    const extSection = resolveExtensionMindSection(sectionId, extensions);
    return { kind: "mind", name, section: extSection ?? sectionId, subpath };
  }

  const mindSectionMatch = path.match(/^\/minds\/([^/]+)\/([^/]+)$/);
  if (mindSectionMatch) {
    const [, name, sectionId] = mindSectionMatch;
    const extSection = resolveExtensionMindSection(sectionId, extensions);
    return { kind: "mind", name, section: extSection ?? sectionId };
  }

  const mindMatch = path.match(/^\/minds\/([^/]+)$/);
  if (mindMatch) return { kind: "mind", name: mindMatch[1] };

  // Channel pages
  const channelMatch = path.match(/^\/channels\/(.+)$/);
  if (channelMatch) return { kind: "channel", slug: channelMatch[1] };

  // Dynamic extension URL pattern matching (e.g. /notes, /pages/:site)
  const extUrlMatch = matchExtensionUrl(path, extensions);
  if (extUrlMatch)
    return {
      kind: "extension",
      extensionId: extUrlMatch.extensionId,
      path: extUrlMatch.path,
    };

  // Backwards compat: /chat/:id → redirect to channel or mind
  const chatIdMatch = path.match(/^\/chat\/(.+)$/);
  if (chatIdMatch) {
    // Return a channel selection with the conversation ID as slug;
    // the caller will resolve this to the proper route
    return { kind: "channel", slug: `__conv:${chatIdMatch[1]}` };
  }

  if (path === "/chat") {
    const mind = search.get("mind");
    if (mind) return { kind: "mind", name: mind };
    return { kind: "home" };
  }

  // Default: home
  return { kind: "home" };
}

/**
 * Convert a Selection to a URL path.
 * For extensions, uses pretty URLs derived from urlPatterns (e.g. /notes, /pages)
 * rather than /ext/<id> paths.
 */
export function selectionToPath(selection: Selection, extensions: ExtensionInfo[] = []): string {
  switch (selection.kind) {
    case "home":
      return "/";
    case "mind": {
      let section = selection.section;
      // Convert ext:pages:pages → pages for clean URLs
      if (section?.startsWith("ext:")) {
        const parts = section.split(":");
        section = parts[2] ?? parts[1];
      }
      // "chat" is the default section — omit from URL
      const base =
        section && section !== "chat"
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
    case "shared-files":
      return "/shared-files";
    case "system-chat":
      return "/system/chat";
    case "system-history":
      return "/history";
    case "channel": {
      // Don't serialize backwards-compat conv IDs to URL
      if (selection.slug.startsWith("__conv:")) {
        return `/chat/${selection.slug.replace("__conv:", "")}`;
      }
      return `/channels/${selection.slug}`;
    }
    default:
      return "/";
  }
}

export function navigate(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
