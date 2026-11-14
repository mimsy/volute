import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { IsolationMode } from "../util/mind-env.js";

/**
 * On macOS, `/usr/bin/git` (and make, clang, …) is a shim that asks `xcrun` where the
 * real tool is, and xcrun writes a lookup cache under the user's temp dir. A sandboxed
 * mind can't write there, so every git it runs prints `xcrun_db … Operation not
 * permitted` before working: harmless, but it reads as failure on every command. The
 * tools themselves sit in the developer directory's `usr/bin`; ahead of `/usr/bin` on
 * the mind's PATH, they are found without the shim. Empty off macOS, unsandboxed, or
 * with no developer tools installed.
 */
export function sandboxedToolchainBin(
  isolationMode: IsolationMode,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "darwin" || isolationMode !== "sandbox") return "";
  return (
    [
      "/Library/Developer/CommandLineTools/usr/bin",
      "/Applications/Xcode.app/Contents/Developer/usr/bin",
    ].find((dir) => exists(resolve(dir, "git"))) ?? ""
  );
}
