#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bind_host="${OPENCODE_WORKFLOW_BIND_HOST:-0.0.0.0}"
public_host="${OPENCODE_WORKFLOW_PUBLIC_HOST:-localhost}"
server_port="${OPENCODE_WORKFLOW_SERVER_PORT:-4211}"
app_port="${OPENCODE_WORKFLOW_APP_PORT:-4173}"
keep="${OPENCODE_WORKFLOW_KEEP_SANDBOX:-0}"
open="${OPENCODE_WORKFLOW_OPEN:-1}"
node_dir="/tmp/node-v22.12.0-linux-x64"
node_tar="/tmp/node-v22.12.0-linux-x64.tar.xz"
sandbox="${OPENCODE_WORKFLOW_SANDBOX:-$(mktemp -d /tmp/opencode-workflow-XXXXXX)}"
seed_file="$sandbox/workflow-seed.json"
seed_log="$sandbox/seed.log"
server_log="$sandbox/server.log"
app_log="$sandbox/app.log"
server_pid=""
app_pid=""

for arg in "$@"; do
  if [[ "$arg" == "--keep" ]]; then
    keep="1"
    continue
  fi
  if [[ "$arg" == "--no-open" ]]; then
    open="0"
    continue
  fi
  echo "Unknown argument: $arg" >&2
  echo "Usage: $0 [--keep] [--no-open]" >&2
  exit 1
done

cleanup() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  if [[ "$keep" != "1" ]]; then
    rm -rf "$sandbox"
  fi
}

trap cleanup EXIT INT TERM

need() {
  if command -v "$1" >/dev/null 2>&1; then
    return
  fi
  echo "Missing required command: $1" >&2
  exit 1
}

need bun
need curl
need lsof
need python3
need tar

copy_state() {
  mkdir -p "$XDG_DATA_HOME/opencode" "$XDG_CACHE_HOME/opencode" "$XDG_CONFIG_HOME"

  if [[ -d "$HOME/.config/opencode" ]]; then
    mkdir -p "$XDG_CONFIG_HOME/opencode"
    cp -R "$HOME/.config/opencode/." "$XDG_CONFIG_HOME/opencode/"
  fi

  if [[ -f "$HOME/.local/share/opencode/auth.json" ]]; then
    cp "$HOME/.local/share/opencode/auth.json" "$XDG_DATA_HOME/opencode/auth.json"
  fi

  if [[ -f "$HOME/.cache/opencode/models.json" ]]; then
    cp "$HOME/.cache/opencode/models.json" "$XDG_CACHE_HOME/opencode/models.json"
  fi
}

port_free() {
  if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "busy"
    return
  fi
  echo "free"
}

wait_http() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 240); do
    if env NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost curl -sf "$url" >/dev/null 2>&1; then
      return
    fi
    sleep 0.5
  done
  echo "$label did not become ready: $url" >&2
  exit 1
}

node_ok() {
  if ! command -v node >/dev/null 2>&1; then
    echo no
    return
  fi
  node - <<'PY'
const [major, minor] = process.versions.node.split(".").map(Number)
const ok = major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19)
process.stdout.write(ok ? "yes" : "no")
PY
}

use_node() {
  if [[ "$(node_ok)" == "yes" ]]; then
    return
  fi
  if [[ ! -x "$node_dir/bin/node" ]]; then
    curl -fsSLo "$node_tar" "https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz"
    tar -xf "$node_tar" -C /tmp
  fi
  export PATH="$node_dir/bin:$PATH"
}

slug() {
  python3 - "$root" <<'PY'
import base64
import sys

print(base64.urlsafe_b64encode(sys.argv[1].encode()).decode().rstrip("="))
PY
}

read_json() {
  python3 - "$1" "$2" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1]))
value = data
for part in sys.argv[2].split("."):
    value = value[part]
print(value)
PY
}

if [[ "$(port_free "$server_port")" != "free" ]]; then
  echo "Server port is busy: $server_port" >&2
  exit 1
fi

if [[ "$(port_free "$app_port")" != "free" ]]; then
  echo "App port is busy: $app_port" >&2
  exit 1
fi

export OPENCODE_DISABLE_SHARE=true
export OPENCODE_DISABLE_LSP_DOWNLOAD=true
export OPENCODE_DISABLE_DEFAULT_PLUGINS=true
export OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true
export OPENCODE_DISABLE_MODELS_FETCH=true
export OPENCODE_MODELS_PATH="${OPENCODE_MODELS_PATH:-$HOME/.cache/opencode/models.json}"
export OPENCODE_TEST_HOME="$sandbox/home"
export XDG_DATA_HOME="$sandbox/share"
export XDG_CACHE_HOME="$sandbox/cache"
export XDG_CONFIG_HOME="$sandbox/config"
export XDG_STATE_HOME="$sandbox/state"
export OPENCODE_E2E_PROJECT_DIR="$root"
export OPENCODE_CLIENT=app
export OPENCODE_E2E_OUTPUT="$seed_file"

copy_state

echo "sandbox: $sandbox"
echo "seeding workflow demo..."
(cd "$root" && bun packages/opencode/script/seed-workflow-e2e.ts) >"$seed_log" 2>&1

root_session_id="$(read_json "$seed_file" rootSessionID)"
workflow_id="$(read_json "$seed_file" workflowID)"
workflow_slug="$(slug)"
workflow_url="http://${public_host}:${app_port}/${workflow_slug}/session/${root_session_id}"
directory_q="$(python3 - "$root" <<'PY'
import urllib.parse
import sys

print(urllib.parse.quote(sys.argv[1], safe=""))
PY
)"

echo "starting opencode server on :$server_port"
(
  cd "$root/packages/opencode"
  bun run --conditions=browser ./src/index.ts serve --hostname "$bind_host" --port "$server_port" --cors "http://${public_host}:${app_port}"
) >"$server_log" 2>&1 &
server_pid="$!"

wait_http "http://127.0.0.1:${server_port}/global/health" "opencode server"

use_node

echo "starting app on :$app_port"
(
  cd "$root/packages/app"
  VITE_OPENCODE_SERVER_HOST="$public_host" \
    VITE_OPENCODE_SERVER_PORT="$server_port" \
    bun run build
  VITE_OPENCODE_SERVER_HOST="$public_host" \
    VITE_OPENCODE_SERVER_PORT="$server_port" \
    bun run serve -- --host "$bind_host" --port "$app_port"
) >"$app_log" 2>&1 &
app_pid="$!"

wait_http "http://127.0.0.1:${app_port}" "app preview"

echo
echo "Workflow demo is ready."
echo "workflow id: $workflow_id"
echo "root session: $root_session_id"
echo "url: $workflow_url"
echo "server log: $server_log"
echo "app log: $app_log"
echo "seed log: $seed_log"
echo
echo "API checks:"
echo "  curl -sf http://${public_host}:${server_port}/global/health"
echo "  curl -sf \"http://${public_host}:${server_port}/workflow/session/${root_session_id}?directory=${directory_q}\""
echo
echo "Press Ctrl+C to stop."

if [[ "$open" == "1" ]]; then
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$workflow_url" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$workflow_url" >/dev/null 2>&1 || true
  fi
fi

wait "$server_pid" "$app_pid"
