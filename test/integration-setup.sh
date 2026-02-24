#!/usr/bin/env bash
set -euo pipefail

# Integration test environment setup for Volute
# Builds a Docker image from the current branch, starts a container,
# waits for health, and prints connection info.
#
# Usage: bash test/integration-setup.sh [--with-fixtures] [--port N]
#
# Writes connection details to /tmp/volute-integration.env

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Error: ANTHROPIC_API_KEY must be set" >&2
  exit 1
fi

if ! command -v docker &>/dev/null; then
  echo "Error: docker is required" >&2
  exit 1
fi

# Parse args
WITH_FIXTURES=false
HOST_PORT=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --with-fixtures) WITH_FIXTURES=true; shift ;;
    --port)
      if [[ $# -lt 2 ]]; then
        echo "Error: --port requires a value" >&2; exit 1
      fi
      HOST_PORT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Randomize port if not specified (range 15000-25000)
if [[ -z "$HOST_PORT" ]]; then
  HOST_PORT=$((15000 + RANDOM % 10000))
fi

CONTAINER="volute-integration-$$"
IMAGE="volute-integration-$$"
ENV_FILE="/tmp/volute-integration.env"

# Check for existing environment
if [[ -f "$ENV_FILE" ]]; then
  echo "Error: existing integration environment found ($ENV_FILE)" >&2
  echo "Run 'bash test/integration-teardown.sh' first" >&2
  exit 1
fi

# Cleanup on failure -- disabled on success at the end of the script
SETUP_COMPLETE=false
cleanup_on_failure() {
  if [[ "$SETUP_COMPLETE" == "true" ]]; then return; fi
  echo "Setup failed, cleaning up..." >&2
  docker rm -f "$CONTAINER" 2>/dev/null || true
  docker rmi "$IMAGE" 2>/dev/null || true
  rm -f "$ENV_FILE"
}
trap cleanup_on_failure EXIT

# Build dist if needed
if [[ ! -f dist/daemon.js ]]; then
  echo "Building project (dist/daemon.js not found)..."
  npm run build
fi

echo "Building Docker image..."
BUILD_LOG=$(mktemp)
if ! docker build -t "$IMAGE" . >"$BUILD_LOG" 2>&1; then
  echo "Error: Docker build failed" >&2
  tail -20 "$BUILD_LOG" >&2
  rm -f "$BUILD_LOG"
  exit 1
fi
rm -f "$BUILD_LOG"
echo "  Image: $IMAGE"

# Collect API key env vars to pass to container
ENV_ARGS=(-e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY")
[[ -n "${OPENROUTER_API_KEY:-}" ]] && ENV_ARGS+=(-e "OPENROUTER_API_KEY=$OPENROUTER_API_KEY")

echo "Starting container on port $HOST_PORT..."
if ! docker run -d --name "$CONTAINER" \
  -p "$HOST_PORT:4200" \
  "${ENV_ARGS[@]}" \
  "$IMAGE" >/dev/null; then
  echo "Error: failed to start container (port $HOST_PORT may be in use)" >&2
  exit 1
fi
echo "  Container: $CONTAINER"

# Reuse patterns from docker-e2e.sh
poll_until() {
  local timeout_s=$1
  shift
  local deadline=$((SECONDS + timeout_s))
  while (( SECONDS < deadline )); do
    if "$@" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

health_check() { curl -sf "http://localhost:$HOST_PORT/api/health" >/dev/null; }

echo "Waiting for daemon to become healthy..."
if ! poll_until 30 health_check; then
  echo "Error: daemon did not become healthy within 30s" >&2
  echo "Container logs:"
  docker logs "$CONTAINER" 2>&1 | tail -20
  exit 1
fi
echo "  Daemon is healthy"

echo "Reading daemon token..."
if ! TOKEN=$(docker exec "$CONTAINER" node -e \
  "process.stdout.write(JSON.parse(require('fs').readFileSync('/data/daemon.json','utf8')).token)" 2>&1); then
  echo "Error: failed to read daemon token" >&2
  echo "  $TOKEN" >&2
  exit 1
fi

if [[ -z "$TOKEN" ]]; then
  echo "Error: daemon token is empty" >&2
  exit 1
fi

# Create a test user account (first user auto-becomes admin)
echo "Creating test user account..."
REGISTER_RESP=$(curl -sf -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: http://127.0.0.1:4200" \
  -d '{"username":"tester","password":"tester"}' \
  "http://localhost:$HOST_PORT/api/auth/register" 2>&1) || true

if echo "$REGISTER_RESP" | grep -q '"role":"admin"'; then
  echo "  User 'tester' created (admin)"
else
  echo "  Warning: user creation response: $REGISTER_RESP" >&2
fi

# Set OPENROUTER_API_KEY as a global env var if present
if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  docker exec "$CONTAINER" node dist/cli.js env set OPENROUTER_API_KEY "$OPENROUTER_API_KEY" >/dev/null 2>&1
  echo "  OPENROUTER_API_KEY set for minds"
fi

# Save connection info (restricted permissions, quoted values)
(umask 077; cat > "$ENV_FILE" <<EOF
CONTAINER='$CONTAINER'
IMAGE='$IMAGE'
HOST_PORT='$HOST_PORT'
TOKEN='$TOKEN'
EOF
)

# Import fixtures if requested
if [[ "$WITH_FIXTURES" == "true" ]]; then
  FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)/fixtures/minds"
  if [[ -d "$FIXTURES_DIR" ]]; then
    for archive in "$FIXTURES_DIR"/*.volute; do
      [[ -f "$archive" ]] || continue
      name=$(basename "$archive" .volute)
      echo "Importing fixture: $name"
      if ! docker cp "$archive" "$CONTAINER:/tmp/$name.volute"; then
        echo "Error: failed to copy archive for '$name'" >&2
        exit 1
      fi
      if ! docker exec -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" "$CONTAINER" \
          volute mind import "/tmp/$name.volute" --name "$name" 2>&1; then
        echo "Error: failed to import mind '$name'" >&2
        exit 1
      fi
      echo "  $name imported"
    done
  else
    echo "  No fixtures directory found at $FIXTURES_DIR"
  fi
fi

SETUP_COMPLETE=true

# Helper alias for running volute commands inside the container
VEXEC="docker exec -e ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY $CONTAINER volute"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Integration environment ready"
echo ""
echo "  Port:      $HOST_PORT"
echo "  Container: $CONTAINER"
echo "  Dashboard: http://localhost:$HOST_PORT (login: tester/tester)"
echo ""
echo "CLI usage (run volute commands inside the container):"
echo ""
echo "  # Shorthand"
echo "  $VEXEC status"
echo ""
echo "  # Seed a mind"
echo "  $VEXEC seed my-mind --template claude --model claude-sonnet-4-6"
echo ""
echo "  # Send a message (--sender needed because Docker runs as root)"
echo "  $VEXEC send @my-mind \"hello, who are you?\" --sender tester --wait"
echo ""
echo "Teardown: bash test/integration-teardown.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
