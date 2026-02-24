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

source "$ENV_FILE"

echo "Stopping container: $CONTAINER"
docker rm -f "$CONTAINER" 2>/dev/null || true

if [[ "$CLEAN" == "true" ]]; then
  echo "Removing image: $IMAGE"
  docker rmi "$IMAGE" 2>/dev/null || true
fi

rm -f "$ENV_FILE"
echo "Done"
