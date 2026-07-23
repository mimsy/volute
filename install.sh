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

# --- ripgrep installation (required for sandbox isolation) ---

install_ripgrep() {
  if command -v rg &>/dev/null; then
    echo "ripgrep already installed, skipping."
    return
  fi
  echo "Installing ripgrep..."
  local ok=true
  case "$DISTRO" in
    debian|ubuntu)
      apt-get update && apt-get install -y --no-install-recommends ripgrep || ok=false
      ;;
    rhel|fedora|centos|amzn)
      if command -v dnf &>/dev/null; then
        dnf install -y ripgrep || ok=false
      else
        yum install -y ripgrep || ok=false
      fi
      ;;
    arch)
      pacman -S --noconfirm ripgrep || ok=false
      ;;
    alpine)
      apk add --no-cache ripgrep || ok=false
      ;;
    sles|opensuse*)
      zypper install -y ripgrep || ok=false
      ;;
    *)
      ok=false
      ;;
  esac
  if [ "$ok" = false ]; then
    echo "Warning: ripgrep installation failed — sandbox isolation will be unavailable."
    echo "  You can install ripgrep manually later: https://github.com/BurntSushi/ripgrep#installation"
  fi
}

# --- browser installation (for 'volute pages preview') ---

browser_present() {
  command -v google-chrome &>/dev/null || command -v google-chrome-stable &>/dev/null || \
    command -v chromium &>/dev/null || command -v chromium-browser &>/dev/null || \
    command -v brave-browser &>/dev/null || command -v microsoft-edge &>/dev/null
}

install_browser() {
  if browser_present; then
    echo "Browser already present (for pages preview), skipping."
    return
  fi

  # No browser found — 'volute pages preview' needs one. Decide whether to install.
  if [ -t 0 ]; then
    printf "No browser found. 'volute pages preview' needs one. Install chromium now? [Y/n] "
    read -r reply
    case "$reply" in
      [Nn]*)
        echo "Skipping browser install — 'volute pages preview' will be unavailable until you install one."
        return
        ;;
    esac
  elif [ "${VOLUTE_INSTALL_BROWSER:-}" != "1" ]; then
    echo "No browser detected — 'volute pages preview' needs Chrome/Chromium."
    echo "  Install later, or re-run with VOLUTE_INSTALL_BROWSER=1."
    return
  fi

  echo "Installing chromium..."
  local ok=true
  case "$DISTRO" in
    debian|ubuntu)
      if ! { apt-get update && apt-get install -y --no-install-recommends chromium; }; then
        apt-get install -y --no-install-recommends chromium-browser || ok=false
      fi
      ;;
    rhel|fedora|centos|amzn)
      if command -v dnf &>/dev/null; then
        dnf install -y chromium || ok=false
      else
        yum install -y chromium || ok=false
      fi
      ;;
    sles|opensuse*)
      zypper install -y chromium || ok=false
      ;;
    *)
      ok=false
      ;;
  esac
  if [ "$ok" = false ]; then
    echo "Warning: browser install failed — pages preview will be unavailable until you install one."
  fi
}

# --- Main ---

main() {
  detect_distro
  resolve_distro

  echo "Detected distro: $DISTRO"

  install_node
  install_git
  install_ripgrep
  install_browser

  # Set system-wide git identity for daemon commits if not already configured
  if ! git config --system user.name >/dev/null 2>&1 || ! git config --system user.email >/dev/null 2>&1; then
    git config --system user.name "Volute" && \
    git config --system user.email "volute@localhost" || \
      echo "Warning: failed to set system git config — git commits may fail."
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

  # Run setup (installs the service, starts the daemon, writes /etc/profile.d/volute.sh)
  echo "Running volute setup --system..."
  /usr/bin/volute setup --system --host 0.0.0.0

  # Source the profile so env vars are available in this session
  # shellcheck disable=SC1091
  [ -f /etc/profile.d/volute.sh ] && . /etc/profile.d/volute.sh

  HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$HOST_IP" ] || HOST_IP="<this-server>"

  echo ""
  echo "Volute is installed and the daemon is running."
  echo "  Finish setup in your browser at http://${HOST_IP}:1618"
  echo "  (create your admin account and connect an AI provider)"
  echo ""
  echo "  Run 'source /etc/profile.d/volute.sh' or start a new shell to use volute CLI commands."
  echo "  systemctl status volute      Check daemon status"
}

main "$@"
