#!/usr/bin/env bash
# Send an image to the active Telegram chat via the bridge's IPC server.
# Usage: send-image.sh /path/to/image.png ["optional caption"]

set -euo pipefail

IMAGE_PATH="${1:?Usage: send-image.sh /path/to/image.png [caption]}"
CAPTION="${2:-}"
SEND_IMAGE_URL="http://127.0.0.1:${PERMISSION_PORT:-19275}/send-image"

if [ ! -f "$IMAGE_PATH" ]; then
  echo "Error: File not found: $IMAGE_PATH" >&2
  exit 1
fi

RESPONSE=$(curl -s --max-time 30 \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"path\": \"$IMAGE_PATH\", \"caption\": \"$CAPTION\"}" \
  "$SEND_IMAGE_URL" 2>/dev/null) || {
  echo "Error: Failed to connect to bridge IPC server" >&2
  exit 1
}

echo "$RESPONSE"
