export type {
  ActivityEvent,
  Database,
  ExtensionContext,
  ExtensionFeedItem,
  ExtensionManifest,
  FeedSource,
  MindSection,
  SystemSection,
  User,
} from "./types.js";

import type { ExtensionManifest } from "./types.js";

export function createExtension(manifest: ExtensionManifest): ExtensionManifest {
  if (!manifest.id) throw new Error("Extension manifest requires an id");
  if (typeof manifest.routes !== "function")
    throw new Error("Extension manifest requires a routes function");
  return manifest;
}
