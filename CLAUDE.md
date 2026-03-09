# Telegram Claude Bridge

Telegram bot that bridges messages to a persistent Claude Code subprocess and streams responses back.

## Quick Start

```bash
cp .env.example .env  # fill in TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_IDS
npm install
npm start
```

## Architecture

```
Telegram ←→ Grammy Bot (index.ts)
                ↕
         Claude subprocess (claude-process.ts)
            spawned with: claude -p --input-format stream-json --output-format stream-json --verbose --settings claude-settings.json
                ↕
         PreToolUse hooks → permission-hook.sh → HTTP POST to IPC server
                ↕
         Permission Handler (permission-handler.ts) → Telegram inline keyboard (Allow/Deny)
```

### Source Files

- `src/index.ts` — Main entry: Grammy bot, message handling, streaming via `@grammyjs/stream`, permission button callbacks
- `src/claude-process.ts` — Claude Code subprocess lifecycle, stream-json message protocol
- `src/permission-handler.ts` — HTTP IPC server on localhost:19275 for permission request/response flow
- `src/permission-hook.sh` — Shell script called by Claude's PreToolUse hook, forwards to IPC server
- `claude-settings.json` — Passed via `--settings` flag, configures PreToolUse hooks (not permissions)
- `~/.claude/settings.local.json` — Stores persistent always-allow permission rules (written by "Always" button)

### Key Technical Details

- **Stream-JSON input format**: Messages sent as `{"type":"user","session_id":"...","message":{"role":"user","content":"text"},"parent_tool_use_id":null}`
- **Hooks**: Uses `PreToolUse` (not `PermissionRequest`) — only PreToolUse fires in `-p` headless mode
- **Streaming**: Uses `@grammyjs/stream` plugin with `sendMessageDraft` API for real-time animated responses
- **Concurrency**: Message handler runs Claude interaction in background (not awaited) so Grammy can process permission button callbacks concurrently. Per-chat lock serializes messages.
- **Env filtering**: All `CLAUDE*` env vars (except `CLAUDE_API_KEY`) are stripped from subprocess to avoid "nested session" error

## Images

- **Telegram → Claude**: Photos sent by the user are downloaded to `/tmp/telegram_photo_<id>.jpg` and passed to Claude as a file path message
- **Claude → Telegram**: Claude runs `src/send-image.sh /path/to/image.png "caption"` which POSTs to the bridge's IPC server (`/send-image` endpoint). The bridge sends the file as a Telegram photo via `sendPhoto`.
- Image sending logic: `src/send-image.sh` (script) → `permission-handler.ts` (`/send-image` endpoint) → `index.ts` (`setSendImageHandler`)

## Voice Messages / Audio

- **Telegram → Claude**: Voice messages and audio files are downloaded to `/tmp/telegram_voice_<timestamp>.<ext>` and passed to Claude as a text message with the file path (e.g. `[Voice message received at /tmp/telegram_voice_123.ogg]`)
- Claude uses the `transcribe` skill (`~/.claude/skills/transcribe/`) to run Whisper locally on the file
- Transcription uses pywhispercpp with the base model (~147MB VRAM, no conflict with hyprwhspr)
- Supported formats: ogg, mp3, wav, m4a, flac, opus (converted to 16kHz WAV via ffmpeg)
- **Claude → Telegram**: Claude generates audio with a TTS skill, then runs `src/send-voice.sh /path/to/audio.ogg` to send it as a Telegram voice message
- Voice sending logic: `src/send-voice.sh` (script) → `permission-handler.ts` (`/send-voice` endpoint) → `index.ts` (`setSendVoiceHandler` → `sendVoice`)

## Environment

- **`TELEGRAM_BRIDGE`**: Set to `"true"` in the Claude subprocess env so Claude can detect it's running via Telegram (used for Clanky identity in `~/CLAUDE.md`)
- All other `CLAUDE*` env vars (except `CLAUDE_API_KEY`) are stripped from the subprocess to avoid "nested session" errors

## Bot Commands

- `/start` — Show chat ID
- `/new` — Kill current Claude process and start fresh
- `/id` — Show chat ID
- Commands are registered via `bot.api.setMyCommands()` on startup to keep the Telegram menu in sync

## Config (.env)

- `TELEGRAM_BOT_TOKEN` — Bot token from @BotFather
- `ALLOWED_CHAT_IDS` — Comma-separated list of authorized chat IDs
- `PERMISSION_PORT` — IPC server port (default: 19275)

## systemd Service

The bridge can run as a systemd user service for auto-start on login and auto-restart on crash. See the "Running as a systemd service" section in README.md for setup. Key commands:

- `systemctl --user status telegram-claude-bridge` — check status
- `systemctl --user restart telegram-claude-bridge` — restart after code changes
- `journalctl --user -u telegram-claude-bridge -f` — tail logs
