// The screens that led to this one. Nothing on the wire tells a new screen from an update, a window
// or a return: going back arrives exactly like going forward, and an IBM list clears the unit just to
// page. The top two lines are what stayed put through paging and matched on every return, so they
// are what identifies a screen.

import type { ScreenBuffer } from "./screen.js";

export type Move = "new" | "update" | "back" | "window";

const DATE = /\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/g;
const TIME = /\d{1,2}:\d{2}(:\d{2})?/g;
// Whole numbers only, so a program name such as ORD010 survives.
const NUMBER = /\b\d+(?:[.,]\d+)?\b/g;

// Typed text is blanked, or a value typed on row 2 would make the same screen look new.
function row(screen: ScreenBuffer, r: number): string {
  let line = screen.line(r);
  for (const f of screen.inputFields()) {
    if (f.row !== r) continue;
    const end = Math.min(line.length, f.col - 1 + f.length);
    line = line.slice(0, f.col - 1).padEnd(end) + line.slice(end);
  }
  return line;
}

function topRows(screen: ScreenBuffer): string[] {
  const top = [row(screen, 1), row(screen, 2)];
  if (top.some((l) => l.trim())) return top;
  const painted: string[] = [];
  for (let r = 3; r <= screen.rows && painted.length < 2; r++) {
    if (row(screen, r).trim()) painted.push(row(screen, r));
  }
  return painted;
}

export function screenKey(screen: ScreenBuffer): string {
  return topRows(screen)
    .map((l) => l.replace(DATE, "#").replace(TIME, "#").replace(NUMBER, "#").replace(/\s+/g, " ").trim())
    .join("|");
}

export function screenTitle(screen: ScreenBuffer): string {
  const title = topRows(screen)
    .flatMap((l) => l.split(/\s{2,}/))
    .map((p) => p.trim())
    .filter((p) => p && !/^[\d\s:./-]+$/.test(p))
    .join(" ");
  return title.length > 60 ? `${title.slice(0, 59)}…` : title;
}

// ponytail: the default border only, a solid run of dots with a colon under both ends, which IBM help
// and DDS windows use. A border made of attributes or WDWBORDER characters goes undetected. A dotted
// leader such as "File . . . ." has spaces in it, so it never qualifies.
export function windowTitle(screen: ScreenBuffer): string | undefined {
  for (let r = 1; r + 2 <= screen.rows; r++) {
    const m = /\.{10,}/.exec(screen.line(r));
    if (!m) continue;
    const left = m.index;
    const right = m.index + m[0].length - 1;
    const side = (i: number) => {
      const l = screen.line(i);
      return l[left] === ":" && l[right] === ":";
    };
    if (!side(r + 1) || !side(r + 2)) continue;
    for (let i = r + 1; i <= screen.rows && side(i); i++) {
      const inner = screen.line(i).slice(left + 1, right).replace(/[.:]+$/, "").trim();
      if (inner) return inner;
    }
    return "untitled";
  }
  return undefined;
}

// ponytail: going back to a screen already on the stack drops everything above it, so a program that
// calls itself deeper, or two screens that share their top lines, fold into one entry. Add the field
// layout to the key if that shows up.
export interface StackEntry {
  key: string;
  title: string;
}

export class ScreenStack {
  private entries: StackEntry[] = [];
  private window?: string;

  get screens(): readonly StackEntry[] {
    return this.entries;
  }

  get windowOnTop(): string | undefined {
    return this.window;
  }

  reset(screen: ScreenBuffer) {
    this.entries = [{ key: screenKey(screen), title: screenTitle(screen) }];
    this.window = undefined;
  }

  // A window is checked first: its border replaces the top lines of the screen under it.
  observe(screen: ScreenBuffer): Move {
    this.window = windowTitle(screen);
    if (this.window) return "window";
    const key = screenKey(screen);
    const at = this.entries.map((e) => e.key).lastIndexOf(key);
    if (at >= 0 && at === this.entries.length - 1) return "update";
    if (at >= 0) {
      this.entries.length = at + 1;
      return "back";
    }
    this.entries.push({ key, title: screenTitle(screen) });
    return "new";
  }

  // The screens behind this one, nearest first, numbered by how far back they are. This one is left
  // out: whoever reads the stack is already looking at it.
  lines(): string[] {
    return this.entries.slice(0, -1).reverse().map((e, i) => `${i + 1}. ${e.title}`);
  }
}
