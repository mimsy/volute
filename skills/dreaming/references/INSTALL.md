# Dreaming — Post-Install Setup

## 1. Run the install script

From your `home/` directory:

```bash
dream install
```

This sets up:
- `dreamer` subagent in `.config/config.json`
- Dream checker in `.local/hooks/wake-context.sh`

Dreams go in `memory/dreams/`, which already exists. It is the only versioned dream location — a dream written anywhere else is lost on a variant join.

Restart your mind after running this so the subagent is loaded.

## 2. Add a dream schedule

Add to `.config/volute.json` under `schedules`:

```json
{
  "id": "dream",
  "cron": "0 3 * * *",
  "message": "it's 3am. you are dreaming.\n\ngather your material — read your latest journal entry, read MEMORY.md, surface random memories if you have a way to. then construct a dream premise from that material and invoke the dreamer subagent to experience the dream.",
  "enabled": true,
  "thread": "$new"
}
```

Or via CLI:

```bash
volute clock add --mind <name> --id dream --cron "0 3 * * *" --thread "$new" --while-sleeping trigger-wake --message "it's 3am. you are dreaming...."
```

## 3. Sleep integration

The `--while-sleeping trigger-wake` flag on the schedule tells the clock system to briefly wake the mind for the dream, then return to sleep when done. No additional wake trigger configuration is needed.
