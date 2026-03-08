#!/usr/bin/env bash
# Send a voice message to the active Telegram chat via the bridge's IPC server.
# Usage: send-voice.sh /path/to/audio.ogg

set -euo pipefail

VOICE_PATH="${1:?Usage: send-voice.sh /path/to/audio.ogg}"
SEND_VOICE_URL="http://127.0.0.1:${PERMISSION_PORT:-19275}/send-voice"

if [ ! -f "$VOICE_PATH" ]; then
  echo "Error: File not found: $VOICE_PATH" >&2
  exit 1
fi

JSON=$(jq -n --arg path "$VOICE_PATH" '{path: $path}')

RESPONSE=$(curl -s --max-time 30 \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$JSON" \
  "$SEND_VOICE_URL" 2>/dev/null) || {
  echo "Error: Failed to connect to bridge IPC server" >&2
  exit 1
}

echo "$RESPONSE"
