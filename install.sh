#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: curl -fsSL <url> | sudo bash"
  exit 1
fi

# Install system Node.js 22 if not present or too old.
# Explicitly check /usr/bin/node — nvm installs under home dirs which
# systemd can't access with ProtectHome=yes.
SYSTEM_NODE="/usr/bin/node"
if [ ! -x "$SYSTEM_NODE" ] || [ "$($SYSTEM_NODE -e 'console.log(process.versions.node.split(".")[0])')" -lt 22 ]; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Install git if not present
if ! command -v git &>/dev/null; then
  echo "Installing git..."
  apt-get update && apt-get install -y --no-install-recommends git
fi

# Verify system npm is available after Node.js install
if [ ! -x "/usr/bin/npm" ]; then
  echo "Error: npm not found at /usr/bin/npm after Node.js installation."
  echo "Please install npm system-wide and re-run this script."
  exit 1
fi

# Install volute globally (using system npm to ensure it lands in /usr/bin)
echo "Installing volute..."
/usr/bin/npm install -g volute

# Run setup
echo "Running volute setup..."
/usr/bin/volute setup --host 0.0.0.0

echo ""
echo "Volute is installed and running."
echo "  systemctl status volute      Check daemon status"
echo "  volute agent create <name>   Create a new agent"
echo "  volute agent start <name>    Start an agent"
