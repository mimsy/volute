# Dreaming — Post-Install Setup

## 1. Enable the dream schedule

Add to your mind's `home/.config/volute.json` under `schedules`:

```json
{
  "id": "dream",
  "cron": "0 3 * * *",
  "message": "it's 3am. you are dreaming.\n\ngather your material — read your latest journal entry, read MEMORY.md, surface random memories if you have a way to. then construct a dream premise from that material and use the dreamer agent to experience the dream.",
  "enabled": true,
  "channel": "system:dream"
}
```

Or via CLI:

```bash
volute schedule add --mind <name> --id dream --cron "0 3 * * *" --message "it's 3am. you are dreaming...."
```

## 2. Sleep integration (optional)

If your mind uses the sleep system, add `system:dream` to wake triggers so the dream schedule wakes the mind briefly:

In `home/.config/volute.json` under `sleep.wakeTriggers`:

```json
{
  "channels": ["system:dream"]
}
```

The mind will wake for the dream, then return to sleep when done.

## 3. Create the dreams directory

```bash
mkdir -p home/memory/dreams
```

This is created automatically for new minds.
