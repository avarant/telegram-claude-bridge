import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { stream, streamApi, type StreamFlavor } from "@grammyjs/stream";
import { ClaudeProcess } from "./claude-process.js";
import { PermissionHandler, PermissionRequest, PermissionDecision } from "./permission-handler.js";
import { markdownToTelegramHtml } from "./markdown.js";

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

// Track last session ID per chat for /resume
const lastSessionIds = new Map<string, string>();

function getOrSpawnClaude(chatId: string, resumeSessionId?: string): ClaudeProcess {
  let cp = claudeProcesses.get(chatId);
  if (cp && cp.isRunning && !resumeSessionId) return cp;

  // Kill existing process if resuming
  if (cp && cp.isRunning) {
    const sid = cp.getSessionId();
    if (sid) lastSessionIds.set(chatId, sid);
    cp.kill();
  }

  cp = new ClaudeProcess();
  claudeProcesses.set(chatId, cp);

  cp.on("exit", () => {
    const sid = cp!.getSessionId();
    if (sid) lastSessionIds.set(chatId, sid);
    console.log(`[bot] Claude process for chat ${chatId} exited (session: ${sid})`);
  });

  cp.spawn(resumeSessionId);
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

    let inputLines: string;
    if (typeof request.toolInput === "object" && request.toolInput !== null) {
      inputLines = Object.entries(request.toolInput)
        .map(([key, value]) => {
          let valStr: string;
          if (typeof value === "string") {
            valStr = value.length > 300 ? value.slice(0, 300) + "…" : value;
          } else {
            valStr = JSON.stringify(value);
          }
          return `${key}: ${valStr}`;
        })
        .join("\n");
    } else {
      inputLines = String(request.toolInput);
    }

    const truncatedInput =
      inputLines.length > 2000 ? inputLines.slice(0, 2000) + "\n..." : inputLines;

    const text = `Permission Request\n\nTool: ${request.toolName}\n\n${truncatedInput}`;

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
    const sid = existing.getSessionId();
    if (sid) lastSessionIds.set(chatId, sid);
    existing.kill();
    claudeProcesses.delete(chatId);
  }
  permissionHandler.clearSessionRules();
  await ctx.reply("Session cleared. Send a message to start a new one.");
});

async function getRecentSessions(): Promise<Array<{ sid: string; display: string; timestamp: number }>> {
  const { readdir, stat, open } = await import("node:fs/promises");
  const home = process.env.HOME || "/home/varant";
  const projectDir = `${home}/.claude/projects/-home-varant`;

  const files = await readdir(projectDir);
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

  const sessions: Array<{ sid: string; display: string; timestamp: number }> = [];
  for (const file of jsonlFiles) {
    const filePath = `${projectDir}/${file}`;
    try {
      const fileStat = await stat(filePath);
      const fh = await open(filePath, "r");
      const firstLine = (await fh.readFile("utf-8")).split("\n")[0];
      await fh.close();
      if (!firstLine) continue;
      const entry = JSON.parse(firstLine);
      const sid = entry.sessionId || file.replace(".jsonl", "");
      const display = entry.content || entry.display || "(no message)";
      sessions.push({ sid, display, timestamp: fileStat.mtimeMs });
    } catch {
      continue;
    }
  }

  return sessions
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 8);
}

bot.command("resume", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) return;

  const chatId = String(ctx.chat.id);
  const arg = ctx.match?.trim();

  // If a session ID was provided directly, resume it
  if (arg) {
    const existing = claudeProcesses.get(chatId);
    if (existing) {
      existing.kill();
      claudeProcesses.delete(chatId);
    }
    permissionHandler.clearSessionRules();
    await ctx.reply(`Resuming session: ${arg}`);
    getOrSpawnClaude(chatId, arg);
    return;
  }

  // Otherwise show session picker
  try {
    const sessions = await getRecentSessions();
    if (sessions.length === 0) {
      await ctx.reply("No sessions found.");
      return;
    }

    const keyboard = new InlineKeyboard();
    const lines: string[] = [];
    for (const s of sessions) {
      const date = new Date(s.timestamp);
      const ts = date.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      const msg = s.display.length > 40 ? s.display.slice(0, 40) + "…" : s.display;
      keyboard.text(msg, `resume:${s.sid}`).row();
      lines.push(`<code>${s.sid.slice(0, 8)}</code> ${ts}\n${msg}`);
    }

    await ctx.reply(`Pick a session to resume:\n\n${lines.join("\n\n")}`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error("[bot] Error listing sessions:", err);
    await ctx.reply("Failed to list sessions.");
  }
});

// --- Helper: download Telegram file as base64 (also saves to /tmp) ---
async function downloadFileAsBase64(fileId: string): Promise<{ base64: string; mediaType: string }> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = file.file_path?.split(".").pop()?.toLowerCase() || "jpg";
  const mediaTypes: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  };
  const savePath = `/tmp/telegram_photo_${Date.now()}.${ext}`;
  await writeFile(savePath, buffer);
  console.log(`[bot] saved photo to ${savePath}`);
  return { base64: buffer.toString("base64"), mediaType: mediaTypes[ext] || "image/jpeg" };
}

// --- Helper: send message to Claude and stream response ---
async function handleClaudeInteraction(
  chatId: string,
  numChatId: number,
  text: string,
  images?: Array<{ base64: string; mediaType: string }>,
): Promise<void> {
  withChatLock(chatId, async () => {
    activeChatId = numChatId;
    permissionHandler.setActiveChatId(numChatId);
    try {
      const claude = getOrSpawnClaude(chatId);
      claude.sendMessage(text, images);

      const draftOffset = (++draftIdCounter) << 8;
      const textStream = streamClaude(claude);
      const api = streamApi(bot.api.raw);
      const messages = await api.streamMessage(numChatId, draftOffset, textStream);

      for (const msg of messages) {
        try {
          const html = markdownToTelegramHtml(msg.text);
          await bot.api.editMessageText(numChatId, msg.message_id, html, {
            parse_mode: "HTML",
          });
        } catch (err) {
          console.error("[bot] markdown render failed, keeping plain text:", (err as Error).message);
        }
      }

      if (messages.length === 0) {
        await bot.api.sendMessage(numChatId, "(No response from Claude)");
      }
    } catch (err) {
      console.error("[bot] Error in Claude interaction:", err);
      await bot.api.sendMessage(numChatId, "Error processing message.").catch(() => {});
    } finally {
      activeChatId = null;
      permissionHandler.setActiveChatId(null);
    }
  });
}

// --- Helper: download Telegram file to disk ---
async function downloadAudioFile(fileId: string): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = file.file_path?.split(".").pop()?.toLowerCase() || "ogg";
  const path = `/tmp/telegram_voice_${Date.now()}.${ext}`;
  await writeFile(path, buffer);
  return path;
}

// --- Handle voice messages ---
bot.on("message:voice", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const chatId = String(ctx.chat.id);
  try {
    const audioPath = await downloadAudioFile(ctx.message.voice.file_id);
    const caption = ctx.message.caption || "";
    const text = caption
      ? `[Voice message received at ${audioPath}] ${caption}`
      : `[Voice message received at ${audioPath}]`;
    await handleClaudeInteraction(chatId, ctx.chat.id, text);
  } catch (err) {
    console.error("[bot] Error processing voice message:", err);
    await ctx.reply("Failed to process voice message.");
  }
});

// --- Handle audio files ---
bot.on("message:audio", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const chatId = String(ctx.chat.id);
  try {
    const audioPath = await downloadAudioFile(ctx.message.audio.file_id);
    const caption = ctx.message.caption || "";
    const text = caption
      ? `[Audio file received at ${audioPath}] ${caption}`
      : `[Audio file received at ${audioPath}]`;
    await handleClaudeInteraction(chatId, ctx.chat.id, text);
  } catch (err) {
    console.error("[bot] Error processing audio file:", err);
    await ctx.reply("Failed to process audio file.");
  }
});

// --- Handle photos ---
bot.on("message:photo", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const chatId = String(ctx.chat.id);
  const caption = ctx.message.caption || "Describe this image.";
  // Telegram provides multiple sizes; pick the largest
  const photo = ctx.message.photo[ctx.message.photo.length - 1];

  try {
    const image = await downloadFileAsBase64(photo.file_id);
    await handleClaudeInteraction(chatId, ctx.chat.id, caption, [image]);
  } catch (err) {
    console.error("[bot] Error downloading photo:", err);
    await ctx.reply("Failed to process image.");
  }
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

  // Check if this is a free-text answer for an AskUserQuestion
  const handled = await permissionHandler.handlePossibleFreeText(ctx.chat.id, text);
  if (handled) return;

  await handleClaudeInteraction(chatId, ctx.chat.id, text);
});

// --- Handle inline keyboard callbacks (permission decisions + AskUserQuestion) ---
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  console.log("[bot] callback_query received:", data);

  // --- AskUserQuestion callbacks ---
  if (data.startsWith("ask:")) {
    try {
      const result = await permissionHandler.handleAskCallback(data);
      await ctx.answerCallbackQuery({ text: result.text || "OK" });
    } catch (err) {
      console.error("[bot] ask callback error:", (err as Error).message);
      await ctx.answerCallbackQuery({ text: "Error" }).catch(() => {});
    }
    return;
  }

  // Handle resume session buttons
  if (data.startsWith("resume:")) {
    const sessionId = data.slice("resume:".length);
    const chatId = String(ctx.chat!.id);
    const existing = claudeProcesses.get(chatId);
    if (existing) {
      existing.kill();
      claudeProcesses.delete(chatId);
    }
    permissionHandler.clearSessionRules();

    await ctx.answerCallbackQuery({ text: "Resuming…" });
    try {
      await ctx.editMessageText(`Resuming session: ${sessionId}`);
    } catch { /* message might be too old */ }

    getOrSpawnClaude(chatId, sessionId);
    return;
  }

  // --- Permission callbacks ---
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

  // Register image sending handler — uses the active chat ID
  permissionHandler.setSendImageHandler(async (imagePath, caption) => {
    if (!activeChatId) {
      console.error("[bot] No active chat for image send");
      return;
    }
    await bot.api.sendPhoto(activeChatId, new InputFile(imagePath), {
      caption: caption || undefined,
    });
    console.log("[bot] sent image to chat", activeChatId, ":", imagePath);
  });

  // Register voice sending handler
  permissionHandler.setSendVoiceHandler(async (voicePath) => {
    if (!activeChatId) {
      console.error("[bot] No active chat for voice send");
      return;
    }
    await bot.api.sendVoice(activeChatId, new InputFile(voicePath));
    console.log("[bot] sent voice to chat", activeChatId, ":", voicePath);
  });

  // Register message sending/editing handlers for AskUserQuestion
  permissionHandler.setSendMessageHandler(async (chatId, text, keyboard) => {
    const msg = await bot.api.sendMessage(chatId, text, { reply_markup: keyboard as any });
    return msg.message_id;
  });

  permissionHandler.setEditMessageHandler(async (chatId, messageId, text, keyboard?) => {
    await bot.api.editMessageText(chatId, messageId, text, {
      reply_markup: keyboard as any,
    });
  });

  // Set bot commands so Telegram's menu matches our actual commands
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome & setup info" },
    { command: "new", description: "Fresh session" },
    { command: "resume", description: "Resume previous session" },
    { command: "id", description: "Show chat ID" },
  ]);

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
