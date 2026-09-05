import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { stream, type StreamFlavor } from "@grammyjs/stream";
import { ClaudeProcess } from "./claude-process.js";
import { PermissionHandler, PermissionRequest, PermissionDecision } from "./permission-handler.js";
import { markdownToTelegramHtml, escapeHtml } from "./markdown.js";

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

const SESSIONS_DIR = `${process.env.HOME || "/home/varant"}/.claude/projects/-home-varant`;

// Read enough of a session file to find its title without loading multi-MB
// transcripts: an ai-title/summary line near the top, else the first user message.
async function getSessionTitle(filePath: string): Promise<string> {
  const { open } = await import("node:fs/promises");
  const fh = await open(filePath, "r");
  const buf = Buffer.alloc(65536);
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
  await fh.close();

  let fallback = "";
  for (const line of buf.subarray(0, bytesRead).toString("utf-8").split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // truncated last line in the buffer
    }
    if (entry.type === "ai-title" && entry.aiTitle) return entry.aiTitle;
    if (entry.type === "summary" && entry.summary) return entry.summary;
    if (!fallback && entry.type === "user" && entry.message?.content) {
      const c = entry.message.content;
      if (typeof c === "string") fallback = c;
      else if (Array.isArray(c)) {
        fallback = c
          .filter((b: any) => b.type === "text" && b.text)
          .map((b: any) => b.text)
          .join(" ");
      }
    }
  }
  return fallback;
}

async function getRecentSessions(limit = 10): Promise<Array<{ sid: string; title: string; timestamp: number }>> {
  const { readdir, stat } = await import("node:fs/promises");
  const files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".jsonl"));

  const sessions: Array<{ sid: string; title: string; timestamp: number }> = [];
  for (const file of files) {
    const filePath = `${SESSIONS_DIR}/${file}`;
    try {
      const fileStat = await stat(filePath);
      const title = (await getSessionTitle(filePath)).replace(/\s+/g, " ").trim();
      sessions.push({
        sid: file.replace(".jsonl", ""),
        title: title || "(no title)",
        timestamp: fileStat.mtimeMs,
      });
    } catch {
      continue;
    }
  }

  return sessions.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

function formatSessionList(sessions: Array<{ sid: string; title: string; timestamp: number }>): string {
  return sessions
    .map((s) => {
      const ts = new Date(s.timestamp).toLocaleDateString("en-US", {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
      const title = s.title.length > 60 ? s.title.slice(0, 60) + "…" : s.title;
      return `<b>${escapeHtml(title)}</b>\n<code>${s.sid}</code> · ${ts}`;
    })
    .join("\n\n");
}

// Resolve a full or prefix session ID to a session file's full ID.
async function resolveSessionId(arg: string): Promise<{ sid?: string; error?: string }> {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".jsonl"));
  const matches = files.filter((f) => f.startsWith(arg)).map((f) => f.replace(".jsonl", ""));
  if (matches.length === 1) return { sid: matches[0] };
  if (matches.length === 0) return { error: `No session found matching "${arg}". Use /list to see recent sessions.` };
  return { error: `"${arg}" matches ${matches.length} sessions — use a longer prefix or the full ID.` };
}

bot.command("list", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) return;

  try {
    const sessions = await getRecentSessions();
    if (sessions.length === 0) {
      await ctx.reply("No sessions found.");
      return;
    }
    await ctx.reply(
      `Recent sessions (resume with /resume &lt;id&gt;):\n\n${formatSessionList(sessions)}`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("[bot] Error listing sessions:", err);
    await ctx.reply("Failed to list sessions.");
  }
});

bot.command("resume", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) return;

  const chatId = String(ctx.chat.id);
  const arg = ctx.match?.trim();

  if (!arg) {
    await ctx.reply("Usage: /resume <session-id> (full ID or unique prefix). Use /list to see recent sessions.");
    return;
  }

  const { sid, error } = await resolveSessionId(arg);
  if (!sid) {
    await ctx.reply(error!);
    return;
  }

  const existing = claudeProcesses.get(chatId);
  if (existing) {
    existing.kill();
    claudeProcesses.delete(chatId);
  }
  permissionHandler.clearSessionRules();
  await ctx.reply(`Resuming session: ${sid}`);
  getOrSpawnClaude(chatId, sid);
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

// Telegram's hard limit is 4096 chars per message. We render markdown to HTML,
// which expands length (e.g. "<" -> "&lt;", added <b>/<pre> tags), so a chunk
// that fits as plain text can bust the limit as HTML. Chunk against a target
// below 4096 measured on the *rendered HTML* to stay safe with headroom.
const TG_HTML_TARGET = 3800;

// Split plain markdown into pieces whose rendered HTML each stays within the
// Telegram limit. Splits on line boundaries; hard-splits a single line whose
// HTML alone is too large (rare — e.g. one enormous unbroken line).
function chunkMarkdown(plain: string): string[] {
  const htmlLen = (s: string) => markdownToTelegramHtml(s).length;
  const chunks: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length > 0) {
      chunks.push(cur.join("\n"));
      cur = [];
    }
  };
  for (const line of plain.split("\n")) {
    // Start a new chunk if appending this line would overflow the current one.
    if (cur.length > 0 && htmlLen([...cur, line].join("\n")) > TG_HTML_TARGET) {
      flush();
    }
    if (htmlLen(line) > TG_HTML_TARGET) {
      // A single line's HTML exceeds the target on its own: hard-split on plain
      // chars. HTML can expand ~4x worst case, so step at a quarter of target.
      flush();
      const step = Math.max(256, Math.floor(TG_HTML_TARGET / 4));
      for (let j = 0; j < line.length; j += step) chunks.push(line.slice(j, j + step));
    } else {
      cur.push(line);
    }
  }
  flush();
  return chunks;
}

// Deliver plain markdown as one or more Telegram messages: render each chunk to
// HTML, falling back to plain text if Telegram rejects the HTML. Never throws —
// send failures are logged and swallowed so a delivery problem can't wedge the
// per-chat lock.
async function deliverMarkdown(chatId: number, plain: string): Promise<void> {
  for (const chunk of chunkMarkdown(plain)) {
    try {
      await bot.api.sendMessage(chatId, markdownToTelegramHtml(chunk), { parse_mode: "HTML" });
    } catch (err) {
      console.error("[bot] HTML send failed, retrying as plain text:", (err as Error).message);
      await bot.api.sendMessage(chatId, chunk).catch(() => {});
    }
  }
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

      // Show a "typing…" indicator while Claude works (it auto-expires after
      // ~5s, so refresh it) — this is the only live feedback; the answer is
      // sent once, when complete.
      await bot.api.sendChatAction(numChatId, "typing").catch(() => {});
      const typing = setInterval(() => {
        bot.api.sendChatAction(numChatId, "typing").catch(() => {});
      }, 5000);

      // Wait for the complete response, then send it once as formatted HTML
      // (chunked across multiple messages only if it exceeds Telegram's limit).
      let fullText = "";
      try {
        for await (const chunk of streamClaude(claude)) {
          fullText += chunk;
        }
      } finally {
        clearInterval(typing);
      }

      if (fullText.trim()) {
        await deliverMarkdown(numChatId, fullText);
      } else {
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

// --- Helper: download Telegram document (CSV, PDF, etc.) to disk ---
async function downloadDocumentFile(fileId: string, originalName?: string): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  // Prefer the original filename (sanitized) so e.g. spend.csv keeps its name;
  // fall back to extension from Telegram's stored path.
  const fallbackExt = file.file_path?.split(".").pop()?.toLowerCase() || "bin";
  const safeName = originalName
    ? originalName.replace(/[^A-Za-z0-9._-]/g, "_")
    : `document.${fallbackExt}`;
  const path = `/tmp/telegram_document_${Date.now()}_${safeName}`;
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

// --- Handle documents (CSV, PDF, txt, etc. — anything attached as a file) ---
bot.on("message:document", async (ctx) => {
  if (!isAllowed(ctx.chat.id)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const chatId = String(ctx.chat.id);
  try {
    const docPath = await downloadDocumentFile(
      ctx.message.document.file_id,
      ctx.message.document.file_name,
    );
    const caption = ctx.message.caption || "";
    const text = caption
      ? `[Document received at ${docPath}] ${caption}`
      : `[Document received at ${docPath}]`;
    await handleClaudeInteraction(chatId, ctx.chat.id, text);
  } catch (err) {
    console.error("[bot] Error processing document:", err);
    await ctx.reply("Failed to process document.");
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

  // Resume buttons were removed — nudge anyone tapping one on an old message
  if (data.startsWith("resume:")) {
    await ctx.answerCallbackQuery({ text: "Buttons removed — use /resume <id>" }).catch(() => {});
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

  // Register inject message handler for cron jobs / external triggers
  permissionHandler.setInjectMessageHandler(async (text, chatId?) => {
    const targetChatId = chatId || [...ALLOWED_CHAT_IDS][0];
    if (!targetChatId) throw new Error("No allowed chat ID configured");
    const numChatId = parseInt(targetChatId, 10);
    console.log(`[bot] injected message to chat ${numChatId}: ${text.slice(0, 80)}...`);
    handleClaudeInteraction(targetChatId, numChatId, text);
  });

  // Set bot commands so Telegram's menu matches our actual commands
  await bot.api.setMyCommands([
    { command: "start", description: "Welcome & setup info" },
    { command: "new", description: "Fresh session" },
    { command: "list", description: "List recent sessions" },
    { command: "resume", description: "Resume a session by ID" },
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
