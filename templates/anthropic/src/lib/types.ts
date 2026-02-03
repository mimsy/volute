export type MoltBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; output: string; is_error?: boolean }
  | { type: "image"; media_type: string; data: string }

export type MoltMessage = {
  role: "user" | "assistant" | "system"
  blocks: MoltBlock[]
  done?: boolean
  timestamp: number
}
