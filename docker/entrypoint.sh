#!/bin/sh
set -e

# Create the shared volute group (idempotent) so mind users can access
# group-writable directories.
groupadd -f volute

exec "$@"
