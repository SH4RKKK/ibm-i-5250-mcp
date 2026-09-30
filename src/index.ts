#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { KEY_TO_AID } from "./codes.js";
import { CONFIG_DIRS, listServers, loadProfileFor } from "./config.js";
import { makeReporter, type ToolReporter } from "./report.js";
import { Session } from "./session.js";
import { renderSnapshot } from "./snapshot.js";
import { applyActions, formatSuite, parseAction, parseTest, runSuite } from "./testrun.js";
import { Viewer } from "./viewer.js";

console.log = (...a: unknown[]) => console.error(...a); // stdout is the JSON-RPC channel
process.on("unhandledRejection", (r) => console.error("[ibm-i-5250] unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("[ibm-i-5250] uncaughtException:", e));

const mcp = new McpServer({ name: "ibm-i-5250", version: "0.3.0" }, { capabilities: { logging: {} } });
const sessions = new Map<string, OpenSession>();

const serverArg = z
  .string()
  .optional()
  .describe("which IBM i to use, named by a .env.<name> file. Omit for the default .env server");
const sessionArg = z
  .string()
  .optional()
  .describe('which open session to act on. Omit unless you opened more than one (default: "default")');

interface OpenSession { session: Session; viewer?: Viewer; }

interface OpenOpts {
  server?: string;
  device?: string;
  signOn?: boolean;
  library?: string;
  program?: string;
  menu?: string;
}

const toolResult = (r: ToolReporter, text: string) => ({
  content: [{ type: "text" as const, text: `${text.trimEnd()}\n\n${r.footer()}` }],
});

const snapshotOf = (live: OpenSession) =>
  renderSnapshot(live.session.screen, live.session.stack.lines(), live.session.stack.windowOnTop);

// One spelling, or a catch handler drops an entry the tool never touched.
const keyOf = (name?: string) => name?.toLowerCase() || "default";

function requireSession(name?: string): OpenSession {
  const key = keyOf(name);
  const live = sessions.get(key);
  if (!live) {
    const open = [...sessions.keys()];
    throw new Error(
      `no open session "${key}". ${open.length ? `Open sessions: ${open.join(", ")}` : "Call session_open first."}`,
    );
  }
  if (live.session.isClosed) {
    // The viewer goes with it, or a stale page shows a frozen screen and the port stays taken.
    drop(key);
    throw new Error(`session "${key}" was closed by the host. Call session_open again.`);
  }
  return live;
}

// Shared with run_tests, which cannot depend on someone having opened a session first.
async function openSession(key: string, opts: OpenOpts, r: ToolReporter): Promise<OpenSession> {
  const profile = loadProfileFor(opts.server);
  if (opts.device) profile.deviceName = opts.device;
  if (opts.library) profile.initialLibrary = opts.library;
  if (opts.program) profile.initialProgram = opts.program;
  if (opts.menu) profile.initialMenu = opts.menu;

  const s = new Session(profile);
  const live: OpenSession = { session: s };

  if (profile.viewerEnabled) {
    const v = new Viewer(`${profile.host} ${profile.deviceName || "(auto device)"} [${key}]`);
    const url = await v.start(profile.viewerPort);
    if (url) {
      live.viewer = v;
      s.on("screen", (sc) => v.update(sc));
      s.on("moved", () => v.stackMoved(s.screen, s.stack.screens, s.stack.windowOnTop));
      s.on("step", (label: string, wire: string[] = []) => v.step(s.screen, label, wire, s.stack.lines()));
      r.log("info", `live view at ${url}`);
    } else {
      r.log("warning", "could not start the live view, continuing without it");
    }
  }

  sessions.set(key, live);
  await s.open(r);
  if (opts.signOn !== false) await s.establish(r);
  s.emit("step", opts.signOn === false ? "opened" : "signed on");
  return live;
}

// The viewer holds a socket, so it goes too.
function drop(key: string) {
  const live = sessions.get(key);
  if (!live) return;
  live.session.close();
  live.viewer?.stop();
  sessions.delete(key);
}

// Sign off before dropping, or the host leaves a job pending recovery under QDEVRCYACN.
// session_close does its own sign off, so it calls drop directly.
async function dropSignedOff(key: string, r: ToolReporter) {
  await sessions.get(key)?.session.signOff(r).catch(() => false);
  drop(key);
}

function collectTests(where: string, filter?: string): string[] {
  if (!existsSync(where)) return [];
  const want = filter?.toLowerCase();
  if (!statSync(where).isDirectory()) return !want || where.toLowerCase().includes(want) ? [where] : [];
  return readdirSync(where)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .filter((f) => !want || f.toLowerCase().includes(want))
    .sort()
    .map((f) => join(where, f));
}

mcp.tool(
  "session_open",
  "Open a 5250 session to an IBM i and sign on, then return the first screen. Also starts a live view in the browser so a human can watch what you do. Returns a screen snapshot: the literal 24x80 screen plus a field list with refs you use in screen_do.",
  {
    server: serverArg,
    session: z.string().optional().describe('a name for this session, so you can open more than one (default: "default")'),
    device: z.string().optional().describe("virtual device name to claim, e.g. MCPDEV01. Overrides the profile. A fixed device makes a run reproducible"),
    signOn: z.boolean().optional().describe("sign on using the profile credentials (default: true). Pass false to stop at the sign on screen"),
    library: z.string().optional().describe("current library to set at sign on, typed into the Current library field. Overrides the profile"),
    program: z.string().optional().describe("program to land in at sign on, typed into the Program/procedure field. Overrides the profile"),
    menu: z.string().optional().describe("menu to land on at sign on. Overrides the profile"),
  },
  async ({ server, session, device, signOn, library, program, menu }, extra) => {
    const r = makeReporter(mcp, extra, "session_open");
    const key = keyOf(session);
    let created = false;
    try {
      // Not inside openSession: the catch below must not drop the session this call refused to replace.
      if (sessions.has(key) && !sessions.get(key)!.session.isClosed) {
        throw new Error(`session "${key}" is already open. Use screen_snapshot, or session_close first.`);
      }
      created = true;
      const live = await openSession(key, { server, device, signOn, library, program, menu }, r);
      const profile = live.session.profile;
      const header =
        `Session "${key}" open on ${profile.host} as ${profile.user}` +
        (profile.deviceName ? ` (device ${profile.deviceName})` : "") +
        (live.viewer?.url() ? `\nLive view: ${live.viewer.url()}  <- open this to watch` : "") +
        `\n\n`;
      return toolResult(r, header + snapshotOf(live));
    } catch (e) {
      // establish() can throw after a successful sign on, which leaves a live job.
      if (created) await dropSignedOff(key, r);
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "screen_snapshot",
  "Return the current screen without changing anything: the literal screen text, the field list with refs, the cursor position, the keyboard state, any message line, and the stack of screens that led here, which is usually where F3 and F12 lead back to. Use this to look before acting.",
  { session: sessionArg },
  async ({ session }, extra) => {
    const r = makeReporter(mcp, extra, "screen_snapshot");
    try {
      return toolResult(r, snapshotOf(requireSession(session)));
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "screen_do",
  `Drive the screen: type into fields, move the cursor and press keys, in one call. Actions run in order and only the final screen comes back, so put a whole interaction in one call instead of one action per call.

Each action is a line:
  "type f1: ACME LTD"   put text in a field, by ref from the snapshot, by "row,col", or by DDS name once known
  "key: Enter"          Enter, F1 to F24, PageUp, PageDown, Help, Clear, Print
  "cursor: 6,53"        move the cursor, which is an argument to the key: Help on a message line explains that message, Help anywhere else explains the field under it

Typing sends nothing to the host. A 5250 holds it locally and transmits only on a key, so ["type f1: ACME", "type f2: 100", "key: Enter"] is one exchange with the box, not three. If an action fails the run stops there and the error names it, with the screen as it stands.`,
  {
    actions: z
      .array(z.string())
      .min(1)
      .describe('the actions, in order, e.g. ["type f1: ACME LTD", "key: Enter"]'),
    session: sessionArg,
  },
  async ({ actions, session }, extra) => {
    const r = makeReporter(mcp, extra, "screen_do");
    try {
      const live = requireSession(session);
      const parsed = actions.map((a, i) => parseAction(a, i + 1, "action "));
      const wire = await applyActions(live.session, parsed, r);
      const trace = wire.length
        ? `\n\nwire (what the host sent for each key):\n${wire.map((w) => `  ${w}`).join("\n")}`
        : "";
      return toolResult(r, snapshotOf(live) + trace);
    } catch (e) {
      const live = sessions.get(keyOf(session));
      // The screen is where the run stopped, which is the thing that says why.
      const msg = e instanceof Error ? e.message : String(e);
      return r.failResult(new Error(live && !live.session.isClosed ? `${msg}\n\n${snapshotOf(live)}` : msg));
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "session_close",
  "Sign off and close the session, releasing the virtual device. Always do this when finished: just dropping the connection leaves a disconnected interactive job on the box, so the next run meets an \"Attempt to Recover Interactive Job\" screen instead of the application, and it holds licensed interactive capacity.",
  {
    session: sessionArg,
    signOff: z
      .boolean()
      .optional()
      .describe("type signoff on the command line first, when the screen has one (default: true). Pass false to drop the connection immediately"),
  },
  async ({ session, signOff }, extra) => {
    const r = makeReporter(mcp, extra, "session_close");
    const key = keyOf(session);
    try {
      const live = requireSession(session);
      const clean = signOff === false ? false : await live.session.signOff(r);
      drop(key);
      return toolResult(
        r,
        `Session "${key}" closed.` +
          (clean
            ? " Signed off cleanly, the device is released."
            : " No sign off was possible from this screen, so the host may leave a disconnected job pending recovery."),
      );
    } catch (e) {
      drop(key); // a close that throws must still tear down, or it is stuck open forever
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

mcp.tool(
  "run_tests",
  "Replay screen regression tests against a program and report what passed. A test is a Markdown file with ```5250-do blocks (the same action lines screen_do takes) and ```5250-expect blocks (checks against the screen that came back), so it reads as a specification. Use this after compiling a change to see whether the display behaviour it was supposed to keep still holds, or before making one to write the expected screens first and watch them fail. Opens its own session and closes it, unless you pass `session` to reuse one that is already open.",
  {
    path: z
      .string()
      .optional()
      .describe('a test file, or a directory of *.md tests to run in name order (default: "screen-tests")'),
    filter: z
      .string()
      .optional()
      .describe("only run tests whose file name contains this, ignoring case"),
    server: serverArg,
    session: z
      .string()
      .optional()
      .describe("reuse this already open session instead of opening and closing one. The session is left where the last test finished"),
  },
  async ({ path: where, filter, server, session }, extra) => {
    const r = makeReporter(mcp, extra, "run_tests");
    // Close only a session this tool opened, not one handed to it, or a failed suite leaks a device.
    let ownKey: string | undefined;
    try {
      const dir = where ?? "screen-tests";
      const files = collectTests(dir, filter);
      if (!files.length) {
        throw new Error(
          `no tests found in ${resolve(dir)}${filter ? ` matching "${filter}"` : ""}. ` +
            `A test is a .md file with \`\`\`5250-do and \`\`\`5250-expect blocks. ` +
            `Relative paths resolve against the folder this server was launched from, so pass an absolute one if that is not where the tests live.`,
        );
      }
      r.step(`parsing ${files.length} test file(s)`);
      const tests = files.map((f) => parseTest(readFileSync(f, "utf8"), relative(process.cwd(), f) || f));

      let live: OpenSession;
      if (session) {
        live = requireSession(session);
      } else {
        ownKey = `run_tests_${Date.now().toString(36)}`;
        live = await openSession(ownKey, { server }, r);
      }
      return toolResult(r, formatSuite(await runSuite(live.session, tests, r)));
    } catch (e) {
      return r.failResult(e);
    } finally {
      // Best effort: a suite result is worth returning even if the sign off went wrong.
      if (ownKey) await dropSignedOff(ownKey, r);
      r.dispose();
    }
  },
);

mcp.tool(
  "list_servers",
  "List the configured IBM i servers, named by the .env.<name> files on disk, plus the keys screen_do accepts.",
  {},
  async (_args, extra) => {
    const r = makeReporter(mcp, extra, "list_servers");
    try {
      const servers = listServers();
      const open = [...sessions.entries()].map(([k, v]) => `${k}${v.session.isClosed ? " (closed)" : ""}`);
      const dirs = CONFIG_DIRS
        .map((d, i) => `  ${i + 1}. ${d}${existsSync(d) ? "" : "  (does not exist)"}`)
        .join("\n");
      return toolResult(
        r,
        `Servers: ${servers.join(", ") || "none configured"}\n` +
          `Open sessions: ${open.join(", ") || "none"}\n\n` +
          `Profiles are read from these folders, first match wins:\n${dirs}\n` +
          (servers.length ? "" : `\nNo profiles found. Copy .env.example into one of the folders above.\n`) +
          `\nKeys: ${Object.keys(KEY_TO_AID).join(", ")}`,
      );
    } catch (e) {
      return r.failResult(e);
    } finally {
      r.dispose();
    }
  },
);

async function main() {
  await mcp.connect(new StdioServerTransport());
  console.error("[ibm-i-5250] MCP server ready on stdio");
}

// Sign off, not just disconnect, or each job sits pending recovery under QDEVRCYACN. Bounded, so an
// unresponsive host cannot block process exit.
async function shutdown() {
  const signOffs = [...sessions.values()].map((live) => live.session.signOff().catch(() => false));
  await Promise.race([Promise.all(signOffs), new Promise((done) => setTimeout(done, 5000).unref())]);
  for (const key of [...sessions.keys()]) drop(key);
  process.exit(0);
}
process.on("SIGINT", shutdown).on("SIGTERM", shutdown);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
