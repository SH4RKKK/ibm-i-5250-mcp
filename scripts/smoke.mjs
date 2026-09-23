// Live smoke test against a real IBM i, through the real MCP tool surface, signing off cleanly.
//
//   node scripts/smoke.mjs MYBOX
//
// Needs npm run build, and IBMI_MCP_CONFIG_DIR pointing at the profile if it is not in the cwd.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const server = process.argv[2] || undefined;
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: process["env"],
    stderr: "pipe",
  }),
);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) failures++;
};

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text ?? "").join("\n");
  return { text, isError: !!res.isError };
};

let opened = false;
try {
  console.log("opening a session");
  const open = await call("session_open", { server });
  check(!open.isError, "session_open succeeded");
  if (open.isError) {
    console.log(open.text);
    throw new Error("cannot continue without a session");
  }
  opened = true;
  check(/keyboard: unlocked/.test(open.text), "the host handed the keyboard back");
  check(/^fields:/m.test(open.text), "the snapshot lists a format table");
  check(!/Attempt to Recover/.test(open.text), "no disconnected job was left behind by a previous run");

  // A missing flushHeaders() is invisible until a client connects before the first paint.
  const url = /Live view: (\S+)/.exec(open.text)?.[1];
  check(!!url, "a live view url was reported");
  if (url) {
    const page = await fetch(url).then((r) => r.text());
    check(page.includes("EventSource"), "the viewer page serves");

    // Keep the query string: new URL("/events", url) drops it and gets a 403 that looks exactly
    // like a stream delivering nothing.
    const events = new URL(url);
    events.pathname = "/events";

    const ac = new AbortController();
    const res = await fetch(events, { signal: ac.signal });
    check(res.status === 200, `the event stream accepted the token (got ${res.status})`);
    const reader = res.body.getReader();
    const chunk = await Promise.race([
      reader.read().then((r) => new TextDecoder().decode(r.value)),
      new Promise((r) => setTimeout(() => r(""), 3000)),
    ]);
    ac.abort();
    check(chunk.startsWith("data: "), "the event stream pushes the current screen");
    check(/"rows":"/.test(chunk), "the pushed payload carries rendered rows");
  }

  // F3 raises a confirmation window and F12 backs out, so this covers batching, settling and windows.
  const keys = await call("screen_do", { actions: ["key: F3", "key: F12"] });
  check(!keys.isError, "screen_do ran F3 then F12 in one call and both screens settled");

  const snap = await call("screen_snapshot");
  // Any geometry: the host picks it per screen.
  check(/^size: \d+x\d+/m.test(snap.text), "screen_snapshot still reports a live screen");
} finally {
  // Or one real failure reports as three.
  if (opened) {
    const close = await call("session_close");
    check(!close.isError, "session_close succeeded");
    check(/Signed off cleanly/.test(close.text), "signed off cleanly, device released");
  }
  await client.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
