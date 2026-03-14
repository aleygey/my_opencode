#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash install.sh [project|global] [target_dir] [--install-deps]

Examples:
  bash install.sh project /path/to/repo
  bash install.sh global
  bash install.sh project /path/to/repo --install-deps
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.opencode"
MODE="${1:-project}"
TARGET_DIR="${2:-$PWD}"
INSTALL_DEPS="${3:-}"

if [[ "$MODE" != "project" && "$MODE" != "global" ]]; then
  printf "Invalid mode: %s\n" "$MODE" >&2
  usage
  exit 1
fi

if [[ "$MODE" == "global" ]]; then
  TARGET_DIR="${2:-$HOME/.config/opencode}"
  DEST_DIR="$TARGET_DIR"
else
  DEST_DIR="$TARGET_DIR/.opencode"
fi

if [[ ! -d "$SRC_DIR" ]]; then
  printf "Template source not found: %s\n" "$SRC_DIR" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp -R "$SRC_DIR"/* "$DEST_DIR/"

printf "Installed embedded workflow into %s\n" "$DEST_DIR"

if [[ "$INSTALL_DEPS" == "--install-deps" ]]; then
  if [[ -f "$DEST_DIR/package.json" ]]; then
    if command -v bun >/dev/null 2>&1; then
      printf "Installing local dependencies with bun in %s ...\n" "$DEST_DIR"
      bun install --cwd "$DEST_DIR"
      printf "Dependency install complete.\n"
    else
      printf "bun not found; skip explicit install. OpenCode will try auto-install on startup.\n"
    fi
  else
    printf "No package.json found in %s; skip dependency install.\n" "$DEST_DIR"
  fi
fi

printf "Restart OpenCode in target workspace to load new agents/commands/plugins.\n"
