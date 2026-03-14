#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
PY=${RAG_DOCLING_PYTHON_BIN:-}
if [[ -z "$PY" ]]; then
  if [[ -x "$ROOT/.venv-docling/bin/python" ]]; then
    PY="$ROOT/.venv-docling/bin/python"
  else
    PY="python3"
  fi
fi

exec "$PY" "$ROOT/script/rag/rag-pipeline.py" init "$@"
