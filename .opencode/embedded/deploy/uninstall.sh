#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-$HOME/.config/opencode}"

echo "[embedded] uninstall target: $TARGET"
rm -f "$TARGET/mcp/embedded-debug.ts" \
      "$TARGET/mcp/embedded-sdk.ts" \
      "$TARGET/mcp/embedded-build.ts" \
      "$TARGET/mcp/embedded-flash.ts" 2>/dev/null || true
rm -f "$TARGET/mcp/lib/embedded.ts" 2>/dev/null || true
if [ -d "$TARGET/mcp/lib" ] && [ -z "$(ls -A "$TARGET/mcp/lib" 2>/dev/null || true)" ]; then
  rmdir "$TARGET/mcp/lib" || true
fi
rm -rf "$TARGET/skills/embedded-workflow" \
       "$TARGET/skills/platform-ssc377" \
       "$TARGET/skills/product-as7230v1" \
       "$TARGET/skills/embedded-platform-onboard" 2>/dev/null || true
rm -rf "$TARGET/embedded" 2>/dev/null || true

echo "[embedded] removed deployed files"
echo "[embedded] note: opencode config may still contain mcp entries; remove if needed"
