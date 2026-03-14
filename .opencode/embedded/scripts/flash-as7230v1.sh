#!/usr/bin/env bash
set -euo pipefail

FIRMWARE="${1:-}"
PORT="${2:-${FLASH_PORT:-/dev/ttyUSB0}}"

if [[ -z "$FIRMWARE" ]]; then
  echo "firmware path is required" >&2
  echo "usage: $0 <firmware.bin> [port]" >&2
  exit 2
fi

if [[ ! -f "$FIRMWARE" ]]; then
  echo "firmware not found: $FIRMWARE" >&2
  exit 3
fi

CMD="openocd -f interface/cmsis-dap.cfg -f target/ssc377.cfg -c \"program $FIRMWARE verify reset exit\""

if [[ "${FLASH_DRY_RUN:-1}" == "1" ]]; then
  echo "[dry-run] port=$PORT"
  echo "[dry-run] $CMD"
  exit 0
fi

echo "flashing firmware: $FIRMWARE"
echo "port: $PORT"
eval "$CMD"
