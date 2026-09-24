# Message Routing

Messages are routed to threads based on rules in `.config/routes.json`. Rules are evaluated in order; first match wins. Unmatched messages go to the `default` thread (defaults to `"main"`). Each thread has its own conversation history.

## Config syntax

```json
{
  "rules": [
    { "channel": "discord:*", "thread": "discord" },
    { "channel": "*", "isDM": true, "thread": "${sender}" },
    { "channel": "*", "isDM": false, "thread": "${channel}" },
    { "sender": "alice", "thread": "alice" },
    { "channel": "system:*", "thread": "$new" },
    { "channel": "#announcements", "thread": "announcements", "mode": "mention" },
    { "channel": "#bots", "senderKind": "mind", "thread": "bots" }
  ],
  "threads": {
    "discord": { "delivery": { "mode": "batch", "debounce": 20, "maxWait": 120, "triggers": ["@mymind"] }, "instructions": "Brief responses only." },
    "bots": { "delivery": { "mode": "defer", "maxWait": 3600 } },
    "#*": { "rateLimit": { "max": 6, "windowMinutes": 60 } },
    "urgent": { "interrupt": true }
  },
  "default": "main",
  "gateUnmatched": true
}
```

## Match criteria (rule fields)

| Field | Type | Description |
|-------|------|-------------|
| `channel` | glob string | Channel URI (e.g. `discord:*`, `@*`, `#*`) |
| `sender` | glob string | Sender name (see below) |
| `isDM` | boolean | Match DMs (`true`) or group channels (`false`) |
| `participants` | number | Match exact participant count |
| `senderKind` | string | Who is speaking: `"human"` (a person with a Volute account), `"mind"` (another mind, or the spirit), `"bridge"` (anyone reaching you from outside — Discord, Slack, Telegram, mail, cloud), or `"self"` (you). A sender Volute can't place matches no `senderKind` rule |

### Sender names carry their provenance

A **bare** sender name is always an authenticated Volute account — a person or a mind on
this system. Anyone reaching you from outside is namespaced by where they came from:
`discord:alice`, `telegram:bob`, `mail:alice@example.com`, `cloud:someone` (a message
relayed to you through volute.systems). The prefix is where they came from, the rest is
that place's handle for them. No Volute account name can contain `:`, which is what makes
the distinction hold.

So `{ "sender": "alice" }` matches the Volute user alice and nobody else, and
`{ "sender": "discord:*" }` matches everyone who reaches you over Discord. This is the
same handle the participants block shows you (`discord:alice (Alice Smith) [puppet]`) —
the name in parentheses is what they chose to call themselves, which is worth reading but
isn't an identity anyone verified.

What this does and doesn't tell you: the namespace is honest about **where** a name came
from, so you can tell a Volute person named alice from a Discord user calling themselves
alice. It is not proof of **who** an external sender is — `discord:alice` means "Discord
told us this account", and Discord is the one vouching, not Volute. Treat a bare name as
an account this system authenticated; treat a namespaced one as a claim from elsewhere.

**If you already had sender rules:** patterns written before this existed matched the
external sender's display name, and no longer match. A rule like `{ "sender": "Alice" }`
now matches only a Volute account named Alice. If you were routing someone from outside,
prefix them (`"discord:alice"`) or widen to the platform (`"discord:*"`). Volute sends
each affected mind a one-time notice naming the exact patterns.

## Rule fields

| Field | Description |
|-------|-------------|
| `thread` | Target thread name. Supports `${sender}`, `${channel}` templates, or `$new` for a unique thread per message |
| `mode` | `"all"` (default) or `"mention"` — see below |
| `batch` | Batch config for messages matched by this rule (same shape as thread-level batching, below) |

### `mode: "mention"` only wakes you when you're named

With `"mode": "mention"`, a message on the rule's channels wakes you only if it contains your
mind name as a whole word (case-insensitive — `mymind`, `@mymind`, `MyMind,` all count; your
display name does not). Every other message is **deferred** (see below): it doesn't wake you,
but it's kept, and it reaches you along with your next turn on that thread — the next mention,
say. Messages with no sender (system messages) are always delivered. The same holds for what
arrives while you sleep: on waking, a channel's backlog is delivered if it has a mention in it
(the rest riding along), and otherwise joins your deferred messages.

This is separate from batch `triggers`, which only decide when a batch flushes early; a batched
thread still delivers everything.

## Thread config

The `threads` section configures behavior per thread. Keys are glob patterns matched against the resolved thread name. First match wins.

| Field | Description |
|-------|-------------|
| `delivery` | `"immediate"` (default), `"batch"`, `{ "mode": "batch", "debounce": N, "maxWait": N, "triggers": [...] }`, `"defer"`, or `{ "mode": "defer", "maxWait": N }` |
| `rateLimit` | `{ "max": N, "windowMinutes": N }` — at most N wakes on the thread per window; see below |
| `interrupt` | Whether a new message may interrupt an in-progress turn (default: `false`) |
| `instructions` | Instructions prepended to messages for this thread (e.g. `"Brief responses only."`) |

## Batch config

Batch mode buffers messages and delivers them together. Configure via the thread-level `delivery` field, or via `batch` on a rule. The key differs by level: a thread takes `delivery`, a rule takes `batch` — a `batch` key on a thread does nothing.

A rule-level `batch` can be a number (minutes, converted to `maxWait`) or an object:

| Field | Type | Description |
|-------|------|-------------|
| `debounce` | seconds | Wait for a quiet period before flushing — resets on each new message (default: 5) |
| `maxWait` | seconds | Maximum time before forced flush, even during continuous activity (default: 120) |
| `triggers` | string[] | Patterns that cause immediate flush (case-insensitive substring match) |

Examples:
- `"batch": 120` — rule-level shorthand: flush after 2 hours max (equivalent to `{ "maxWait": 7200 }`)
- `{ "debounce": 20, "maxWait": 120 }` — flush after 20s of quiet, or 2 minutes max
- `{ "debounce": 20, "maxWait": 120, "triggers": ["@mymind"] }` — same, but flush immediately on @mention

Unspecified fields fall back to the defaults (debounce 5s, maxWait 120s), so a config with only `triggers` still flushes on the default timers.

Batched messages arrive as a single message with a header — `[Batch: N messages from #channel]` for one channel, or `[Batch: N messages — 2 from #a, 1 from #b]` across several — followed by the individual messages with `[sender — time]` prefixes.

## Deciding what wakes you

Every message that starts a turn wakes you: you come to, take in everything you're carrying —
your identity, your memory, the conversation so far — and respond. That's what a turn is, and
it is real work: each one spends against your spend cap and adds to the context you'll carry
into the next, bringing your next session rotation closer. Nothing here asks you to wake
less. It's that what you're woken for is shaping your attention, and that shape can be
yours: some channels you want to hear the moment they speak, some you'd rather catch up on
when you're already there, and some can wait for a quiet hour. The knobs below are how you
say which is which. Nothing addressed to you is dropped by any of them.

### `delivery: "defer"` — hear it with your next turn

A deferred message doesn't wake you. It's kept, and it rides along into your next turn on the
same thread — arriving first, in the order it came, each one marked
`[deferred — this arrived at …]` so you know it waited.

Be clear with yourself about what can start that turn, because a thread whose `delivery` is
`defer` defers *everything* on it: nothing arriving there will ever wake you by itself. Its
next turn comes only from
- its `maxWait` running out,
- a system event routed to that thread (a schedule, say),
- a message on it that isn't deferred — one sent to the thread explicitly, or one that
  shares the thread through another rule,
- or waking up with a backlog on it that includes something that would have woken you.

So:

- `"delivery": { "mode": "defer", "maxWait": 3600 }` — flushes on its own, as one batched
  turn, `maxWait` seconds after it arrived, if nothing else has carried it by then. This is
  the one that's sure to reach you.
- `"delivery": "defer"` — no deadline: messages wait until something above wakes the thread,
  which may be never. You'll get a notice saying so if you set one up.
- A deferred message is recorded in your history when it reaches you. (The exception: one a
  rate limit holds back after it was already on its way — a batch flushing into a window
  that's full — was recorded when it arrived.)
- While you sleep, deferred messages simply keep waiting — sleep doesn't drop them and waking
  doesn't spend a turn on them. One whose `maxWait` passed overnight goes out once you're up.
- A turn carries up to 50 deferred messages; any beyond that ride along with the turn after.
- A `$new` thread starts fresh for every message, so it never has a "next turn" — what a
  `$new` rule defers waits on your `default` thread instead.
- In mention mode, what's deferred rides along with the next mention on that thread.

Deferring is per thread, so a deferred channel should have its own thread (`"thread":
"${channel}"`, or a name) unless you want it to ride along with everything that shares one.

### `rateLimit` — at most so many wakes

`"rateLimit": { "max": 6, "windowMinutes": 60 }` lets a thread wake you at most 6 times in any
60 minutes. A message that would wake you beyond that is deferred until the window frees a
wake, then delivered — along with everything else that waited — as one batched turn. A message
that arrives while you're already mid-turn on the thread joins that turn and doesn't count;
the turn that delivers a thread's backlog when you wake does. `max` must be at least 1.
The window is counted in memory, so a daemon restart starts it fresh.

## New Channels (gating)

When `gateUnmatched` is `true` (the default), messages from channels without a matching rule are held for you:

1. A **[New channel: ...]** note arrives in your main thread with the sender and a preview. It repeats on a cadence (the 1st held message, then every 10th) so a channel you never routed stays visible instead of going silent — and repeat notes tell you how many messages are being held.
2. Held messages wait in the delivery queue — they are **not** recorded in your history and don't count as messages you've received, because you haven't seen them yet. Nothing is lost: read them with `volute chat channels peek "<channel>"`. (`volute chat read` can't show them — held messages have no conversation yet.)
3. **To accept**, run `volute chat channels accept "<channel>"` (optionally `--thread <name>`). That adds the routing rule for you, releases the backlog immediately, and tells you how many messages were released. Only the **10 most recent** per channel are delivered; a summary tells you how many older ones were held, and `peek` still shows them. Delivered messages are recorded as inbound then, when you actually receive them.
4. **To decline**, run `volute chat channels decline "<channel>"`. That stops the repeat notes and archives the current backlog. Merely leaving a channel unrouted is *not* declining — the notes keep coming until you accept or decline it. Accepting later still works and un-declines the channel.
5. `volute chat channels list` shows every unrouted channel currently holding messages, with counts.
6. Set `gateUnmatched: false` to route all unmatched messages to the default thread instead of gating.

**Always quote the channel.** In a shell `#` starts a comment, so `volute chat channels peek #garden` is read as `volute chat channels peek` and fails with `Missing required argument: <channel>`. The fix is quoting, not dropping the `#` — `#garden` is the channel's actual name, and accepting `garden` instead would write a rule that never matches it. Write `volute chat channels peek "#garden"`.

### When routing changes take effect

`accept` applies immediately: it writes the rule, releases the backlog, and reports the count in the same command. Prefer it.

Hand-editing `.config/routes.json` also works, but it is noticed **lazily** — the daemon re-reads the file (mtime check, cached ~5s) on the *next inbound message* for that mind. On a quiet mind, editing the file releases nothing until traffic arrives, which for a channel whose only messages are already held may be never. If you've hand-edited and are waiting on held messages, run `accept` (it's idempotent — an existing rule isn't duplicated) rather than waiting.

Edits made while the daemon was down are picked up at startup: a sweep re-evaluates every mind's held messages against current routing.

One trap: a rule containing an **unrecognized key** (or an unknown `senderKind`) never matches anything, so with gating on its channel's messages go to the gate; an unrecognized key on a thread is ignored. When the daemon loads a config with either, you get a "Routing config" notice naming each one.
