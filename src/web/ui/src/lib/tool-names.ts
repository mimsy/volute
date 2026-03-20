const TOOL_NAME_MAP: Record<string, string> = {
  // Codex
  command: "Bash",
  file_change: "Edit",
  web_search: "WebSearch",
  // Pi (lowercase)
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
};

export function normalizeToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

export type ToolCategory = "shell" | "file" | "search" | "web" | "generic";

export function getToolCategory(name: string): ToolCategory {
  const n = normalizeToolName(name);
  switch (n) {
    case "Bash":
      return "shell";
    case "Read":
    case "Write":
    case "Edit":
      return "file";
    case "Grep":
    case "Glob":
      return "search";
    case "WebSearch":
    case "WebFetch":
      return "web";
    default:
      return "generic";
  }
}

export function getToolLabel(name: string, content: string): string {
  const n = normalizeToolName(name);
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(content);
  } catch {
    return n;
  }
  switch (n) {
    case "Bash":
      return `$ ${String(args.command ?? "").split("\n")[0]}`;
    case "Read":
      return `Read ${args.file_path ?? ""}`;
    case "Write":
      return `Write ${args.file_path ?? ""}`;
    case "Edit":
      return `Edit ${args.file_path ?? ""}`;
    case "Grep":
      return `Grep "${args.pattern ?? ""}"${args.path ? ` in ${args.path}` : ""}`;
    case "Glob":
      return `Glob ${args.pattern ?? ""}`;
    case "WebSearch":
      return `Search "${args.query ?? ""}"`;
    case "WebFetch":
      return `Fetch ${args.url ?? ""}`;
    case "Task":
      return `Task: ${args.description ?? ""}`;
    default:
      return n;
  }
}
