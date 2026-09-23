// Per tool call progress. step() becomes an MCP progress notification when the client sent a
// progressToken, and an info log notification when it did not.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { LogLevel, Reporter } from "./types.js";

const STALL_MS = 8000; // silence before the watchdog speaks
const POLL_MS = 2000;  // only decides how late the first stall message is

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

interface ReporterIO {
  sendProgress?: (progress: number, message: string) => void;
  sendLog: (level: LogLevel, message: string) => void;
}

export class ToolReporter implements Reporter {
  private value = 0; // MCP requires these to strictly increase
  private lastSaid: string;
  private startedAt = Date.now();
  private lastActivity = Date.now();
  private timer?: NodeJS.Timeout;
  // Replayed only on failure.
  private trail: { t: number; msg: string }[] = [];

  constructor(private tool: string, private io: ReporterIO) {
    this.lastSaid = tool;
    this.timer = setInterval(() => {
      if (Date.now() - this.lastActivity < STALL_MS) return;
      const secs = Math.round((Date.now() - this.startedAt) / 1000);
      this.emit(`still working: ${this.lastSaid} (${secs}s elapsed)`);
    }, POLL_MS);
    this.timer.unref?.();
  }

  step(message: string): void {
    this.trail.push({ t: Date.now(), msg: message });
    this.emit(message);
  }

  log(level: LogLevel, message: string): void {
    this.trail.push({ t: Date.now(), msg: level === "info" ? message : `${level}: ${message}` });
    this.lastActivity = Date.now();
    this.io.sendLog(level, message);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  footer(): string {
    return `[${this.tool}: ${((Date.now() - this.startedAt) / 1000).toFixed(1)}s]`;
  }

  failResult(e: unknown): { isError: true; content: { type: "text"; text: string }[] } {
    const msg = e instanceof Error ? e.message : String(e);
    // Before the log call, or the error lands in its own trail and is said twice.
    const trail = this.trail.map((s) => `  ${((s.t - this.startedAt) / 1000).toFixed(1).padStart(5)}s  ${s.msg}`);
    this.log("error", `${this.tool} failed: ${msg}`);
    return {
      isError: true,
      content: [
        { type: "text", text: `${this.tool} failed: ${msg}\n\n${this.footer()}${trail.length ? `\n${trail.join("\n")}` : ""}` },
      ],
    };
  }

  private emit(message: string): void {
    this.lastSaid = message;
    this.lastActivity = Date.now();
    this.value += 1;
    if (this.io.sendProgress) this.io.sendProgress(this.value, message);
    else this.io.sendLog("info", message);
  }
}

export function makeReporter(mcp: McpServer, extra: ToolExtra, tool: string): ToolReporter {
  const token = extra._meta?.progressToken;
  const io: ReporterIO = {
    sendProgress:
      token === undefined
        ? undefined
        : (progress, message) => {
            console.error(`[ibm-i-5250] ${tool}: ${message}`);
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken: token, progress, message },
              })
              .catch(() => {});
          },
    sendLog: (level, message) => {
      console.error(`[ibm-i-5250] ${tool} ${level}: ${message}`);
      void mcp.server.sendLoggingMessage({ level, logger: tool, data: message }).catch(() => {});
    },
  };
  const reporter = new ToolReporter(tool, io);
  extra.signal.addEventListener("abort", () => reporter.dispose());
  return reporter;
}
