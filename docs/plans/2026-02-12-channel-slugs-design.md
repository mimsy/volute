# Human-Readable Channel Slugs

## Problem

Channel URIs use opaque platform IDs (`discord:1234567890`, `slack:C0AB1CD2E`, `telegram:98765432`). These are hard for agents to read, type in CLI commands, and use in routing rules.

## Solution

Replace platform IDs with human-readable slugs as the canonical channel identifier everywhere. A per-agent mapping file (`channels.json`) maps slugs to platform IDs for API calls.

## Slug Format

All names are slugified: lowercased, spaces/special chars replaced with hyphens.

| Platform | Type | Format | Example |
|----------|------|--------|---------|
| Discord | Guild channel | `discord:server-name/channel-name` | `discord:my-server/general` |
| Discord | DM | `discord:@username` | `discord:@alice` |
| Discord | Group DM | `discord:@user1,user2` | `discord:@alice,bob` |
| Slack | Channel | `slack:workspace/channel-name` | `slack:my-workspace/random` |
| Slack | DM | `slack:@username` | `slack:@bob` |
| Slack | Group DM | `slack:@user1,user2` | `slack:@alice,bob` |
| Telegram | Group | `telegram:group-title` | `telegram:my-group-chat` |
| Telegram | DM | `telegram:@firstname` | `telegram:@john` |
| Volute | Conversation | `volute:title` | `volute:project-planning` |
| Volute | DM | `volute:@username` | `volute:@username` |

Group DM participant lists are sorted alphabetically.

## channels.json

Located at `<agentDir>/.volute/channels.json`. Keyed by slug, stores platform ID and metadata.

```json
{
  "discord:my-server/general": {
    "platformId": "1234567890",
    "platform": "discord",
    "name": "#general",
    "server": "My Server",
    "type": "channel"
  },
  "discord:@alice": {
    "platformId": "9876543210",
    "platform": "discord",
    "name": "alice",
    "type": "dm"
  }
}
```

Written by:
- Connectors as they encounter channels (on every incoming message)
- `volute channel list` command (populates for channels not yet seen)

Read by:
- Channel drivers to resolve slug -> platform ID for read/send operations

## Changes

### Connector SDK (`src/connectors/sdk.ts`)

- Add `slugify(text: string): string` — lowercases, replaces spaces/special chars with hyphens
- Add `buildChannelSlug(platform, meta): string` — builds slug from platform + channel metadata
- Add `writeChannelEntry(agentDir, slug, entry): void` — upserts entry in channels.json
- These are called by each connector when constructing the `AgentPayload`

### Connectors (`src/connectors/discord.ts`, `slack.ts`, `telegram.ts`)

- Replace `platform:${platformId}` channel construction with slug generation via SDK helpers
- Call `writeChannelEntry()` for each channel encountered
- Discord: uses `guild.name`/`channel.name` for channels, `recipient.username` for DMs
- Slack: uses `team`/`channel.name` for channels, username for DMs
- Telegram: uses `chat.title` for groups, `from.first_name` for DMs

### Channel drivers (`src/lib/channels/discord.ts`, `slack.ts`, `telegram.ts`, `volute.ts`)

- Add `resolveChannelId(channels.json path, slug): string` shared helper
- `read()` and `send()` receive slug, resolve to platform ID before calling API
- `listConversations()` returns slugs instead of platform IDs, also writes to channels.json
- `createConversation()` returns slug instead of platform ID

### CLI (`src/commands/channel.ts`)

- `parseUri()` unchanged — still splits on first `:` to get platform + slug
- Channel drivers handle slug resolution internally

### Routing (template `routing.ts`)

- No code changes needed — routing rules match on channel string which is now a slug
- Agents write rules like `{ "channel": "discord:my-server/general", ... }`

### Format prefix (template `format-prefix.ts`)

- No changes needed — still uses `channelName`/`serverName` metadata for rich prefixes

### Router (template `router.ts`)

- Inbox file paths use slugified channel name instead of `sanitizeChannelPath(platformId)`
- Invite notifications show slug-based channel URIs in suggested routing rules

## Migration

Clean break — no migration code. Old routing rules with platform IDs stop matching. Agents receive channel invite notifications for the "new" slug-based channels and update their rules naturally through the existing gating flow.

## Not in scope

- Handling channel/server renames (slugs are stable snapshots; renames create new slugs)
- Deduplication if a server is renamed (old and new slugs both exist in channels.json)
- Volute conversation slug generation (conversations already have titles; untitled ones get generated slugs)
