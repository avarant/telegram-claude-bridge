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
- `claude-settings.json` — Passed via `--settings` flag, configures PreToolUse hooks

### Key Technical Details

- **Stream-JSON input format**: Messages sent as `{"type":"user","session_id":"...","message":{"role":"user","content":"text"},"parent_tool_use_id":null}`
- **Hooks**: Uses `PreToolUse` (not `PermissionRequest`) — only PreToolUse fires in `-p` headless mode
- **Streaming**: Uses `@grammyjs/stream` plugin with `sendMessageDraft` API for real-time animated responses
- **Concurrency**: Message handler runs Claude interaction in background (not awaited) so Grammy can process permission button callbacks concurrently. Per-chat lock serializes messages.
- **Env filtering**: All `CLAUDE*` env vars (except `CLAUDE_API_KEY`) are stripped from subprocess to avoid "nested session" error

## Images

- **Telegram → Claude**: Photos sent by the user are downloaded to `/tmp/telegram_photo_<id>.jpg` and passed to Claude as a file path message
- **Claude → Telegram**: Claude outputs `![caption](/path/to/image.png)` in its text. The bridge detects this via `IMAGE_RE` regex, sends the file as a Telegram photo via `sendPhoto`, and strips the markdown from the text. Supported formats: png, jpg, jpeg, gif, webp, bmp.
- Detection logic is in `src/index.ts` — `extractImages()` function and `IMAGE_RE` regex

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
