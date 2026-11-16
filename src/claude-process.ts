import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import path from "path";

export interface ClaudeEvent {
  type: string;
  session_id?: string;
  [key: string]: unknown;
}

export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private _ready = false;
  private sessionId: string | null = null;
  // True between sending a user message and receiving that turn's result event.
  private turnActive = false;
  // True if an interrupt was requested for the current/just-finished turn.
  private interruptRequested = false;

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Whether Claude is currently working on a turn. */
  get isBusy(): boolean {
    return this.turnActive;
  }

  /** Whether the current/last turn was interrupted via interrupt(). */
  get wasInterrupted(): boolean {
    return this.interruptRequested;
  }

  spawn(resumeSessionId?: string): void {
    if (this.proc) this.kill();

    const repoRoot = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      ".."
    );

    // Read settings template and resolve the hook path dynamically
    const settings = JSON.parse(
      readFileSync(path.join(repoRoot, "claude-settings.json"), "utf-8")
    );
    for (const hook of settings.hooks?.PreToolUse?.[0]?.hooks ?? []) {
      if (hook.type === "command" && hook.command?.includes("permission-hook.sh")) {
        hook.command = path.join(repoRoot, "src/permission-hook.sh");
      }
    }

    // With --input-format stream-json, claude -p reads messages from stdin.
    // No prompt argument needed.
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      process.env.BRIDGE_MODEL || "claude-opus-5",
      "--settings",
      JSON.stringify(settings),
    ];
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }

    this.proc = spawn("claude", args, {
        cwd: process.env.HOME,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([k]) => !k.startsWith("CLAUDE") || k === "CLAUDE_API_KEY"
            )
          ),
          TELEGRAM_BRIDGE: "1",
        },
      }
    );

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error("[claude stderr]", text);
    });

    this.proc.on("close", (code) => {
      console.log(`[claude] process exited with code ${code}`);
      this.proc = null;
      this._ready = false;
      this.sessionId = null;
      this.turnActive = false;
      this.emit("exit", code);
    });

    this.proc.on("error", (err) => {
      console.error("[claude] process error:", err);
      this.proc = null;
      this._ready = false;
      this.sessionId = null;
      this.turnActive = false;
      this.emit("error", err);
    });

    this._ready = true;
    console.log("[claude] process spawned");
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as ClaudeEvent;
        // Capture session_id from init event
        if (event.type === "system" && event.subtype === "init" && event.session_id) {
          this.sessionId = event.session_id as string;
          console.log("[claude] session_id:", this.sessionId);
        }
        if (event.type === "result") this.turnActive = false;
        console.log("[claude] event:", event.type, JSON.stringify(event).slice(0, 200));
        this.emit("event", event);
      } catch {
        console.error("[claude] non-JSON line:", trimmed.slice(0, 200));
      }
    }
  }

  sendMessage(text: string, images?: Array<{ base64: string; mediaType: string }>): void {
    if (!this.proc || !this.proc.stdin || this.proc.killed) {
      throw new Error("Claude process is not running");
    }

    const sid = this.sessionId || randomUUID();

    let content: string | Array<Record<string, unknown>>;
    if (images && images.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      for (const img of images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.base64 },
        });
      }
      if (text) {
        blocks.push({ type: "text", text });
      }
      content = blocks;
    } else {
      content = text;
    }

    const msg = JSON.stringify({
      type: "user",
      session_id: sid,
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    this.proc.stdin.write(msg + "\n");
    this.turnActive = true;
    this.interruptRequested = false;
    console.log("[claude] sent user message", images ? `(with ${images.length} image(s))` : "");
  }

  /**
   * Ask Claude to abort the in-flight turn, leaving the process (and session)
   * alive. Sends the stream-json `interrupt` control request, which ends the
   * turn with a `result` event of subtype `error_during_execution`.
   * Returns false if there is nothing to interrupt.
   */
  interrupt(): boolean {
    if (!this.proc || !this.proc.stdin || this.proc.killed || !this.turnActive) {
      return false;
    }
    const msg = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.proc.stdin.write(msg + "\n");
    this.interruptRequested = true;
    console.log("[claude] sent interrupt control request");
    return true;
  }

  kill(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      this.proc = null;
      this._ready = false;
      this.sessionId = null;
      this.turnActive = false;
      this.interruptRequested = false;
      console.log("[claude] process killed");
    }
  }
}
