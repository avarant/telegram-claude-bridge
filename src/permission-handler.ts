import http from "http";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

export interface PermissionRequest {
  id: string;
  toolName: string;
  toolInput: unknown;
  rawBody: string;
}

export type PermissionDecision = "allow" | "allowSession" | "alwaysAllow" | "deny";

interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: { allow: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
}

type SendPermissionPrompt = (
  request: PermissionRequest
) => Promise<void>;

export type SendImageHandler = (
  imagePath: string,
  caption?: string
) => Promise<void>;

export type SendVoiceHandler = (
  voicePath: string
) => Promise<void>;

export class PermissionHandler {
  private server: http.Server;
  private pending = new Map<string, PendingPermission>();
  private sendPrompt: SendPermissionPrompt;
  private sendImage: SendImageHandler | null = null;
  private sendVoice: SendVoiceHandler | null = null;
  private port: number;
  private timeoutMs = 120_000;
  private sessionRules = new Set<string>();
  private settingsPath: string;

  constructor(port: number, sendPrompt: SendPermissionPrompt) {
    this.port = port;
    this.sendPrompt = sendPrompt;
    this.settingsPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../claude-settings.json"
    );

    this.server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/permission") {
        this.handlePermissionRequest(req, res);
      } else if (req.method === "POST" && req.url === "/send-image") {
        this.handleSendImage(req, res);
      } else if (req.method === "POST" && req.url === "/send-voice") {
        this.handleSendVoice(req, res);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
  }

  setSendImageHandler(handler: SendImageHandler): void {
    this.sendImage = handler;
  }

  setSendVoiceHandler(handler: SendVoiceHandler): void {
    this.sendVoice = handler;
  }

  // Tools that should always prompt the user regardless of rules
  // (e.g. ExitPlanMode requires reviewing the plan each time)
  private static ALWAYS_PROMPT = new Set(["ExitPlanMode"]);

  private isAutoAllowed(toolName: string): boolean {
    if (PermissionHandler.ALWAYS_PROMPT.has(toolName)) return false;
    return this.sessionRules.has(toolName);
  }

  private addAlwaysAllow(toolName: string): void {
    try {
      const raw = fs.readFileSync(this.settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      if (!settings.permissions) settings.permissions = {};
      if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
      const rule = toolName;
      if (!settings.permissions.allow.includes(rule)) {
        settings.permissions.allow.push(rule);
        fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2) + "\n");
        console.log("[permission] added always-allow rule for:", toolName);
      }
    } catch (err) {
      console.error("[permission] failed to update settings:", err);
    }
  }

  clearSessionRules(): void {
    this.sessionRules.clear();
    console.log("[permission] session rules cleared");
  }

  private handlePermissionRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);
        const id = uuidv4();

        // Extract tool info from the hook payload
        const toolName =
          parsed.tool_name ||
          parsed.toolName ||
          parsed.tool?.name ||
          "unknown tool";
        const toolInput =
          parsed.tool_input ||
          parsed.toolInput ||
          parsed.tool?.input ||
          parsed.input ||
          {};

        // Check session auto-allow rules
        if (this.isAutoAllowed(toolName)) {
          console.log("[permission] auto-allowed by session rule:", toolName);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: "Auto-allowed by session rule",
            },
          }));
          return;
        }

        const request: PermissionRequest = {
          id,
          toolName,
          toolInput,
          rawBody: body,
        };
        console.log("[permission] new request id:", id, "tool:", toolName);

        const decisionPromise = new Promise<{ allow: boolean }>(
          (resolve) => {
            const timer = setTimeout(() => {
              this.pending.delete(id);
              resolve({ allow: false });
            }, this.timeoutMs);

            this.pending.set(id, { request, resolve, timer });
          }
        );

        // Send prompt to Telegram
        await this.sendPrompt(request);

        // Wait for user decision
        const decision = await decisionPromise;

        const hookOutput = decision.allow
          ? {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                permissionDecisionReason: "Approved by user via Telegram",
              },
            }
          : {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "Denied by user via Telegram",
              },
            };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(hookOutput));
      } catch (err) {
        console.error("[permission] error handling request:", err);
        res.writeHead(500);
        res.end(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Internal error",
            },
          })
        );
      }
    });
  }

  private handleSendImage(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { path: imagePath, caption } = JSON.parse(body);
        if (!imagePath || !fs.existsSync(imagePath)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "File not found: " + imagePath }));
          return;
        }
        if (!this.sendImage) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No image handler registered" }));
          return;
        }
        await this.sendImage(imagePath, caption);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("[permission] error sending image:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
  }

  private handleSendVoice(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { path: voicePath } = JSON.parse(body);
        if (!voicePath || !fs.existsSync(voicePath)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "File not found: " + voicePath }));
          return;
        }
        if (!this.sendVoice) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No voice handler registered" }));
          return;
        }
        await this.sendVoice(voicePath);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("[permission] error sending voice:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
  }

  resolvePermission(id: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(id);

    const toolName = pending.request.toolName;

    if (decision === "allowSession") {
      this.sessionRules.add(toolName);
      console.log("[permission] added session rule for:", toolName);
      pending.resolve({ allow: true });
    } else if (decision === "alwaysAllow") {
      this.sessionRules.add(toolName);
      this.addAlwaysAllow(toolName);
      pending.resolve({ allow: true });
    } else {
      pending.resolve({ allow: decision === "allow" });
    }

    return true;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, "127.0.0.1", () => {
        console.log(
          `[permission] IPC server listening on 127.0.0.1:${this.port}`
        );
        resolve();
      });
    });
  }

  stop(): void {
    this.server.close();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ allow: false });
    }
    this.pending.clear();
  }
}
