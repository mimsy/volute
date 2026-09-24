/**
 * The model a subagent runs on when the mind's config doesn't choose one — for
 * config-defined subagents and, via CLAUDE_CODE_SUBAGENT_MODEL, the SDK's built-in ones.
 *
 * Sonnet, because subagents inheriting the mind's model were a third of one mind's real
 * spend. But a default must never raise a mind's cost, so a mind already on a model
 * cheaper than Sonnet (Haiku) keeps its subagents on its own model.
 */
export function defaultSubagentModel(mindModel: string | undefined): string {
  return mindModel && /haiku/i.test(mindModel) ? "inherit" : "sonnet";
}
