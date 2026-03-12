export type ExtensionInfo = {
  id: string;
  name: string;
  version: string;
  description?: string;
  systemSections?: { id: string; label: string; urlPatterns?: string[] }[];
  mindSections?: { id: string; label: string; defaultPath?: string }[];
  feedSource?: { endpoint: string; kind?: string };
};

export async function fetchExtensions(): Promise<ExtensionInfo[]> {
  const res = await fetch("/api/extensions");
  if (!res.ok) return [];
  return res.json();
}
