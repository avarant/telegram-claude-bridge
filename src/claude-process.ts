import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
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

  get isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  spawn(): void {
    if (this.proc) this.kill();

    const settingsPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../claude-settings.json"
    );

    // With --input-format stream-json, claude -p reads messages from stdin.
    // No prompt argument needed.
    this.proc = spawn(
      "claude",
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--settings",
        settingsPath,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => !k.startsWith("CLAUDE") || k === "CLAUDE_API_KEY"
          )
        ),
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
      this.emit("exit", code);
    });

    this.proc.on("error", (err) => {
      console.error("[claude] process error:", err);
      this.proc = null;
      this._ready = false;
      this.sessionId = null;
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
        console.log("[claude] event:", event.type, JSON.stringify(event).slice(0, 200));
        this.emit("event", event);
      } catch {
        console.error("[claude] non-JSON line:", trimmed.slice(0, 200));
      }
    }
  }

  sendMessage(text: string): void {
    if (!this.proc || !this.proc.stdin || this.proc.killed) {
      throw new Error("Claude process is not running");
    }

    const sid = this.sessionId || randomUUID();
    const msg = JSON.stringify({
      type: "user",
      session_id: sid,
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    this.proc.stdin.write(msg + "\n");
    console.log("[claude] sent user message");
  }

  kill(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      this.proc = null;
      this._ready = false;
      this.sessionId = null;
      console.log("[claude] process killed");
    }
  }
}
