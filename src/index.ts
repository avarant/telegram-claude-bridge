import "dotenv/config";
import { Bot, InlineKeyboard, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { stream, streamApi, type StreamFlavor } from "@grammyjs/stream";
import { ClaudeProcess } from "./claude-process.js";
import { PermissionHandler, PermissionRequest, PermissionDecision } from "./permission-handler.js";

type MyContext = StreamFlavor<Context>;

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
// Draft ID counter to avoid clashes between concurrent streams
let draftIdCounter = 0;

function withChatLock(chatId: string, fn: () => Promise<void>): Promise<void> {
  const prev = chatLocks.get(chatId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chatLocks.set(chatId, next);
  return next;
}

// --- Bot ---
const bot = new Bot<MyContext>(BOT_TOKEN);
bot.api.config.use(autoRetry());
bot.use(stream());

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

/**
 * Create an async iterator that yields text chunks from Claude events,
 * resolving when the result event is received.
 */
function streamClaude(
  claude: ClaudeProcess
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let finished = false;
      let resolveNext: ((value: IteratorResult<string>) => void) | null = null;
      const pending: string[] = [];

      const onEvent = (event: Record<string, unknown>) => {
        if (event.type === "assistant") {
          const msg = event.message as {
            content?: Array<{ type: string; text?: string }>;
          } | undefined;
          if (msg?.content) {
            for (const block of msg.content) {
              if (block.type === "text" && block.text) {
                if (resolveNext) {
                  const r = resolveNext;
                  resolveNext = null;
                  r({ value: block.text, done: false });
                } else {
                  pending.push(block.text);
                }
              }
            }
          }
        } else if (event.type === "result") {
          finished = true;
          const result = event as Record<string, unknown>;
          // If no text was streamed, yield the result text
          if (result.is_error === true) {
            const errText = (result.error as string) || (result.result as string) || "An error occurred.";
            if (resolveNext) {
              const r = resolveNext;
              resolveNext = null;
              r({ value: errText, done: false });
            } else {
              pending.push(errText);
            }
          }
          // Signal completion on next pull
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r({ value: undefined as unknown as string, done: true });
          }
        }
      };

      const onExit = () => {
        finished = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          if (pending.length === 0) {
            r({ value: undefined as unknown as string, done: true });
          }
        }
      };

      claude.on("event", onEvent);
      claude.once("exit", onExit);

      return {
        next(): Promise<IteratorResult<string>> {
          // Drain pending chunks first
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift()!, done: false });
          }
          if (finished) {
            claude.removeListener("event", onEvent);
            claude.removeListener("exit", onExit);
            return Promise.resolve({ value: undefined as unknown as string, done: true });
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
        return(): Promise<IteratorResult<string>> {
          claude.removeListener("event", onEvent);
          claude.removeListener("exit", onExit);
          return Promise.resolve({ value: undefined as unknown as string, done: true });
        },
      };
    },
  };
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
      .text("Session", `perm:allowSession:${request.id}`)
      .text("Always", `perm:alwaysAllow:${request.id}`)
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
  permissionHandler.clearSessionRules();
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
  withChatLock(chatId, async () => {
    activeChatId = numChatId;

    try {
      const claude = getOrSpawnClaude(chatId);
      claude.sendMessage(text);

      const draftOffset = (++draftIdCounter) << 8;
      const textStream = streamClaude(claude);
      const api = streamApi(bot.api.raw);
      const messages = await api.streamMessage(numChatId, draftOffset, textStream);

      if (messages.length === 0) {
        await bot.api.sendMessage(numChatId, "(No response from Claude)");
      }
    } catch (err) {
      console.error("[bot] Error in Claude interaction:", err);
      await bot.api.sendMessage(numChatId, "Error processing message.").catch(() => {});
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
  const decision = parts[1] as PermissionDecision;
  const requestId = parts.slice(2).join(":");
  console.log("[bot] permission decision:", decision, "requestId:", requestId);

  const resolved = permissionHandler.resolvePermission(requestId, decision);
  console.log("[bot] resolvePermission result:", resolved);

  const labels: Record<PermissionDecision, string> = {
    allow: "Allowed",
    allowSession: "Allowed (session)",
    alwaysAllow: "Always allowed",
    deny: "Denied",
  };
  const label = labels[decision] || decision;

  try {
    if (resolved) {
      await ctx.answerCallbackQuery({ text: label });
      try {
        await ctx.editMessageText(
          ctx.callbackQuery.message?.text + `\n\n${label}`
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
