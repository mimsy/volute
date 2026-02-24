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
2. Create a mind and interact with it until it develops a personality:
   ```sh
   docker exec -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
     volute-integration-$$ node dist/cli.js mind create echo
   # Start it, send messages, let it develop...
   ```
3. Copy its home directory out:
   ```sh
   docker cp volute-integration-$$:/minds/echo/home test/fixtures/minds/echo/home
   ```
4. Clean up runtime artifacts that shouldn't be in fixtures:
   - Remove `.claude/` (SDK state)
   - Remove `.config/hooks/` (generated at create time)
   - Remove any session state files
5. Keep:
   - `SOUL.md` — the mind's personality
   - `MEMORY.md` — accumulated knowledge
   - `memory/journal/` — daily journal entries
   - Any files the mind created in `home/`

## Using Fixtures

The setup script handles this with `--with-fixtures`:

```sh
bash test/integration-setup.sh --with-fixtures
```

Or manually inside a container:

```sh
docker exec -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  CONTAINER node dist/cli.js mind create echo
docker cp test/fixtures/minds/echo/home/. CONTAINER:/minds/echo/home/
docker exec CONTAINER chown -R mind-echo:mind-echo /minds/echo/home/
```

## Maintenance

Fixtures track the `home/` directory contract between Volute and minds. If template changes break fixtures, that's a signal — it means the change would also break real minds during upgrades. Update fixtures when intentional breaking changes are made, and use the breakage as a reminder to handle migration.
