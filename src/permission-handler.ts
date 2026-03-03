import http from "http";
import { v4 as uuidv4 } from "uuid";

export interface PermissionRequest {
  id: string;
  toolName: string;
  toolInput: unknown;
  rawBody: string;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: { allow: boolean }) => void;
  timer: ReturnType<typeof setTimeout>;
}

type SendPermissionPrompt = (
  request: PermissionRequest
) => Promise<void>;

export class PermissionHandler {
  private server: http.Server;
  private pending = new Map<string, PendingPermission>();
  private sendPrompt: SendPermissionPrompt;
  private port: number;
  private timeoutMs = 120_000;

  constructor(port: number, sendPrompt: SendPermissionPrompt) {
    this.port = port;
    this.sendPrompt = sendPrompt;

    this.server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/permission") {
        this.handlePermissionRequest(req, res);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
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

  resolvePermission(id: string, allow: boolean): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve({ allow });
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
