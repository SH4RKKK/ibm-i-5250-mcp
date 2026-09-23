// Run the screen regression tests against a real IBM i, without an agent. Exits non zero on failure.
//
//   node scripts/test.mjs                              screen-tests/ on the default box
//   node scripts/test.mjs screen-tests MYBOX           a folder, or a single .md file
//   node scripts/test.mjs screen-tests MYBOX ordentr   only tests matching
//
// Needs npm run build, and IBMI_MCP_CONFIG_DIR pointing at the profile if it is not in the cwd.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [path, server, filter] = process.argv.slice(2);

const client = new Client({ name: "screen-tests", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: process["env"],
    stderr: "pipe",
  }),
);

let failed = true;
try {
  const res = await client.callTool({
    name: "run_tests",
    arguments: { path, server, filter },
  });
  const text = res.content.map((c) => c.text ?? "").join("\n");
  console.log(text);
  // Anchored on the success line, so rewording a failure message cannot turn a red build green.
  failed = !!res.isError || !/^all \d+ test\(s\) passed$/m.test(text);
} catch (e) {
  console.error(`could not run the suite: ${e?.message ?? e}`);
} finally {
  await client.close();
}

process.exit(failed ? 1 : 0);
