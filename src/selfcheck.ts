import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScreenBuffer, type Field } from "./screen.js";
import { Session } from "./session.js";
import { Viewer } from "./viewer.js";
import { loadProfile, loadProfileFor } from "./config.js";
import { decode, encode } from "./ebcdic.js";
import { assertCommandAllowed } from "./guard.js";
import { KEY_TO_AID, AID, CMD, ESC, FFW, ORDER, attrName, attrOf } from "./codes.js";
import { buildInbound, buildQueryReply, buildSaveScreenReply } from "./inbound.js";
import { MAX_STEPS, renderFrame } from "./render.js";
import { formatSuite, parseTest } from "./testrun.js";
import { lastPaintedRow, messageLine, renderSnapshot } from "./snapshot.js";
import { ScreenStack, screenKey, windowTitle } from "./stack.js";

// dist/selfcheck.js -> project root -> test/fixtures
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (n: string) => readFileSync(join(ROOT, "test", "fixtures", n));
const enc = (t: string) => encode(t, 37);

// A GDS record around a body, with the header length computed rather than counted by hand.
const gds = (...body: number[]) => {
  const rec = Buffer.alloc(10 + body.length);
  rec.writeUInt16BE(rec.length, 0);
  rec.writeUInt16BE(0x12a0, 2);
  rec[6] = 4;
  Buffer.from(body).copy(rec, 10);
  return rec;
};

const field = (over: Partial<Field> = {}): Field => ({
  id: "f1", row: 1, col: 1, length: 1, attr: 0x20, protectedField: false,
  shift: "alpha shift", monocase: false, mandatory: false, autoEnter: false, mdt: false, seq: 1, ...over,
});


// The three places a secret must never reach. Both masking tests check the same three.
const assertMasked = (s: ScreenBuffer, secret: string) => {
  assert.ok(!s.line(7).includes(secret), "the display line must not carry it");
  assert.ok(!s.text().includes(secret), "nor the whole screen text");
  assert.ok(!renderSnapshot(s).includes(secret), "nor the snapshot the model sees");
};

// A real 501 byte sign on record from a live IBM i, with only the system name replaced: MYBOX1 is
// the same six bytes, so no offset moved.
test("parses a real sign on record into the right screen", () => {
  const s = new ScreenBuffer(24, 80, 37);
  const p = s.apply(fixture("signon.bin"));

  // clear unit, write to display, read mdt fields
  assert.deepEqual(p.commands, [0x40, 0x11, 0x52]);
  // 0x18 in the header is row 24, the error row.
  assert.deepEqual(p.trace, ["clear unit", "write 00 18", "header 00 00 00 18 00 00 00", "read mdt"]);
  assert.equal(p.unlockedKeyboard, true);
  assert.equal(s.keyboardLocked, false);

  assert.match(s.line(1), /Sign On/);
  assert.match(s.line(2), /System/);
  assert.match(s.line(2), /MYBOX1/);
  assert.match(s.line(3), /QINTER/);
  assert.match(s.line(6), /User/);
  assert.match(s.line(7), /Password/);
  assert.match(s.line(24), /COPYRIGHT IBM CORP/);

  // MCPDEV01 is the device we asked for, echoed back: this is what makes a run reproducible.
  assert.match(s.line(4), /MCPDEV01/);
});

test("recovers the sign on format table, including the nondisplay password", () => {
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));

  assert.equal(s.fields.length, 5);
  assert.equal(s.inputFields().length, 5);

  const [user, password] = s.fields;
  assert.equal(user.id, "f1");
  assert.deepEqual([user.row, user.col, user.length], [6, 53, 10]);
  assert.equal(user.protectedField, false);
  assert.equal(user.monocase, true); // IBM i upper cases the user id for you

  assert.equal(password.attr, 0x27);
  assert.equal(attrName(password.attr), "nondisplay");
  assert.equal(password.length, 10);

  // The sign on fields are stacked in one column, which is what looksLikeSignOn matches on.
  for (const f of s.fields) assert.equal(f.col, 53);
});

test("defaults the cursor to the first input field when the host sends no IC", () => {
  const s = new ScreenBuffer(24, 80, 37);
  const p = s.apply(fixture("signon.bin"));
  assert.equal(p.sawInsertCursor, false);
  assert.equal(s.cursorRow, 6);
  assert.equal(s.cursorCol, 53);
  assert.equal(s.fieldAt(s.cursorRow, s.cursorCol)?.id, "f1");
});

test("typing sets the modified data tag and respects monocase", () => {
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));
  const user = s.fields[0];
  assert.equal(user.mdt, false);

  s.typeInto(user, "testuser", enc);
  assert.equal(user.mdt, true);
  assert.equal(s.valueOf(user).trim(), "TESTUSER");
  // the cells past the text are blanked, not left as nulls
  assert.equal(s.valueOf(user).length, 10);
});

test("attribute bytes occupy a cell and render blank, keeping columns aligned", () => {
  assert.equal(decode([0x22]), " "); // white attribute
  assert.equal(decode([0x27]), " "); // nondisplay attribute
  assert.equal(decode([0x00]), " "); // null cell
  assert.equal(decode([0x40]), " "); // EBCDIC space

  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));

  // The attribute holds column 22 and the S lands on 36. Skip its cell and every column shifts.
  assert.equal(s.line(1).indexOf("Sign On") + 1, 36);
  assert.equal(s.attrAt(1, 22).colour, "white");
  assert.equal(s.attrAt(1, 36).colour, "white"); // the attribute governs the text after it
  assert.equal(s.line(1)[21], " ");
});

test("EBCDIC round trips", () => {
  assert.equal(decode([0xe2, 0x89, 0x87, 0x95, 0x40, 0xd6, 0x95], 37), "Sign On");
  assert.equal(decode([0xd8, 0xc9, 0xd5, 0xe3, 0xc5, 0xd9], 37), "QINTER");
  assert.equal(decode(encode("Hello world", 37), 37), "Hello world");
  // Unmappable characters become "?" rather than vanishing, which would shift every later column.
  assert.equal(decode(encode("a中b", 37), 37), "a?b");
});

test("the CCSID actually matters, so a wrong one is detectable", () => {
  // 0x4A is where these tables disagree, so an identical result means a wrong table shipped.
  assert.notEqual(decode([0x4a], 37), decode([0x4a], 500));
  assert.notEqual(decode([0x4a], 273), decode([0x4a], 500));
  assert.equal(decode([0x4a], 500), "[");
  assert.throws(() => decode([0x40], 9999), /unsupported CCSID/);
});

test("key names map to the AID bytes the host expects", () => {
  assert.equal(KEY_TO_AID.Enter, 0xf1);
  assert.equal(KEY_TO_AID.F3, 0x33);
  assert.equal(KEY_TO_AID.F12, 0x3c);
  assert.equal(KEY_TO_AID.F13, 0xb1);
  // Roll Up means Page Down on a 5250. Backwards, this looks like a broken program, not a broken tool.
  assert.equal(KEY_TO_AID.PgDn, AID.ROLL_UP);
  assert.equal(KEY_TO_AID.PageDown, AID.ROLL_UP);
  assert.equal(KEY_TO_AID.PgUp, AID.ROLL_DOWN);
  assert.equal(AID.ROLL_UP, 0xf5);
  assert.equal(AID.ROLL_DOWN, 0xf4);
});

test("a short or malformed record fails loudly rather than half parsing", () => {
  const s = new ScreenBuffer();
  assert.throws(() => s.apply(Buffer.alloc(4)), /too short/);
  const bad = Buffer.alloc(16);
  bad.writeUInt16BE(16, 0);
  bad.writeUInt16BE(0x1234, 2); // not 0x12a0
  assert.throws(() => s.apply(bad), /not a GDS record/);
});

test("clear format table keeps the pixels but forgets the fields", () => {
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));
  const before = s.line(1);
  assert.ok(s.fields.length > 0);
  s.clearFormatTable();
  assert.equal(s.fields.length, 0);
  assert.equal(s.line(1), before);
});

test("builds the exact inbound record a real IBM i accepted", () => {
  // This exact byte string went to a real IBM i, which answered CPF1120, so the framing is good.
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));
  const [user, password] = s.fields;
  s.typeInto(user, "ZZTESTZZ", enc);
  s.typeInto(password, "BOGUSPW", enc);

  const rec = buildInbound(s, KEY_TO_AID.Enter);
  assert.equal(
    rec.toString("hex"),
    "0027" + // length 39
      "12a0" + // GDS
      "0000" + // reserved
      "04" + // header length
      "0000" + // flags
      "00" + // opcode, no op
      "0635" + // cursor row 6, col 53
      "f1" + // AID: Enter
      "110635" + "e9e9e3c5e2e3e9e94040" + // SBA 6,53 then "ZZTESTZZ  "
      "110735" + "c2d6c7e4e2d7e6404040", // SBA 7,53 then "BOGUSPW   "
  );
});

test("only modified fields go back to the host", () => {
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));
  const bare = buildInbound(s, KEY_TO_AID.Enter);
  assert.equal(bare.length, 13, "header 10 + cursor 2 + aid 1");

  // Touch one of five, one comes back: sending all makes an RPG program see changes nobody made.
  s.typeInto(s.fields[0], "AB", enc);
  const one = buildInbound(s, KEY_TO_AID.Enter);
  assert.equal(one.length, 13 + 3 + 10);

  // allFields is what Read Input Fields needs, as opposed to Read MDT Fields.
  const all = buildInbound(s, KEY_TO_AID.Enter, { allFields: true });
  assert.equal(all.length, 13 + 5 * (3 + 10));

  // A CA style key returns the indicator but discards changed data.
  const ca = buildInbound(s, KEY_TO_AID.F12, { suppressFields: true });
  assert.equal(ca.length, 13);
});

test("answers the 5250 Query, which the host waits for after sign on", () => {
  // Found live: unanswered, the host sends WSF class 0xd9 type 0x70 and never proceeds, so sign on hangs.
  const q = buildQueryReply("IBM-3179-2", enc);
  assert.equal(q.length, 10 + 61);
  assert.equal(q.readUInt16BE(0), 71);
  assert.equal(q.readUInt16BE(2), 0x12a0);

  const body = q.subarray(10);
  assert.equal(body[2], 0x88); // AID: inbound write structured field
  assert.equal(body.readUInt16BE(3), 0x3a); // declared reply length
  assert.equal(body[5], 0xd9); // command class
  assert.equal(body[6], 0x70); // query
  assert.equal(body[29], 0x01); // display, not printer

  // Must match what TERMINAL-TYPE negotiation claimed, or the host hears two stories about one terminal.
  assert.equal(decode(body.subarray(30, 34), 37), "3179");
  assert.equal(decode(body.subarray(35, 37), 37), "02");

  // A non numeric model ("FC") must report as 00, not fall back to a different device type.
  const wide = buildQueryReply("IBM-3477-FC", enc).subarray(10);
  assert.equal(decode(wide.subarray(30, 34), 37), "3477");
  assert.equal(decode(wide.subarray(35, 37), 37), "00");
});

test("a saved screen puts back the screen and the format table it was saved from", () => {
  // The host keeps this record and plays it back to close a window. An empty one ended the job.
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));
  const saved = buildSaveScreenReply(s);

  const later = new ScreenBuffer(24, 80, 37);
  later.apply(fixture("signon.bin"));
  later.typeInto(later.fields[0], "SCRIBBLE", enc);
  later.fields.push({ ...later.fields[0], id: "fWindow", row: 20, col: 40 }); // a field a window adds on top

  later.apply(saved);
  assert.equal(later.text(), s.text(), "every cell comes back");
  assert.deepEqual(
    later.fields.map((f) => `${f.row},${f.col},${f.length}`),
    s.fields.map((f) => `${f.row},${f.col},${f.length}`),
    "the field the window added is gone again",
  );
});

test("a nondisplay field is never rendered, so a password cannot leak", () => {
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));
  const password = s.fields[1];
  assert.equal(attrName(password.attr), "nondisplay");

  s.typeInto(password, "SECRET42", enc);

  assertMasked(s, "SECRET42");
  assert.match(renderSnapshot(s), /<nondisplay>/);

  // But the host still needs the real value, so the raw paths keep it.
  assert.equal(s.valueOf(password).trim(), "SECRET42");
});

test("the command line heuristic is conservative", () => {
  // Through commandLine itself: a copy of its predicate passes whatever the real one does.
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));
  const stub = Object.assign(Object.create(Session.prototype), { screen: s }) as Session;
  assert.equal(stub.commandLine(), undefined);
});

test("a field a window was drawn over is reported as covered, not as somewhere to type", () => {
  // IBM i draws a DDS window as plain characters and sends nothing that says one exists, so the
  // fields underneath stay in the format table and the host ignores them. The paint is the evidence.
  const sf = [ORDER.SF, FFW.PRESENT, 0x00, 0x20, 0x00, 0x05];
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(gds(ESC, CMD.WRITE_TO_DISPLAY, 0, 0, ORDER.SBA, 1, 1, ...sf, ORDER.SBA, 3, 1, ...sf));
  assert.equal(s.fields.length, 2, "two fields, one on row 1 and one on row 3");
  assert.equal(s.covered(s.fields[0]), false, "nothing has painted over it yet");

  // A second record paints row 1 only, the way a window border does.
  s.apply(gds(ESC, CMD.WRITE_TO_DISPLAY, 0, 0, ORDER.SBA, 1, 2, 0x7a, 0x7a));
  assert.equal(s.covered(s.fields[0]), true, "painted over, so the host would ignore it");
  assert.equal(s.covered(s.fields[1]), false, "the row it did not touch is still live");

  // Same record, not a later one: a field is written with its own initial value and stays live.
  const fresh = new ScreenBuffer(24, 80, 37);
  fresh.apply(gds(ESC, CMD.WRITE_TO_DISPLAY, 0, 0, ORDER.SBA, 1, 1, ...sf, 0x7a, 0x7a));
  assert.equal(fresh.covered(fresh.fields[0]), false, "its own value does not cover it");
});

test("a saved screen names its own geometry, so the host restores it at the right width", () => {
  // The host clears to 24x80 before replaying this, so a screen that does not say so comes back
  // re-flowed through an 80 column buffer.
  const wide = new ScreenBuffer(27, 132, 37);
  wide.apply(gds(0x04, 0x20, 0x00, 0x04, 0x11, 0x00, 0x00));
  const w = buildSaveScreenReply(wide).subarray(10);
  assert.deepEqual([...w.subarray(0, 3)], [ESC, CMD.CLEAR_UNIT_ALTERNATE, 0x00], "clear unit alternate");

  const narrow = new ScreenBuffer(24, 80, 37);
  const n = buildSaveScreenReply(narrow).subarray(10);
  assert.deepEqual([...n.subarray(0, 2)], [ESC, CMD.CLEAR_UNIT], "plain clear unit at 24x80");

  // And the round trip: a terminal replaying its own reply must land on the size it saved.
  const back = new ScreenBuffer(27, 132, 37);
  back.apply(gds(0x04, 0x40));
  assert.equal(back.cols, 80, "the host clears to the default size first");
  back.apply(buildSaveScreenReply(wide));
  assert.equal(back.cols, 132, "and the restore puts the wide geometry back");
  assert.equal(back.rows, 27);
});

test("restricted mode is an allowlist, and with it off only IBMI_BLOCKED_CL refuses anything", () => {
  const on = { restricted: true, allowedCl: [], blockedCl: [] };
  for (const cmd of ["call mylib/mypgm", "?call mypgm", "mylib/call x", "strdbg x", "signoff", "dsplibl"]) {
    assert.doesNotThrow(() => assertCommandAllowed(cmd, on), cmd);
  }
  // A named list, not a dsp* rule: dspobjd writes a file when given an outfile.
  for (const cmd of ["wrkactjob", "dltlib payroll", "dspobjd mylib/*all *file"]) {
    assert.throws(() => assertCommandAllowed(cmd, on), /restricted mode/, cmd);
  }
  assert.doesNotThrow(() => assertCommandAllowed("strapp parm(x)", { ...on, allowedCl: ["strapp"] }));

  // IBM i reads "? dltlib payroll" as dltlib prompted, leaving verbOf nothing to return.
  for (const cmd of ["? dltlib payroll", "?"]) {
    assert.throws(() => assertCommandAllowed(cmd, on), /restricted mode/, cmd);
  }
  assert.doesNotThrow(() => assertCommandAllowed("   ", on), "nothing typed is nothing to check");

  // Off, there is no list of ours at all, only the verbs the operator named.
  const off = { restricted: false, allowedCl: [], blockedCl: ["dltlib"] };
  for (const cmd of ["wrkactjob", "rmvm mylib/myfile mbr", "clrpfm x"]) {
    assert.doesNotThrow(() => assertCommandAllowed(cmd, off), cmd);
  }
  assert.throws(() => assertCommandAllowed("dltlib payroll", off), /IBMI_BLOCKED_CL/);
  assert.throws(() => assertCommandAllowed("?dltlib payroll", off), /IBMI_BLOCKED_CL/, "prompted too");
  assert.throws(() => assertCommandAllowed("qsys/dltlib x", off), /IBMI_BLOCKED_CL/, "qualified too");
});

test("a command line is told from a business field by the ===> prompt, not by width alone", () => {
  // 40 wide used to be the whole test, which a 35 wide mail subject nearly clears.
  const found = (line: string, col: number, length: number) =>
    (
      Object.assign(Object.create(Session.prototype), {
        screen: {
          rows: 24,
          line: (r: number) => (r === 20 ? line : r < 20 ? "text" : "   "),
          inputFields: () => [{ id: "f1", row: 20, col, length }],
          covered: () => false,
        },
      }) as Session
    ).commandLine();

  assert.ok(found("  ===>", 7, 153), "a prompted command line");
  assert.ok(found("  Remark", 12, 313), "IBM's own width, prompt or no prompt");
  assert.equal(found("  Remark", 12, 60), undefined, "a wide remark field is not a command line");
  assert.equal(found("  Option:", 9, 2), undefined, "nor is a menu option field");
  // The prompt has to sit before the field, or every field on the row inherits it.
  assert.equal(found("  Name           ===>", 7, 60), undefined, "a prompt to the right is not ours");
});

test("a menu with no command line signs off through its own numbered option", () => {
  // The top menu of an application stack ignores F3 and its option field is two characters wide.
  const option = (lines: string[], length: number) =>
    (
      Object.assign(Object.create(Session.prototype), {
        screen: { text: () => lines.join("\n"), inputFields: () => [{ id: "f1", length }] },
      }) as Session
    ).signOffOption();

  assert.equal(option(["  80. Development", "  90. Sign off", "Option:"], 2)?.option, "90");
  assert.equal(option(["  12. Sign Off"], 2)?.option, "12", "read off the screen, not assumed to be 90");
  assert.equal(option(["  90. Sign off"], 1), undefined, "a field too short to hold the number");
  assert.equal(option(["  90. Other choices"], 2), undefined, "a menu that offers no sign off");
});


test("parseTest reads actions and expectations out of Markdown, ignoring the prose", () => {
  const md = [
    "# Order entry rejects a blank customer",
    "",
    "Calling the program lands on the entry screen.",
    "",
    "```5250-do",
    "type f1: call mylib/ordentr",
    "key: Enter",
    "```",
    "",
    "```5250-expect",
    "text: Order Entry",
    "message: none",
    "fields: 4 input",
    "```",
    "",
    "```sql",
    "select * from somewhere -- an ordinary code block, not a step",
    "```",
    "",
    "```5250-do",
    "cursor: 6,53",
    "key: F3",
    "```",
  ].join("\n");

  const t = parseTest(md, "ordentr.md");
  assert.equal(t.name, "Order entry rejects a blank customer");
  assert.equal(t.steps.length, 2); // the sql block is not a step

  assert.deepEqual(t.steps[0].actions[0], { kind: "type", field: "f1", text: "call mylib/ordentr", line: 6 });
  assert.deepEqual(t.steps[0].actions[1], { kind: "key", key: "Enter", line: 7 });
  assert.equal(t.steps[0].expectations.length, 3);
  assert.deepEqual(t.steps[0].expectations[0], { kind: "text", value: "Order Entry", negated: false, line: 11 });
  assert.deepEqual(t.steps[0].expectations[2], { kind: "fields", count: 4, line: 13 });
  assert.deepEqual(t.steps[1].actions[0], { kind: "cursor", row: 6, col: 53, line: 21 });
});

test("parseTest keeps a trailing blank in typed text but not a leading one", () => {
  // Clearing a fixed width field means typing blanks, so text after ": " is literal bar the separator.
  const t = parseTest(["```5250-do", "type f2:   ", "```"].join("\n"), "t.md");
  assert.equal(t.steps[0].actions[0].kind === "type" && t.steps[0].actions[0].text, "  ");
});

test("an expect block with no preceding do block checks the screen already there", () => {
  const t = parseTest(["```5250-expect", "text: Main Menu", "```"].join("\n"), "t.md");
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0].actions.length, 0);
  assert.equal(t.steps[0].expectations.length, 1);
});

test("parseTest refuses anything it does not understand, naming the file and line", () => {
  const cases: [string[], RegExp][] = [
    [["```5250-do", "shout: hello", "```"], /t\.md:2: unknown action "shout"/],
    [["```5250-expect", "colour: green", "```"], /t\.md:2: unknown expectation "colour"/],
    [["```5250-do", "no colon here", "```"], /t\.md:2: expected "key: value"/],
    [["```5250-do", "type: nothing", "```"], /"type" needs a field/],
    [["```5250-do", "key f3: Enter", "```"], /"key" takes no field/],
    [["```5250-do", "cursor: sideways", "```"], /"cursor" needs row,col/],
    [["```5250-expect", "keyboard: melted", "```"], /"keyboard" is locked or unlocked/],
    [["```5250-expect", "not message: CPF0000", "```"], /"not" only works with text/],
    [["```5250-do", "key: Enter"], /unclosed ```5250-do block/],
    // A near miss on the tag used to run the actions, assert nothing, and print ok.
    [["```5250-expct", "text: x", "```"], /t\.md:1: unknown block ```5250-expct/],
    [["```5250-doo", "key: Enter", "```"], /unknown block ```5250-doo/],
    [["# Just prose", "", "Nothing to run here."], /no 5250-do or 5250-expect blocks/],
  ];
  for (const [lines, want] of cases) {
    assert.throws(() => parseTest(lines.join("\n"), "t.md"), want, lines.join(" | "));
  }
});

test("a test with no heading falls back to its file name", () => {
  const t = parseTest(["```5250-expect", "text: x", "```"].join("\n"), "screen-tests/ordentr.md");
  assert.equal(t.name, "screen-tests/ordentr.md");
});

test("formatSuite prints one line per passing test and the checks only for failures", () => {
  const suite = {
    results: [
      { name: "green", passed: true, checks: [{ ok: true, what: "line 3: whatever" }] },
      {
        name: "red",
        passed: false,
        checks: [
          { ok: true, what: "line 3: fine" },
          { ok: false, what: "line 4: message contains \"CPF9898\", got no message", detail: "SCREEN HERE" },
        ],
      },
    ],
    passed: 1,
    failed: 1,
  };
  const out = formatSuite(suite);
  assert.match(out, /^ {2}ok {4}green$/m);
  assert.match(out, /^ {2}FAIL {2}red$/m);
  assert.doesNotMatch(out, /line 3: whatever/);
  assert.doesNotMatch(out, /line 3: fine/); // quiet even inside a failing test
  assert.match(out, /line 4: message contains/);
  assert.match(out, /1 of 2 test\(s\) failed/);
  assert.match(out, /SCREEN HERE/);
});


test("a sign on message screen is acknowledged, a prompt never is", () => {
  // The only place the session presses Enter unasked, so the guard must hold: no input fields, or no.
  const ack = (fields: number, text: string) =>
    (
      Object.assign(Object.create(Session.prototype), {
        screen: { inputFields: () => new Array(fields), text: () => text },
      }) as Session
    ).looksLikeAcknowledgement();

  assert.equal(ack(0, "Job 1/X/QPADEV1 started.  Press Enter to continue."), true);
  assert.equal(ack(0, "Bottom  F3=Exit"), false);
  // A real confirmation has something to type into, which is what stops this auto answering.
  assert.equal(ack(1, "Delete library PAYROLL (Y/N)?  Press Enter to continue."), false);
  // Refused again for a second, independent reason: a question is never auto answered.
  assert.equal(ack(0, "Delete library PAYROLL (Y/N)?  Press Enter to continue."), false);
  assert.equal(ack(0, "Confirm Delete of Member.  Press Enter to continue."), false);
});

test("the command line is found on a 27x132 session, not just 24x80", () => {
  // A 24 row layout in a 27 row display leaves rows 24 to 27 blank, so the physical bottom misses it.
  const found = (rows: number, lastPainted: number, fieldRow: number) =>
    (
      Object.assign(Object.create(Session.prototype), {
        screen: {
          rows,
          line: (r: number) => (r <= lastPainted ? "text" : "   "),
          inputFields: () => [{ id: "f1", row: fieldRow, col: 7, length: 313 }],
          covered: () => false,
        },
      }) as Session
    ).commandLine();

  assert.ok(found(27, 23, 18), "27x132 Command Entry");
  assert.ok(found(24, 23, 18), "24x80 Command Entry");
  assert.ok(found(24, 24, 20), "a menu with its command line at row 20");
  // Still conservative: a wide field high up the screen is not a command line.
  assert.equal(found(27, 23, 6), undefined);
});

test("the host picks the screen size per screen, not the config", () => {
  // A 132 column buffer for a screen addressed as 80 puts everything past column 80 on the wrong row.
  const s = new ScreenBuffer(27, 132, 37);
  assert.equal(s.cols, 80, "starts at the default size, which is what the host addresses first");
  assert.equal(s.rows, 24);

  // The real record carries Clear Unit, so it stays 24x80 despite the larger negotiated device.
  s.apply(fixture("signon.bin"));
  assert.equal(s.cols, 80);
  assert.match(s.line(1), /Sign On/);

  // Clear Unit Alternate switches to the negotiated geometry, and back again.
  s.clearUnit(s.altRows, s.altCols);
  assert.equal(s.rows, 27);
  assert.equal(s.cols, 132);
  assert.equal(s.line(1).length, 132);
  s.clearUnit(24, 80);
  assert.equal(s.line(1).length, 80);

  // A 24x80 only device has no alternate, so it never changes shape.
  const narrow = new ScreenBuffer(24, 80, 37);
  assert.equal(narrow.altCols, 80);
});

test("typing onto a sign on screen is refused", () => {
  // Cancelling a program drops back here unwarned, and failed attempts count towards QMAXSIGN.
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));
  const stub: Session = Object.assign(Object.create(Session.prototype), {
    screen: s,
  });
  assert.throws(() => stub.typeInto(s.inputFields()[0], "C"), /QMAXSIGN/);
  // establish() writes to the buffer directly, so signing on still works.
  assert.doesNotThrow(() => s.typeInto(s.inputFields()[0], "SOMEUSER", (x) => encode(x, 37)));
});

test("every nondisplay attribute is recognised, and the colours are right", () => {
  // Nondisplay is the low three bits set, all four of them. The table is not monotonic.
  for (const a of [0x27, 0x2f, 0x37, 0x3f]) {
    assert.equal(attrName(a), "nondisplay", `0x${a.toString(16)}`);
  }
  for (let a = 0x20; a <= 0x3f; a++) {
    if ((a & 7) === 7) continue;
    assert.notEqual(attrName(a), "nondisplay", `0x${a.toString(16)}`);
  }
  // The interleaved pairs a threshold chain gets wrong.
  assert.equal(attrName(0x20), "green");
  assert.equal(attrName(0x22), "white");
  assert.equal(attrName(0x28), "red");
  assert.equal(attrName(0x30), "turquoise");
  assert.equal(attrName(0x32), "yellow");
  assert.equal(attrName(0x36), "yellow");
  assert.equal(attrName(0x38), "pink");
  assert.equal(attrName(0x3a), "blue");
  assert.equal(attrName(0x3c), "pink");
});

test("the key table cannot be walked through the prototype", () => {
  // As a plain object these resolve through Object.prototype and reach the host as AID 0x00.
  for (const k of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
    assert.equal(KEY_TO_AID[k], undefined, k);
  }
  assert.equal(KEY_TO_AID.Enter, AID.ENTER);
  assert.equal(Object.keys(KEY_TO_AID).length > 20, true);
});

test("a server name cannot walk out of the config folders", () => {
  // The name becomes a filename, so a traversing one reads another box's password.
  for (const bad of [
    "../../../../etc/hosts",
    "../sibling",
    "a/b",
    "a\b",
    ".hidden",
    "",
    "-flag",
  ]) {
    assert.throws(() => loadProfileFor(bad), /invalid server name|missing IBMI_HOST/, JSON.stringify(bad));
  }
  // A normal name still reaches the "no config for" path, not the guard.
  assert.throws(() => loadProfileFor("NOSUCHBOX"), /no config for server/);
});

test("the live view answers only to localhost, so DNS rebinding cannot read it", () => {
  // Binding to 127.0.0.1 does not stop a site pointing its own hostname there. Host tells them apart.
  const v = new Viewer("t");
  const allowed = (host: string) => Viewer.prototype["allowedHost"].call(v, { headers: { host } } as never);

  for (const h of ["127.0.0.1:5250", "localhost:5250", "127.0.0.1", "LocalHost:99", "[::1]:5250"]) {
    assert.equal(allowed(h), true, h);
  }
  for (const h of ["evil.example.com:5250", "attacker.test", "127.0.0.1.evil.com:5250", ""]) {
    assert.equal(allowed(h), false, h);
  }
});

test("a read command is the readiness signal, so settle does not pay the quiet period", async () => {
  // A read means the host stopped painting. Without one the quiet period applies.
  const stub: Session = Object.assign(Object.create(Session.prototype), {
    screen: new ScreenBuffer(24, 80, 37),
    profile: { ccsid: 37, terminalType: "IBM-3477-FC" },
    lastReply: "",
    recordCount: 0,
    exchange: [],
    emit: () => true,
  });

  Session.prototype["onRecord"].call(stub, fixture("signon.bin"));
  // The fixture really does end in Read MDT Fields: see the commands assert above.
  assert.equal(stub["sawRead"], true);
  assert.equal(stub.screen.keyboardLocked, false);

  const fast = Date.now();
  await stub.settle();
  const withRead = Date.now() - fast;

  stub["sawRead"] = false;
  stub["lastRecordAt"] = Date.now();
  const slow = Date.now();
  await stub.settle();
  const withoutRead = Date.now() - slow;

  // Relative, not an absolute budget: a loaded machine makes both slower, not one of them.
  assert.ok(withoutRead >= 110, `waited ${withoutRead}ms, the fallback quiet period should still apply`);
  assert.ok(withRead < withoutRead, `a read settled in ${withRead}ms against ${withoutRead}ms without one`);
});

test("the live view is gated by a per session token, not just the Host header", () => {
  // The Host check stops a remote page, not another process on this machine.
  const a = new Viewer("a");
  const b = new Viewer("b");
  const tokenOf = (v: Viewer) => v["token"] as string;

  assert.match(tokenOf(a), /^[0-9a-f]{32}$/);
  assert.notEqual(tokenOf(a), tokenOf(b), "a token is per session, so two viewers never share one");

  const gate = (v: Viewer, url: string) =>
    Viewer.prototype["allowedToken"].call(v, { url } as never);

  assert.equal(gate(a, `/?t=${tokenOf(a)}`), true);
  assert.equal(gate(a, `/events?t=${tokenOf(a)}`), true);
  for (const url of ["/", "/events", "/?t=", "/?t=deadbeef", `/?t=${tokenOf(b)}`]) {
    assert.equal(gate(a, url), false, url);
  }
});

test("the stack pushes new screens, keeps updates, pops on return and leaves windows out", () => {
  const painted = (rows: Record<number, string>) => {
    const s = new ScreenBuffer(24, 80, 37);
    for (const [r, text] of Object.entries(rows)) enc(text.padEnd(80)).copy(s.chars, (Number(r) - 1) * 80);
    return s;
  };
  // IBM help draws its window as a full repaint, with only the border to say so.
  const help = (title: string) => ({
    1: "MAIN          IBM i Main Menu",
    2: " " + ".".repeat(78),
    3: " :" + `   ${title}`.padEnd(76) + ":",
    4: " :" + "".padEnd(76) + ":",
    5: " :" + ".".repeat(76) + ":",
  });
  const main = painted({ 1: "MAIN          IBM i Main Menu", 2: "                     System:   MYBOX1" });
  const menu = (time: string) => painted({ 1: `  ORD000   ORDERS     01-02-2026  ${time}`, 5: "  1. Order entry" });
  const sub = painted({ 1: "  ORD010   ORDERS Test   01-02-2026  09:15" });

  const st = new ScreenStack();
  st.reset(main);
  assert.equal(st.observe(menu("09:15")), "new");
  assert.equal(st.observe(menu("09:16")), "update", "a new time is the same screen");
  assert.equal(st.observe(sub), "new");
  // This screen is what the reader is looking at, so only the ones behind it are listed.
  assert.deepEqual(st.lines(), ["1. ORD000 ORDERS", "2. MAIN IBM i Main Menu System: MYBOX1"],
    "nearest first, without dates and times");

  assert.equal(st.observe(painted(help("Main Menu - Help"))), "window");
  assert.equal(st.lines().length, 2, "a window is marked, not stacked");
  assert.equal(st.windowOnTop, "Main Menu - Help");
  assert.equal(st.observe(sub), "update", "closing the window lands on the same screen");
  assert.equal(st.windowOnTop, undefined);

  assert.equal(st.observe(main), "back", "F3 twice at once still lands on the right entry");
  assert.deepEqual(st.lines(), [], "nothing behind the first screen");

  assert.equal(windowTitle(painted({ 3: "  Library . . . . . . . . . . .   QGPL" })), undefined, "a dotted leader is not a border");

  const typed = painted({ 1: "Work with things" });
  typed.fields = [field({ row: 2, col: 10, length: 10 })];
  const blank = screenKey(typed);
  typed.typeInto(typed.fields[0], "ACME", enc);
  assert.equal(screenKey(typed), blank, "typed text is not part of what identifies a screen");
});

// SBA to the cell before the field, since Start Field writes the attribute there.
const sf = (row: number, col: number, len: number) =>
  [ORDER.SBA, row, col - 1, ORDER.SF, FFW.PRESENT, 0x00, 0x20, 0, len];
const header = (errorRow: number) => [ORDER.SOH, 7, 0, 0, 0, errorRow, 0, 0, 0];

test("a header drops the fields of the format it replaces, as tn5250 does", () => {
  // A selection screen back to the list it filters: writes only, no clear, and a header.
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(gds(ESC, CMD.WRITE_TO_DISPLAY, 0, 0, ...sf(5, 14, 8), ...sf(8, 40, 30)));
  s.apply(gds(ESC, CMD.WRITE_TO_DISPLAY, 0, 0, ...header(0x19), ...sf(5, 2, 1), ...sf(6, 2, 1)));
  assert.deepEqual(s.fields.map((f) => [f.row, f.col, f.length]), [[5, 2, 1], [6, 2, 1]]);
  assert.equal(s.fields.filter((f) => s.covered(f)).length, 0, "nothing left to report as under a window");
});

test("an error message goes on the header's error row, or the last row when that is off screen", () => {
  const onRow = (errorRow: number) => {
    const s = new ScreenBuffer(24, 80, 37);
    s.apply(gds(ESC, CMD.WRITE_TO_DISPLAY, 0, 0, ...header(errorRow)));
    s.apply(gds(ESC, CMD.WRITE_ERROR_CODE, ...enc("CPD9999 key not allowed")));
    return s.lines().findIndex((l) => l.startsWith("CPD9999")) + 1;
  };
  assert.equal(onRow(22), 22);
  // IBM i sent rows plus one, 25 here and 28 on a 27 row display, and the message landed nowhere.
  assert.equal(onRow(25), 24);
  assert.equal(onRow(0), 24);
});

test("the stack view keeps each screen as it was on top and forgets popped ones", () => {
  const v = new Viewer("t");
  const writes: string[] = [];
  v["clients"].add({ write: (w: string) => writes.push(w) } as never);
  const at = (text: string) => {
    const s = new ScreenBuffer(24, 80, 37);
    enc(text).copy(s.chars, 0);
    return s;
  };
  const a = { key: "a", title: "MAIN" };
  const b = { key: "b", title: "ORD000" };

  v.stackMoved(at("MAIN MENU"), [a]);
  v.stackMoved(at("ORD000 MENU"), [a, b]);
  const last = () => JSON.parse(writes[writes.length - 1].split("data: ")[1]);
  assert.deepEqual(last().entries.map((e: { title: string }) => e.title), ["MAIN", "ORD000"]);
  assert.match(last().entries[0].rows, /MAIN MENU/, "the entry below keeps its own screen");
  assert.match(last().entries[1].rows, /ORD000 MENU/);

  v.stackMoved(at("MAIN MENU AGAIN"), [a]);
  assert.equal(v["stackFrames"].size, 1, "a popped screen's frame goes with it");
  assert.match(last().entries[0].rows, /MAIN MENU AGAIN/);
});

test("a page that connects gets the history, oldest first and capped, then the live screen", () => {
  const s = new ScreenBuffer(24, 80, 37);
  const connect = (v: Viewer) => {
    const written: string[] = [];
    const res = { writeHead() {}, flushHeaders() {}, on() {}, write: (w: string) => written.push(w) };
    v["stream"](res as never);
    return written.map((w) =>
      w.startsWith("event: step\n") ? JSON.parse(w.slice(w.indexOf("data: ") + 6)).label : "live",
    );
  };

  const v = new Viewer("t");
  v.step(s, "signed on");
  v.step(s, "Enter");
  v.update(s);
  assert.deepEqual(connect(v), ["signed on", "Enter", "live"]);

  const full = new Viewer("t");
  for (let i = 0; i <= MAX_STEPS; i++) full.step(s, String(i));
  const replay = connect(full);
  assert.equal(replay.length, MAX_STEPS);
  assert.equal(replay[0], "1", "the oldest step is the one dropped");
});


test("a nondisplay field masks even when the host never painted its cells", () => {
  // line() masks per cell on attrs and typeInto writes only chars, so the attribute has to reach them.
  const s = new ScreenBuffer(24, 80, 37);
  s.fields = [field({ row: 7, col: 53, length: 10, attr: 0x27 })];
  s.typeInto(s.fields[0], "SECRET42", enc);

  assertMasked(s, "SECRET42");
  assert.equal(s.displayValueOf(s.fields[0]), undefined);
  assert.equal(s.valueOf(s.fields[0]).trim(), "SECRET42", "the host still needs the real value");
});

test("the message line is found on a 27 row buffer holding a 24 row layout", () => {
  // A 27 row display running a 24 row program puts the message line at 24 with blanks under it.
  const s = new ScreenBuffer(27, 132, 37);
  s.clearUnit(27, 132);
  encode("CPF1120 User ZZ does not exist", 37).copy(s.chars, (24 - 1) * 132);

  assert.equal(lastPaintedRow(s), 24);
  assert.match(messageLine(s) ?? "", /CPF1120/);

  // And a genuinely empty screen still reports nothing rather than throwing.
  const blank = new ScreenBuffer(24, 80, 37);
  assert.equal(messageLine(blank), undefined);
});

test("a truncated order does not poison the buffer with NaN", () => {
  // Math.max(1, undefined) is NaN, which the bounds check lets through. onRecord catches throws.
  const s = new ScreenBuffer(24, 80, 37);
  const rec = gds(0x04, 0x11, 0x00, 0x00, 0x11); // ESC WTD cc1 cc2, then an SBA with no operands
  assert.doesNotThrow(() => s.apply(rec));
  for (const f of s.fields) assert.ok(Number.isFinite(f.row) && Number.isFinite(f.col), f.id);
  assert.equal(s.line(1).trim(), "", "a truncated order must not paint anything");

  // Insert Cursor reads the same two operands and lands them on the cursor rather than a field.
  const c = new ScreenBuffer(24, 80, 37);
  c.apply(gds(0x04, 0x11, 0x00, 0x00, 0x13));
  assert.ok(Number.isFinite(c.cursorRow) && Number.isFinite(c.cursorCol), "the cursor survives it too");
});

test("a read the host answers itself is not the host waiting for the operator", () => {
  // These ask the terminal for something and the host waits, so counting them as readiness settles
  // on the screen already there and leaves the host blocked.
  const read = (cmd: number) => {
    const s = new ScreenBuffer(24, 80, 37);
    return s.apply(gds(0x04, cmd, 0x00, 0x00));
  };

  for (const cmd of [0x42, 0x52, 0x82]) {
    const p = read(cmd);
    assert.equal(p.unlockedKeyboard, true, `0x${cmd.toString(16)} asks the operator`);
    assert.equal(p.readScreenRequested, false);
    assert.equal(p.readFieldsRequested, false);
  }

  const screen = read(0x62);
  assert.equal(screen.readScreenRequested, true, "Read Screen Immediate is a request to answer");
  assert.equal(screen.unlockedKeyboard, false, "and must not count as the host being ready");

  const fields = read(0x72);
  assert.equal(fields.readFieldsRequested, true, "Read Immediate is a request to answer");
  assert.equal(fields.unlockedKeyboard, false);
});

test("a redraw at the same positions replaces fields rather than appending them", () => {
  // IBM i redraws a subfile by rewriting every visible row without clearing the format table.
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));

  const before = s.fields.length;
  const ids = s.fields.map((f) => f.id);
  const places = s.fields.map((f) => `${f.row},${f.col}`);
  assert.ok(before > 0);

  s.apply(fixture("signon.bin")); // the same screen again, no clear in between

  assert.equal(s.fields.length, before, "the same positions must not double the list");
  assert.deepEqual(s.fields.map((f) => f.id), ids, "and a ref keeps meaning the same field");
  assert.deepEqual(s.fields.map((f) => `${f.row},${f.col}`), places);

  // A field at a position nothing occupies is still a new field, which is how a window adds one.
  s.fields.push(field({ id: "fX", row: 20, col: 5 }));
  assert.equal(s.fields.length, before + 1);
});

test("reverse image and underline survive as far as the rendered page", () => {
  // Reverse fills the whole run including trailing blanks, which makes a DSPATR(RI) title a bar.
  assert.deepEqual(attrOf(0x31), { colour: "turquoise", reverse: true, underline: false, nondisplay: false });
  assert.deepEqual(attrOf(0x24), { colour: "green", reverse: false, underline: true, nondisplay: false });
  assert.deepEqual(attrOf(0x20), { colour: "green", reverse: false, underline: false, nondisplay: false });
  assert.equal(attrOf(0x27).nondisplay, true, "nondisplay outranks the other bits");
  assert.equal(attrOf(0x27).reverse, false);

  const s = new ScreenBuffer(24, 80, 37);
  s.attrs.fill(0x31, s["idx"](1, 1), s["idx"](1, 1) + 20);
  encode("TITLE", 37).copy(s.chars, s["idx"](1, 3));
  s.attrs.fill(0x24, s["idx"](2, 1), s["idx"](2, 1) + 10);

  const html = renderFrame(s);
  assert.match(html, /background:#4de2ff/, "the bar is painted, not just its text");
  assert.match(html, /text-decoration:underline/);
  assert.ok(!/background:[^;"]*;color:[^;"]*;text-decoration/.test(renderFrame(new ScreenBuffer(24, 80, 37))),
    "a plain green screen carries neither");
});

test("a window's own field is where the cursor goes, not the first field on the screen", () => {
  // A window adds a field to a screen that has others and sends no Insert Cursor, and IBM i refuses
  // an AID whose cursor is outside it. So the default is the first field this record defined.
  const s = new ScreenBuffer(24, 80, 37);
  s.apply(fixture("signon.bin"));
  const firstOnScreen = s.inputFields()[0];
  assert.deepEqual([s.cursorRow, s.cursorCol], [firstOnScreen.row, firstOnScreen.col]);

  // A second write defining one field lower down, the shape of a window opening.
  s.apply(gds(
    0x04, 0x11, 0x00, 0x02,             // WTD, cc1, cc2 unlock
    0x11, 20, 40,                       // SBA to 20,40
    0x1d, 0x40, 0x00, 0x20, 0x00, 0x01, // SF: FFW present, attribute green, length 1
  ));

  const w = s.fields.find((f) => f.row === 20 && f.col === 41);
  assert.ok(w, "the window field was defined");
  assert.deepEqual([s.cursorRow, s.cursorCol], [w.row, w.col], "the cursor follows the field just written");
  assert.notDeepEqual([s.cursorRow, s.cursorCol], [firstOnScreen.row, firstOnScreen.col]);
});

test("a field that runs past the end of its row is still found from the rows it covers", () => {
  // A command line is 313 characters, four rows of an 80 column screen, and every other accessor
  // reads a field as a flat run.
  const s = new ScreenBuffer(24, 80, 37);
  s.fields = [field({ row: 18, col: 7, length: 313 })];

  assert.equal(s.fieldAt(18, 7)?.id, "f1", "its first cell");
  assert.equal(s.fieldAt(19, 1)?.id, "f1", "and the row it wraps onto");
  assert.equal(s.fieldAt(22, 1), undefined, "but not past its end");
});

test("a yes or no setting refuses a value that is neither, rather than reading as no", () => {
  // IBMI_5250_VIEWER=ture would otherwise read as the default and quietly do the opposite.
  const base = { IBMI_HOST: "h", IBMI_USER: "u", IBMI_PASSWORD: "p" };
  assert.equal(loadProfile({ ...base, IBMI_5250_VIEWER: "TRUE" }).viewerEnabled, true);
  assert.equal(loadProfile({ ...base, IBMI_5250_VIEWER: "off" }).viewerEnabled, false);
  assert.equal(loadProfile({ ...base, IBMI_5250_VIEWER: "  " }).viewerEnabled, false, "blank is unset");
  assert.throws(() => loadProfile({ ...base, IBMI_5250_VIEWER: "ture" }), /neither true nor false/);
});

