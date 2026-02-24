#!/usr/bin/env bash
set -euo pipefail

# Integration test environment teardown for Volute
# Stops and removes the container started by integration-setup.sh.
#
# Usage: bash test/integration-teardown.sh [--clean]
#
# Options:
#   --clean   Also remove the Docker image

ENV_FILE="/tmp/volute-integration.env"
CLEAN=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --clean) CLEAN=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No integration environment found ($ENV_FILE missing)" >&2
  echo "Is there a running integration environment?" >&2
  exit 1
fi

# Parse env file explicitly instead of sourcing
CONTAINER=""
IMAGE=""

while IFS='=' read -r key value; do
  # Strip surrounding single quotes
  value="${value#\'}"
  value="${value%\'}"
  case "$key" in
    CONTAINER) CONTAINER="$value" ;;
    IMAGE) IMAGE="$value" ;;
  esac
done < "$ENV_FILE"

if [[ -z "$CONTAINER" ]]; then
  echo "Error: CONTAINER not found in $ENV_FILE (file may be corrupted)" >&2
  exit 1
fi

echo "Stopping container: $CONTAINER"
if ! docker rm -f "$CONTAINER" 2>/dev/null; then
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    echo "Error: failed to remove container $CONTAINER" >&2
    echo "Env file preserved for retry" >&2
    exit 1
  fi
  echo "  Container was already removed"
fi

if [[ "$CLEAN" == "true" && -n "$IMAGE" ]]; then
  echo "Removing image: $IMAGE"
  docker rmi "$IMAGE" 2>/dev/null || true
fi

rm -f "$ENV_FILE"
echo "Done"
