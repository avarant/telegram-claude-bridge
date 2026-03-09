import http from "http";
import fs from "fs";
import os from "os";
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
  resolve: (decision: { allow: boolean; updatedInput?: Record<string, unknown>; systemMessage?: string }) => void;
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

export type SendMessageHandler = (
  chatId: number,
  text: string,
  keyboard: unknown
) => Promise<number>;

export type EditMessageHandler = (
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: unknown
) => Promise<void>;

// --- AskUserQuestion types ---

interface AskOption {
  label: string;
  description?: string;
}

interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect: boolean;
}

interface AskSession {
  requestId: string;
  shortId: number;
  chatId: number;
  messageId: number;
  questions: AskQuestion[];
  currentIndex: number;
  answers: Record<string, string>;
  selectedOptions: Set<string>;
  waitingForFreeText: boolean;
}

export class PermissionHandler {
  private server: http.Server;
  private pending = new Map<string, PendingPermission>();
  private sendPrompt: SendPermissionPrompt;
  private sendImage: SendImageHandler | null = null;
  private sendVoice: SendVoiceHandler | null = null;
  private sendMsg: SendMessageHandler | null = null;
  private editMsg: EditMessageHandler | null = null;
  private port: number;
  private timeoutMs = 120_000;
  private sessionRules = new Set<string>();
  private settingsPath: string;

  // AskUserQuestion state
  private askSessions = new Map<number, AskSession>(); // shortId -> session
  private askByChat = new Map<number, AskSession>();   // chatId -> active session
  private askShortIdCounter = 0;

  constructor(port: number, sendPrompt: SendPermissionPrompt) {
    this.port = port;
    this.sendPrompt = sendPrompt;
    this.settingsPath = path.join(os.homedir(), ".claude", "settings.local.json"
    );
    this.loadAlwaysAllowRules();

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

  setSendMessageHandler(handler: SendMessageHandler): void {
    this.sendMsg = handler;
  }

  setEditMessageHandler(handler: EditMessageHandler): void {
    this.editMsg = handler;
  }

  // Tools that should always prompt the user regardless of rules
  // (e.g. ExitPlanMode requires reviewing the plan each time)
  private static ALWAYS_PROMPT = new Set(["ExitPlanMode"]);

  private loadAlwaysAllowRules(): void {
    try {
      const raw = fs.readFileSync(this.settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      const allow = settings?.permissions?.allow;
      if (Array.isArray(allow)) {
        for (const rule of allow) {
          this.sessionRules.add(rule);
        }
        console.log("[permission] loaded always-allow rules:", [...this.sessionRules]);
      }
    } catch {
      // File doesn't exist yet — no rules to load
    }
  }

  private isAutoAllowed(toolName: string): boolean {
    if (PermissionHandler.ALWAYS_PROMPT.has(toolName)) return false;
    return this.sessionRules.has(toolName);
  }

  private addAlwaysAllow(toolName: string): void {
    try {
      let settings: Record<string, unknown> = {};
      try {
        const raw = fs.readFileSync(this.settingsPath, "utf-8");
        settings = JSON.parse(raw);
      } catch {
        // File doesn't exist yet — start fresh
      }
      if (!settings.permissions) settings.permissions = {};
      const perms = settings.permissions as Record<string, unknown>;
      if (!Array.isArray(perms.allow)) perms.allow = [];
      if (!(perms.allow as string[]).includes(toolName)) {
        (perms.allow as string[]).push(toolName);
        fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
        fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2) + "\n");
        console.log("[permission] added always-allow rule for:", toolName);
      }
    } catch (err) {
      console.error("[permission] failed to update settings:", err);
    }
  }

  clearSessionRules(): void {
    this.sessionRules.clear();
    this.loadAlwaysAllowRules();
    console.log("[permission] session rules cleared (always-allow rules reloaded)");
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

        const decisionPromise = new Promise<{ allow: boolean; updatedInput?: Record<string, unknown>; systemMessage?: string }>(
          (resolve) => {
            const timer = setTimeout(() => {
              this.pending.delete(id);
              resolve({ allow: false });
            }, this.timeoutMs);

            this.pending.set(id, { request, resolve, timer });
          }
        );

        // For AskUserQuestion, show interactive question UI instead of permission prompt
        if (toolName === "AskUserQuestion") {
          await this.handleAskUserQuestion(id, request, toolInput);
        } else {
          // Send normal permission prompt to Telegram
          await this.sendPrompt(request);
        }

        // Wait for user decision
        const decision = await decisionPromise;

        const hookOutput = decision.allow
          ? {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow" as const,
                permissionDecisionReason: "Approved by user via Telegram",
                ...(decision.updatedInput && { updatedInput: decision.updatedInput }),
              },
              ...(decision.systemMessage && { systemMessage: decision.systemMessage }),
            }
          : {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny" as const,
                permissionDecisionReason: decision.systemMessage || "Denied by user via Telegram",
              },
              ...(decision.systemMessage && { systemMessage: decision.systemMessage }),
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

  // --- AskUserQuestion handling ---

  private async handleAskUserQuestion(
    requestId: string,
    _request: PermissionRequest,
    toolInput: unknown,
  ): Promise<void> {
    const input = toolInput as { questions?: AskQuestion[] };
    const questions = input.questions;

    if (!questions || questions.length === 0) {
      // Fall back to normal permission prompt
      await this.sendPrompt(_request);
      return;
    }

    if (!this.sendMsg) {
      console.error("[ask] no sendMessage handler registered");
      await this.sendPrompt(_request);
      return;
    }

    const chatId = (await this.getActiveChatId());
    if (!chatId) {
      console.error("[ask] no active chat ID");
      await this.sendPrompt(_request);
      return;
    }

    const shortId = ++this.askShortIdCounter;
    const session: AskSession = {
      requestId,
      shortId,
      chatId,
      messageId: 0,
      questions,
      currentIndex: 0,
      answers: {},
      selectedOptions: new Set(),
      waitingForFreeText: false,
    };

    this.askSessions.set(shortId, session);
    this.askByChat.set(chatId, session);

    await this.sendCurrentQuestion(session);
  }

  private activeChatIdRef: number | null = null;

  setActiveChatId(chatId: number | null): void {
    this.activeChatIdRef = chatId;
  }

  private async getActiveChatId(): Promise<number | null> {
    return this.activeChatIdRef;
  }

  private formatQuestion(q: AskQuestion): string {
    let text = "";
    if (q.header) text += `${q.header}\n\n`;
    text += q.question;
    if (q.multiSelect) text += "\n\n(Select multiple, then tap Done)";
    return text;
  }

  private buildKeyboard(session: AskSession): Array<Array<{ text: string; callback_data: string }>> {
    const q = session.questions[session.currentIndex];
    const sid = session.shortId;
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];

    if (q.multiSelect) {
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const selected = session.selectedOptions.has(opt.label);
        const label = selected ? `\u2713 ${opt.label}` : opt.label;
        rows.push([{ text: label, callback_data: `ask:t:${sid}:${i}` }]);
      }
      rows.push([
        { text: "Other...", callback_data: `ask:o:${sid}` },
        { text: "Done", callback_data: `ask:d:${sid}` },
      ]);
    } else {
      for (let i = 0; i < q.options.length; i++) {
        rows.push([{ text: q.options[i].label, callback_data: `ask:s:${sid}:${i}` }]);
      }
      rows.push([{ text: "Other...", callback_data: `ask:o:${sid}` }]);
    }

    return rows;
  }

  private async sendCurrentQuestion(session: AskSession): Promise<void> {
    const q = session.questions[session.currentIndex];
    const text = this.formatQuestion(q);
    const keyboard = this.buildKeyboard(session);

    if (this.sendMsg) {
      const msgId = await this.sendMsg(session.chatId, text, { inline_keyboard: keyboard });
      session.messageId = msgId;
    }
  }

  async handleAskCallback(data: string): Promise<{ answered: boolean; text?: string }> {
    const parts = data.split(":");
    // ask:<type>:<shortId>[:<optIndex>]
    const type = parts[1];
    const shortId = parseInt(parts[2], 10);
    const session = this.askSessions.get(shortId);

    if (!session) {
      return { answered: false, text: "Question expired" };
    }

    const q = session.questions[session.currentIndex];

    if (type === "s") {
      // Single select
      const optIdx = parseInt(parts[3], 10);
      const label = q.options[optIdx]?.label || "Unknown";
      session.answers[q.question] = label;
      return this.advanceOrFinish(session, `Selected: ${label}`);
    }

    if (type === "t") {
      // Toggle multiSelect
      const optIdx = parseInt(parts[3], 10);
      const label = q.options[optIdx]?.label || "Unknown";
      if (session.selectedOptions.has(label)) {
        session.selectedOptions.delete(label);
      } else {
        session.selectedOptions.add(label);
      }
      // Re-render keyboard with updated toggles
      const keyboard = this.buildKeyboard(session);
      const text = this.formatQuestion(q);
      if (this.editMsg) {
        await this.editMsg(session.chatId, session.messageId, text, { inline_keyboard: keyboard });
      }
      return { answered: false, text: label };
    }

    if (type === "d") {
      // Done (multiSelect)
      const selected = Array.from(session.selectedOptions);
      session.answers[q.question] = selected.join(", ");
      session.selectedOptions.clear();
      return this.advanceOrFinish(session, `Selected: ${selected.join(", ")}`);
    }

    if (type === "o") {
      // Other - wait for free text
      session.waitingForFreeText = true;
      if (this.editMsg) {
        await this.editMsg(session.chatId, session.messageId, `${this.formatQuestion(q)}\n\nType your answer:`);
      }
      return { answered: false, text: "Type your answer" };
    }

    return { answered: false };
  }

  async handlePossibleFreeText(chatId: number, text: string): Promise<boolean> {
    const session = this.askByChat.get(chatId);
    if (!session || !session.waitingForFreeText) return false;

    session.waitingForFreeText = false;
    const q = session.questions[session.currentIndex];

    if (q.multiSelect) {
      // Add free text to selections, re-show keyboard
      session.selectedOptions.add(text);
      const keyboard = this.buildKeyboard(session);
      const questionText = this.formatQuestion(q);
      if (this.editMsg) {
        await this.editMsg(session.chatId, session.messageId, questionText, { inline_keyboard: keyboard });
      }
    } else {
      session.answers[q.question] = text;
      await this.advanceOrFinish(session, `Answered: ${text}`);
    }

    return true;
  }

  private async advanceOrFinish(
    session: AskSession,
    confirmText: string,
  ): Promise<{ answered: boolean; text: string }> {
    session.currentIndex++;

    // Edit the answered question message to show confirmation
    if (this.editMsg) {
      const prevQ = session.questions[session.currentIndex - 1];
      const headerLine = prevQ.header ? `${prevQ.header}\n\n` : "";
      await this.editMsg(
        session.chatId,
        session.messageId,
        `${headerLine}${prevQ.question}\n\n${confirmText}`
      );
    }

    if (session.currentIndex < session.questions.length) {
      // More questions - send next
      session.selectedOptions.clear();
      await this.sendCurrentQuestion(session);
      return { answered: false, text: confirmText };
    }

    // All done — deny the tool (AskUserQuestion UI doesn't work in headless mode)
    // but pass the answers via systemMessage so Claude receives them.
    const pending = this.pending.get(session.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(session.requestId);

      const answersFormatted = Object.entries(session.answers)
        .map(([q, a]) => `"${q}" = "${a}"`)
        .join("\n");

      pending.resolve({
        allow: false,
        systemMessage: `The user answered your questions via Telegram (AskUserQuestion is not supported in headless mode, but the answers were collected successfully):\n${answersFormatted}\n\nProceed using these answers.`,
      });
    }

    // Clean up
    this.askSessions.delete(session.shortId);
    this.askByChat.delete(session.chatId);

    return { answered: true, text: confirmText };
  }

  // --- Image/Voice handling (unchanged) ---

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
    this.askSessions.clear();
    this.askByChat.clear();
  }
}
