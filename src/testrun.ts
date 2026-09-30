// Screen regression tests. A test is a Markdown file, so it reads as a specification: two fence
// tags, and everything outside them is prose the parser ignores.
//
//   ```5250-do        type into a field, press a key, move the cursor
//   ```5250-expect    check the screen that came back

import type { Reporter } from "./types.js";
import type { Session } from "./session.js";
import { messageLine, renderSnapshot, structuralSignature } from "./snapshot.js";

export type Action =
  | { kind: "type"; field: string; text: string; line: number }
  | { kind: "key"; key: string; line: number }
  | { kind: "cursor"; row: number; col: number; line: number };

export type Expectation =
  | { kind: "text"; value: string; negated: boolean; line: number }
  | { kind: "message"; value: string; line: number }
  | { kind: "fields"; count: number; line: number }
  | { kind: "field"; field: string; value: string; line: number }
  | { kind: "cursor"; row: number; col: number; line: number }
  | { kind: "keyboard"; locked: boolean; line: number }
  | { kind: "signature"; value: string; line: number };

export interface Step { actions: Action[]; expectations: Expectation[]; }

export interface ScreenTest {
  name: string;
  source: string;
  steps: Step[];
}

export interface CheckResult {
  ok: boolean;
  what: string;
  detail?: string; // the screen, attached once per suite: see runSuite
}

export interface TestResult {
  name: string;
  passed: boolean;
  checks: CheckResult[];
}

export interface SuiteResult { results: TestResult[]; passed: number; failed: number; }

type Fail = (message: string) => never;

const FENCE = /^\s*```+\s*(\S*)\s*$/;
const ROWCOL = /^(\d+)\s*,\s*(\d+)$/;

// Anything unrecognised throws naming the file and line, because a silently ignored assertion
// reports a pass it never checked. A 5250-expect block attaches to the step before it.
export function parseTest(markdown: string, source: string): ScreenTest {
  const lines = markdown.split(/\r?\n/);
  const steps: Step[] = [];
  let name = "";
  let tag: string | undefined;
  let tagLine = 0;
  let body: { text: string; line: number }[] = [];

  const fail = (line: number, message: string): never => {
    throw new Error(`${source}:${line}: ${message}`);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fence = FENCE.exec(raw);

    if (fence && tag === undefined) {
      tag = fence[1].toLowerCase();
      tagLine = i + 1;
      body = [];
      continue;
    }
    if (fence && tag !== undefined) {
      if (tag === "5250-do") {
        steps.push({ actions: body.map((b) => parseAction(b.text, b.line, `${source}:`)), expectations: [] });
      } else if (tag === "5250-expect") {
        if (!steps.length) steps.push({ actions: [], expectations: [] });
        steps[steps.length - 1].expectations.push(...body.map((b) => parseExpectation(b.text, b.line, fail)));
      } else if (tag.startsWith("5250-")) {
        // A near miss on the tag would otherwise run the actions, assert nothing, and print ok.
        fail(tagLine, `unknown block \`\`\`${tag}, expected 5250-do or 5250-expect`);
      }
      tag = undefined;
      continue;
    }
    if (tag !== undefined) {
      const text = raw.trim();
      if (text && !text.startsWith("#")) body.push({ text: raw, line: i + 1 });
      continue;
    }
    if (!name) {
      const heading = /^#\s+(.*\S)\s*$/.exec(raw);
      if (heading) name = heading[1];
    }
  }

  if (tag !== undefined) fail(lines.length, `unclosed \`\`\`${tag} block`);
  if (!steps.length) fail(1, "no 5250-do or 5250-expect blocks found, so this test would check nothing");

  return { name: name || source, source, steps };
}

// Exported because screen_do takes the same lines. `where` prefixes the error.
export function parseAction(raw: string, line: number, where = ""): Action {
  const fail: Fail = (message) => {
    throw new Error(`${where}${line}: ${message}`);
  };
  const at = raw.indexOf(":");
  if (at < 0) fail(`expected "key: value", got "${raw.trim()}"`);
  const head = raw.slice(0, at).trim().toLowerCase();
  // Not trimmed at the end: trailing blanks in a fixed width field are real.
  const value = raw.slice(at + 1).replace(/^\s/, "");
  const [verb, target] = head.split(/\s+/);

  if (verb === "type") {
    if (!target) fail(`"type" needs a field, e.g. "type f1:" or "type 6,53:"`);
    return { kind: "type", field: target, text: value, line };
  }
  if (verb === "key") {
    if (target) fail(`"key" takes no field, write "key: ${target}"`);
    if (!value.trim()) fail(`"key" needs a key name, e.g. "key: Enter"`);
    return { kind: "key", key: value.trim(), line };
  }
  if (verb === "cursor") {
    const m = ROWCOL.exec(value.trim());
    if (!m) fail(`"cursor" needs row,col, got "${value.trim()}"`);
    return { kind: "cursor", row: Number(m[1]), col: Number(m[2]), line };
  }
  return fail(`unknown action "${verb}". Known: type, key, cursor`);
}

function parseExpectation(raw: string, line: number, failAt: (line: number, message: string) => never): Expectation {
  const fail: Fail = (message) => failAt(line, message);
  const at = raw.indexOf(":");
  if (at < 0) fail(`expected "key: value", got "${raw.trim()}"`);
  const head = raw.slice(0, at).trim().toLowerCase();
  const value = raw.slice(at + 1).trim();
  const words = head.split(/\s+/);
  const negated = words[0] === "not";
  const [verb, target] = negated ? words.slice(1) : words;

  if (verb === "text") {
    if (!value) fail(`"text" needs something to look for`);
    return { kind: "text", value, negated, line };
  }
  if (negated) fail(`"not" only works with text, not with "${verb}"`);

  if (verb === "message") {
    if (!value) fail(`"message" needs a message id, or "none"`);
    return { kind: "message", value, line };
  }
  if (verb === "fields") {
    // The word "input" is decorative: the count is always of input fields.
    const m = /^(\d+)(?:\s+input)?$/.exec(value);
    if (!m) fail(`"fields" needs a count, e.g. "fields: 4"`);
    return { kind: "fields", count: Number(m[1]), line };
  }
  if (verb === "field") {
    if (!target) fail(`"field" needs a ref, e.g. "field f1: ABC"`);
    return { kind: "field", field: target, value, line };
  }
  if (verb === "cursor") {
    const m = ROWCOL.exec(value);
    if (!m) fail(`"cursor" needs row,col, got "${value}"`);
    return { kind: "cursor", row: Number(m[1]), col: Number(m[2]), line };
  }
  if (verb === "keyboard") {
    if (value !== "locked" && value !== "unlocked") {
      fail(`"keyboard" is locked or unlocked, got "${value}"`);
    }
    return { kind: "keyboard", locked: value === "locked", line };
  }
  if (verb === "signature") {
    if (!value) fail(`"signature" needs a signature`);
    return { kind: "signature", value, line };
  }
  return fail(`unknown expectation "${verb}". Known: text, not text, message, fields, field, cursor, keyboard, signature`);
}

// Shared by run_tests and screen_do, so a test can never pass where the tool would fail.
export async function applyActions(
  session: Session,
  actions: Action[],
  reporter: Reporter,
): Promise<string[]> {
  const wire: string[] = [];
  const traced = () => (session.profile.trace ? wire : []);
  // One live view history step per key, the screen the host settled on. Labelled by the key alone:
  // typed text would carry a value typed into a hidden field. A timed out key is the one whose trace
  // says most, so the catch records it too.
  const step = (key: string, move?: string) => {
    const line = `${key} (${move ?? "stopped"}): ${session.exchange.join(" / ") || "nothing"}`;
    wire.push(line);
    session.emit("step", move ? key : `${key}, stopped on an error`, session.profile.trace ? [line] : []);
  };
  for (const a of actions) {
    try {
      if (a.kind === "type") {
        const rc = ROWCOL.exec(a.field);
        const f = session.resolveField(rc ? { row: Number(rc[1]), col: Number(rc[2]) } : a.field);
        session.typeInto(f, a.text);
      } else if (a.kind === "cursor") {
        session.moveCursor(a.row, a.col);
      } else {
        await session.pressKey(a.key, reporter);
        step(a.key, session.lastMove);
      }
    } catch (e) {
      if (a.kind === "key") step(a.key);
      // In a batch, "which one stopped" is the first thing the caller needs, and the screen omits it.
      throw new Error(`"${label(a)}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return traced();
}

const label = (a: Action) =>
  a.kind === "type" ? `type ${a.field}: ${a.text}` : a.kind === "key" ? `key: ${a.key}` : `cursor: ${a.row},${a.col}`;

// False once an earlier test attached one: the report only prints the first.
async function runTest(
  session: Session,
  test: ScreenTest,
  reporter: Reporter,
  attachScreen: boolean,
): Promise<TestResult> {
  const checks: CheckResult[] = [];
  let attached = false;

  const check = (ok: boolean, what: string) => {
    const result: CheckResult = { ok, what };
    if (!ok && attachScreen && !attached) {
      result.detail = renderSnapshot(session.screen);
      attached = true;
    }
    checks.push(result);
  };

  for (const [n, step] of test.steps.entries()) {
    reporter.step(`${test.name}: step ${n + 1} of ${test.steps.length}`);
    try {
      await applyActions(session, step.actions, reporter);
    } catch (e) {
      // A broken test or an unexpected screen, so stop: later steps assumed this landed.
      const message = e instanceof Error ? e.message : String(e);
      check(false, `step ${n + 1} could not run: ${message}`);
      return { name: test.name, passed: false, checks };
    }
    for (const e of step.expectations) checkExpectation(session, e, check);
  }

  const passed = checks.every((c) => c.ok);
  reporter.log("info", `${test.name}: ${passed ? "passed" : "FAILED"} (${checks.length} check(s))`);
  return { name: test.name, passed, checks };
}

function checkExpectation(session: Session, e: Expectation, check: (ok: boolean, what: string) => void): void {
  const screen = session.screen;
  switch (e.kind) {
    case "text": {
      const found = screen.text().includes(e.value);
      check(found !== e.negated, `line ${e.line}: screen ${e.negated ? "does not contain" : "contains"} "${e.value}"`);
      return;
    }
    case "message": {
      const actual = messageLine(screen);
      if (e.value.toLowerCase() === "none") {
        check(actual === undefined, `line ${e.line}: no message on the message line${actual ? `, got "${actual}"` : ""}`);
      } else {
        check(
          actual !== undefined && actual.includes(e.value),
          `line ${e.line}: message contains "${e.value}", got ${actual ? `"${actual}"` : "no message"}`,
        );
      }
      return;
    }
    case "fields": {
      const actual = screen.inputFields().length;
      check(actual === e.count, `line ${e.line}: ${e.count} input field(s), got ${actual}`);
      return;
    }
    case "field": {
      const f = screen.fieldById(e.field);
      if (!f) {
        check(false, `line ${e.line}: field ${e.field} exists`);
        return;
      }
      // displayValueOf, so a test that wants to check a password cannot print it.
      const shown = screen.displayValueOf(f);
      const actual = shown === undefined ? "<nondisplay>" : shown.replace(/\s+$/, "");
      check(actual === e.value, `line ${e.line}: field ${e.field} is "${e.value}", got "${actual}"`);
      return;
    }
    case "cursor": {
      const ok = screen.cursorRow === e.row && screen.cursorCol === e.col;
      check(ok, `line ${e.line}: cursor at ${e.row},${e.col}, got ${screen.cursorRow},${screen.cursorCol}`);
      return;
    }
    case "keyboard": {
      check(
        screen.keyboardLocked === e.locked,
        `line ${e.line}: keyboard ${e.locked ? "locked" : "unlocked"}, got ${screen.keyboardLocked ? "locked" : "unlocked"}`,
      );
      return;
    }
    case "signature": {
      const actual = structuralSignature(screen);
      check(actual === e.value, `line ${e.line}: signature ${e.value}, got ${actual ?? "none (no input fields)"}`);
      return;
    }
  }
}

export async function runSuite(
  session: Session,
  tests: ScreenTest[],
  reporter: Reporter,
): Promise<SuiteResult> {
  const results: TestResult[] = [];
  let attach = true;
  for (const [i, t] of tests.entries()) {
    reporter.step(`running test ${i + 1} of ${tests.length}: ${t.name}`);
    const r = await runTest(session, t, reporter, attach);
    if (r.checks.some((c) => c.detail)) attach = false;
    results.push(r);
  }
  const passed = results.filter((r) => r.passed).length;
  return { results, passed, failed: results.length - passed };
}

// Passing checks are hidden so a green suite is glanceable.
export function formatSuite(suite: SuiteResult): string {
  const out: string[] = [];
  for (const r of suite.results) {
    out.push(`${r.passed ? "  ok  " : "  FAIL"}  ${r.name}`);
    if (r.passed) continue;
    for (const c of r.checks.filter((x) => !x.ok)) out.push(`          ${c.what}`);
  }
  out.push("");
  out.push(
    suite.failed === 0
      ? `all ${suite.passed} test(s) passed`
      : `${suite.failed} of ${suite.results.length} test(s) failed`,
  );

  const firstScreen = suite.results.flatMap((r) => r.checks).find((c) => c.detail)?.detail;
  if (firstScreen) out.push("", "The screen at the first failure:", "", firstScreen);
  return out.join("\n");
}
