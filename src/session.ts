// One 5250 session: transport, screen, and settle logic. The host says it is done twice, by
// unlocking the keyboard and then definitively by sending a read command, so nothing here polls.

import { EventEmitter } from "node:events";
import { CMD, KEY_TO_AID, READ_CMDS, isNondisplay } from "./codes.js";
import { encode } from "./ebcdic.js";
import { assertCommandAllowed } from "./guard.js";
import { buildInbound, buildQueryReply, buildReadScreenReply, buildSaveScreenReply } from "./inbound.js";
import { ScreenBuffer, type Field, type ParsedRecord } from "./screen.js";
import { lastPaintedRow, messageLine } from "./snapshot.js";
import { ScreenStack, type Exchange, type Move } from "./stack.js";
import { Telnet5250Connection } from "./telnet.js";
import { NOOP_REPORTER, type Profile, type Reporter } from "./types.js";

const READ_GRACE_MS = 5;         // a read means the host is waiting, so this only catches a trailing record
const QUIET_MS = 120;            // for a host that unlocks without a read and splits a paint over records
const SETTLE_TIMEOUT_MS = 15000; // backstop for a host that never answers
// ponytail: Date.now() ticks every ~15.6ms on Windows, so a finer poll buys nothing. performance.now() would.
const POLL_MS = 5;

// CA keys tell the terminal to discard changed data, so typing then F3 loses the input. Correct 5250.
const CA_KEYS = new Set(["F3", "F12", "Clear"]);

const EXIT_PRESSES = 6; // menus nest

export class Session extends EventEmitter {
  readonly screen: ScreenBuffer;
  private lastReply = ""; // named in the timeout message
  private conn: Telnet5250Connection;
  private lastRecordAt = 0;
  private sawRead = false;
  private recordCount = 0;
  private lastReadWasAllFields = false;
  private closed = false;
  exchange: string[] = []; // the trace of each record since the last key, see ParsedRecord.trace
  private seen: Omit<Exchange, "key"> = { saved: false, restored: false, cleared: false };
  readonly stack = new ScreenStack();
  lastMove?: Move;

  constructor(readonly profile: Profile) {
    super();
    this.screen = new ScreenBuffer(profile.rows, profile.cols, profile.ccsid);
    this.conn = new Telnet5250Connection(profile);

    this.conn.on("record", (rec) => this.onRecord(rec));
    this.conn.on("close", () => {
      this.closed = true;
    });
  }

  get isClosed() {
    return this.closed;
  }

  private onRecord(rec: Buffer) {
    this.recordCount++;
    this.lastRecordAt = Date.now();

    let parsed: ParsedRecord;
    try {
      parsed = this.screen.apply(rec);
    } catch (e) {
      // Only the parse is wrapped, so a throw from a screen listener is not swallowed as one.
      console.error(`[ibm-i-5250] unparseable 5250 record: ${(e as Error).message}`);
      this.exchange.push("unparseable");
      return;
    }

    this.exchange.push(parsed.trace.join(", "));
    if (parsed.saveScreenRequested) this.seen.saved = true;
    if (parsed.commands.includes(CMD.RESTORE_SCREEN)) this.seen.restored = true;
    if (parsed.commands.includes(CMD.CLEAR_UNIT) || parsed.commands.includes(CMD.CLEAR_UNIT_ALTERNATE)) {
      this.seen.cleared = true;
    }
    if (parsed.commands.some((c) => READ_CMDS.has(c))) this.sawRead = true;
    if (parsed.commands.includes(CMD.READ_INPUT_FIELDS)) this.lastReadWasAllFields = true;
    else if (parsed.commands.includes(CMD.READ_MDT_FIELDS) || parsed.commands.includes(CMD.READ_MDT_FIELDS_ALT)) {
      this.lastReadWasAllFields = false;
    }

    // Housekeeping, not a screen change, so none of these may count as the screen settling.
    const reply = (what: string, record: Buffer) => {
      this.lastReply = what;
      this.conn.sendRecord(record);
      this.restartSettle();
    };
    if (parsed.queryRequested) reply("5250 Query", buildQueryReply(this.profile.terminalType, this.encoder));
    if (parsed.saveScreenRequested) reply("Save Screen", buildSaveScreenReply(this.screen));
    if (parsed.readScreenRequested) reply("Read Screen Immediate", buildReadScreenReply(this.screen.chars));
    if (parsed.readFieldsRequested) reply("Read Immediate", buildInbound(this.screen, 0x00));

    this.emit("screen", this.screen);
  }

  private restartSettle() {
    this.lastRecordAt = 0;
    this.sawRead = false;
  }

  // After a read there is only a grace for a trailing record. Without one the quiet period applies.
  settle(what = "screen"): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const tick = setInterval(() => {
        if (this.closed) {
          clearInterval(tick);
          return reject(new Error("the session closed while waiting for the host"));
        }
        const quietFor = this.sawRead ? READ_GRACE_MS : QUIET_MS;
        const quiet = this.lastRecordAt > 0 && Date.now() - this.lastRecordAt >= quietFor;
        if (quiet && !this.screen.keyboardLocked) {
          clearInterval(tick);
          return resolve();
        }
        if (Date.now() > deadline) {
          clearInterval(tick);
          // recordCount, not lastRecordAt: restartSettle zeroes that on every reply.
          const why =
            this.recordCount === 0
              ? "no record ever arrived from the host"
              : this.screen.keyboardLocked
                ? `the host never unlocked the keyboard (still busy). Last ${this.recordCount} records received` +
                  (this.lastReply ? `, most recently a ${this.lastReply} we answered` : ", none of them a request we recognise")
                : "the screen never went quiet";
          return reject(new Error(`timed out after ${SETTLE_TIMEOUT_MS}ms waiting for ${what}: ${why}`));
        }
      }, POLL_MS);
    });
  }

  async open(reporter: Reporter = NOOP_REPORTER): Promise<void> {
    reporter.step(`connecting to ${this.profile.host}:${this.profile.port}`);
    await this.conn.connect();
    reporter.step("negotiating TN5250E");
    await this.settle("first screen");
  }

  private encoder = (s: string) => encode(s, this.profile.ccsid);

  resolveField(which: string | { row: number; col: number }): Field {
    if (typeof which !== "string") {
      const f = this.screen.fieldAt(which.row, which.col);
      if (!f) throw new Error(`no field at ${which.row},${which.col}`);
      return f;
    }
    const byId = this.screen.fieldById(which);
    if (byId) return byId;
    throw new Error(
      `no field "${which}" on this screen. Available refs: ${this.screen.fields.map((f) => f.id).join(", ") || "none"}`,
    );
  }

  typeInto(f: Field, text: string) {
    if (this.looksLikeSignOn()) {
      throw new Error(
        `this is the sign on screen, not an application screen. Refusing to type into it: ` +
          `failed sign on attempts count towards QMAXSIGN and can disable the profile. ` +
          `session_open signs on for you.`,
      );
    }
    if (this.commandLineCandidates().some((c) => c.id === f.id)) {
      assertCommandAllowed(text, {
        restricted: this.profile.restricted,
        allowedCl: this.profile.allowedCl,
        blockedCl: this.profile.blockedCl,
      });
    }
    if (this.screen.covered(f)) {
      throw new Error(
        `field ${f.id} at ${f.row},${f.col} is underneath a window that was drawn over it. It is `+
          `still in the format table, which is why it is listed, but the host ignores anything `+
          `typed into it, so this would look like it worked and do nothing. Close the window `+
          `first, or use one of the fields inside it.`,
      );
    }
    if (f.protectedField) {
      throw new Error(
        `field ${f.id} at ${f.row},${f.col} is protected (output only), it cannot be typed into. ` +
          `A real terminal would beep and refuse.`,
      );
    }
    if (text.length > f.length) {
      throw new Error(`"${text}" is ${text.length} characters but field ${f.id} holds ${f.length}`);
    }
    this.screen.typeInto(f, text, this.encoder);
    this.emit("screen", this.screen);
  }

  // Local until the next AID key: cursor position is an argument to the key on a 5250.
  moveCursor(row: number, col: number) {
    if (row < 1 || row > this.screen.rows || col < 1 || col > this.screen.cols) {
      throw new Error(`cursor ${row},${col} is off a ${this.screen.rows}x${this.screen.cols} screen`);
    }
    this.screen.cursorRow = row;
    this.screen.cursorCol = col;
    this.emit("screen", this.screen);
  }

  async pressKey(key: string, reporter: Reporter = NOOP_REPORTER): Promise<void> {
    this.exchange = [];
    this.seen = { saved: false, restored: false, cleared: false };
    const name = normaliseKey(key);
    const aid = KEY_TO_AID[name];
    if (aid === undefined) {
      throw new Error(`unknown key "${key}". Known: ${Object.keys(KEY_TO_AID).join(", ")}`);
    }
    const record = buildInbound(this.screen, aid, {
      allFields: this.lastReadWasAllFields,
      suppressFields: CA_KEYS.has(name),
    });
    reporter.step(`pressing ${key}`);
    // Lock on send, or the previous screen's unlocked state satisfies settle() immediately.
    this.screen.keyboardLocked = true;
    this.screen.alarm = false;
    this.restartSettle();
    this.conn.sendRecord(record);
    await this.settle(`the response to ${key}`);
    this.lastMove = this.stack.observe(this.screen, { key: name, ...this.seen });
    this.emit("moved");
  }

  async signOn(reporter: Reporter = NOOP_REPORTER): Promise<void> {
    if (!this.looksLikeSignOn()) {
      reporter.log("info", "not on a sign on screen, skipping sign on");
      return;
    }
    const input = this.screen.inputFields();
    if (input.length < 2) throw new Error("sign on screen has fewer than two input fields");

    reporter.step(`signing on as ${this.profile.user}`);
    // By the nondisplay bit, not by position: on a customised screen input[1] may be Program, which
    // would render the password and send it as a name.
    const pw = input.find((f) => isNondisplay(f.attr)) ?? input[1];
    this.screen.typeInto(input[0], this.profile.user, this.encoder);
    this.screen.typeInto(pw, this.profile.password, this.encoder);

    const landing = [this.profile.initialProgram, this.profile.initialMenu, this.profile.initialLibrary];
    landing.forEach((val, i) => {
      if (val && input[i + 2]) this.screen.typeInto(input[i + 2], val, this.encoder);
    });

    await this.pressKey("Enter", reporter);

    const msg = messageLine(this.screen);
    if (msg && /CPF1[01]\d\d|CPF22\d\d/.test(msg)) throw new Error(`sign on failed: ${msg}`);
    if (this.looksLikeSignOn()) {
      throw new Error(`still on the sign on screen after Enter${msg ? `: ${msg}` : ""}`);
    }
  }

  async establish(reporter: Reporter = NOOP_REPORTER): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.looksLikeSignOn()) await this.signOn(reporter);
      if (this.looksLikeRecovery()) {
        await this.clearRecovery(reporter);
        continue; // clearing drops us back to sign on
      }
      if (this.looksLikeAcknowledgement()) {
        reporter.step("acknowledging a sign on message screen");
        await this.pressKey("Enter", reporter);
        continue; // the application screen is behind it
      }
      // Sign on and recovery are not where the user is, so the stack starts here.
      this.stack.reset(this.screen);
      this.emit("moved");
      return;
    }
    throw new Error("could not reach an application screen after three attempts (sign on and recovery kept repeating)");
  }

  // Shown when a previous job on this device was dropped rather than signed off.
  looksLikeRecovery(): boolean {
    return /Attempt to Recover Interactive Job/i.test(this.screen.text());
  }

  // Option 90 signs the previous job off. Option 1 resumes it, and a test wants a fresh job.
  private async clearRecovery(reporter: Reporter): Promise<void> {
    reporter.step("clearing a disconnected job left on this device");
    const sel = this.screen.inputFields()[0];
    if (!sel) throw new Error("recovery screen has no selection field");
    this.screen.typeInto(sel, "90", this.encoder);
    await this.pressKey("Enter", reporter);
    await this.clearSignOffPrompt(reporter);
  }

  // Recovery option 90 and typing signoff can both land on the Sign Off prompt rather than run it.
  private async clearSignOffPrompt(reporter: Reporter): Promise<void> {
    for (let i = 0; i < 2 && /Sign Off \(SIGNOFF\)/i.test(this.screen.text()); i++) {
      await this.pressKey("Enter", reporter);
    }
  }

  // Structural, so it holds on a translated screen. The text match is an alternative and never a
  // requirement: ANDing the two disengaged this on a French box.
  looksLikeSignOn(): boolean {
    const input = this.screen.inputFields();
    const stacked = input.filter((f) => f.length === 10 && f.col === input[0]?.col);
    if (stacked.length < 4) return false;
    return (
      stacked.some((f) => isNondisplay(f.attr)) ||
      /Sign On|Aanmelden|Anmeldung/i.test(this.screen.text())
    );
  }

  // Taking no input at all is the guard, so this can never auto answer a question.
  looksLikeAcknowledgement(): boolean {
    return (
      this.screen.inputFields().length === 0 &&
      !this.looksLikeConfirmation() &&
      /Press Enter to continue|Druk op Enter/i.test(this.screen.text())
    );
  }

  // Gates automatic keystrokes only. A program under test paints its own panels and answering them
  // is the point of a test.
  looksLikeConfirmation(): boolean {
    return /\(Y\/N\)|Y=Yes|Confirm|Bevestig|Weet [uj]e? het zeker|Bestätig/i.test(this.screen.text());
  }

  commandLine(): Field | undefined {
    return this.commandLineCandidates()[0];
  }

  // Nothing on the wire says "command line". ===> is the nearest thing, and being punctuation it
  // reads the same on a translated box. 100 is the width IBM gives its own, where a mail subject is
  // 35. Sign off types into the top pick, so a false positive puts signoff in a customer name. The
  // guard checks every candidate, so a wider field elsewhere must not hide the real one.
  commandLineCandidates(): Field[] {
    const lastPainted = lastPaintedRow(this.screen);
    const prompted = (f: Field) => this.screen.line(f.row).slice(0, f.col - 1).includes("==>");
    return this.screen
      .inputFields()
      .filter((f) => f.row >= lastPainted - 7 && (f.length >= 100 || prompted(f)))
      .filter((f) => !this.screen.covered(f))
      .sort((a, b) => b.length - a.length);
  }

  // The top menu of an application stack ignores F3 and its option field is two characters wide, so
  // its own sign off option is the only way off it. The number is read off the screen because 90 is
  // a convention rather than a rule.
  signOffOption(): { field: Field; option: string } | undefined {
    const m = /^\s*(\d{1,2})\.\s+(sign ?off|afmelden|abmelden|log ?off)/im.exec(this.screen.text());
    const field = this.screen.inputFields()[0];
    if (!m || !field || field.length < m[1].length) return undefined;
    return { field, option: m[1] };
  }

  // Dropping the socket leaves the job pending recovery under the default QDEVRCYACN, so the next
  // run meets "Attempt to Recover Interactive Job" and it holds licensed capacity. Best effort.
  async signOff(reporter: Reporter = NOOP_REPORTER): Promise<boolean> {
    if (this.closed) return false;
    if (this.looksLikeSignOn()) {
      reporter.log("info", "already signed off, the device is free");
      return true;
    }
    try {
      // A real session ends inside an application, so press out to a command line first.
      for (let i = 0; i < EXIT_PRESSES && !this.commandLine(); i++) {
        if (this.looksLikeSignOn()) break;
        // Cancel, not exit, when the screen is asking something. Both discard rather than commit.
        const key = this.looksLikeConfirmation() ? "F12" : "F3";
        reporter.step(`pressing ${key} to reach a screen with a command line`);
        const before = this.screen.text();
        await this.pressKey(key, reporter);
        // The same key on the same screen gives the same nothing, so let the menu route below have it.
        if (this.screen.text() === before) break;
      }
      if (this.looksLikeSignOn()) {
        reporter.log("info", "signed off, the device is free");
        return true;
      }

      const cmd = this.commandLine();
      if (!cmd) {
        const menu = this.signOffOption();
        if (!menu) {
          reporter.log("info", "no command line reachable from this screen, closing without a sign off");
          return false;
        }
        reporter.step(`taking menu option ${menu.option} to sign off`);
        this.screen.typeInto(menu.field, menu.option, this.encoder);
        await this.pressKey("Enter", reporter);
        await this.clearSignOffPrompt(reporter);
        return this.looksLikeSignOn(); // the number came off the screen, so check rather than assume
      }
      reporter.step("signing off to release the device");
      // Straight to the buffer: typeInto's refusals exist to stop a caller doing something it did
      // not mean, and closing is not that.
      this.screen.typeInto(cmd, "signoff", this.encoder);
      await this.pressKey("Enter", reporter);
      await this.clearSignOffPrompt(reporter);
      return true;
    } catch (e) {
      reporter.log("warning", `sign off did not complete: ${(e as Error).message}`);
      return false;
    }
  }

  close() {
    this.conn.close();
    this.closed = true;
  }
}

// An LLM reaches for lots of spellings. Null prototype, same reason as KEY_TO_AID.
const KEY_ALIASES: Record<string, string> = Object.assign(Object.create(null), {
  enter: "Enter", ret: "Enter", return: "Enter",
  pagedown: "PageDown", pgdn: "PageDown", rollup: "PageDown", next: "PageDown",
  pageup: "PageUp", pgup: "PageUp", rolldown: "PageUp", prev: "PageUp",
  clear: "Clear", help: "Help", print: "Print",
});

function normaliseKey(k: string): string {
  const t = k.trim().replace(/[\s_-]/g, "").toLowerCase();
  if (KEY_ALIASES[t]) return KEY_ALIASES[t];
  const fn = /^f(\d{1,2})$/.exec(t);
  return fn ? `F${Number(fn[1])}` : k;
}
