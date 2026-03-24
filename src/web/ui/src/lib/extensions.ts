export type ExtensionInfo = {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  systemSection?: { id: string; label: string; urlPatterns?: string[] };
  mindSections?: { id: string; label: string; defaultPath?: string }[];
  feedSource?: { endpoint: string; kind?: string };
};

export async function fetchExtensions(): Promise<ExtensionInfo[]> {
  const res = await fetch("/api/extensions");
  if (!res.ok) {
    console.warn(`Failed to fetch extensions: HTTP ${res.status}`);
    return [];
  }
  return res.json();
}

export type ExtensionManagementInfo = {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  source: "builtin" | "npm" | "local";
  enabled: boolean;
  package?: string;
};
