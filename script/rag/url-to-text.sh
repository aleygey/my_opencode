#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DOC=${RAG_DOCLING_BIN:-"$ROOT/.venv-docling/bin/docling"}
PY=${RAG_DOCLING_PYTHON_BIN:-"$ROOT/.venv-docling/bin/python"}
OUT=${RAG_TEXT_URL_OUTPUT:-"$ROOT/.rag/text/url"}
HTML=${RAG_TEXT_URL_HTML:-"$ROOT/.rag/html/url"}
URL=""
NAME=""
KEEP_HTML=false
OCR_IMAGES=false
IMAGE_LIMIT=${RAG_TEXT_URL_IMAGE_LIMIT:-30}
OCR_ENGINE=${RAG_TEXT_URL_OCR_ENGINE:-}
OCR_LANG=${RAG_TEXT_URL_OCR_LANG:-}
OCR_ARTIFACTS=${RAG_TEXT_URL_OCR_ARTIFACTS:-}
OCR_PSM=${RAG_TEXT_URL_OCR_PSM:-}
IMAGE_INLINE=${RAG_TEXT_URL_IMAGE_INLINE:-marker}
USER=${RAG_TEXT_URL_USER:-}
PASS=${RAG_TEXT_URL_PASSWORD:-}
COOKIE=${RAG_TEXT_URL_COOKIE:-}
COOKIE_FILE=${RAG_TEXT_URL_COOKIE_FILE:-}
PROXY=${RAG_TEXT_URL_PROXY:-}
NO_PROXY_MODE=false
INSECURE=false
declare -a HDR=()

usage() {
  cat <<'EOF'
Fetch one URL as HTML, then convert it to plain text with docling.

Usage:
  script/rag/url-to-text.sh --url URL [--name NAME] [--output DIR] [--html-dir DIR] [--header "K: V"] [--user USER --password PASS] [--cookie "a=b"] [--cookie-file FILE] [--proxy URL] [--no-proxy] [--insecure] [--keep-html] [--ocr-images] [--image-limit N] [--ocr-engine NAME] [--ocr-lang CODE] [--psm N] [--image-inline MODE]

Options:
  --url URL              Source URL to fetch
  --name NAME            Output file stem (default: generated from URL)
  --output DIR           Text output directory (default: ./.rag/text/url)
  --html-dir DIR         Downloaded HTML directory (default: ./.rag/html/url)
  --header "K: V"        Extra request header for curl (repeatable)
  --user USER            HTTP auth username for URL fetch
  --password PASS        HTTP auth password for URL fetch (or set RAG_TEXT_URL_PASSWORD)
  --cookie "k=v;..."     Cookie header value
  --cookie-file FILE     Netscape cookie file used by curl
  --proxy URL            Proxy for curl requests
  --no-proxy             Bypass proxy for all hosts (adds --noproxy "*")
  --insecure             Allow insecure TLS for intranet/self-signed cert
  --keep-html            Keep downloaded HTML file
  --ocr-images           OCR text in <img> resources and append to output txt
  --image-limit N        Max images to OCR when --ocr-images is enabled (default: 30)
  --ocr-engine NAME      OCR engine for image OCR (for example: tesseract, rapidocr, auto)
  --ocr-lang CODE        OCR language list (for example: eng or eng,chi_sim)
  --psm N                OCR page segmentation mode, 0-13 (useful for tesseract)
  --image-inline MODE    Inline image strategy: marker|ocr|none (default: marker)
  --artifacts-path PATH  Local docling artifacts path for OCR-related models
  --docling-bin PATH     docling executable (default: ./.venv-docling/bin/docling)
  --python-bin PATH      python executable used to parse html img tags (default: ./.venv-docling/bin/python)
  -h, --help             Show help
EOF
}

slug() {
  printf '%s' "$1" |
    sed -E 's#https?://##; s#[^a-zA-Z0-9._-]+#-#g; s#-+#-#g; s#(^-|-$)##g' |
    cut -c1-120
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      URL="$2"
      shift 2
      ;;
    --name)
      NAME="$2"
      shift 2
      ;;
    --output)
      OUT="$2"
      shift 2
      ;;
    --html-dir)
      HTML="$2"
      shift 2
      ;;
    --header)
      HDR+=("$2")
      shift 2
      ;;
    --user)
      USER="$2"
      shift 2
      ;;
    --password)
      PASS="$2"
      shift 2
      ;;
    --cookie)
      COOKIE="$2"
      shift 2
      ;;
    --cookie-file)
      COOKIE_FILE="$2"
      shift 2
      ;;
    --proxy)
      PROXY="$2"
      shift 2
      ;;
    --no-proxy)
      NO_PROXY_MODE=true
      shift
      ;;
    --insecure)
      INSECURE=true
      shift
      ;;
    --keep-html)
      KEEP_HTML=true
      shift
      ;;
    --ocr-images)
      OCR_IMAGES=true
      shift
      ;;
    --image-limit)
      IMAGE_LIMIT="$2"
      shift 2
      ;;
    --ocr-engine)
      OCR_ENGINE="$2"
      shift 2
      ;;
    --ocr-lang)
      OCR_LANG="$2"
      shift 2
      ;;
    --psm)
      OCR_PSM="$2"
      shift 2
      ;;
    --image-inline)
      IMAGE_INLINE="$2"
      shift 2
      ;;
    --artifacts-path)
      OCR_ARTIFACTS="$2"
      shift 2
      ;;
    --docling-bin)
      DOC="$2"
      shift 2
      ;;
    --python-bin)
      PY="$2"
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

if [[ -z "$URL" ]]; then
  echo "--url is required" >&2
  usage
  exit 1
fi

if [[ ! -x "$DOC" ]]; then
  echo "docling not found: $DOC" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl not found" >&2
  exit 1
fi

if [[ -n "$COOKIE_FILE" && ! -f "$COOKIE_FILE" ]]; then
  echo "cookie file not found: $COOKIE_FILE" >&2
  exit 1
fi

if [[ "$OCR_IMAGES" == "true" && ! -x "$PY" ]]; then
  echo "python not found or not executable: $PY" >&2
  exit 1
fi

if [[ "$OCR_IMAGES" == "true" ]]; then
  if [[ -z "$OCR_ENGINE" ]]; then
    if command -v tesseract >/dev/null 2>&1; then
      OCR_ENGINE="tesseract"
      if [[ -z "$OCR_LANG" ]]; then
        OCR_LANG="eng,chi_sim"
      fi
      echo "image OCR engine selected: tesseract" >&2
    else
      OCR_ENGINE="auto"
      echo "image OCR engine selected: auto (tesseract not found)" >&2
    fi
  fi

  if [[ "$OCR_ENGINE" == "tesseract" ]]; then
    if ! command -v tesseract >/dev/null 2>&1; then
      echo "tesseract not found, install it first: sudo apt install -y tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim" >&2
      exit 1
    fi
    if [[ -z "$OCR_LANG" ]]; then
      OCR_LANG="eng,chi_sim"
    fi
    if [[ -z "$OCR_PSM" ]]; then
      OCR_PSM="6"
    fi
  fi
  echo "image OCR config: engine=$OCR_ENGINE lang=${OCR_LANG:-<default>} psm=${OCR_PSM:-<default>}" >&2
fi

if [[ -n "$OCR_PSM" ]] && ! [[ "$OCR_PSM" =~ ^[0-9]+$ ]]; then
  echo "invalid --psm: $OCR_PSM" >&2
  exit 1
fi
if [[ "$IMAGE_INLINE" != "marker" && "$IMAGE_INLINE" != "ocr" && "$IMAGE_INLINE" != "none" ]]; then
  echo "invalid --image-inline: $IMAGE_INLINE (expected marker|ocr|none)" >&2
  exit 1
fi

if [[ -z "$NAME" ]]; then
  NAME=$(slug "$URL")
fi

if [[ -z "$NAME" ]]; then
  NAME="page-$(date +%Y%m%d-%H%M%S)"
fi

mkdir -p "$OUT" "$HTML"
HTML_FILE="$HTML/$NAME.html"

declare -a CURL_CMD=("curl" "-fsSL")
if [[ "$NO_PROXY_MODE" == "true" ]]; then
  CURL_CMD+=("--noproxy" "*")
elif [[ -n "$PROXY" ]]; then
  CURL_CMD+=("--proxy" "$PROXY")
fi
if [[ "$INSECURE" == "true" ]]; then
  CURL_CMD+=("-k")
fi
if [[ -n "$USER" ]]; then
  CURL_CMD+=("-u" "$USER:$PASS")
fi
if [[ -n "$COOKIE" ]]; then
  CURL_CMD+=("-H" "Cookie: $COOKIE")
fi
if [[ -n "$COOKIE_FILE" ]]; then
  CURL_CMD+=("-b" "$COOKIE_FILE")
fi
CURL_CMD+=("$URL" "-o" "$HTML_FILE")
for h in "${HDR[@]}"; do
  CURL_CMD+=("-H" "$h")
done
"${CURL_CMD[@]}"

"$DOC" "$HTML_FILE" --from html --to text --output "$OUT" --abort-on-error

TXT_FILE="$OUT/$NAME.txt"
if [[ ! -f "$TXT_FILE" ]]; then
  FALLBACK=$(find "$OUT" -maxdepth 1 -type f -name "$NAME*.txt" | head -n 1 || true)
  if [[ -n "$FALLBACK" ]]; then
    TXT_FILE="$FALLBACK"
  fi
fi

if [[ ! -f "$TXT_FILE" ]]; then
  echo "docling conversion finished but no txt was found for: $NAME" >&2
  exit 1
fi

if [[ "$OCR_IMAGES" == "true" ]]; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  IMG_LIST="$TMP/image_urls.txt"
  IMG_META="$TMP/image_meta.json"
  IMG_DIR="$TMP/images"
  OCR_DIR="$TMP/ocr"
  mkdir -p "$IMG_DIR" "$OCR_DIR"

  "$PY" - "$URL" "$HTML_FILE" "$IMG_LIST" "$IMG_META" <<'PY'
import json
import pathlib
import sys
from urllib.parse import urljoin
from bs4 import BeautifulSoup

base = sys.argv[1]
html_path = pathlib.Path(sys.argv[2])
out = pathlib.Path(sys.argv[3])
meta = pathlib.Path(sys.argv[4])
raw = html_path.read_text(encoding="utf-8", errors="ignore")
soup = BeautifulSoup(raw, "html.parser")
seen = set()
rows = []
for n in soup.find_all("img"):
    src = (n.get("src") or n.get("data-src") or n.get("data-original") or "").strip()
    if not src:
        continue
    if src.startswith("data:"):
        continue
    u = urljoin(base, src)
    if not u or u in seen:
        continue
    seen.add(u)
    rows.append(
        {
            "id": f"img-{len(rows)}",
            "url": u,
            "alt": (n.get("alt") or "").strip(),
        }
    )
out.write_text("\n".join(row["url"] for row in rows), encoding="utf-8")
meta.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
PY

  mapfile -t IMAGES <"$IMG_LIST"
  MAX="$IMAGE_LIMIT"
  if ! [[ "$MAX" =~ ^[0-9]+$ ]]; then
    echo "invalid --image-limit: $MAX" >&2
    exit 1
  fi

  OCR_OK=0
  OCR_BAD=0
  OCR_DONE=0
  OCR_LOG="$OUT/$NAME.image_ocr.log"
  : >"$OCR_LOG"
  for u in "${IMAGES[@]}"; do
    if [[ "$OCR_DONE" -ge "$MAX" ]]; then
      break
    fi
    clean="${u%%\?*}"
    ext="${clean##*.}"
    if [[ "$ext" == "$clean" ]] || [[ ! "$ext" =~ ^[A-Za-z0-9]{1,6}$ ]]; then
      ext="img"
    fi
    f="$IMG_DIR/img-$OCR_DONE.$ext"
    declare -a CURL_IMAGE=("curl" "-fsSL")
    if [[ "$NO_PROXY_MODE" == "true" ]]; then
      CURL_IMAGE+=("--noproxy" "*")
    elif [[ -n "$PROXY" ]]; then
      CURL_IMAGE+=("--proxy" "$PROXY")
    fi
    if [[ "$INSECURE" == "true" ]]; then
      CURL_IMAGE+=("-k")
    fi
    if [[ -n "$USER" ]]; then
      CURL_IMAGE+=("-u" "$USER:$PASS")
    fi
    if [[ -n "$COOKIE" ]]; then
      CURL_IMAGE+=("-H" "Cookie: $COOKIE")
    fi
    if [[ -n "$COOKIE_FILE" ]]; then
      CURL_IMAGE+=("-b" "$COOKIE_FILE")
    fi
    CURL_IMAGE+=("$u" "-o" "$f" "-H" "Referer: $URL")
    for h in "${HDR[@]}"; do
      CURL_IMAGE+=("-H" "$h")
    done
    if ! "${CURL_IMAGE[@]}" >/dev/null 2>&1; then
      OCR_BAD=$((OCR_BAD + 1))
      OCR_DONE=$((OCR_DONE + 1))
      continue
    fi

    t="$OCR_DIR/$(basename "$f").txt"
    if [[ "$OCR_ENGINE" == "tesseract" ]]; then
      declare -a TESS=("tesseract" "$f" "stdout")
      if [[ -n "$OCR_LANG" ]]; then
        TESS+=("-l" "${OCR_LANG//,/+}")
      fi
      if [[ -n "$OCR_PSM" ]]; then
        TESS+=("--psm" "$OCR_PSM")
      fi
      if "${TESS[@]}" >"$t" 2>>"$OCR_LOG"; then
        :
      else
        OCR_BAD=$((OCR_BAD + 1))
        OCR_DONE=$((OCR_DONE + 1))
        continue
      fi
    else
      declare -a OCR_CMD=("$DOC" "$f" "--from" "image" "--to" "text" "--output" "$OCR_DIR" "--ocr" "--force-ocr" "--abort-on-error")
      if [[ -n "$OCR_ENGINE" ]]; then
        OCR_CMD+=("--ocr-engine" "$OCR_ENGINE")
      fi
      if [[ -n "$OCR_LANG" ]]; then
        OCR_CMD+=("--ocr-lang" "$OCR_LANG")
      fi
      if [[ -n "$OCR_ARTIFACTS" ]]; then
        OCR_CMD+=("--artifacts-path" "$OCR_ARTIFACTS")
      fi
      if [[ -n "$OCR_PSM" ]]; then
        OCR_CMD+=("--psm" "$OCR_PSM")
      fi
      if "${OCR_CMD[@]}" >>"$OCR_LOG" 2>&1; then
        :
      else
        OCR_BAD=$((OCR_BAD + 1))
        OCR_DONE=$((OCR_DONE + 1))
        continue
      fi
    fi

    if [[ -s "$t" ]] && grep -q '[^[:space:]]' "$t"; then
      OCR_OK=$((OCR_OK + 1))
    else
      OCR_BAD=$((OCR_BAD + 1))
    fi
    OCR_DONE=$((OCR_DONE + 1))
  done

  SIDECAR="$OUT/$NAME.images.json"
  RAW_TXT="$OUT/$NAME.raw.txt"
  "$PY" "$ROOT/script/rag/merge-image-ocr.py" \
    --text "$TXT_FILE" \
    --meta "$IMG_META" \
    --ocr-dir "$OCR_DIR" \
    --sidecar "$SIDECAR" \
    --raw "$RAW_TXT" \
    --inline-mode "$IMAGE_INLINE" \
    --source-url "$URL"

  echo "image_ocr_total=${#IMAGES[@]} scanned=$OCR_DONE success=$OCR_OK failed=$OCR_BAD" >&2
  echo "image_sidecar=$SIDECAR" >&2
  if [[ "${#IMAGES[@]}" -gt 0 && "$OCR_OK" -eq 0 ]]; then
    echo "image OCR produced no text; inspect log: $OCR_LOG" >&2
    echo "hint: try --ocr-lang chi_sim or eng,chi_sim with --psm 6; if page images are tiny/icons, OCR may return empty." >&2
  fi
fi

if [[ "$KEEP_HTML" != "true" ]]; then
  rm -f "$HTML_FILE"
fi

echo "$TXT_FILE"
