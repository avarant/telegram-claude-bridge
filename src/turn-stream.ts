import path from "path";
import type { Api } from "grammy";
import type { ClaudeProcess, ClaudeEvent } from "./claude-process.js";

/**
 * Streams one Claude turn into a Telegram rich-message draft
 * (sendRichMessageDraft), then the caller finalizes it with real messages.
 *
 * - Token-level text comes from `stream_event` / `text_delta` events, which
 *   Claude only emits with `--include-partial-messages`.
 * - While Claude runs a tool, the draft ends with a <tg-thinking> status line
 *   ("Running git status…"). It doubles as a heartbeat: drafts expire after
 *   ~30s, so the draft is re-sent periodically even when nothing changed.
 * - The draft carries Telegram's stop button (can_stop); tapping it sends the
 *   bot a `stopped_message_generation` update (handled in index.ts).
 */

// Rich messages allow 32768 chars; leave headroom for the status line.
const DRAFT_MAX_CHARS = 30000;
const DRAFT_TAIL_CHARS = 28000;
// Plain-draft fallback limit (sendMessageDraft is 4096 after entity parsing).
const PLAIN_DRAFT_MAX = 4000;
const MIN_INTERVAL_MS = 500;
const HEARTBEAT_MS = 15000;

let draftCounter = (Date.now() % 1_000_000_000) + 1;

export interface TurnResult {
  text: string;
  /** Error text from an `is_error` result that wasn't a deliberate interrupt. */
  error?: string;
}

export function toolLabel(name: string, input: Record<string, unknown> | undefined): string {
  const s = (k: string) => (typeof input?.[k] === "string" ? (input[k] as string) : "");
  const clip = (t: string, n = 70) => {
    const one = t.replace(/\s+/g, " ").trim();
    return one.length > n ? one.slice(0, n - 1) + "…" : one;
  };
  const base = (p: string) => (p ? path.basename(p) : "");
  switch (name) {
    case "Bash":
      return s("description") ? clip(s("description")) : `Running ${clip(s("command"), 60)}`;
    case "Read":
      return `Reading ${base(s("file_path"))}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${base(s("file_path"))}`;
    case "Write":
      return `Writing ${base(s("file_path"))}`;
    case "Grep":
      return `Searching for ${clip(s("pattern"), 50)}`;
    case "Glob":
      return `Finding ${clip(s("pattern"), 50)}`;
    case "WebSearch":
      return `Searching the web: ${clip(s("query"), 60)}`;
    case "WebFetch": {
      try {
        return `Fetching ${new URL(s("url")).host}`;
      } catch {
        return "Fetching a page";
      }
    }
    case "Agent":
    case "Task":
      return `Agent: ${clip(s("description") || "working", 60)}`;
    case "TodoWrite":
      return "Updating plan";
    case "AskUserQuestion":
      return "Waiting for your answer";
    default: {
      // mcp__server__tool -> "server: tool"
      const m = name.match(/^mcp__(.+?)__(.+)$/);
      return m ? `${m[1]}: ${m[2]}` : `Using ${name}`;
    }
  }
}

/** Number of ``` fence lines in s (odd => an unclosed code block). */
function fenceCount(s: string): number {
  return (s.match(/^\s*```/gm) || []).length;
}

/** What the draft shows: the text (tail-trimmed if huge) plus a status line. */
function draftMarkdown(text: string, status: string | null): string {
  let body = text;
  if (body.length > DRAFT_MAX_CHARS) {
    let cut = body.length - DRAFT_TAIL_CHARS;
    const nl = body.indexOf("\n", cut);
    if (nl !== -1 && nl - cut < 2000) cut = nl + 1;
    const head = body.slice(0, cut);
    body = (fenceCount(head) % 2 === 1 ? "```\n" : "") + "…\n\n" + body.slice(cut);
  }
  if (!status) return body;
  // Close an open code block so the status line isn't swallowed into it.
  const close = fenceCount(body) % 2 === 1 ? "\n```" : "";
  return `${body}${close}${body ? "\n\n" : ""}<tg-thinking>${escapeTag(status)}</tg-thinking>`;
}

function escapeTag(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Run one turn: subscribe to Claude's events, keep the draft up to date, and
 * resolve with the full text when the `result` event (or process exit) arrives.
 * The caller must have already sent the user message.
 */
export function streamTurn(api: Api, chatId: number, claude: ClaudeProcess): {
  draftId: number;
  done: Promise<TurnResult>;
} {
  const draftId = draftCounter++;

  let text = "";
  let status: string | null = "Thinking";
  let error: string | undefined;
  let finished = false;
  let dirty = true;
  let inFlight = false;
  let lastSent = 0;
  let richFailed = false;

  const send = async () => {
    if (inFlight || finished) return;
    inFlight = true;
    dirty = false;
    lastSent = Date.now();
    try {
      if (!richFailed) {
        try {
          await api.sendRichMessageDraft(chatId, draftId, { markdown: draftMarkdown(text, status) }, {
            can_stop: true,
            keep_on_stop: true,
          });
          return;
        } catch (err) {
          console.error("[stream] rich draft failed, using plain drafts:", (err as Error).message);
          richFailed = true;
        }
      }
      let plain = text.length > PLAIN_DRAFT_MAX ? "…" + text.slice(-PLAIN_DRAFT_MAX + 1) : text;
      if (status) {
        const line = `\n\n⏳ ${status}…`;
        if (plain.length + line.length > PLAIN_DRAFT_MAX) plain = "…" + plain.slice(-(PLAIN_DRAFT_MAX - line.length - 1));
        plain = plain + line;
      }
      await api.sendMessageDraft(chatId, draftId, plain.trim(), { can_stop: true, keep_on_stop: true });
    } catch (err) {
      console.error("[stream] draft send failed:", (err as Error).message);
    } finally {
      inFlight = false;
    }
  };

  const tick = setInterval(() => {
    const since = Date.now() - lastSent;
    if ((dirty && since >= MIN_INTERVAL_MS) || since >= HEARTBEAT_MS) void send();
  }, 150);

  const onEvent = (event: ClaudeEvent) => {
    // Ignore subagent traffic; only the top-level conversation is shown.
    if (event.parent_tool_use_id) return;

    if (event.type === "stream_event") {
      const ev = event.event as Record<string, any> | undefined;
      if (!ev) return;
      if (ev.type === "content_block_start") {
        const block = ev.content_block as { type: string; name?: string } | undefined;
        if (block?.type === "text") {
          // Separate text blocks that are split by tool calls.
          if (text && !text.endsWith("\n\n")) text += text.endsWith("\n") ? "\n" : "\n\n";
          status = null;
          dirty = true;
        } else if (block?.type === "tool_use" && block.name) {
          status = toolLabel(block.name, undefined);
          dirty = true;
        } else if (block?.type === "thinking") {
          status = "Thinking";
          dirty = true;
        }
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        text += ev.delta.text as string;
        dirty = true;
      } else if (ev.type === "message_stop") {
        // Claude is about to run tools or think further — keep a live status.
        if (!status) {
          status = "Working";
          dirty = true;
        }
      }
    } else if (event.type === "assistant") {
      // Complete message: tool inputs are only fully known here.
      const content = (event.message as { content?: Array<Record<string, any>> } | undefined)?.content;
      for (const block of content ?? []) {
        if (block.type === "tool_use") {
          status = toolLabel(block.name, block.input);
          dirty = true;
        }
      }
    } else if (event.type === "user") {
      // Tool results came back; Claude is thinking about them.
      status = "Thinking";
      dirty = true;
    }
  };

  const done = new Promise<TurnResult>((resolve) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(tick);
      claude.removeListener("event", onResult);
      claude.removeListener("exit", finish);
      claude.removeListener("event", onEvent);
      resolve({ text, error });
    };
    const onResult = (event: ClaudeEvent) => {
      if (event.type !== "result") return;
      if (event.is_error === true && !claude.wasInterrupted) {
        error = (event.error as string) || (event.result as string) || "An error occurred.";
      }
      // Partial-message mode should have streamed everything; fall back to
      // the result text if somehow nothing arrived.
      if (!text.trim() && typeof event.result === "string" && !event.is_error) text = event.result;
      finish();
    };
    claude.on("event", onEvent);
    claude.on("event", onResult);
    claude.once("exit", finish);
  });

  void send();
  return { draftId, done };
}

/**
 * Split markdown into pieces of at most `max` chars on line boundaries,
 * closing and re-opening a code fence that spans a split.
 */
export function splitMarkdown(md: string, max = DRAFT_MAX_CHARS): string[] {
  if (md.length <= max) return [md];
  const chunks: string[] = [];
  let cur = "";
  let fence: string | null = null; // the opening ``` line while inside a code block
  const push = () => {
    if (!cur) return;
    chunks.push(fence ? cur + "\n```" : cur);
    cur = fence ? fence + "\n" : "";
  };
  for (const rawLine of md.split("\n")) {
    let line = rawLine;
    while (line.length > max - 200) {
      // Pathological single line: hard split.
      if (cur) push();
      cur += line.slice(0, max - 200);
      push();
      line = line.slice(max - 200);
    }
    if (cur.length + line.length + 1 > max - 10) push();
    cur += (cur ? "\n" : "") + line;
    if (/^\s*```/.test(line)) fence = fence ? null : line.trim();
  }
  if (cur) chunks.push(cur);
  return chunks;
}
