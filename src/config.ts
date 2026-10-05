import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv, parse } from "dotenv";
import { DEFAULT_CCSID } from "./ebcdic.js";
import type { Profile } from "./types.js";

// First match wins. IBMI_MCP_CONFIG_DIR and .ibm-i-servers are shared with the other IBM i MCP
// servers, so one set of profiles serves them all. Use a home folder with npx: the install folder
// lives in the npx cache and is wiped on update.
export const CONFIG_DIRS = [
  process.env.IBMI_MCP_CONFIG_DIR,
  join(homedir(), ".ibm-i-servers"),
  join(homedir(), ".ibm-i-5250-mcp"),
  join(dirname(fileURLToPath(import.meta.url)), ".."),
]
  .filter((d): d is string => Boolean(d))
  .map((d) => resolve(d));

// The first file found wins the whole profile. Merging per variable would let a file holding only a
// host inherit another box's password.
const defaultEnv = CONFIG_DIRS.map((d) => join(d, ".env")).find((p) => existsSync(p));
if (defaultEnv) loadEnv({ path: defaultEnv });

// The name arrives as a tool argument and becomes part of a filename, so "../../../sibling" would
// otherwise read another box's credentials.
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function listServers(): string[] {
  const names = new Set<string>();
  for (const d of CONFIG_DIRS) {
    let files: string[] = [];
    try {
      files = readdirSync(d);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f === ".env") names.add("default");
      else if (f.startsWith(".env.") && f !== ".env.example") names.add(f.slice(5));
    }
  }
  return [...names].sort();
}

export function loadProfileFor(server?: string): Profile {
  if (!server || server.toLowerCase() === "default") return loadProfile();
  if (!SERVER_NAME.test(server)) {
    throw new Error(
      `invalid server name "${server}". A server is named by its config file, so the ` +
        `name may only contain letters, digits, dot, dash and underscore.`,
    );
  }
  for (const d of CONFIG_DIRS) {
    const p = join(d, `.env.${server}`);
    if (existsSync(p)) return loadProfile(parse(readFileSync(p)));
  }
  throw new Error(
    `no config for server "${server}" (expected a .env.${server} file). Available: ${listServers().join(", ") || "none"}`,
  );
}

// Unrecognised throws rather than reading as false, so a typo cannot quietly turn a setting off.
const bool = (v: string | undefined, dflt: boolean, name: string) => {
  if (v === undefined || v.trim() === "") return dflt;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name}="${v}" is neither true nor false. Use true or false.`);
};
// Bare verbs, so "MYLIB/STRAPP" would sit in the allowlist never matching anything.
const list = (v: string | undefined) =>
  v ? v.split(/[,\s]+/).map((s) => s.toLowerCase().split("/").pop()!).filter(Boolean) : [];
const num = (v: string | undefined, dflt: number) => {
  const n = Number(v?.trim());
  return v?.trim() && Number.isFinite(n) ? n : dflt;
};

export function loadProfile(env: NodeJS.ProcessEnv | Record<string, string> = process.env): Profile {
  const host = env.IBMI_HOST;
  const user = env.IBMI_USER;
  const password = env.IBMI_PASSWORD;
  if (!host || !user || !password) {
    throw new Error("missing IBMI_HOST, IBMI_USER and/or IBMI_PASSWORD in the env file");
  }

  // Not aliased to IBMI_RESTRICTED: the two mean different things.
  if (env.IBMI_READ_ONLY) {
    console.error(
      `[ibm-i-5250-mcp] warning: IBMI_READ_ONLY is set but does nothing here. Use IBMI_RESTRICTED ` +
        `for allowlist mode, or IBMI_BLOCKED_CL to name the verbs to refuse.`,
    );
  }

  // 992 is telnet over TLS and 23 is plain, so a separate flag could only contradict the port.
  const port = num(env.IBMI_5250_PORT, 23);

  // The host picks geometry per screen, so the larger device runs 24x80 programs too.
  const terminalType = env.IBMI_5250_TERMINAL || "IBM-3477-FC";
  const wide = /3477|-fc$/i.test(terminalType);

  return {
    host,
    user,
    password,
    port,
    tls: port === 992,
    tlsInsecure: bool(env.IBMI_5250_TLS_INSECURE, false, "IBMI_5250_TLS_INSECURE"),
    deviceName: env.IBMI_5250_DEVICE || undefined,
    terminalType,
    ccsid: num(env.IBMI_5250_CCSID, DEFAULT_CCSID),
    rows: wide ? 27 : 24,
    cols: wide ? 132 : 80,
    restricted: bool(env.IBMI_RESTRICTED, true, "IBMI_RESTRICTED"),
    allowedCl: list(env.IBMI_ALLOWED_CL),
    blockedCl: list(env.IBMI_BLOCKED_CL),
    viewerEnabled: bool(env.IBMI_5250_VIEWER, false, "IBMI_5250_VIEWER"),
    viewerPort: num(env.IBMI_5250_VIEWER_PORT, 5250),
    initialLibrary: env.IBMI_5250_CURLIB || undefined,
    initialProgram: env.IBMI_5250_PROGRAM || undefined,
    initialMenu: env.IBMI_5250_MENU || undefined,
  };
}
