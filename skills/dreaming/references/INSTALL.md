# Dreaming — Post-Install Setup

## 1. Run the install script

From your `home/` directory:

```bash
npx tsx .claude/skills/dreaming/scripts/dream.ts install
```

This sets up:
- `system:dream` route in `.config/routes.json`
- `dreamer` subagent in `.config/config.json`
- Dream checker in `.config/hooks/wake-context.sh`

The `memory/dreams/` directory is created automatically on your first dream.

Restart your mind after running this so the subagent is loaded.

## 2. Add a dream schedule

Add to `.config/volute.json` under `schedules`:

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
volute clock add --mind <name> --id dream --cron "0 3 * * *" --channel system:dream --while-sleeping trigger-wake --message "it's 3am. you are dreaming...."
```

## 3. Sleep integration

The `--while-sleeping trigger-wake` flag on the schedule tells the clock system to briefly wake the mind for the dream, then return to sleep when done. No additional wake trigger configuration is needed.
