#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
BUNDLE=${RAG_OFFLINE_BUNDLE:-"$ROOT/.rag/offline/bundle"}
VENV=${RAG_DOCLING_VENV:-"$ROOT/.venv-docling"}
INSTALL_LLM=false
INSTALL_VECTOR=false

usage() {
  cat <<'EOF'
Install docling+tesseract from an offline bundle.

Usage:
  script/rag/install-offline-bundle.sh [--bundle DIR] [--venv PATH] [--install-llamaindex] [--install-vectordb]

Options:
  --bundle DIR            Offline bundle directory (default: ./.rag/offline/bundle)
  --venv PATH             Venv install path (default: ./.venv-docling)
  --install-llamaindex    Install llamaindex wheels if available in bundle
  --install-vectordb      Install vector db wheels if available in bundle
  -h, --help              Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle)
      BUNDLE="$2"
      shift 2
      ;;
    --venv)
      VENV="$2"
      shift 2
      ;;
    --install-llamaindex)
      INSTALL_LLM=true
      shift
      ;;
    --install-vectordb)
      INSTALL_VECTOR=true
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

if [[ ! -d "$BUNDLE" ]]; then
  echo "bundle directory not found: $BUNDLE" >&2
  exit 1
fi
if [[ ! -d "$BUNDLE/wheelhouse" ]]; then
  echo "wheelhouse not found: $BUNDLE/wheelhouse" >&2
  exit 1
fi

SUDO=""
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "sudo not found and current user is not root." >&2
    exit 1
  fi
fi

if ls "$BUNDLE/deb/"*.deb >/dev/null 2>&1; then
  $SUDO apt-get install -y "$BUNDLE"/deb/*.deb
fi

bash "$ROOT/script/rag/install-docling.sh" \
  --venv "$VENV" \
  --requirements "$BUNDLE/script/rag/requirements-docling.txt" \
  --wheelhouse "$BUNDLE/wheelhouse"

if [[ "$INSTALL_LLM" == "true" && -f "$BUNDLE/script/rag/requirements-llamaindex.txt" ]]; then
  "$VENV/bin/python" -m pip --disable-pip-version-check install \
    --no-index --find-links "$BUNDLE/wheelhouse" \
    -r "$BUNDLE/script/rag/requirements-llamaindex.txt"
fi
if [[ "$INSTALL_VECTOR" == "true" && -f "$BUNDLE/script/rag/requirements-vector.txt" ]]; then
  "$VENV/bin/python" -m pip --disable-pip-version-check install \
    --no-index --find-links "$BUNDLE/wheelhouse" \
    -r "$BUNDLE/script/rag/requirements-vector.txt"
fi

echo "offline install completed"
