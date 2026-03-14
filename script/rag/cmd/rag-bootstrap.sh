#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
TARGET=""
WITH_OPENCODE=true

usage() {
  cat <<'EOF'
Copy RAG pipeline scripts and optional OpenCode assets to another project.

Usage:
  bash script/rag/cmd/rag-bootstrap.sh --target /path/to/target [--no-opencode]

Options:
  --target DIR    Target project root
  --no-opencode   Do not copy .opencode plugin/tool/skill files
  -h, --help      Show help
EOF
}

copy_dir() {
  local src="$1"
  local dst="$2"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude '__pycache__' --exclude '*.pyc' "$src"/ "$dst"/
    return
  fi
  find "$src" -type d -name "__pycache__" -prune -o -type f ! -name '*.pyc' -print | while read -r file; do
    rel=${file#"$src"/}
    mkdir -p "$dst/$(dirname "$rel")"
    cp -f "$file" "$dst/$rel"
  done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --no-opencode)
      WITH_OPENCODE=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "--target is required" >&2
  usage
  exit 1
fi

mkdir -p "$TARGET/script"
copy_dir "$ROOT/script/rag" "$TARGET/script/rag"

if [[ "$WITH_OPENCODE" == "true" ]]; then
  mkdir -p "$TARGET/.opencode/tool" "$TARGET/.opencode/plugins" "$TARGET/.opencode/skills/rag-pipeline"
  cp -f "$ROOT/.opencode/tool/rag_search.ts" "$TARGET/.opencode/tool/rag_search.ts"
  cp -f "$ROOT/.opencode/tool/rag_search.txt" "$TARGET/.opencode/tool/rag_search.txt"
  cp -f "$ROOT/.opencode/plugins/rag_context.ts" "$TARGET/.opencode/plugins/rag_context.ts"
  cp -f "$ROOT/.opencode/skills/rag-pipeline/SKILL.md" "$TARGET/.opencode/skills/rag-pipeline/SKILL.md"
  cp -f "$ROOT/.opencode/rag.ts" "$TARGET/.opencode/rag.ts"
fi

echo "bootstrap_done target=$TARGET with_opencode=$WITH_OPENCODE"
echo "next:"
echo "  1) cd $TARGET"
echo "  2) bash script/rag/install-docling.sh"
echo "  3) bash script/rag/install-vector.sh"
echo "  4) bash script/rag/cmd/rag-init.sh --help"
