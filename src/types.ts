export type { LoggingLevel as LogLevel } from "@modelcontextprotocol/sdk/types.js";
import type { LoggingLevel as LogLevel } from "@modelcontextprotocol/sdk/types.js";

export interface Reporter {
  step(message: string): void;
  log(level: LogLevel, message: string): void;
}

export const NOOP_REPORTER: Reporter = { step: () => {}, log: () => {} };

export interface Profile {
  host: string;
  user: string;
  password: string;
  port: number;
  tls: boolean;
  tlsInsecure: boolean;
  deviceName?: string;
  terminalType: string;
  ccsid: number;
  rows: number;
  cols: number;
  restricted: boolean;           // allowlist mode: only the guard's list plus allowedCl reach a command line
  allowedCl: string[];           // extra verbs permitted in restricted mode
  blockedCl: string[];           // extra verbs refused when restricted mode is off
  viewerEnabled: boolean;
  viewerPort: number;
  initialLibrary?: string;       // typed into the sign on screen when it offers the field
  initialProgram?: string;
  initialMenu?: string;
}
