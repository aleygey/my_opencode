#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DOC=${RAG_DOCLING_BIN:-"$ROOT/.venv-docling/bin/docling"}
IN=""
OUT=${RAG_TEXT_FILES_OUTPUT:-"$ROOT/.rag/text/files"}
EXT="pdf docx pptx html htm md txt csv xls xlsx xml"

usage() {
  cat <<'EOF'
Convert supported files in a directory to text with docling.

Usage:
  script/rag/convert-dir-to-text.sh --input DIR [--output DIR] [--ext "pdf docx html"]

Options:
  --input DIR            Source directory (required)
  --output DIR           Text output directory (default: ./.rag/text/files)
  --ext "a b c"          Extensions to include (default: pdf docx pptx html htm md txt csv xls xlsx xml)
  --docling-bin PATH     docling executable (default: ./.venv-docling/bin/docling)
  -h, --help             Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)
      IN="$2"
      shift 2
      ;;
    --output)
      OUT="$2"
      shift 2
      ;;
    --ext)
      EXT="$2"
      shift 2
      ;;
    --docling-bin)
      DOC="$2"
      shift 2
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

if [[ -z "$IN" ]]; then
  echo "--input is required" >&2
  usage
  exit 1
fi

if [[ ! -d "$IN" ]]; then
  echo "input directory not found: $IN" >&2
  exit 1
fi

if [[ ! -x "$DOC" ]]; then
  echo "docling not found: $DOC" >&2
  exit 1
fi

mkdir -p "$OUT"
SUCCESS_LOG="$OUT/_success.log"
FAIL_LOG="$OUT/_failed.log"
RUN_LOG="$OUT/_run.log"
: >"$SUCCESS_LOG"
: >"$FAIL_LOG"
: >"$RUN_LOG"

declare -a FIND_EXPR=()
read -ra PARTS <<<"$EXT"
for i in "${!PARTS[@]}"; do
  e="${PARTS[$i]}"
  [[ -z "$e" ]] && continue
  if [[ "$i" -gt 0 ]]; then
    FIND_EXPR+=("-o")
  fi
  FIND_EXPR+=("-iname" "*.$e")
done

if [[ "${#FIND_EXPR[@]}" -eq 0 ]]; then
  echo "no valid extensions in --ext" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mapfile -t FILES < <(find "$IN" -type f \( "${FIND_EXPR[@]}" \) | sort)
if [[ "${#FILES[@]}" -eq 0 ]]; then
  echo "no files matched in: $IN"
  exit 0
fi

OK=0
BAD=0

for f in "${FILES[@]}"; do
  rel=${f#"$IN"/}
  target="$OUT/${rel%.*}.txt"
  mkdir -p "$(dirname "$target")"

  work="$TMP/out"
  rm -rf "$work"
  mkdir -p "$work"

  if "$DOC" "$f" --to text --output "$work" --abort-on-error >>"$RUN_LOG" 2>&1; then
    b=$(basename "${f%.*}")
    src="$work/$b.txt"
    if [[ -f "$src" ]]; then
      mv "$src" "$target"
      printf '%s\n' "$target" >>"$SUCCESS_LOG"
      OK=$((OK + 1))
      continue
    fi
  fi

  printf '%s\n' "$f" >>"$FAIL_LOG"
  BAD=$((BAD + 1))
done

echo "done: total=${#FILES[@]} success=$OK failed=$BAD"
echo "success log: $SUCCESS_LOG"
echo "failed log: $FAIL_LOG"
echo "run log: $RUN_LOG"

