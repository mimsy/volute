#!/bin/sh
set -e

# Create the shared volute group (idempotent) so agent users can access
# group-writable directories like CLAUDE_CONFIG_DIR.
groupadd -f volute

# If a Claude config directory is mounted, make it and the credentials file
# readable by the volute group so isolated agent users can access them.
# Only touch the top-level dir and key files — a recursive chown on a large
# bind-mounted ~/.claude is too slow.
if [ -n "$CLAUDE_CONFIG_DIR" ] && [ -d "$CLAUDE_CONFIG_DIR" ]; then
  chown root:volute "$CLAUDE_CONFIG_DIR"
  chmod 2770 "$CLAUDE_CONFIG_DIR"
  for f in .credentials.json settings.json; do
    if [ -f "$CLAUDE_CONFIG_DIR/$f" ]; then
      chown root:volute "$CLAUDE_CONFIG_DIR/$f"
      chmod 640 "$CLAUDE_CONFIG_DIR/$f"
    fi
  done
fi

exec "$@"
