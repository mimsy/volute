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
  return manifest;
}
