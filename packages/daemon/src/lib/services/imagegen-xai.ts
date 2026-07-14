/**
 * xAI (Grok Imagine) image provider. One endpoint serves both credential kinds:
 * a SuperGrok/X Premium OAuth token OR a metered XAI_API_KEY hit the same
 * /v1/images/generations. OAuth is preferred (subscription), but xAI allowlists
 * that surface by plan tier — a 403 on an OAuth token means "this plan tier
 * isn't entitled". When that happens we transparently retry with an API key if
 * one is configured (a payment-method swap, not a model swap); otherwise we
 * surface a not-entitled error the caller can explain.
 */

import { readGlobalConfig } from "../config/setup.js";
import log from "../util/logger.js";
import type { Credential, ModelSearchResult } from "./imagegen.js";

const xaiLog = log.child("imagegen-xai");
const XAI_IMAGES_URL = "https://api.x.ai/v1/images/generations";

/** Raised when an xAI plan tier isn't allowlisted for image generation. */
export class XaiNotEntitledError extends Error {
  constructor() {
    super("xAI plan tier is not entitled to image generation");
    this.name = "XaiNotEntitledError";
  }
}

/** Metered API key fallback (never OAuth): imagegen config → ai config → env. */
export function xaiApiKeyFallback(): string | undefined {
  const config = readGlobalConfig();
  return (
    config.imagegen?.providers?.xai?.apiKey ??
    config.ai?.providers?.xai?.apiKey ??
    process.env.XAI_API_KEY ??
    undefined
  );
}

/** One generation request against api.x.ai with a given bearer token. */
async function requestXaiImage(
  model: string,
  prompt: string,
  token: string,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; status: number; body: string }> {
  const res = await fetch(XAI_IMAGES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, prompt, n: 1, response_format: "b64_json" }),
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      body: (await res.text().catch(() => "")).slice(0, 200),
    };
  }
  const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const item = data.data?.[0];
  if (item?.b64_json) return { ok: true, buffer: Buffer.from(item.b64_json, "base64") };
  if (item?.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error(`Failed to fetch xAI image URL: ${imgRes.status}`);
    return { ok: true, buffer: Buffer.from(await imgRes.arrayBuffer()) };
  }
  throw new Error("xAI returned no image");
}

export async function xaiGenerate(
  model: string,
  prompt: string,
  cred: Credential,
): Promise<Buffer> {
  const first = await requestXaiImage(model, prompt, cred.token);
  if (first.ok) return first.buffer;

  // A 403 on an OAuth token = plan tier not allowlisted. Retry with a metered
  // key if configured; otherwise report not-entitled.
  if (first.status === 403 && cred.kind === "oauth") {
    const apiKey = xaiApiKeyFallback();
    if (apiKey) {
      xaiLog.warn(
        "xAI OAuth token not entitled for image generation; retrying with XAI_API_KEY (billed to the API account).",
      );
      const retry = await requestXaiImage(model, prompt, apiKey);
      if (retry.ok) return retry.buffer;
      if (retry.status === 403) throw new XaiNotEntitledError();
      throw new Error(`xAI image generation failed (${retry.status}): ${retry.body}`);
    }
    throw new XaiNotEntitledError();
  }

  throw new Error(`xAI image generation failed (${first.status}): ${first.body}`);
}

// xAI exposes fixed image models; return them statically for the model UI.
export async function xaiSearch(_query: string, _cred: Credential): Promise<ModelSearchResult[]> {
  return [
    {
      id: "xai:grok-imagine-image",
      name: "Grok Imagine",
      description: "xAI Grok Imagine image model ($0.02/image via API key).",
      owner: "xai",
    },
    {
      id: "xai:grok-imagine-image-quality",
      name: "Grok Imagine (quality)",
      description: "Higher-quality Grok Imagine image model ($0.05/image via API key).",
      owner: "xai",
    },
  ];
}
