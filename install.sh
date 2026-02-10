#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: curl -fsSL <url> | sudo bash"
  exit 1
fi

# Install Node.js 22 if not present or too old
if ! command -v node &>/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 22 ]; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Install git if not present
if ! command -v git &>/dev/null; then
  echo "Installing git..."
  apt-get update && apt-get install -y --no-install-recommends git
fi

# Install volute globally
echo "Installing volute..."
npm install -g volute

# Run setup
echo "Running volute setup..."
volute setup --host 0.0.0.0

echo ""
echo "Volute is installed and running."
echo "  systemctl status volute     Check daemon status"
echo "  volute agent create <name>   Create a new agent"
echo "  volute agent start <name>   Start an agent"
