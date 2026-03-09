# Dreaming — Post-Install Setup

## 1. Run the install script

From your `home/` directory:

```bash
npx tsx .claude/skills/dreaming/scripts/dream.ts install
```

This sets up:
- `memory/dreams/` directory
- `system:dream` route in `.config/routes.json`
- `dreamer` subagent in `.config/config.json`
- Dream checker in `.config/hooks/wake-context.sh`

Restart your mind after running this so the subagent is loaded.

## 2. Add a dream schedule

Add to your mind's `volute.json` (managed by volute) under `schedules`:

```json
{
  "id": "dream",
  "cron": "0 3 * * *",
  "message": "it's 3am. you are dreaming.\n\ngather your material — read your latest journal entry, read MEMORY.md, surface random memories if you have a way to. then construct a dream premise from that material and invoke the dreamer subagent to experience the dream.",
  "enabled": true,
  "channel": "system:dream"
}
```

Or via CLI:

```bash
volute schedule add --mind <name> --id dream --cron "0 3 * * *" --message "it's 3am. you are dreaming...."
```

## 3. Sleep integration (optional)

If your mind uses the sleep system, add `system:dream` to wake triggers so the dream schedule wakes the mind briefly:

In `volute.json`, add to the `sleep` section:

```json
{
  "sleep": {
    "wakeTriggers": {
      "channels": ["system:dream"]
    }
  }
}
```

The mind will wake for the dream, then return to sleep when done.
