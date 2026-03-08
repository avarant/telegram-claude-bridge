# Telegram Claude Bridge

A Telegram bot that bridges messages to a persistent [Claude Code](https://docs.anthropic.com/en/docs/claude-code) subprocess and streams responses back in real time.

Responses are streamed live using Telegram's `sendMessageDraft` API and rendered with full markdown formatting (bold, italic, code blocks, links, etc.).

## Features

- **Streaming responses** — See Claude's output as it's generated, not after
- **Markdown rendering** — Claude's markdown is converted to Telegram-native formatting
- **Interactive permissions** — Tool use requires approval via inline buttons with four options:
  - **Allow** — Allow once
  - **Session** — Auto-allow this tool for the rest of the session
  - **Always** — Permanently allow (writes to `claude-settings.json`)
  - **Deny** — Block the tool call
- **Plan mode support** — `ExitPlanMode` always prompts for review regardless of auto-allow rules
- **Image support** — Send photos to Claude (downloaded and passed as file paths) and receive images back (Claude's markdown images sent as Telegram photos)
- **Per-chat sessions** — Each chat gets its own persistent Claude subprocess
- **Concurrency safe** — Permission button callbacks are processed while Claude is running
- **Identity-aware** — Sets `TELEGRAM_BRIDGE` env var so Claude can detect it's running via Telegram

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` command available)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

1. Clone the repo and install dependencies:

```bash
git clone <repo-url>
cd telegram-claude-bridge
npm install
```

2. Create a `.env` file:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token-here
ALLOWED_CHAT_IDS=123456789,987654321
PERMISSION_PORT=19275
```

To find your chat ID, start the bot and send `/id`.

3. Start the bot:

```bash
npm start
```

## Bot Commands

| Command  | Description                                    |
|----------|------------------------------------------------|
| `/start` | Show chat ID and setup instructions            |
| `/new`   | Kill the current Claude session and start fresh |
| `/id`    | Show your chat ID                              |

## Architecture

```
Telegram <-> Grammy Bot (index.ts)
                |
         Claude subprocess (claude-process.ts)
           spawned with: claude -p --input-format stream-json
                         --output-format stream-json --verbose
                         --settings claude-settings.json
                |
         PreToolUse hooks -> permission-hook.sh -> HTTP POST to IPC server
                |
         Permission Handler (permission-handler.ts)
           -> Telegram inline keyboard (Allow/Session/Always/Deny)
```

### Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Grammy bot, message handling, streaming, permission callbacks |
| `src/claude-process.ts` | Claude Code subprocess lifecycle, stream-json protocol |
| `src/permission-handler.ts` | HTTP IPC server for permission request/response flow |
| `src/permission-hook.sh` | Shell hook script, forwards PreToolUse events to IPC server |
| `src/markdown.ts` | Markdown to Telegram HTML converter |
| `claude-settings.json` | Claude Code settings: hooks config and permission rules |

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather | *(required)* |
| `ALLOWED_CHAT_IDS` | Comma-separated list of authorized chat IDs | *(required)* |
| `PERMISSION_PORT` | Port for the local permission IPC server | `19275` |

## Linux setup

### systemd service

Run the bridge persistently in the background (auto-starts on login, restarts on crash):

```bash
# Create the service file
cat > ~/.config/systemd/user/telegram-claude-bridge.service << 'EOF'
[Unit]
Description=Telegram Claude Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/telegram-claude-bridge
ExecStart=/usr/bin/node --import tsx src/index.ts
Restart=on-failure
RestartSec=5
EnvironmentFile=/path/to/telegram-claude-bridge/.env
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

# Enable and start
systemctl --user daemon-reload
systemctl --user enable --now telegram-claude-bridge

# Check status / logs
systemctl --user status telegram-claude-bridge
journalctl --user -u telegram-claude-bridge -f
```

> **Note:** Update `WorkingDirectory` and `EnvironmentFile` paths to match where you cloned the repo.

### Claude Code

Add the following to your `~/CLAUDE.md` so Claude knows it's running via Telegram and can send images:

```markdown
# Telegram Bridge

- If the `TELEGRAM_BRIDGE` env var is set, you are communicating via Telegram
- **Sending images to Telegram**: Run the send-image script:
  ```
  bash /path/to/telegram-claude-bridge/src/send-image.sh /absolute/path/to/image.png "optional caption"
  ```
  The script sends the image to the active Telegram chat via the bridge's IPC server. The file must exist on disk.
```

The `TELEGRAM_BRIDGE` env var is set automatically by the bridge in the Claude subprocess. Update the script path to match where you cloned the repo.

## License

ISC
