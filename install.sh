#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: curl -fsSL <url> | sudo bash"
  exit 1
fi

# --- Distro detection ---

detect_distro() {
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO="${ID:-unknown}"
    DISTRO_LIKE="${ID_LIKE:-}"
  else
    DISTRO="unknown"
    DISTRO_LIKE=""
  fi
}

# Map ID_LIKE fallback to a known distro family
resolve_distro() {
  case "$DISTRO" in
    debian|ubuntu|rhel|fedora|centos|amzn|arch|alpine|sles|opensuse*)
      return ;;
  esac
  # Fallback: check ID_LIKE for a known family
  for like in $DISTRO_LIKE; do
    case "$like" in
      debian|ubuntu)  DISTRO="debian"; return ;;
      rhel|fedora)    DISTRO="rhel";   return ;;
      arch)           DISTRO="arch";   return ;;
      suse|opensuse*) DISTRO="sles";   return ;;
    esac
  done
}

# --- Node.js 24 installation ---

node_needed() {
  local system_node="/usr/bin/node"
  if [ ! -x "$system_node" ]; then
    return 0
  fi
  local major
  major="$("$system_node" -e 'console.log(process.versions.node.split(".")[0])')"
  [ "$major" -lt 24 ]
}

install_node() {
  if ! node_needed; then
    echo "Node.js >= 24 already installed, skipping."
    return
  fi
  echo "Installing Node.js 24..."
  case "$DISTRO" in
    debian|ubuntu)
      curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
      apt-get install -y nodejs
      ;;
    rhel|fedora|centos|amzn)
      curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
      if command -v dnf &>/dev/null; then
        dnf install -y nodejs
      else
        yum install -y nodejs
      fi
      ;;
    arch)
      pacman -S --noconfirm nodejs npm
      ;;
    alpine)
      apk add --no-cache nodejs npm
      ;;
    sles|opensuse*)
      curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
      zypper install -y nodejs
      ;;
    *)
      echo "Error: unsupported distro '$DISTRO' for Node.js installation."
      exit 1
      ;;
  esac
}

# --- Git installation ---

install_git() {
  if command -v git &>/dev/null; then
    echo "Git already installed, skipping."
    return
  fi
  echo "Installing git..."
  case "$DISTRO" in
    debian|ubuntu)
      apt-get update && apt-get install -y --no-install-recommends git
      ;;
    rhel|fedora|centos|amzn)
      if command -v dnf &>/dev/null; then
        dnf install -y git
      else
        yum install -y git
      fi
      ;;
    arch)
      pacman -S --noconfirm git
      ;;
    alpine)
      apk add --no-cache git
      ;;
    sles|opensuse*)
      zypper install -y git
      ;;
    *)
      echo "Error: unsupported distro '$DISTRO' for git installation."
      exit 1
      ;;
  esac
}

# --- Main ---

main() {
  detect_distro
  resolve_distro

  echo "Detected distro: $DISTRO"

  install_node
  install_git

  # Verify system npm is available after Node.js install
  if [ ! -x "/usr/bin/npm" ]; then
    echo "Error: npm not found at /usr/bin/npm after Node.js installation."
    echo "Please install npm system-wide and re-run this script."
    exit 1
  fi

  # Install volute globally (using system npm to ensure it lands in /usr/bin)
  echo "Installing volute..."
  /usr/bin/npm install -g volute

  # Run setup (writes /etc/profile.d/volute.sh for CLI env vars)
  echo "Running volute setup..."
  /usr/bin/volute setup --host 0.0.0.0

  # Source the profile so env vars are available in this session
  # shellcheck disable=SC1091
  [ -f /etc/profile.d/volute.sh ] && . /etc/profile.d/volute.sh

  echo ""
  echo "Volute is installed and running."
  echo "  Run 'source /etc/profile.d/volute.sh' or start a new shell to use volute CLI commands."
  echo ""
  echo "  systemctl status volute      Check daemon status"
  echo "  volute mind create <name>    Create a new mind"
  echo "  volute mind start <name>     Start a mind"
}

main "$@"
