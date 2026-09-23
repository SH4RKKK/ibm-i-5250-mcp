// Rendering a screen for humans. The model reads snapshot.ts, not this.

import type { Attr } from "./codes.js";
import type { ScreenBuffer } from "./screen.js";

// No nondisplay entry: spanFor gives that its own class.
const COLOURS: Record<Attr["colour"], string> = {
  green: "#33ff44",
  white: "#e8e8e8",
  red: "#ff4d4d",
  turquoise: "#4de2ff",
  yellow: "#ffdd33",
  pink: "#ff6ed6",
  blue: "#6f8cff",
};

const SCREEN_BG = "#000";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The whole attribute, not just the colour, or a field differing only by underline loses it.
const sameAttr = (a: Attr, b: Attr) =>
  a.nondisplay === b.nondisplay && a.colour === b.colour && a.reverse === b.reverse && a.underline === b.underline;

function spanFor(a: Attr, chunk: string): string {
  if (a.nondisplay) return `<span class="nd">${chunk}</span>`;
  const c = COLOURS[a.colour];
  // Reverse fills the background including trailing blanks, which is what makes DSPATR(RI) a bar.
  const style = a.reverse ? `background:${c};color:${SCREEN_BG}` : `color:${c}`;
  return `<span style="${style}${a.underline ? ";text-decoration:underline" : ""}">${chunk}</span>`;
}

function renderRow(screen: ScreenBuffer, row: number): string {
  const text = screen.line(row);
  let html = "";
  // Slice offsets are zero based, col below is a one based screen column.
  let sliceStart = 0;
  let runAttr = screen.attrAt(row, 1);

  const flush = (sliceEnd: number) => {
    if (sliceEnd > sliceStart) html += spanFor(runAttr, esc(text.slice(sliceStart, sliceEnd)));
  };

  for (let col = 2; col <= screen.cols; col++) {
    const a = screen.attrAt(row, col);
    if (!sameAttr(a, runAttr)) {
      flush(col - 1);
      sliceStart = col - 1;
      runAttr = a;
    }
  }
  flush(screen.cols);
  return html;
}

// Must stay on one line: viewer.ts writes it into `data: ...` and a raw newline would end the frame
// early. JSON.stringify never emits one.
export function renderFrame(screen: ScreenBuffer): string {
  const rows: string[] = [];
  for (let r = 1; r <= screen.rows; r++) {
    const cursor = r === screen.cursorRow;
    rows.push(
      `<div class="row${cursor ? " cur" : ""}">` +
        `<span class="rn">${String(r).padStart(2)}</span>${renderRow(screen, r)}</div>`,
    );
  }
  const oia =
    `<span class="${screen.keyboardLocked ? "locked" : "ok"}">` +
    `${screen.keyboardLocked ? "X SYSTEM" : "ready"}</span>` +
    ` &middot; cursor ${screen.cursorRow},${screen.cursorCol}` +
    ` &middot; ${screen.inputFields().length} input field(s)` +
    (screen.alarm ? ` &middot; <span class="locked">alarm</span>` : "");

  return JSON.stringify({ rows: rows.join(""), oia });
}

// The whole page, inlined. No build step, no dependency, no CDN.
export function viewerPage(title: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0b0f0b; color:#33ff44;
         font:14px/1.35 "Cascadia Mono","Consolas","DejaVu Sans Mono",monospace; }
  header { padding:8px 12px; background:#111a11; border-bottom:1px solid #234023;
           display:flex; gap:14px; align-items:baseline; flex-wrap:wrap; }
  header b { color:#e8e8e8; font-weight:600; }
  header .dim { color:#7fa07f; font-size:12px; }
  main { padding:14px; overflow-x:auto; }
  .screen { display:inline-block; background:${SCREEN_BG}; padding:10px 12px;
            border:1px solid #234023; border-radius:4px; white-space:pre; }
  .row { height:1.35em; }
  .rn { color:#2f5a2f; user-select:none; margin-right:8px; }
  .cur .rn { color:#ffdd33; }
  .nd { color:transparent; }
  .locked { color:#ff4d4d; font-weight:600; }
  .ok { color:#33ff44; }
  #oia { padding:6px 14px; color:#9fc09f; font-size:12px;
         border-top:1px solid #234023; background:#111a11; }
  #conn { color:#ff4d4d; }
</style></head>
<body>
<header>
  <b>${esc(title)}</b>
  <span class="dim">live 5250 view &middot; read only &middot; repaints on every screen the agent drives</span>
  <span id="conn"></span>
</header>
<main><div class="screen" id="screen">waiting for the first screen…</div></main>
<div id="oia"></div>
<script>
  // The token is read before being stripped from the address bar, so it leaves no history entry.
  const t = new URLSearchParams(location.search).get("t") || "";
  const src = new EventSource("/events?t=" + encodeURIComponent(t));
  history.replaceState({}, "", location.pathname);
  const screen = document.getElementById("screen");
  const oia = document.getElementById("oia");
  const conn = document.getElementById("conn");
  src.onmessage = (e) => {
    const d = JSON.parse(e.data);
    screen.innerHTML = d.rows;
    oia.innerHTML = d.oia;
    conn.textContent = "";
  };
  src.onerror = () => { conn.textContent = "disconnected, retrying…"; };
</script>
</body></html>`;
}
