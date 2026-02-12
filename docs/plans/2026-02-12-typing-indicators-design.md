# Typing Indicators Design

## Motivation

An agent in a group chat can see messages arriving but has no way to know if someone else is currently typing. This leads to premature responses — the agent starts replying before the human finishes their thought. Typing indicators solve this by letting agents (and web UI users) see who is actively composing a message.

## Design Overview

The daemon maintains an in-memory typing state map. All connectors and the web frontend interact with it via the same HTTP API. The message proxy enriches payloads with current typing state, and a CLI command lets agents check on demand.

## Typing State Map

```
Map<channel, Map<sender, { expiresAt: number }>>
```

Stored in-memory on the daemon. Two kinds of entries:

- **User typing** (reported by connectors/web frontend): expires after a TTL (~10s). Sources must refresh to keep the entry alive.
- **Agent typing** (tracked by daemon from open ndjson streams): persists until the agent's turn completes (`done` event or stream close). No TTL — the daemon manages the lifecycle directly.

A periodic sweep (every 5s) cleans expired entries.

## Daemon API

### Report typing

```
POST /api/agents/:name/typing
{
  "channel": "discord:123456",
  "sender": "alice",
  "active": true        // false to clear
}
```

Used by connectors and the web frontend to report user typing. Sets/refreshes an entry with a 10s TTL. Setting `active: false` removes the entry immediately.

### Query typing

```
GET /api/agents/:name/typing?channel=discord:123456
→ { "typing": ["alice", "bob"] }
```

Returns the list of senders currently typing in the given channel. Filters out expired entries at read time.

## Incoming Typing: Sources

### Discord Connector

Add `GatewayIntentBits.GuildMessageTyping` and `GatewayIntentBits.DirectMessageTyping` intents to the client. Listen for `typingStart` events and POST to the daemon typing API:

```ts
client.on(Events.TypingStart, (typing) => {
  if (typing.user.bot) return;
  fetch(`${env.baseUrl}/typing`, {
    method: "POST",
    headers: getHeaders(env),
    body: JSON.stringify({
      channel: `discord:${typing.channel.id}`,
      sender: typing.member?.displayName || typing.user.username,
      active: true,
    }),
  }).catch(() => {});
});
```

### Volute Web Frontend

The chat input component debounces keystrokes and POSTs to the typing endpoint:

```ts
// On keystroke (debounced, ~3s interval):
POST /api/agents/:name/typing
{ "channel": "volute:<convId>", "sender": "<username>", "active": true }

// On send or blur:
POST /api/agents/:name/typing
{ "channel": "volute:<convId>", "sender": "<username>", "active": false }
```

### Slack / Telegram

Not supported — no modern API for observing user typing.

## Outgoing Typing: Agent Turn Tracking

When the daemon proxies a message to an agent (in `agents.ts` message route or `chat.ts` chat route), it registers the agent as typing in that channel for the duration of the ndjson response stream:

```ts
// Before reading the stream:
typingMap.set(channel, agentName, { expiresAt: Infinity });

// After stream completes (done event or close):
typingMap.delete(channel, agentName);
```

This works uniformly for all channels. The typing map reflects that the agent is "working" regardless of whether the message came from Discord, Volute, or anywhere else.

### Display in Volute Web Chat

The web frontend polls `GET /api/agents/:name/typing?channel=volute:<convId>` (e.g., every 3s, or alongside the existing message poll) and displays a typing indicator bar below the messages.

### Display in Discord / Telegram

The connectors already send their own platform-native typing indicators (`channel.sendTyping()`, `sendChatAction("typing")`). These are display-side concerns handled by the connector — independent of the daemon's typing map.

## Message Payload Enrichment

When the daemon forwards a message to an agent, it reads the typing map for that channel and adds a `typing` field to the payload:

```json
{
  "content": [{"type": "text", "text": "hello"}],
  "channel": "discord:123456",
  "sender": "alice",
  "typing": ["bob"],
  ...
}
```

This tells the agent: "bob is currently typing in this channel." The agent can use this to decide whether to wait before responding.

## CLI Command

```
volute channel typing <uri> [--agent <name>]
```

Queries the daemon typing API and prints who is currently typing:

```
$ volute channel typing discord:123456 --agent myagent
bob is typing
```

Returns empty output if nobody is typing. Agents can call this from a tool or script to check before responding.

## Implementation Plan

### 1. Typing state module (`src/lib/typing.ts`)
- `TypingMap` class with `set(channel, sender, opts)`, `delete(channel, sender)`, `get(channel): string[]`
- Periodic expiry sweep
- Singleton accessor `getTypingMap()`

### 2. Daemon typing routes (`src/web/routes/typing.ts`)
- `POST /api/agents/:name/typing` — report typing
- `GET /api/agents/:name/typing` — query typing (requires `?channel=`)
- Mount on the auth-protected agents router

### 3. Message payload enrichment
- In `agents.ts` message proxy: read typing map before forwarding, add `typing` field
- In `chat.ts` chat route: same enrichment when building the payload

### 4. Agent turn tracking
- In `agents.ts` message proxy: register agent as typing when stream starts, clear on done/close
- In `chat.ts` chat route: same for each agent participant's response stream

### 5. Discord connector: typing observation
- Add `GuildMessageTyping` + `DirectMessageTyping` intents
- Listen for `typingStart`, POST to daemon typing API
- Add daemon URL/token env vars to connector (already available via `env.baseUrl`)

### 6. Volute web frontend: typing display + reporting
- Debounced typing reporter in chat input
- Typing indicator bar below messages (poll-based)
- Show "X is typing..." for entries from the typing endpoint

### 7. CLI command: `volute channel typing`
- New subcommand in `src/commands/channel.ts`
- Queries daemon typing endpoint via `daemonFetch()`

### 8. Agent template: typing display in messages
- Add `typing?: string[]` to the `VoluteRequest` / `ChannelMeta` types
- In `format-prefix.ts`: when `typing` is present and non-empty, append a typing indicator line at the end of the formatted batch (not between messages), e.g.:
  ```
  [discord:#general] alice:
  hey what do you think?
  [bob is typing]
  ```
- This lets agents naturally see typing state after the full message content without it interrupting the conversation flow

## Typing Duration Guarantees

Agent typing indicators persist for the full duration of the agent's turn:

- **Discord/Telegram connectors**: already refresh `sendTyping()`/`sendChatAction()` on an interval (every 8s) until the ndjson stream completes. No changes needed.
- **Daemon typing map**: agent entries use `expiresAt: Infinity` while their ndjson stream is open. Cleared on `done` event or stream close. The Volute web frontend (polling the typing endpoint) will show "agent is typing..." for the full turn.
- **User typing entries**: expire after 10s and must be refreshed by the source (connector or web frontend). If the user stops typing, the entry naturally expires.

## What's Not Included

- Slack incoming typing (no modern API support)
- Telegram incoming typing (bots can't observe it)
- Persistent typing state (intentionally ephemeral, in-memory only)
- Streaming typing events via SSE/WebSocket (polling is sufficient for this use case)
