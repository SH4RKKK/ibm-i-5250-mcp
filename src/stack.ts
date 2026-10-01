// The screens that led to this one. The 5250 stream names no program and no record format, and it
// sends constants and data alike as plain characters, so the text cannot say which screen this is.
// Moves are read from what the host did in answer to a key: Save Screen before it paints over a
// screen, Restore Screen to bring one back, Clear Unit for a screen of its own. Where those do not
// decide, screens are compared by record format (structuralSignature), never by text, which only
// labels them.

import type { ScreenBuffer } from "./screen.js";
import { structuralSignature } from "./snapshot.js";

export type Move = "new" | "window" | "update" | "replace" | "back";

// What the host did in answer to one key, across every record until the screen settled.
export interface Exchange {
  key: string;
  saved: boolean;
  restored: boolean;
  cleared: boolean;
}

export interface StackEntry {
  id: number;      // stable while the entry lives, so the live view keeps its picture
  format: string;  // structuralSignature, "" for a screen with no input fields
  title: string;
  window: boolean; // painted over the entry below without a clear
  saved: boolean;  // the host saved this screen before painting over it, so a restore lands here
  windowTitle?: string; // the window on this screen, a label only
}

const ROLL_KEYS = new Set(["PageUp", "PageDown"]);
// IBM's convention rather than anything on the wire: F3 exits and F12 cancels, so neither goes deeper.
const RETURN_KEYS = new Set(["F3", "F12"]);

// Typed text is blanked, or a value typed on row 2 would show up in the title.
function row(screen: ScreenBuffer, r: number): string {
  let line = screen.line(r);
  for (const f of screen.inputFields()) {
    if (f.row !== r) continue;
    const end = Math.min(line.length, f.col - 1 + f.length);
    line = line.slice(0, f.col - 1).padEnd(end) + line.slice(end);
  }
  return line;
}

export function screenTitle(screen: ScreenBuffer): string {
  const top = [row(screen, 1), row(screen, 2)];
  if (!top.some((l) => l.trim())) {
    top.length = 0;
    for (let r = 3; r <= screen.rows && top.length < 2; r++) if (row(screen, r).trim()) top.push(row(screen, r));
  }
  const title = top
    .flatMap((l) => l.split(/\s{2,}/))
    .map((p) => p.trim())
    .filter((p) => p && !/^[\d\s:./-]+$/.test(p))
    .join(" ");
  return title.length > 60 ? `${title.slice(0, 59)}…` : title;
}

// ponytail: a label only, never a move. The default border, a solid run of dots with a colon under
// both ends, which IBM help and DDS windows use. A border made of attributes or WDWBORDER characters
// goes unnamed. A dotted leader such as "File . . . ." has spaces in it, so it never qualifies.
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

// ponytail: screens built from one template, such as a set of menus, are told apart by order alone,
// so an F3 that skips a level among them lands on the nearest one. A same layer change with no
// detour, such as a sort toggled on the list itself, reads as one menu leading to the next.
export class ScreenStack {
  private entries: StackEntry[] = [];
  private nextId = 1;

  get screens(): readonly StackEntry[] {
    return this.entries;
  }

  get windowOnTop(): string | undefined {
    return this.entries.at(-1)?.windowTitle;
  }

  reset(screen: ScreenBuffer) {
    this.entries = [];
    this.push(false);
    this.describeTop(screen);
  }

  // The first rule that applies decides. Whatever it decided, the top entry then describes the screen
  // that is on top, which is how a return replaces the caller's old data with its new.
  observe(screen: ScreenBuffer, ex: Exchange): Move {
    const move = this.decide(structuralSignature(screen) ?? "", ex);
    this.describeTop(screen);
    return move;
  }

  private decide(format: string, ex: Exchange): Move {
    const top = this.entries.at(-1);
    if (!top) {
      this.push(false);
      return "new";
    }
    if (ex.restored) {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        if (this.entries[i].saved) {
          this.backTo(i);
          break;
        }
      }
      if (!ex.saved) return "back";
    }
    if (ex.saved) {
      this.entries[this.entries.length - 1].saved = true;
      this.push(!ex.cleared);
      return ex.cleared ? "new" : "window";
    }
    if (!ex.cleared) return "update";
    if (ROLL_KEYS.has(ex.key)) {
      top.window = false;
      return "update";
    }
    const below = this.nearestBelow(format);
    if (RETURN_KEYS.has(ex.key)) {
      if (below >= 0) {
        this.backTo(below);
        return "back";
      }
      top.window = false;
      return "replace";
    }
    if (format === top.format) {
      if (ex.key === "Enter") {
        this.push(false);
        return "new";
      }
      top.window = false;
      return "update";
    }
    // The caller coming back. A screen with no input fields has nothing to match on.
    if (format && below >= 0) {
      this.backTo(below);
      return "back";
    }
    this.push(false);
    return "new";
  }

  private push(window: boolean) {
    this.entries.push({ id: this.nextId++, format: "", title: "", window, saved: false });
  }

  // The screen returned to is on top again, so whatever it was saved for is over.
  private backTo(i: number) {
    this.entries.length = i + 1;
    this.entries[i].saved = false;
  }

  private nearestBelow(format: string): number {
    for (let i = this.entries.length - 2; i >= 0; i--) if (this.entries[i].format === format) return i;
    return -1;
  }

  private describeTop(screen: ScreenBuffer) {
    const top = this.entries[this.entries.length - 1];
    top.format = structuralSignature(screen) ?? "";
    // The border names a window whatever brought it, so IBM help, which repaints rather than saves, is
    // named for the window and not for the menu redrawn under it.
    top.windowTitle = windowTitle(screen) ?? (top.window ? "untitled" : undefined);
    top.title = top.windowTitle ?? screenTitle(screen);
  }

  // The screens behind this one, nearest first, numbered by how far back they are. This one is left
  // out: whoever reads the stack is already looking at it.
  lines(): string[] {
    return this.entries.slice(0, -1).reverse().map((e, i) => `${i + 1}. ${e.title}`);
  }
}
