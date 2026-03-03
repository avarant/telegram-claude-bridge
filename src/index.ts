import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { ClaudeProcess } from "./claude-process.js";
import { PermissionHandler, PermissionRequest } from "./permission-handler.js";

// --- Config ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const ALLOWED_CHAT_IDS = new Set(
  (process.env.ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const PERMISSION_PORT = parseInt(process.env.PERMISSION_PORT || "19275", 10);

// --- State ---
const claudeProcesses = new Map<string, ClaudeProcess>();
// Track which chat ID each Claude process belongs to for permission routing
const permissionChatMap = new Map<string, number>();
// Active chat ID for incoming permission requests (set before each message)
let activeChatId: number | null = null;
// Per-chat message queue to prevent concurrent sends
const chatLocks = new Map<string, Promise<void>>();

function withChatLock(chatId: string, fn: () => Promise<void>): Promise<void> {
  const prev = chatLocks.get(chatId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chatLocks.set(chatId, next);
  return next;
}

// --- Bot ---
const bot = new Bot(BOT_TOKEN);

function isAllowed(chatId: number): boolean {
  if (ALLOWED_CHAT_IDS.size === 0) return false;
  return ALLOWED_CHAT_IDS.has(String(chatId));
}

function getOrSpawnClaude(chatId: string): ClaudeProcess {
  let cp = claudeProcesses.get(chatId);
  if (cp && cp.isRunning) return cp;

  cp = new ClaudeProcess();
  claudeProcesses.set(chatId, cp);

  cp.on("exit", () => {
    console.log(`[bot] Claude process for chat ${chatId} exited`);
  });

  cp.spawn();
  return cp;
}

const MAX_MSG_LENGTH = 4096;

async function sendLongMessage(chatId: number, text: string): Promise<void> {
  if (text.length <= MAX_MSG_LENGTH) {
    await bot.api.sendMessage(chatId, text);
    return;
  }
  const lines = text.split("\n");
  let chunk = "";
  for (const line of lines) {
    if (chunk.length + line.length + 1 > MAX_MSG_LENGTH) {
      if (chunk) await bot.api.sendMessage(chatId, chunk);
      chunk = line;
    } else {
      chunk += (chunk ? "\n" : "") + line;
    }
  }
  if (chunk) await bot.api.sendMessage(chatId, chunk);
}

/**
 * Wait for a result event from Claude, collecting response text.
 */
function waitForResult(
  claude: ClaudeProcess,
  sendTyping: () => void
): Promise<string> {
  return new Promise<string>((resolve) => {
    let responseText = "";
    let finished = false;

    const onEvent = (event: Record<string, unknown>) => {
      switch (event.type) {
        case "assistant": {
          const msg = event.message as {
            content?: Array<{ type: string; text?: string }>;
          } | undefined;
          if (msg?.content) {
            for (const block of msg.content) {
              if (block.type === "text" && block.text) {
                responseText += block.text;
              }
            }
          }
          break;
        }

        case "result": {
          const result = event as Record<string, unknown>;
          if (result.result && typeof result.result === "string") {
            if (!responseText) responseText = result.result;
          }
          if (result.is_error === true && !responseText) {
            responseText =
              (result.error as string) ||
              (result.result as string) ||
              "An error occurred.";
          }
          finished = true;
          break;
        }
      }
    };

    claude.on("event", onEvent);

    const check = () => {
      if (finished) {
        claude.removeListener("event", onEvent);
        resolve(responseText);
        return;
      }
      sendTyping();
      setTimeout(check, 3000);
    };
    check();

    claude.once("exit", () => {
      if (!finished) {
        finished = true;
        claude.removeListener("event", onEvent);
        resolve(responseText || "Claude process exited unexpectedly.");
      }
    });
  });
}

// --- Permission Handler ---
const permissionHandler = new PermissionHandler(
  PERMISSION_PORT,
  async (request: PermissionRequest) => {
    // Use the active chat ID for this permission request
    const chatId = activeChatId;
    permissionChatMap.set(request.id, chatId!);
    if (!chatId) {
      console.error("[bot] No active chat for permission request", request.id);
      return;
    }

    const inputStr =
      typeof request.toolInput === "object"
        ? JSON.stringify(request.toolInput, null, 2)
        : String(request.toolInput);

    const truncatedInput =
      inputStr.length > 2000 ? inputStr.slice(0, 2000) + "\n..." : inputStr;

    const text = `Permission Request\n\nTool: ${request.toolName}\n\nInput:\n${truncatedInput}`;

    const keyboard = new InlineKeyboard()
      .text("Allow", `perm:allow:${request.id}`)
      .text("Deny", `perm:deny:${request.id}`);

    await bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
  }
);

// --- Bot Commands ---
bot.command("start", async (ctx) => {
  await ctx.reply(
    `Clank is ready. Your chat ID: ${ctx.chat.id}\n\nAdd this ID to ALLOWED_CHAT_IDS in .env and restart to enable access.`
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(`Your chat ID: ${ctx.chat.id}`);
});

bot.command("new", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) return;

  const chatId = String(ctx.chat.id);
  const existing = claudeProcesses.get(chatId);
  if (existing) {
    existing.kill();
    claudeProcesses.delete(chatId);
  }
  await ctx.reply("Session cleared. Send a message to start a new one.");
});

// --- Handle text messages ---
bot.on("message:text", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const chatId = String(ctx.chat.id);
  const text = ctx.message.text;

  if (text.startsWith("/")) return;

  const numChatId = ctx.chat.id;

  // Run Claude interaction in background so Grammy can process callback queries
  // (permission button clicks) while we wait for Claude's response
  const numChatIdCopy = numChatId;
  const chatIdCopy = chatId;
  const textCopy = text;

  withChatLock(chatIdCopy, async () => {
    activeChatId = numChatIdCopy;

    try {
      await bot.api.sendChatAction(numChatIdCopy, "typing");

      const claude = getOrSpawnClaude(chatIdCopy);
      claude.sendMessage(textCopy);

      const responseText = await waitForResult(claude, () => {
        bot.api.sendChatAction(numChatIdCopy, "typing").catch(() => {});
      });

      if (responseText.trim()) {
        await sendLongMessage(numChatIdCopy, responseText.trim());
      } else {
        await bot.api.sendMessage(numChatIdCopy, "(No response from Claude)");
      }
    } catch (err) {
      console.error("[bot] Error in Claude interaction:", err);
      await bot.api.sendMessage(numChatIdCopy, "Error processing message.").catch(() => {});
    } finally {
      activeChatId = null;
    }
  });
});

// --- Handle inline keyboard callbacks (permission decisions) ---
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  console.log("[bot] callback_query received:", data);
  if (!data.startsWith("perm:")) return;

  const parts = data.split(":");
  const decision = parts[1];
  const requestId = parts.slice(2).join(":");
  console.log("[bot] permission decision:", decision, "requestId:", requestId);

  const allow = decision === "allow";
  const resolved = permissionHandler.resolvePermission(requestId, allow);
  console.log("[bot] resolvePermission result:", resolved);

  try {
    if (resolved) {
      await ctx.answerCallbackQuery({
        text: allow ? "Allowed" : "Denied",
      });
      try {
        await ctx.editMessageText(
          ctx.callbackQuery.message?.text +
            `\n\n${allow ? "Allowed" : "Denied"}`
        );
      } catch {
        // Message might be too old to edit
      }
    } else {
      await ctx.answerCallbackQuery({
        text: "Request expired or already handled",
      });
    }
  } catch (err) {
    console.error("[bot] callback_query error (non-fatal):", (err as Error).message);
  }
});

// --- Error handler ---
bot.catch((err) => {
  console.error("[bot] Error:", err.message);
});

// --- Start ---
async function main() {
  await permissionHandler.start();
  console.log("[bot] Starting Telegram bot...");
  bot.start({
    onStart: () => console.log("[bot] Bot is running!"),
  });
}

process.on("SIGINT", () => {
  console.log("\n[bot] Shutting down...");
  bot.stop();
  permissionHandler.stop();
  for (const [, cp] of claudeProcesses) {
    cp.kill();
  }
  process.exit(0);
});

main().catch((err) => {
  console.error("[bot] Fatal error:", err);
  process.exit(1);
});
