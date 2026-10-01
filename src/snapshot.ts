// The LLM facing view of a screen: the literal screen, plus a field list with stable refs.

import { createHash } from "node:crypto";
import { isNondisplay } from "./codes.js";
import type { Field, ScreenBuffer } from "./screen.js";

const MSGID = /\b[A-Z]{3}\d{4}\b/;

// Not screen.rows: a 27 row display runs 24 row programs, so the bottom sits at 24 with blanks under.
export function lastPaintedRow(screen: ScreenBuffer): number {
  let last = screen.rows;
  while (last > 1 && screen.line(last).trim() === "") last--;
  return last;
}

// The record format, not the data. A subfile's option column counts once from its first row, so a
// list showing 3 rows signs like one showing 20.
export function structuralSignature(screen: ScreenBuffer): string | undefined {
  const messageRow = screen.messageRow(); // transient, so not part of identity
  const shape = (f: Field, row = f.row) =>
    [row, f.col, f.length, f.shift, f.monocase, f.mandatory, f.autoEnter, isNondisplay(f.attr)].join(",");
  const input = screen.inputFields().filter((f) => f.row !== messageRow);
  const all = new Set(input.map((f) => shape(f)));
  const heads = input.filter((f) => !all.has(shape(f, f.row - 1))).map((f) => shape(f)).sort();
  if (!heads.length) return undefined;
  const canonical = `v2:${screen.keyMask}|${heads.join(";")}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

// The error row is settable through the SOH order and windows move it, so scan rather than assume 24.
export function messageLine(screen: ScreenBuffer): string | undefined {
  const last = lastPaintedRow(screen);
  for (const row of [last, last - 1, last - 2]) {
    if (row < 1) break;
    const t = screen.line(row).trim();
    if (t && MSGID.test(t)) return t;
  }
  return undefined;
}

function ruler(cols: number): string {
  let s = "";
  for (let c = 1; c <= cols; c++) s += c % 10 === 0 ? String((c / 10) % 10) : c % 5 === 0 ? "5" : ".";
  return s;
}

function describe(f: Field, screen: ScreenBuffer): string {
  const pos = `${f.row},${f.col}`.padEnd(7);
  const shown = screen.displayValueOf(f);
  const value = shown === undefined ? "<nondisplay>" : JSON.stringify(shown.replace(/\s+$/, ""));
  const flags = [
    f.mandatory ? "mandatory" : "",
    f.monocase ? "monocase" : "",
    f.autoEnter ? "auto enter" : "",
    f.mdt ? "modified" : "",
    f.shift !== "alpha shift" ? f.shift : "",
  ]
    .filter(Boolean)
    .join(" ");
  const kind = screen.covered(f) ? "under" : f.protectedField ? "out  " : "INPUT";
  return `  [${f.id}] ${pos} len ${String(f.length).padStart(3)}  ${kind}  ${value}${flags ? "  " + flags : ""}`;
}

export function renderSnapshot(screen: ScreenBuffer, stack: string[] = [], window?: string): string {
  // Never a name: nothing on the wire carries one.
  const sig = structuralSignature(screen);
  const out: string[] = [
    `screen: ${sig ? `signature ${sig}` : "no signature (no input fields)"}`,
    `size: ${screen.rows}x${screen.cols}   cursor: ${screen.cursorRow},${screen.cursorCol}   ` +
      `keyboard: ${screen.keyboardLocked ? "LOCKED (host is busy)" : "unlocked"}` +
      (screen.alarm ? "   alarm: sounded" : ""),
  ];
  const msg = messageLine(screen);
  if (msg) out.push(`message: ${msg}`);
  if (window) out.push(`window: ${window}, drawn over the screen behind it`);
  if (stack.length) {
    out.push("stack (the screens behind this one, nearest first):");
    for (const l of stack) out.push(`  ${l}`);
  }
  out.push("");

  const w = String(screen.rows).length;
  out.push(" ".repeat(w + 2) + ruler(screen.cols));
  for (let r = 1; r <= screen.rows; r++) {
    const line = screen.line(r);
    if (line.trim()) out.push(`${String(r).padStart(w)} |${line}|`);
  }
  out.push("");

  const input = screen.inputFields();
  const under = screen.fields.filter((f) => screen.covered(f)).length;
  out.push(
    `fields: ${input.length} input${under ? ` (${under} of them under a window)` : ``}, ` +
      `${screen.fields.length - input.length} output`,
  );
  if (under) {
    out.push(`  ("under" is a field a window is drawn over. It is still in the format table, which is`);
    out.push(`   why it is listed, but the host ignores anything typed into it.)`);
  }
  if (!screen.fields.length) out.push("  (none: this screen has no fields at all, it is display only)");
  for (const f of screen.fields) out.push(describe(f, screen));

  return out.join("\n");
}
