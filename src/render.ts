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

export const MAX_STEPS = 500;

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

export interface Frame {
  rows: string;
  oia: string;
}

// Must stay on one line: viewer.ts writes it into `data: ...` and a raw newline would end the frame
// early. JSON.stringify never emits one.
export function renderFrame(screen: ScreenBuffer, extra: object = {}): string {
  return JSON.stringify({ ...frameOf(screen), ...extra });
}

export function frameOf(screen: ScreenBuffer): Frame {
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

  return { rows: rows.join(""), oia };
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
  section { padding:14px; overflow-x:auto; }
  section + section { border-top:1px solid #234023; }
  .bar { display:flex; gap:10px; align-items:center; margin-bottom:8px; font-size:12px; color:#9fc09f; }
  .bar b { color:#e8e8e8; font-size:13px; font-weight:600; }
  .bar button { font:inherit; color:#33ff44; background:#111a11; border:1px solid #234023;
                border-radius:3px; padding:2px 10px; cursor:pointer; }
  .bar button:disabled { color:#2f5a2f; cursor:default; }
  #label { color:#7fa07f; }
  summary { cursor:pointer; color:#9fc09f; font-size:12px; }
  summary b { color:#e8e8e8; font-size:13px; font-weight:600; margin-right:6px; }
  details[open] summary { margin-bottom:8px; }
  .screen { display:inline-block; background:${SCREEN_BG}; padding:10px 12px;
            border:1px solid #234023; border-radius:4px; white-space:pre; }
  .row { height:1.35em; }
  .rn { color:#2f5a2f; user-select:none; margin-right:8px; }
  .cur .rn { color:#ffdd33; }
  .nd { color:transparent; }
  .locked { color:#ff4d4d; font-weight:600; }
  .ok { color:#33ff44; }
  .oia { margin-top:6px; color:#9fc09f; font-size:12px; }
  .crumbs { display:flex; flex-direction:column; align-items:flex-start; gap:4px; margin-bottom:8px; }
  .crumbs button { font:inherit; font-size:12px; color:#9fc09f; background:#111a11; text-align:left;
                   border:1px solid #234023; border-radius:3px; padding:2px 10px; cursor:pointer; }
  .crumbs button.on { color:#e8e8e8; border-color:#33ff44; }  #conn { color:#ff4d4d; }
</style></head>
<body>
<header>
  <b>${esc(title)}</b>
  <span class="dim">live 5250 view &middot; read only &middot; repaints on every screen the agent drives</span>
  <span id="conn"></span>
</header>
<section>
  <div class="bar"><b>Live</b></div>
  <div class="screen" id="screen">waiting for the first screen…</div>
  <div class="oia" id="oia"></div>
</section>
<section>
<details id="stk">
  <summary><b>Screen stack</b> <span id="depth">empty</span></summary>
  <div class="crumbs" id="crumbs"></div>
  <div id="spick" hidden>
    <div class="screen" id="sscreen"></div>
    <div class="oia" id="soia"></div>
  </div>
</details>
</section>
<section>
<details id="hist">
  <summary><b>History</b> <span id="count">no screens yet</span></summary>
  <div class="bar">
    <button id="prev" title="previous screen (left arrow)">&#9664;</button>
    <span id="pos"></span>
    <button id="next" title="next screen (right arrow)">&#9654;</button>
    <span id="label"></span>
    <button id="newest" hidden>newest</button>
  </div>
  <div class="screen" id="hscreen">no screens yet</div>
  <div class="oia" id="hoia"></div>
</details>
</section><script>
  // The token is read before being stripped from the address bar, so it leaves no history entry.
  const t = new URLSearchParams(location.search).get("t") || "";
  const src = new EventSource("/events?t=" + encodeURIComponent(t));
  history.replaceState({}, "", location.pathname);
  const $ = (id) => document.getElementById(id);
  const screen = $("screen");
  const oia = $("oia");
  const conn = $("conn");

  // The newest step is the live screen, so the history is every step before it. While following,
  // each new one is shown as it arrives. Stepping back stops that, so a new step does not pull the
  // view away, and reaching the latest again resumes it.
  const steps = [];
  let at = -1;
  let follow = true;
  const past = () => Math.max(0, steps.length - 1);

  function show() {
    const s = at < past() ? steps[at] : undefined;
    if (s) {
      $("hscreen").innerHTML = s.rows;
      $("hoia").innerHTML = s.oia;
    }
    $("count").textContent = past()
      ? past() + (past() === 1 ? " screen" : " screens")
      : "no screens yet";
    $("pos").textContent = s ? "screen " + (at + 1) + " of " + past() : "";
    $("label").textContent = s ? s.label + " \\u00b7 " + new Date(s.at).toLocaleTimeString() : "";
    $("prev").disabled = at <= 0;
    $("next").disabled = at >= past() - 1;
    $("newest").hidden = follow;
  }

  const go = (i) => {
    at = Math.max(0, Math.min(i, past() - 1));
    follow = at === past() - 1;
    show();
  };
  $("prev").onclick = () => go(at - 1);
  $("next").onclick = () => go(at + 1);
  $("newest").onclick = () => go(past() - 1);
  document.onkeydown = (e) => {
    if (!$("hist").open) return;
    if (e.key === "ArrowLeft") $("prev").click();
    if (e.key === "ArrowRight") $("next").click();
  };

  // The top entry is the live screen, so it is left out. picked counts from the bottom, so it stays on
  // the same screen while others are pushed above it.
  let stack = { entries: [] };
  let picked = -1;

  function showStack() {
    const list = stack.entries;
    const behind = Math.max(0, list.length - 1);
    if (picked >= behind) picked = -1; // the picked screen was popped, or is now the live one
    $("depth").textContent = behind
      ? behind + (behind === 1 ? " screen" : " screens") + " behind this one"
      : "nothing behind this screen";
    $("crumbs").textContent = "";
    for (let n = behind - 1; n >= 0; n--) {
      const b = document.createElement("button");
      b.textContent = (behind - n) + ". " + list[n].title;
      if (n === picked) b.className = "on";
      b.onclick = () => {
        picked = picked === n ? -1 : n;
        showStack();
      };
      $("crumbs").appendChild(b);
    }
    const e = list[picked];
    $("spick").hidden = !e;
    $("sscreen").innerHTML = e && e.rows ? e.rows : "";
    $("soia").innerHTML = e && e.oia ? e.oia : "";
  }

  src.addEventListener("stack", (e) => {
    stack = JSON.parse(e.data);
    showStack();
  });

  // The server replays every step on each connection.
  src.onopen = () => { steps.length = 0; };
  src.addEventListener("step", (e) => {
    if (steps.push(JSON.parse(e.data)) > ${MAX_STEPS}) {
      steps.shift();
      at = Math.max(0, at - 1);
    }
    if (follow) at = past() - 1;
    show();
  });
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
