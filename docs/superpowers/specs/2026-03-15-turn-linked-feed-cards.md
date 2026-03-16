# Turn-Linked Feed Cards

## Problem

Feed cards (conversations, notes, pages) on the mind timeline are paired to turn summaries using timestamp overlap. This is fragile (same-second collisions, wrong pairings) and loads everything upfront. With first-class turns now in place, we can structurally link all feed items to the turns and events that produced them.

## Design

### Structural Linking

Every feed-producing action gets tagged with the turn and tool_use event that caused it:

- **Conversation messages** get a `turn_id` column. Inbound messages are tagged when created in the chat endpoint. Outbound messages already have `source_event_id`; they also get `turn_id`.
- **Activity events** (notes, pages) get `turn_id` and `source_event_id` columns. Populated automatically when `publishActivity` is called from a mind-authenticated request context — the daemon looks up the active turn and last tool_use event for that mind.

### Schema Changes

**`messages` table**: add `turn_id` text (nullable)

**`activity` table**: add `turn_id` text (nullable), `source_event_id` integer (nullable)

**Migration**: `drizzle/0002_turn_feed_links.sql`

### Chat Endpoint Changes

In `src/web/api/volute/chat.ts`, both the per-mind chat endpoint (`POST /:name/chat`) and the unified chat endpoint (`POST /chat`):

1. Before `addMessage`: resolve the active turn for the target mind(s). For each mind being delivered to, call `getActiveTurnId(mindName)` to get the current turn. If sender is a mind, also look up `getLastToolUseEventId`.
2. Pass `turn_id` (and `source_event_id` for mind senders) to `addMessage`.

The `addMessage` function already accepts an `opts` parameter — extend it with `turnId`.

### Activity Event Changes

In `src/lib/events/activity-events.ts`, the `publishActivity` function and the `activity` table insert path:

1. `publishActivity` accepts optional `turnId` and `sourceEventId` fields.
2. In extension route handlers that call `ctx.publishActivity()`, the extension context resolves the caller's mind name (from auth), looks up the active turn and last tool_use event, and passes them through.
3. The `ExtensionContext.publishActivity` method in `src/lib/extensions.ts` is updated to auto-attach turn context when the caller is a mind.

### New Endpoint: Turn-Based Timeline

**`GET /api/minds/:name/history/turns`**

Query params: `limit`, `offset` (pagination, newest first)

Returns an array of turn objects, each containing:

```ts
{
  id: string;              // turn ID
  summary: string;         // summary text
  summary_meta: object;    // summary metadata (tools, times)
  status: string;          // "active" | "complete"
  created_at: string;
  // Linked items for this turn:
  conversations: {
    id: string;            // conversation ID
    label: string;         // display label (@user, #channel)
    type: "dm" | "channel";
    messages: {            // messages sent/received during this turn
      role: string;
      sender_name: string;
      content: ContentBlock[];
      source_event_id: number | null;
      created_at: string;
    }[];
  }[];
  activities: {
    type: string;          // "note_created", "page_published", etc.
    title: string;
    url: string;
    icon?: string;
    color?: string;
    body_preview: string;  // first ~200 chars
    source_event_id: number | null;
    created_at: string;
  }[];
}
```

Implementation:
1. Query `turns` table for the mind, ordered by `created_at DESC`, with limit/offset.
2. For each turn, query `messages WHERE turn_id = X` grouped by `conversation_id`. Join with conversations for label/type.
3. For each turn, query `activity WHERE turn_id = X`.
4. Join the summary from `mind_history WHERE turn_id = X AND type = 'summary'`.

For turns without any linked items (e.g., old data before structural linking), the `conversations` and `activities` arrays will be empty — the summary still renders standalone.

### Frontend Changes

**MindPage.svelte** — rewrite the timeline data layer:

1. Replace three separate fetches (history summaries, conversations, extension feeds) with a single `fetchTurns(name, { limit, offset })` call.
2. The `timeline` derived removes all time-range pairing logic. Each turn row has its feed items pre-linked.
3. SSE handler: on `summary` event, the turn_id is included. Fetch that turn's linked items and insert into the timeline.

**Timeline row structure (collapsed)**:
- Left column: summary text
- Right column: stacked feed cards for that turn

**Timeline row structure (expanded)**:
- Left column: expanded turn events (inbound, text, tool_use, etc.)
- Right column: feed cards positioned next to their `source_event_id` event. Cards without a source_event_id (inbound conversation messages) sit next to the inbound event.

**Chat cards become turn-scoped**: instead of showing the last N messages of the whole conversation, they show only messages with matching `turn_id`. The card header still shows the channel label, and clicking opens the full conversation modal.

**ExtensionFeedCard**: unchanged in structure. Just receives its data from the turn object instead of a separate fetch.

### Backward Compatibility

- `turn_id` on messages and activity is nullable. Old data without turns renders summaries with empty feed card lists.
- The existing `GET /history` endpoint is unchanged. The new `/history/turns` endpoint is additive.
- Old summaries without `turn_id` still work in the timeline — they just won't have linked feed items.
- The time-range pairing code in MindPage.svelte is removed entirely. No fallback to temporal matching.

## Files to Modify

| File | Change |
|------|--------|
| `src/lib/schema.ts` | Add `turn_id` to messages, `turn_id` + `source_event_id` to activity |
| `drizzle/0002_turn_feed_links.sql` | Migration SQL |
| `drizzle/meta/_journal.json` | Add migration entry |
| `packages/api/src/types.ts` | Add Turn type for the new endpoint |
| `src/lib/events/conversations.ts` | Extend `addMessage` opts with `turnId` |
| `src/lib/events/activity-events.ts` | Add turn fields to publish + persist |
| `src/lib/extensions.ts` | Auto-attach turn context in `publishActivity` |
| `src/web/api/volute/chat.ts` | Pass `turnId` to `addMessage` for all recipients |
| `src/web/api/minds.ts` | New `GET /:name/history/turns` endpoint |
| `src/web/ui/src/lib/client.ts` | Add `fetchTurns` client function |
| `src/web/ui/src/pages/MindPage.svelte` | Rewrite timeline to use turns endpoint |
| `src/web/ui/src/components/HistoryEvent.svelte` | Accept and render linked feed cards |

## Verification

1. Unit tests for the new endpoint
2. Verify activity events get turn_id when created by minds
3. Verify conversation messages get turn_id in both chat endpoints
4. Manual e2e: send a message to a mind, verify the resulting turn's endpoint returns the conversation messages and any notes/pages created
5. Visual verification: timeline shows feed cards linked to turns, expanding shows cards next to source events
6. Backward compat: old history without turn_ids renders correctly (summaries without cards)
