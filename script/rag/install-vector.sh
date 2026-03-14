#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
VENV=${RAG_DOCLING_VENV:-"$ROOT/.venv-docling"}
PY=${RAG_DOCLING_PYTHON:-python3}
REQ=${RAG_VECTOR_REQUIREMENTS:-"$ROOT/script/rag/requirements-vector.txt"}
WHEEL=${RAG_DOCLING_WHEELHOUSE:-}

usage() {
  cat <<'EOF'
Install vector database dependencies into the existing rag virtual environment.

Usage:
  script/rag/install-vector.sh [--venv PATH] [--python BIN] [--requirements FILE] [--wheelhouse DIR]

Options:
  --venv PATH           Virtualenv path (default: ./.venv-docling)
  --python BIN          Python executable (default: python3)
  --requirements FILE   Requirements file (default: script/rag/requirements-vector.txt)
  --wheelhouse DIR      Offline wheels directory, enables --no-index install
  -h, --help            Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --venv)
      VENV="$2"
      shift 2
      ;;
    --python)
      PY="$2"
      shift 2
      ;;
    --requirements)
      REQ="$2"
      shift 2
      ;;
    --wheelhouse)
      WHEEL="$2"
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

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "python executable not found: $PY" >&2
  exit 1
fi

if [[ ! -d "$VENV" ]]; then
  "$PY" -m venv "$VENV"
fi

declare -a PIP=("$VENV/bin/python" "-m" "pip" "--disable-pip-version-check")

if [[ -n "$WHEEL" ]]; then
  if [[ ! -d "$WHEEL" ]]; then
    echo "wheelhouse directory not found: $WHEEL" >&2
    exit 1
  fi
  "${PIP[@]}" install --no-index --find-links "$WHEEL" -r "$REQ"
  echo "vector dependencies installed in: $VENV"
  exit 0
fi

"${PIP[@]}" install -U pip setuptools wheel
"${PIP[@]}" install -r "$REQ"
echo "vector dependencies installed in: $VENV"
