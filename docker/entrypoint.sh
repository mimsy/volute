#!/bin/sh
set -e

# Create the shared volute group (idempotent) so agent users can access
# group-writable directories like CLAUDE_CONFIG_DIR.
groupadd -f volute

# If a Claude config directory is mounted, make it readable by the volute
# group so isolated agent users can access credentials.
if [ -n "$CLAUDE_CONFIG_DIR" ] && [ -d "$CLAUDE_CONFIG_DIR" ]; then
  chown -R root:volute "$CLAUDE_CONFIG_DIR"
  chmod 2770 "$CLAUDE_CONFIG_DIR"
  find "$CLAUDE_CONFIG_DIR" -type f -exec chmod g+r {} +
  find "$CLAUDE_CONFIG_DIR" -type d -exec chmod 2770 {} +
fi

exec "$@"
