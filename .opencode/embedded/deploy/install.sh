#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-$HOME/.config/opencode}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SELF_DIR/.." && pwd)"

echo "[embedded] install target: $TARGET"
mkdir -p "$TARGET"
mkdir -p "$TARGET/mcp" "$TARGET/skills" "$TARGET/embedded"

cp -R "$ROOT_DIR/mcp/." "$TARGET/mcp/"
cp -R "$ROOT_DIR/skills/." "$TARGET/skills/"
cp -R "$ROOT_DIR/embedded/." "$TARGET/embedded/"

if [ -d "$TARGET/embedded/scripts" ]; then
  chmod +x "$TARGET/embedded/scripts"/*.sh || true
fi

if command -v bun >/dev/null 2>&1; then
  echo "[embedded] installing mcp runtime deps"
  (cd "$TARGET" && bun add --exact @modelcontextprotocol/sdk@1.25.2 zod@3.25.76 >/dev/null)
else
  echo "[embedded] warning: bun not found, skip dependency install"
fi

CFG="$TARGET/opencode.jsonc"
[ -f "$CFG" ] || CFG="$TARGET/opencode.json"
if [ ! -f "$CFG" ]; then
  CFG="$TARGET/opencode.jsonc"
  printf '{}\n' > "$CFG"
fi

cp "$CFG" "$CFG.bak.$(date +%Y%m%d-%H%M%S)"

python3 - "$CFG" "$TARGET" <<'PY'
import json
import pathlib
import re
import sys

cfg_path = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
text = cfg_path.read_text(encoding="utf-8")

def parse_jsonc(raw: str):
    try:
        return json.loads(raw)
    except Exception:
        pass
    s = re.sub(r"/\*.*?\*/", "", raw, flags=re.S)
    s = re.sub(r"//.*", "", s)
    s = re.sub(r",\s*([}\]])", r"\1", s)
    return json.loads(s) if s.strip() else {}

def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v

cfg = parse_jsonc(text)
if not isinstance(cfg, dict):
    cfg = {}

cfg.setdefault("mcp", {})
cfg.setdefault("skills", {})
cfg.setdefault("permission", {})
cfg["permission"].setdefault("skill", {})

mcp = {
    "embedded_debug": {
        "type": "local",
        "command": ["bun", "run", str(target / "mcp" / "embedded-debug.ts")],
        "enabled": True,
        "environment": {
            "SER2NET_HOST": "127.0.0.1",
            "SER2NET_RW_PORT": "3333",
            "SER2NET_MON_PORT": "3334",
            "SERIAL_LOCK_FILE": str(target / "embedded" / "runtime" / "serial-write-lock.json"),
        },
    },
    "embedded_sdk": {
        "type": "local",
        "command": ["bun", "run", str(target / "mcp" / "embedded-sdk.ts")],
        "enabled": True,
        "environment": {
            "EMBEDDED_MANIFEST_ROOT": str(target / "embedded" / "manifest"),
            "SDK_SEARCH_ROOTS": "$SSC377_SDK_ROOT:./sdk:./third_party:/opt",
        },
    },
    "embedded_build": {
        "type": "local",
        "command": ["bun", "run", str(target / "mcp" / "embedded-build.ts")],
        "enabled": True,
        "environment": {
            "BUILD_CMD_DEFAULT": "cmake --build build -j8",
        },
    },
    "embedded_flash": {
        "type": "local",
        "command": ["bun", "run", str(target / "mcp" / "embedded-flash.ts")],
        "enabled": True,
    },
}

deep_merge(cfg["mcp"], mcp)

paths = cfg["skills"].get("paths")
if not isinstance(paths, list):
    paths = []
skill_path = str(target / "skills")
if skill_path not in paths:
    paths.append(skill_path)
cfg["skills"]["paths"] = paths

deep_merge(
    cfg["permission"]["skill"],
    {
        "embedded-*": "allow",
        "platform-*": "allow",
        "product-*": "allow",
    },
)

cfg_path.write_text(json.dumps(cfg, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
PY

echo "[embedded] installed"
echo "[embedded] config updated: $CFG"
echo "[embedded] next steps:"
echo "  1) configure ser2net based on $TARGET/embedded/README.md"
echo "  2) export SSC377_SDK_ROOT=/path/to/ssc377-sdk"
echo "  3) run opencode and ask it to use embedded-workflow"
