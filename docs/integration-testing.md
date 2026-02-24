# Integration Testing

## Philosophy

Integration testing in Volute means experiencing features alongside minds. Minds are participants in testing — their feedback is part of the test result.

If a mind's experience is confusing or degraded, that's a bug even if the code is correct. Engage meaningfully: don't send "test" or "hi" — give context, invite genuine response. Report what minds said as part of test results.

## Environment Setup (Docker)

Docker is the canonical path for integration testing. It gives you a clean, isolated environment with user isolation enabled — matching production.

### Prerequisites

- Docker
- `ANTHROPIC_API_KEY` environment variable
- `OPENROUTER_API_KEY` (optional, for pi-template minds using OpenRouter models)

### Quick start

```sh
# Start a test environment
bash test/integration-setup.sh

# The setup script prints a shorthand for running volute commands:
#   docker exec -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY <container> volute ...

# Seed a mind and wait for its response
docker exec -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY <container> \
  volute mind seed my-mind --template claude --model claude-sonnet-4-6

docker exec <container> volute send @my-mind "hello, who are you?" --wait

# Tear down when done
bash test/integration-teardown.sh
```

### Setup script

`test/integration-setup.sh` automates environment setup:

1. Builds the Docker image from the current working directory
2. Starts a container with a randomized port (or `--port N`)
3. Waits for the daemon to become healthy
4. Creates a test user account (`tester`/`tester`, auto-admin)
5. Sets `OPENROUTER_API_KEY` as a global env var for minds (if present)
6. Prints connection info and CLI usage examples

Options:

- `--with-fixtures` — imports test mind fixtures after setup (see [Test Mind Fixtures](#test-mind-fixtures))
- `--port N` — use a specific host port instead of random

The script writes connection details to `/tmp/volute-integration.env` so the teardown script can find the container.

### Teardown script

`test/integration-teardown.sh` stops and removes the container.

Options:

- `--clean` — also removes the Docker image

### Manual setup

Build the image from your current branch (`npm run build` is required because the Docker image copies pre-built `dist/` files):

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

The `volute` CLI is available inside the container:

```sh
docker exec volute-test volute status
```

## CLI Usage

All `volute` commands work inside the container. The general pattern:

```sh
docker exec -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY <container> volute <command>
```

The `ANTHROPIC_API_KEY` is needed for commands that create or start minds (it gets passed to the mind process). For read-only commands like `status`, `history`, or `mind list`, you can omit it.

### Sending messages with `--wait`

`volute send --wait` sends a message to a mind and streams the response back to your terminal:

```sh
docker exec <container> volute send @my-mind "what are you thinking about?" --wait
```

This connects to the mind's event stream, prints response text as it arrives, and exits when the mind finishes processing. Default timeout is 120 seconds; override with `--timeout <ms>`.

Without `--wait`, the command returns immediately after the message is delivered.

### Example session

```sh
# Load container name from setup
source /tmp/volute-integration.env
V="docker exec -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY $CONTAINER volute"

# Seed two minds with different templates
$V seed aria --template claude --model claude-sonnet-4-6
$V seed kimi --template pi --model "openrouter:moonshotai/kimi-k2.5"

# Talk to them and see their responses
docker exec $CONTAINER volute send @aria "tell me about yourself" --wait
docker exec $CONTAINER volute send @kimi "what interests you?" --wait

# Check their files
docker exec $CONTAINER cat /minds/aria/home/SOUL.md
docker exec $CONTAINER cat /minds/kimi/home/SOUL.md

# Sprout them once they've developed identity
docker exec -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY -e VOLUTE_MIND=aria $CONTAINER volute mind sprout
docker exec -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY -e VOLUTE_MIND=kimi $CONTAINER volute mind sprout

# Check status
docker exec $CONTAINER volute status
```

## Testing via the Web Dashboard

The setup script creates a test user (`tester`/`tester`) with admin access. Open the dashboard at the URL printed by the setup script (e.g., `http://localhost:15432`).

The dashboard is useful for:
- Real-time chat with streaming responses
- Viewing mind logs and file changes
- Testing the dashboard UI itself
- Multi-mind conversations

For scripted or automated testing, prefer the CLI.

## Test Mind Fixtures

Directory: `test/fixtures/minds/`

Each fixture is a mind's `home/` directory — the identity layer (SOUL.md, MEMORY.md, journal entries). Fixtures are created organically: seed a mind, sprout it, have a conversation, then save the `home/` directory.

### Using fixtures

Inside a running test container (after `source /tmp/volute-integration.env`):

```sh
# Create the mind (sets up project structure)
docker exec -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  $CONTAINER volute mind create echo

# Overlay with fixture identity
docker cp test/fixtures/minds/echo/home/. \
  $CONTAINER:/minds/echo/home/

# Fix ownership (required for user isolation)
docker exec $CONTAINER chown -R mind-echo:mind-echo /minds/echo/home/
```

The `--with-fixtures` flag on the setup script does this automatically for all fixtures in the directory.

### Creating new fixtures

1. Start a test environment (`bash test/integration-setup.sh`)
2. Load the container name: `source /tmp/volute-integration.env`
3. Create and interact with a mind until it has a distinct personality
4. Copy its home directory out: `docker cp $CONTAINER:/minds/<name>/home test/fixtures/minds/<name>/home`
5. Remove runtime artifacts that shouldn't be in fixtures (`.claude/` SDK state, `.config/hooks/` copied from template, `.config/scripts/`, `.config/prompts.json`, `.config/routes.json`)
6. Keep: `SOUL.md`, `MEMORY.md`, `memory/journal/`, any files the mind created in `home/`

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
