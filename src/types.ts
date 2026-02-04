export type MoltContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string }

export type MoltRequest = {
  content: MoltContentPart[]
  channel?: string
  session?: string
}

export type MoltEvent =
  | { type: "text"; content: string }
  | { type: "image"; media_type: string; data: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; output: string; is_error?: boolean }
  | { type: "done" }
