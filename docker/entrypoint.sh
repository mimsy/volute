#!/bin/sh
set -e

# Create the shared volute group (idempotent) so agent users can access
# group-writable directories.
groupadd -f volute

exec "$@"
