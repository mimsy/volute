# Test Mind Fixtures

Pre-made mind `home/` directories for integration testing. Each fixture provides the identity layer — SOUL.md, MEMORY.md, journal entries, and any files the mind created — so you can skip the seed/sprout process and test against minds with established personalities.

## Structure

Each subdirectory is a fixture named after the mind:

```
minds/
├── echo/
│   └── home/
│       ├── SOUL.md
│       ├── MEMORY.md
│       └── memory/journal/
│           └── 2025-01-15.md
└── another-mind/
    └── home/
        └── ...
```

## Creating a Fixture

1. Start a test environment: `bash test/integration-setup.sh`
2. Load the container name: `source /tmp/volute-integration.env`
3. Create a mind and interact with it until it develops a personality:
   ```sh
   docker exec -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
     $CONTAINER node dist/cli.js mind create echo
   # Start it, send messages, let it develop...
   ```
4. Copy its home directory out:
   ```sh
   docker cp $CONTAINER:/minds/echo/home test/fixtures/minds/echo/home
   ```
5. Clean up runtime artifacts that shouldn't be in fixtures:
   - Remove `.claude/` (SDK state)
   - Remove `.config/hooks/`, `.config/scripts/`, `.config/prompts.json`, `.config/routes.json` (copied from template)
   - Remove any session state files
6. Keep:
   - `SOUL.md` — the mind's personality
   - `MEMORY.md` — accumulated knowledge
   - `memory/journal/` — daily journal entries
   - Any files the mind created in `home/`

## Using Fixtures

The setup script handles this with `--with-fixtures`:

```sh
bash test/integration-setup.sh --with-fixtures
```

Or manually (after `source /tmp/volute-integration.env`):

```sh
docker exec -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  $CONTAINER node dist/cli.js mind create echo
docker cp test/fixtures/minds/echo/home/. $CONTAINER:/minds/echo/home/
docker exec $CONTAINER chown -R mind-echo:mind-echo /minds/echo/home/
```

## Maintenance

Fixtures track the `home/` directory contract between Volute and minds. If template changes break fixtures, that's a signal — it means the change would also break real minds during upgrades. Update fixtures when intentional breaking changes are made, and use the breakage as a reminder to handle migration.
