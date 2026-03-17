import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type PageEntry = { publishedAt: string };
export type PagesManifest = { pages: Record<string, PageEntry> };

export function readManifest(pagesDir: string): PagesManifest {
  const manifestPath = resolve(pagesDir, "pages.json");
  if (!existsSync(manifestPath)) return { pages: {} };
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return { pages: {} };
  }
}

export function writeManifest(pagesDir: string, manifest: PagesManifest): void {
  const manifestPath = resolve(pagesDir, "pages.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

export function isPublished(pagesDir: string, file: string): boolean {
  const manifest = readManifest(pagesDir);
  return file in manifest.pages;
}

export function publishPage(pagesDir: string, file: string): PagesManifest {
  const manifest = readManifest(pagesDir);
  manifest.pages[file] = { publishedAt: new Date().toISOString() };
  writeManifest(pagesDir, manifest);
  return manifest;
}

export function unpublishPage(pagesDir: string, file: string): PagesManifest {
  const manifest = readManifest(pagesDir);
  delete manifest.pages[file];
  writeManifest(pagesDir, manifest);
  return manifest;
}
