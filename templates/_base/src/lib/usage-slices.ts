/**
 * Usage math for templates whose SDK reports usage per assistant message (pi): summing a
 * run's messages, and the per-model slices the daemon prices when a turn spans more than
 * one agent — e.g. subagents that run as their own in-process sessions.
 */

import type { UsageByModel } from "./types.js";

/** Minimal shape of an agent message carrying usage (subset of pi's AgentMessage). */
type UsageMessage = {
  role?: string;
  /** pi-ai's provider id (`anthropic`, `openrouter`, …) — pairs with `model` for pricing. */
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheWrite?: number;
    /** The part of `cacheWrite` with a 1-hour TTL — set by pi-ai's Anthropic provider only. */
    cacheWrite1h?: number;
    cache_creation?: number;
    cacheRead?: number;
    cache_read?: number;
  };
};

/** Summed usage of the assistant messages in one run. */
export type AssistantUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Undefined until a message reports the 1-hour split. */
  cacheWrite1h?: number;
  /** Context size at the last assistant message (input + cache), 0 if none reported. */
  lastContext: number;
  /** `provider:model` of the last assistant message. */
  model?: string;
};

export function sumAssistantUsage(messages: unknown[] | undefined): AssistantUsage {
  const sum: AssistantUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, lastContext: 0 };
  for (const msg of (messages ?? []) as UsageMessage[]) {
    if (msg.role !== "assistant" || !msg.usage) continue;
    sum.input += msg.usage.input ?? 0;
    sum.output += msg.usage.output ?? 0;
    const cacheWrite = msg.usage.cacheWrite ?? msg.usage.cache_creation ?? 0;
    const cacheRead = msg.usage.cacheRead ?? msg.usage.cache_read ?? 0;
    sum.cacheWrite += cacheWrite;
    if (msg.usage.cacheWrite1h !== undefined) {
      sum.cacheWrite1h = (sum.cacheWrite1h ?? 0) + msg.usage.cacheWrite1h;
    }
    sum.cacheRead += cacheRead;
    const context = (msg.usage.input ?? 0) + cacheWrite + cacheRead;
    if (context) sum.lastContext = context;
    if (msg.model) sum.model = msg.provider ? `${msg.provider}:${msg.model}` : msg.model;
  }
  return sum;
}

export function hasTokens(u: AssistantUsage): boolean {
  return u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0;
}

/** Summed usage as a slice under `model`. */
export function usageSlice(u: AssistantUsage, model: string): UsageByModel {
  return {
    model,
    input_tokens: u.input,
    output_tokens: u.output,
    cache_read_input_tokens: u.cacheRead,
    cache_creation_input_tokens: u.cacheWrite,
  };
}

/** A run's usage as a slice under its own model, or undefined if it reported none. */
export function runUsageSlice(messages: unknown[] | undefined): UsageByModel | undefined {
  const u = sumAssistantUsage(messages);
  return u.model && hasTokens(u) ? usageSlice(u, u.model) : undefined;
}

/** Sum slices that share a model id, keeping first-seen order. */
export function mergeSlices(slices: UsageByModel[]): UsageByModel[] {
  const byModel = new Map<string, UsageByModel>();
  for (const s of slices) {
    const acc = byModel.get(s.model);
    if (!acc) {
      byModel.set(s.model, { ...s });
      continue;
    }
    acc.input_tokens += s.input_tokens;
    acc.output_tokens += s.output_tokens;
    acc.cache_read_input_tokens += s.cache_read_input_tokens;
    acc.cache_creation_input_tokens += s.cache_creation_input_tokens;
  }
  return [...byModel.values()];
}
