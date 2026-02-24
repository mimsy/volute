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
    --port) HOST_PORT="$2"; shift 2 ;;
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

# Build dist if needed
if [[ ! -f dist/daemon.js ]]; then
  echo "Building project (dist/daemon.js not found)..."
  npm run build
fi

echo "Building Docker image..."
docker build -t "$IMAGE" . >/dev/null 2>&1
echo "  Image: $IMAGE"

echo "Starting container on port $HOST_PORT..."
docker run -d --name "$CONTAINER" \
  -p "$HOST_PORT:4200" \
  -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  "$IMAGE" >/dev/null
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
if poll_until 30 health_check; then
  echo "  Daemon is healthy"
else
  echo "Error: daemon did not become healthy within 30s" >&2
  echo "Container logs:"
  docker logs "$CONTAINER" 2>&1 | tail -20
  docker rm -f "$CONTAINER" 2>/dev/null || true
  docker rmi "$IMAGE" 2>/dev/null || true
  exit 1
fi

TOKEN=$(docker exec "$CONTAINER" node -e \
  "process.stdout.write(JSON.parse(require('fs').readFileSync('/data/daemon.json','utf8')).token)")

# Save connection info
cat > "$ENV_FILE" <<EOF
CONTAINER=$CONTAINER
IMAGE=$IMAGE
HOST_PORT=$HOST_PORT
TOKEN=$TOKEN
EOF

# Import fixtures if requested
if [[ "$WITH_FIXTURES" == "true" ]]; then
  FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)/fixtures/minds"
  if [[ -d "$FIXTURES_DIR" ]]; then
    for fixture_dir in "$FIXTURES_DIR"/*/; do
      [[ -d "$fixture_dir/home" ]] || continue
      name=$(basename "$fixture_dir")
      echo "Importing fixture: $name"
      docker exec -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" "$CONTAINER" \
        node dist/cli.js mind create "$name" >/dev/null 2>&1
      docker cp "$fixture_dir/home/." "$CONTAINER:/minds/$name/home/"
      docker exec "$CONTAINER" chown -R "mind-$name:mind-$name" "/minds/$name/home/"
      echo "  $name imported"
    done
  else
    echo "  No fixtures directory found at $FIXTURES_DIR"
  fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Integration environment ready"
echo ""
echo "  Port:      $HOST_PORT"
echo "  Token:     $TOKEN"
echo "  Container: $CONTAINER"
echo "  Dashboard: http://localhost:$HOST_PORT"
echo ""
echo "Example API calls:"
echo ""
echo "  # List minds"
echo "  curl -s -H 'Authorization: Bearer $TOKEN' \\"
echo "    -H 'Origin: http://127.0.0.1:4200' \\"
echo "    http://localhost:$HOST_PORT/api/minds"
echo ""
echo "  # Create a mind"
echo "  docker exec -e ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY \\"
echo "    $CONTAINER node dist/cli.js mind create test-mind"
echo ""
echo "Teardown: bash test/integration-teardown.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
