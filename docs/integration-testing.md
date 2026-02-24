# Integration Testing

## Philosophy

Integration testing in Volute means experiencing features alongside minds. Minds are participants in testing — their feedback is part of the test result.

If a mind's experience is confusing or degraded, that's a bug even if the code is correct. Engage meaningfully: don't send "test" or "hi" — give context, invite genuine response. Report what minds said as part of test results.

## Environment Setup (Docker)

Docker is the canonical path for integration testing. It gives you a clean, isolated environment with user isolation enabled — matching production.

### Prerequisites

- Docker
- `ANTHROPIC_API_KEY` environment variable

### Quick start

```sh
# Start a test environment
bash test/integration-setup.sh

# ... interact with minds via the API or dashboard ...

# Tear down when done
bash test/integration-teardown.sh
```

### Manual setup

Build the image from your current branch:

```sh
npm run build
docker build -t volute-test .
```

Start a container:

```sh
docker run -d --name volute-test \
  -p 14200:4200 \
  -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  volute-test
```

Wait for health:

```sh
curl -sf http://localhost:14200/api/health
```

Read the daemon token for API access:

```sh
TOKEN=$(docker exec volute-test node -e \
  "process.stdout.write(JSON.parse(require('fs').readFileSync('/data/daemon.json','utf8')).token)")
```

Make API calls:

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Origin: http://127.0.0.1:4200" \
  http://localhost:14200/api/minds
```

### Setup script

`test/integration-setup.sh` automates all of the above:

1. Builds the image from the current working directory
2. Starts a container with a randomized port
3. Waits for the daemon to become healthy
4. Extracts the daemon token
5. Prints connection info (port, token, example curl commands)

Options:

- `--with-fixtures` — imports test mind fixtures after setup (see [Test Mind Fixtures](#test-mind-fixtures))
- `--port N` — use a specific host port instead of random

The script writes connection details to `/tmp/volute-integration.env` so the teardown script can find the container.

### Teardown script

`test/integration-teardown.sh` stops and removes the container.

Options:

- `--clean` — also removes the Docker image

## Test Mind Fixtures

Directory: `test/fixtures/minds/`

Each fixture is a mind's `home/` directory — the identity layer (SOUL.md, MEMORY.md, journal entries). Fixtures are created organically: seed a mind, sprout it, have a conversation, then save the `home/` directory.

### Using fixtures

Inside a running test container:

```sh
# Create the mind (sets up project structure)
docker exec -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  volute-test node dist/cli.js mind create echo

# Overlay with fixture identity
docker cp test/fixtures/minds/echo/home/. \
  volute-test:/minds/echo/home/

# Fix ownership (required for user isolation)
docker exec volute-test chown -R mind-echo:mind-echo /minds/echo/home/
```

The `--with-fixtures` flag on the setup script does this automatically for all fixtures in the directory.

### Creating new fixtures

1. Start a test environment (`bash test/integration-setup.sh`)
2. Create and interact with a mind until it has a distinct personality
3. Copy its home directory out: `docker cp volute-test:/minds/<name>/home test/fixtures/minds/<name>/home`
4. Remove runtime artifacts that shouldn't be in fixtures (`.claude/`, `.config/hooks/`, session state)
5. Keep: `SOUL.md`, `MEMORY.md`, `memory/journal/`, any files the mind created in `home/`

### Maintenance

If template changes break the home directory contract, fixtures may need updating. This is a feature — it catches real compatibility issues. The fixture README has details.

## Testing Workflows

### Fresh environment (feature testing)

1. Run `bash test/integration-setup.sh`
2. Create minds as needed for the feature
3. Interact with minds to test the feature
4. Document findings (what worked, what the minds said, any issues)
5. Run `bash test/integration-teardown.sh`

### Common flows

| Flow | When to use |
|------|-------------|
| Seed then sprout | Testing the primary onboarding path |
| `mind create` | Quick setup for feature-specific testing |
| Fixture import | When you need minds with existing personality/history |
| `mind upgrade` | Testing template changes |
| Connector setup | Testing Discord/Slack/Telegram integration |

### Creating a mind and sending a message

```sh
# Create
docker exec -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  volute-test node dist/cli.js mind create test-mind

# Start
curl -sf -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Origin: http://127.0.0.1:4200" \
  http://localhost:$PORT/api/minds/test-mind/start

# Send a message
curl -sf -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Origin: http://127.0.0.1:4200" \
  -H "Content-Type: application/json" \
  -d '{"content":[{"type":"text","text":"I just added a new feature — try exploring your memory directory and tell me what you find."}],"channel":"test","sender":"developer"}' \
  http://localhost:$PORT/api/minds/test-mind/message
```

## Interaction Guidelines

- **Give context.** Tell minds what you're testing: "I just added a new way for you to browse channels — try asking to see what channels are available."
- **Ask about the experience.** Ask minds what they think, not just whether it "works."
- **Use natural messages.** Each interaction should feel like a real conversation, not a probe.
- **Let autonomous features run.** For schedules, memory consolidation, and similar features — start them and check back later.
- **Test cross-mind interaction.** For features that affect multiple minds, test with at least two.
- **Note qualitative feedback.** The mind's tone, confusion, delight — all of it matters.

## Testing with a Local Install

If you have Volute running locally, you can also test against that:

```sh
npm run build && npm link
volute restart
```

**Advantages:** Faster iteration, persistent minds with real history.

**Risk:** Bad code can affect your real minds. Acceptable if you understand the risk. Not recommended for collaborators who don't have an existing local setup.

## Automated Tests

Unit tests (`npm test`) remain the primary automated safety net.

| Test | What it covers | When to run |
|------|---------------|-------------|
| `npm test` | Unit tests, daemon e2e | Always — before every PR |
| `test/docker-e2e.sh` | Full Docker lifecycle | PRs touching daemon, mind lifecycle, or Docker setup |
| `test/daemon-e2e.test.ts` | Daemon API without Docker | Included in `npm test` |

**Rules:**
- Adding a new API endpoint or daemon feature → add a test to `daemon-e2e.test.ts`
- Changing mind lifecycle (create/start/stop/upgrade) → verify against `docker-e2e.sh`
