export type {
  ActivityEvent,
  CommandHandler,
  Database,
  ExtensionCommand,
  ExtensionContext,
  ExtensionFeedItem,
  ExtensionManifest,
  FeedSource,
  MindSection,
  SystemSection,
  User,
} from "./types.js";

import type { ExtensionManifest } from "./types.js";

const VALID_EXTENSION_ID = /^[a-z0-9][a-z0-9_-]*$/;

export function createExtension(manifest: ExtensionManifest): ExtensionManifest {
  if (!manifest.id) throw new Error("Extension manifest requires an id");
  if (!VALID_EXTENSION_ID.test(manifest.id))
    throw new Error(
      "Extension id must be lowercase alphanumeric with hyphens/underscores, starting with a letter or digit",
    );
  if (typeof manifest.routes !== "function")
    throw new Error("Extension manifest requires a routes function");
  return manifest;
}
