#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OUT=${RAG_OFFLINE_OUT:-"$ROOT/.rag/offline/bundle"}
PY=${RAG_DOCLING_PYTHON:-python3}
LANGS=${RAG_TESS_LANGS:-"eng chi-sim"}
DOC_REQ=${RAG_DOCLING_REQUIREMENTS:-"$ROOT/script/rag/requirements-docling.txt"}
LLM_REQ=${RAG_LLAMA_REQUIREMENTS:-"$ROOT/script/rag/requirements-llamaindex.txt"}
VECTOR_REQ=${RAG_VECTOR_REQUIREMENTS:-"$ROOT/script/rag/requirements-vector.txt"}
INCLUDE_LLM=false
INCLUDE_VECTOR=false

usage() {
  cat <<'EOF'
Build an offline bundle for Ubuntu hosts with limited mirror/network access.

Usage:
  script/rag/build-offline-bundle.sh [--out DIR] [--python BIN] [--langs "eng chi-sim"] [--include-llamaindex] [--include-vectordb]

Options:
  --out DIR               Bundle output directory (default: ./.rag/offline/bundle)
  --python BIN            Python executable used for wheel download (default: python3)
  --langs "a b"           Tesseract language packs (default: "eng chi-sim")
  --include-llamaindex    Also download llamaindex wheels
  --include-vectordb      Also download vector db wheels (qdrant-client/openai)
  -h, --help              Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT="$2"
      shift 2
      ;;
    --python)
      PY="$2"
      shift 2
      ;;
    --langs)
      LANGS="$2"
      shift 2
      ;;
    --include-llamaindex)
      INCLUDE_LLM=true
      shift
      ;;
    --include-vectordb)
      INCLUDE_VECTOR=true
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

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "python executable not found: $PY" >&2
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get not found, this script targets Debian/Ubuntu" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/wheelhouse" "$OUT/deb" "$OUT/script/rag"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
"$PY" -m venv "$TMP/venv"

"$TMP/venv/bin/python" -m pip install -U pip
"$TMP/venv/bin/pip" download -r "$DOC_REQ" -d "$OUT/wheelhouse"

if [[ "$INCLUDE_LLM" == "true" && -f "$LLM_REQ" ]]; then
  "$TMP/venv/bin/pip" download -r "$LLM_REQ" -d "$OUT/wheelhouse"
fi
if [[ "$INCLUDE_VECTOR" == "true" && -f "$VECTOR_REQ" ]]; then
  "$TMP/venv/bin/pip" download -r "$VECTOR_REQ" -d "$OUT/wheelhouse"
fi

declare -a PKGS=("tesseract-ocr")
read -ra ITEMS <<<"$LANGS"
for l in "${ITEMS[@]}"; do
  [[ -z "$l" ]] && continue
  PKGS+=("tesseract-ocr-${l//_/-}")
done

if command -v apt-rdepends >/dev/null 2>&1; then
  mapfile -t ALL < <(
    apt-rdepends "${PKGS[@]}" 2>/dev/null |
      awk '/^[a-zA-Z0-9]/ { print $1 }' |
      rg -v '^(Reading|Building|Depends|PreDepends|Recommends|Suggests)$' |
      sort -u
  )
else
  echo "warning: apt-rdepends not installed, only top-level tesseract packages will be downloaded." >&2
  ALL=("${PKGS[@]}")
fi

(
  cd "$OUT/deb"
  apt-get download "${ALL[@]}"
)

cp "$ROOT/script/rag/install-docling.sh" "$OUT/script/rag/"
cp "$ROOT/script/rag/install-tesseract.sh" "$OUT/script/rag/"
cp "$ROOT/script/rag/install-vector.sh" "$OUT/script/rag/"
cp "$ROOT/script/rag/install-offline-bundle.sh" "$OUT/script/rag/" 2>/dev/null || true
cp "$ROOT/script/rag/build-vector-index.py" "$OUT/script/rag/" 2>/dev/null || true
cp "$ROOT/script/rag/search-vector-index.py" "$OUT/script/rag/" 2>/dev/null || true
cp "$ROOT/script/rag/requirements-docling.txt" "$OUT/script/rag/"
if [[ -f "$LLM_REQ" ]]; then
  cp "$LLM_REQ" "$OUT/script/rag/"
fi
if [[ -f "$VECTOR_REQ" ]]; then
  cp "$VECTOR_REQ" "$OUT/script/rag/"
fi

sha256sum "$OUT"/wheelhouse/* "$OUT"/deb/* >"$OUT/SHA256SUMS.txt"
tar -C "$(dirname "$OUT")" -czf "${OUT%/}.tar.gz" "$(basename "$OUT")"
echo "bundle directory: $OUT"
echo "bundle archive: ${OUT%/}.tar.gz"
