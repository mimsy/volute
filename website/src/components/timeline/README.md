# Vendored timeline components

These are the real Volute timeline components, vendored from the product UI so the
website renders an actual mind timeline (with hand-authored fixture data) rather
than a mockup. Last re-vendored from main after the system-events rework
(#684/#698: heartbeats and schedules render as sender-less system events, and
card-tier items share `TimelineCard`).

Sources (in the monorepo):

- `TimelineBranch.svelte` — verbatim from `packages/web/src/ui/components/TimelineBranch.svelte`
- `SummaryNode.svelte` — near-verbatim from `packages/web/src/ui/components/SummaryNode.svelte` (import paths only)
- `TimelineCard.svelte` — near-verbatim from `packages/web/src/ui/components/TimelineCard.svelte` (import paths only)
- `HistoryEvent.svelte` — from `packages/web/src/ui/components/HistoryEvent.svelte`, trimmed:
  no API fetches (events come from `fixture-events.ts`), no show-all-events detail
  toggle, cards don't navigate, added `initialExpanded` prop
- `ToolGroup.svelte` — verbatim from `packages/web/src/ui/components/chat/ToolGroup.svelte` (import paths only)
- `StaticTimeline.svelte` — a static fork of `packages/web/src/ui/components/TurnTimeline.svelte`:
  no SSE/fetching/stores/router/modal/liveness/paging; accepts fixture items as
  props; in-memory summary expand fed by `summaryChildren`/`summaryDirectEvents`;
  peeks (conversations, system events, activities) kept, minus navigation
- `Icon.svelte`, `tooltip.ts`, `sanitize.ts` — verbatim from `packages/ui/src/`
- `markdown.ts` — from `packages/ui/src/markdown.ts`
- `tool-groups.ts`, `tool-names.ts`, `peek.ts`, `turn-events.ts`, `timeline-card.ts` —
  verbatim from `packages/web/src/ui/lib/` (import paths only)
- `feed-utils.ts` — just `extractTextContent` from `packages/web/src/ui/lib/feed-utils.ts`
- `period-format.ts` — the pure period/time helpers from `TurnTimeline.svelte`
  (browser-local variant; the product version anchors to the server timezone)
- `timeline.css` — tokens from `packages/ui/src/theme.css` + the shared classes/keyframes
  the components rely on (`.markdown-body`, `.volute-tooltip`, `fadeIn`/`pulse`/`iridescent`)

`types.ts` mirrors the row shapes from `packages/api/src/types.ts` (including
`TurnRow.events`/`TurnSystemEvent` and `HistoryMessage.thread`), so fixture data is
shaped exactly like real exported data — a future "residents" section can render real
mind exports through these same components.

The fixture (`fixture.ts`) is modeled on the rhythms of real minds: heartbeats and
wind-downs arrive as schedule-fired system events (gear markers, private closing
reflections), mornings start at the system channel's shared table, and published
pages/notes ride their turns as activities with the extensions' real icon/color
metadata. The page activity's `iframeUrl` points at a static demo page in
`public/fern/`.

When the product components change visually, re-vendor by re-applying the trims above.
