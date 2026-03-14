#!/usr/bin/env bash
set -euo pipefail

LANGS=${RAG_TESS_LANGS:-"eng chi-sim"}
NO_UPDATE=false

usage() {
  cat <<'EOF'
Install tesseract OCR and language packs on Debian/Ubuntu.

Usage:
  script/rag/install-tesseract.sh [--langs "eng chi-sim"] [--no-update]

Options:
  --langs "a b"    Language packs to install (default: "eng chi-sim")
  --no-update       Skip apt update
  -h, --help        Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --langs)
      LANGS="$2"
      shift 2
      ;;
    --no-update)
      NO_UPDATE=true
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

if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get not found. This script currently supports Debian/Ubuntu only." >&2
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

declare -a PKGS=("tesseract-ocr")
read -ra ITEMS <<<"$LANGS"
for l in "${ITEMS[@]}"; do
  [[ -z "$l" ]] && continue
  PKGS+=("tesseract-ocr-${l//_/-}")
done

if [[ "$NO_UPDATE" != "true" ]]; then
  $SUDO apt-get update
fi
$SUDO apt-get install -y "${PKGS[@]}"

tesseract --version | head -n 2
tesseract --list-langs | sed -n '1,40p'
echo "tesseract installed"
