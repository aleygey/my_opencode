#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SELF_DIR/../../.." && pwd)"
OUT_DIR="$REPO_DIR/.opencode/embedded/dist"
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="opencode-embedded-bundle-$STAMP"
STAGE="$(mktemp -d)"
DEST="$STAGE/$NAME"

mkdir -p "$OUT_DIR"
mkdir -p "$DEST"

cp "$SELF_DIR/install.sh" "$DEST/install.sh"
cp "$SELF_DIR/uninstall.sh" "$DEST/uninstall.sh"
cp "$SELF_DIR/README.md" "$DEST/README.md"
cp "$SELF_DIR/env.example" "$DEST/env.example"

mkdir -p "$DEST/mcp"
mkdir -p "$DEST/skills"
mkdir -p "$DEST/embedded"

cp -R "$REPO_DIR/.opencode/mcp/." "$DEST/mcp/"
cp -R "$REPO_DIR/.opencode/skills/." "$DEST/skills/"
cp -R "$REPO_DIR/.opencode/embedded/manifest" "$DEST/embedded/"
cp -R "$REPO_DIR/.opencode/embedded/scripts" "$DEST/embedded/"
cp "$REPO_DIR/.opencode/embedded/README.md" "$DEST/embedded/README.md"

chmod +x "$DEST/install.sh" "$DEST/uninstall.sh"
if [ -d "$DEST/embedded/scripts" ]; then
  chmod +x "$DEST/embedded/scripts"/*.sh || true
fi

tar -czf "$OUT_DIR/$NAME.tar.gz" -C "$STAGE" "$NAME"
rm -rf "$STAGE"

echo "$OUT_DIR/$NAME.tar.gz"
