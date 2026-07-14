/**
 * OpenAI Codex image provider — generates images through a ChatGPT subscription
 * (no metered API key) by driving the Codex Responses backend's hosted
 * `image_generation` tool. This is the same mechanism OpenClaw and Hermes use.
 *
 * The credential is a Codex OAuth access token (resolved by the imagegen
 * service from the `openai-codex` AI provider). The account id is read from the
 * token's own JWT claim, so nothing extra needs storing.
 */

import type { Credential, ModelSearchResult } from "./imagegen.js";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
// Host chat model: cheap, only needs to carry the hosted image tool. Its text
// output is discarded — the image comes from the tool, not the model.
const HOST_MODEL = "gpt-5.4-mini";

/**
 * Exact 400 body the backend returns when the account's plan is not entitled to
 * the hosted image tool. Callers (entitlement) match on this precise string.
 */
export const CODEX_NOT_ENTITLED_SENTINEL =
  "Tool choice 'image_generation' not found in 'tools' parameter.";

/** Raised when the plan can't use the hosted image tool (vs. a transient error). */
export class CodexNotEntitledError extends Error {
  constructor() {
    super(CODEX_NOT_ENTITLED_SENTINEL);
    this.name = "CodexNotEntitledError";
  }
}

/** Extract the chatgpt-account-id from a Codex OAuth access token's JWT claims. */
export function accountIdFromToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<
      string,
      unknown
    >;
    const auth = claims["https://api.openai.com/auth"] as
      | { chatgpt_account_id?: string }
      | undefined;
    return auth?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

function codexHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    session_id: crypto.randomUUID(),
  };
  const accountId = accountIdFromToken(token);
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return headers;
}

/**
 * Build the Responses request that forces the hosted image tool.
 * `imageModel` is the image model id (e.g. "gpt-image-2").
 */
export function buildCodexRequest(imageModel: string, prompt: string): unknown {
  return {
    model: HOST_MODEL,
    instructions:
      "Use the image_generation tool immediately to render the request. Never ask questions.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [
      {
        type: "image_generation",
        model: imageModel,
        size: "1024x1024",
        quality: "auto",
        output_format: "png",
        partial_images: 1,
      },
    ],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
  };
}

/**
 * Parse the Codex SSE stream and return the final image bytes. The image never
 * appears in the terminal `response.completed` payload (its output array is
 * empty); the bytes arrive in `image_generation_call.partial_image` /
 * `output_item.done` events, so we keep the longest base64 blob seen.
 */
export async function parseCodexImageStream(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let best = "";

  const consumeLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const candidate =
      (evt.partial_image_b64 as string | undefined) ??
      (evt.result as string | undefined) ??
      (evt.item as { result?: string } | undefined)?.result ??
      undefined;
    if (candidate && candidate.length > best.length) best = candidate;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      consumeLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  consumeLine(buf);

  if (!best) throw new Error("Codex stream produced no image");
  return Buffer.from(best, "base64");
}

export async function codexGenerate(
  model: string,
  prompt: string,
  cred: Credential,
): Promise<Buffer> {
  const res = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: codexHeaders(cred.token),
    body: JSON.stringify(buildCodexRequest(model, prompt)),
  });

  if (res.status === 400) {
    const errBody = await res.text().catch(() => "");
    if (errBody.includes(CODEX_NOT_ENTITLED_SENTINEL)) throw new CodexNotEntitledError();
    throw new Error(`Codex image generation failed (400): ${errBody.slice(0, 200)}`);
  }
  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`Codex image generation failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  return parseCodexImageStream(res.body);
}

/**
 * Cheaply probe whether the account is entitled to the hosted image tool: force
 * the tool, then abort the stream the instant it's accepted (the
 * `image_generation_call.in_progress` event) — so we learn entitlement without
 * paying for a full image. A 400 with the sentinel means not entitled.
 */
export async function probeCodexEntitlement(
  cred: Credential,
): Promise<"entitled" | "not_entitled"> {
  const controller = new AbortController();
  let res: Response;
  try {
    res = await fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers: codexHeaders(cred.token),
      body: JSON.stringify(buildCodexRequest("gpt-image-2", "entitlement probe")),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return "entitled";
    throw err;
  }

  if (res.status === 400) {
    const body = await res.text().catch(() => "");
    if (body.includes(CODEX_NOT_ENTITLED_SENTINEL)) return "not_entitled";
    throw new Error(`Codex entitlement probe failed (400): ${body.slice(0, 200)}`);
  }
  if (!res.ok || !res.body) {
    throw new Error(`Codex entitlement probe failed (${res.status})`);
  }

  // Stream until the tool is accepted, then abort — the account is entitled.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("response.image_generation_call.in_progress")) {
        controller.abort();
        return "entitled";
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return "entitled";
    throw err;
  }
  // Stream ended without the tool starting — treat as not entitled.
  return "not_entitled";
}

// Codex exposes a single hosted image model; return it statically so it can be
// enabled in the model-selection UI like any other.
export async function codexSearch(_query: string, _cred: Credential): Promise<ModelSearchResult[]> {
  return [
    {
      id: "openai-codex:gpt-image-2",
      name: "gpt-image-2 (ChatGPT subscription)",
      description: "OpenAI's image model via a ChatGPT/Codex subscription — no API key required.",
      owner: "openai",
    },
  ];
}
