// The live view server: one page, one event stream, no dependency. Read only.

import http from "node:http";
import { randomBytes } from "node:crypto";
import type { ScreenBuffer } from "./screen.js";
import { MAX_STEPS, frameOf, renderFrame, viewerPage, type Frame } from "./render.js";
import type { StackEntry } from "./stack.js";

export class Viewer {
  private readonly token = randomBytes(16).toString("hex"); // per session
  private server?: http.Server;
  private clients = new Set<http.ServerResponse>();
  private lastFrame?: string;
  private steps: string[] = [];
  private stackFrames = new Map<string, Frame>();
  private lastStack?: string;
  private actualPort?: number;

  constructor(private title: string) {}

  // A port clash falls back to an ephemeral one rather than failing the session.
  start(preferredPort: number): Promise<string | undefined> {
    const server = http.createServer((req, res) => this.route(req, res));
    this.server = server;

    const bind = (port: number, retry: boolean): Promise<string | undefined> =>
      new Promise((resolve) => {
        const onError = () => {
          server.removeAllListeners("listening");
          resolve(retry ? bind(0, false) : undefined);
        };
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", onError);
          this.actualPort = (server.address() as { port: number }).port;
          resolve(this.url());
        });
      });

    return bind(preferredPort, true);
  }

  url(): string | undefined {
    return this.actualPort ? `http://127.0.0.1:${this.actualPort}/?t=${this.token}` : undefined;
  }

  // DNS rebinding defence. Any site can point a hostname it controls at 127.0.0.1, which makes this
  // server same origin to the browser, so binding to loopback is not enough on its own.
  private allowedHost(req: http.IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    const name = host.replace(/:\d+$/, "");
    return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
  }

  // Gates every route, the page included, so the token cannot be read back out of it.
  private allowedToken(req: http.IncomingMessage): boolean {
    return new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("t") === this.token;
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.allowedHost(req) || !this.allowedToken(req)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("refused: open the live view with the URL session_open printed, it carries a per session token\n");
      return;
    }
    if ((req.url ?? "/").split("?")[0] === "/events") {
      this.stream(res);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The page is inline and renders host text into the DOM, so nothing may be fetched or framed.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(viewerPage(this.title));
  }

  private stream(res: http.ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-content-type-options": "nosniff",
    });
    // Without this Node holds the headers back until the first body write, so a page that connects
    // before any screen has painted hangs.
    res.flushHeaders();
    this.clients.add(res);
    // So a page opened mid session has the history and the current screen rather than a blank grid.
    for (const s of this.steps) res.write(`event: step\ndata: ${s}\n\n`);
    if (this.lastStack) res.write(`event: stack\ndata: ${this.lastStack}\n\n`);
    if (this.lastFrame) res.write(`data: ${this.lastFrame}\n\n`);
    res.on("close", () => this.clients.delete(res));
  }

  // The top entry takes the screen as it settled. The ones below keep the screen they had on top.
  stackMoved(screen: ScreenBuffer, entries: readonly StackEntry[], window?: string) {
    const top = entries[entries.length - 1];
    if (top) this.stackFrames.set(top.key, frameOf(screen));
    for (const key of this.stackFrames.keys()) {
      if (!entries.some((e) => e.key === key)) this.stackFrames.delete(key);
    }
    this.lastStack = JSON.stringify({
      window,
      entries: entries.map((e) => ({ title: e.title, ...this.stackFrames.get(e.key) })),
    });
    for (const c of this.clients) c.write(`event: stack\ndata: ${this.lastStack}\n\n`);
  }

  update(screen: ScreenBuffer) {
    this.lastFrame = renderFrame(screen);
    for (const c of this.clients) c.write(`data: ${this.lastFrame}\n\n`);
  }

  step(screen: ScreenBuffer, label: string, wire: string[] = [], stack: string[] = []) {
    const frame = renderFrame(screen, { label, at: Date.now(), wire, stack });
    if (this.steps.push(frame) > MAX_STEPS) this.steps.shift();
    for (const c of this.clients) c.write(`event: step\ndata: ${frame}\n\n`);
  }

  stop() {
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.server?.close();
    this.server = undefined;
  }
}
