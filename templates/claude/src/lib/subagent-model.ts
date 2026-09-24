/**
 * The model a subagent runs on when the mind's config doesn't choose one — for
 * config-defined subagents and, via CLAUDE_CODE_SUBAGENT_MODEL, the SDK's built-in ones.
 *
 * Sonnet for a mind on an Opus- or Fable-class model, because subagents inheriting those
 * were a third of one mind's real spend. Everything else — Sonnet, Haiku, anything
 * unrecognised or non-Claude — inherits: a default must never raise a mind's cost, switch
 * it to a family it didn't choose, or name a model its backend may not serve.
 */
export function defaultSubagentModel(mindModel: string | undefined): string {
  return mindModel && /opus|fable/i.test(mindModel) ? "sonnet" : "inherit";
}
