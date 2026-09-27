import { resolve } from "node:path";

/**
 * pi's built-in tool names, as the claude template's hooks see them. A mind's post-tool-use
 * hook reads the same `tool_name` whichever framework it runs on — a hook matching "Bash"
 * would otherwise never fire on pi, which names it "bash". pi's `find` is claude's `Glob`;
 * anything else (`ls`, a custom tool) passes through unchanged.
 */
const CLAUDE_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  read: "Read",
  grep: "Grep",
  find: "Glob",
};

/** The text a pi tool result carries (its `content` text parts, joined). */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * The stdin a post-tool-use hook gets on pi, in the claude template's shape (its SDK
 * PostToolUse input plus `session`), shared with codex. Only a call that succeeded gets
 * one, as on claude. Where pi's tool maps onto a claude one, the input and response carry
 * claude's fields: a file tool's absolute `file_path` (beside pi's own `path`) and
 * `filePath`; bash's `stdout` and `exit_code` (pi fails a non-zero exit, and interleaves
 * stderr into its one output, so a success is exit 0 with an empty `stderr`). Anything
 * else is pi's own.
 */
export function postToolUseInput(opts: {
  session: string;
  sessionId?: string;
  transcriptPath?: string;
  cwd: string;
  toolName: string;
  toolCallId: string;
  toolInput: Record<string, unknown> | undefined;
  toolResponse: unknown;
}) {
  const input = opts.toolInput ?? {};
  const path = typeof input.path === "string" ? resolve(opts.cwd, input.path) : undefined;
  const isFileTool = ["read", "edit", "write"].includes(opts.toolName);
  let toolResponse = opts.toolResponse;
  if (opts.toolName === "bash") {
    toolResponse = {
      stdout: resultText(opts.toolResponse),
      stderr: "",
      exit_code: 0,
      interrupted: false,
    };
  } else if (isFileTool && path && opts.toolName !== "read") {
    toolResponse = { filePath: path };
  }
  return {
    hook_event_name: "PostToolUse",
    session: opts.session,
    session_id: opts.sessionId,
    transcript_path: opts.transcriptPath,
    cwd: opts.cwd,
    tool_name: CLAUDE_TOOL_NAMES[opts.toolName] ?? opts.toolName,
    tool_input: isFileTool && path ? { ...input, file_path: path } : input,
    tool_response: toolResponse,
    tool_use_id: opts.toolCallId,
  };
}
