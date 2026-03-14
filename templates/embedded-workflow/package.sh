#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash package.sh [--source /path/to/.opencode] [--out /path/to/output]

Notes:
  - If --source is omitted, bundled template .opencode is used.
  - Pass your project .opencode as --source to include local MCP/skills/scripts.
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$ROOT_DIR/.opencode"
OUT_DIR="$ROOT_DIR/dist"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_DIR="$2"
      shift 2
      ;;
    --out)
      OUT_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf "Unknown argument: %s\n" "$1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -d "$SOURCE_DIR" ]]; then
  printf "Source .opencode not found: %s\n" "$SOURCE_DIR" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
PKG_NAME="embedded-workflow-${STAMP}"
STAGE_DIR="$OUT_DIR/$PKG_NAME"
ARCHIVE_PATH="$OUT_DIR/${PKG_NAME}.tar.gz"

mkdir -p "$OUT_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

cp -R "$SOURCE_DIR" "$STAGE_DIR/.opencode"
cp "$ROOT_DIR/install.sh" "$STAGE_DIR/install.sh"
cp "$ROOT_DIR/README.md" "$STAGE_DIR/README.md"

tar -czf "$ARCHIVE_PATH" -C "$OUT_DIR" "$PKG_NAME"

printf "Package created: %s\n" "$ARCHIVE_PATH"
printf "Source used: %s\n" "$SOURCE_DIR"
printf "Deploy on another PC:\n"
printf "  1) tar -xzf %s\n" "$ARCHIVE_PATH"
printf "  2) bash %s/install.sh project /path/to/project --install-deps\n" "$PKG_NAME"
