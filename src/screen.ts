// The regeneration buffer and the format table: everything an emulator holds in memory for the
// current screen, built by walking a Write To Display order stream.

import { decode, DEFAULT_CCSID } from "./ebcdic.js";
import { ATTR_GREEN, CC2, CMD, CMD_NAMES, ESC, FFW, GDS, isAttribute, isNondisplay, ORDER, SHIFT, attrOf, type Attr, type Shift } from "./codes.js";

export interface Field {
  id: string;              // f1, f2, ... stable within one screen, the model's handle
  row: number;             // 1 based, the first DATA cell, which is one past the attribute
  col: number;
  length: number;
  attr: number;
  protectedField: boolean;
  shift: Shift;
  monocase: boolean;
  mandatory: boolean;
  autoEnter: boolean;
  mdt: boolean;            // set locally when we type into it, sent back on an AID key
  seq: number;             // the record that defined it, against paint, see covered()
}

export interface ParsedRecord {
  commands: number[];
  unlockedKeyboard: boolean;
  soundAlarm: boolean;
  sawInsertCursor: boolean;
  queryRequested: boolean;      // host sent the 5250 Query and is waiting for a reply
  saveScreenRequested: boolean; // host asked for the screen back and is waiting
  readScreenRequested: boolean; // Read Screen Immediate: the host wants the buffer, not the operator
  readFieldsRequested: boolean; // Read Immediate: the host wants the MDT fields, not the operator
  trace: string[];              // how the host drew it, never what it drew
}

const NULL_CELL = 0x00;

// A truncated record reads undefined past its end, and a throw here would drop the whole record.
const hex = (...bytes: (number | undefined)[]) =>
  bytes.map((b) => (b === undefined ? "--" : b.toString(16).padStart(2, "0"))).join(" ");

const OPERANDS: Record<number, number> = {
  [ORDER.SBA]: 2,
  [ORDER.RA]: 3,
  [ORDER.EA]: 2,
  [ORDER.IC]: 2,
  [ORDER.MC]: 2,
  [ORDER.WEA]: 2,
  [ORDER.TD]: 2,
};

export class ScreenBuffer {
  rows: number;             // not readonly: the host picks the geometry per screen, see clearUnit
  cols: number;
  readonly altRows: number; // the larger geometry this session negotiated
  readonly altCols: number;
  chars: Uint8Array;        // raw EBCDIC, one byte per cell
  attrs: Uint8Array;
  fields: Field[] = [];
  cursorRow = 1;
  cursorCol = 1;
  keyboardLocked = true;
  alarm = false;
  ccsid: number;
  keyMask = ""; // the Start of Header's function key switches, which the record format sets

  private pos = 0;
  private seq = 0;
  private errorRow = 0; // from the Start of Header, 0 until one arrives
  private paint!: Uint32Array; // per cell, the record that last wrote it
  private curAttr: number = ATTR_GREEN;
  private definedHere: Field[] = []; // fields the record being applied defined, for the cursor default

  // rows and cols are the largest geometry negotiated, 27x132 for an IBM-3477-FC.
  // The buffer starts at 24x80, because that is the size the host addresses until it says otherwise.
  constructor(rows = 24, cols = 80, ccsid = DEFAULT_CCSID) {
    this.altRows = rows;
    this.altCols = cols;
    this.rows = Math.min(24, rows);
    this.cols = Math.min(80, cols);
    this.ccsid = ccsid;
    this.chars = new Uint8Array(this.rows * this.cols);
    this.attrs = new Uint8Array(this.rows * this.cols).fill(ATTR_GREEN);
    this.paint = new Uint32Array(this.rows * this.cols);
  }

  private idx(row: number, col: number) {
    return (row - 1) * this.cols + (col - 1);
  }

  clearUnit(rows: number, cols: number) {
    if (rows !== this.rows || cols !== this.cols) {
      this.rows = rows;
      this.cols = cols;
      this.chars = new Uint8Array(rows * cols);
      this.attrs = new Uint8Array(rows * cols);
      this.paint = new Uint32Array(rows * cols);
    }
    this.chars.fill(NULL_CELL);
    this.attrs.fill(ATTR_GREEN);
    this.fields = [];
    this.errorRow = 0;
    this.keyMask = "";
    this.pos = 0;
    this.curAttr = ATTR_GREEN;
    this.cursorRow = 1;
    this.cursorCol = 1;
  }

  clearFormatTable() {
    this.fields = []; // leaves the pixels: this is how a repaint keeps its layout
    this.errorRow = 0;
    this.keyMask = "";
  }

  // As tn5250 reads it: a row past the screen, which IBM i sends on a 27 row display, means the last.
  messageRow(): number {
    return this.errorRow >= 1 && this.errorRow <= this.rows ? this.errorRow : this.rows;
  }

  // Hidden fields are masked for live view, logs, snapshots
  line(row: number): string {
    const start = this.idx(row, 1);
    const out: number[] = [];
    for (let c = 0; c < this.cols; c++) {
      const i = start + c;
      out.push(isNondisplay(this.attrs[i]) ? 0x40 : this.chars[i]);
    }
    return decode(out, this.ccsid);
  }

  lines(): string[] {
    return Array.from({ length: this.rows }, (_, i) => this.line(i + 1));
  }

  text(): string {
    return this.lines().join("\n");
  }

  // Not masked, so not for display: see displayValueOf.
  valueOf(f: Field): string {
    const start = this.idx(f.row, f.col);
    return decode(this.chars.subarray(start, start + f.length), this.ccsid);
  }

  displayValueOf(f: Field): string | undefined {
    return isNondisplay(f.attr) ? undefined : this.valueOf(f);
  }

  bytesOf(f: Field): Uint8Array {
    const start = this.idx(f.row, f.col);
    return this.chars.subarray(start, start + f.length);
  }

  attrAt(row: number, col: number): Attr {
    return attrOf(this.attrs[this.idx(row, col)]);
  }

  fieldById(id: string): Field | undefined {
    return this.fields.find((f) => f.id === id);
  }

  // A 313 character command line starts on one row and ends on another.
  fieldAt(row: number, col: number): Field | undefined {
    const p = this.idx(row, col);
    return this.fields.find((f) => {
      const start = this.idx(f.row, f.col);
      return p >= start && p < start + f.length;
    });
  }

  inputFields(): Field[] {
    return this.fields.filter((f) => !f.protectedField);
  }

  // Left justified only: right adjust needs the FFW adjust bits and only matters for numeric entry.
  typeInto(f: Field, text: string, encodeFn: (s: string) => Buffer): void {
    const bytes = encodeFn(f.monocase ? text.toUpperCase() : text);
    const start = this.idx(f.row, f.col);
    for (let i = 0; i < f.length; i++) {
      this.chars[start + i] = i < bytes.length ? bytes[i] : 0x40;
      // line() masks per cell, so a nondisplay field the host never painted would leak from text().
      this.attrs[start + i] = f.attr;
    }
    f.mdt = true;
  }

  private fillTo(row: number, col: number, byte: number) {
    const end = this.idx(Math.max(1, row), Math.max(1, col));
    while (this.pos <= end && this.pos < this.chars.length) {
      this.chars[this.pos] = byte;
      this.attrs[this.pos] = this.curAttr;
      this.pos++;
    }
  }

  private writeCell(b: number) {
    if (this.pos >= this.chars.length) return;
    if (isAttribute(b)) this.curAttr = b;
    this.chars[this.pos] = b;
    this.attrs[this.pos] = this.curAttr;
    this.paint[this.pos] = this.seq;
    this.pos++;
  }

  // A DDS window is drawn as plain characters over the screen below it, and IBM i sends nothing that says so.
  // The format table therefore still holds the fields underneath but the host ignores anything typed into them.
  covered(f: Field): boolean {
    const start = this.idx(f.row, f.col);
    for (let p = start; p < start + f.length && p < this.paint.length; p++) {
      if (this.paint[p] > f.seq) return true;
    }
    return false;
  }

  apply(record: Buffer): ParsedRecord {
    if (record.length < 10) throw new Error(`5250 record too short: ${record.length} bytes`);
    const type = record.readUInt16BE(2);
    if (type !== GDS) throw new Error(`not a GDS record: 0x${type.toString(16)}`);

    let i = 6 + record[6]; // header length 4 puts the data at offset 10
    this.seq++;
    this.definedHere = [];
    const out: ParsedRecord = {
      commands: [],
      unlockedKeyboard: false,
      soundAlarm: false,
      sawInsertCursor: false,
      queryRequested: false,
      saveScreenRequested: false,
      readScreenRequested: false,
      readFieldsRequested: false,
      trace: [],
    };

    while (i < record.length) {
      if (record[i] !== ESC) {
        i++; // stray data outside a command: a partial screen beats no screen
        continue;
      }
      const cmd = record[i + 1];
      out.commands.push(cmd);
      out.trace.push(CMD_NAMES[cmd] ?? hex(cmd));
      i = this.applyCommand(cmd, record, i + 2, out);
    }

    if (out.unlockedKeyboard) this.keyboardLocked = false;
    if (out.soundAlarm) this.alarm = true;
    if (!out.sawInsertCursor) {
      const first = this.definedHere.find((f) => !f.protectedField) ?? this.inputFields()[0];
      if (first) {
        this.cursorRow = first.row;
        this.cursorCol = first.col;
      }
    }
    return out;
  }

  // Returns the offset just past this command's operands.
  private applyCommand(cmd: number, r: Buffer, i: number, out: ParsedRecord): number {
    switch (cmd) {
      case CMD.CLEAR_UNIT:
        this.clearUnit(Math.min(24, this.altRows), Math.min(80, this.altCols));
        return i;

      case CMD.CLEAR_UNIT_ALTERNATE:
        this.clearUnit(this.altRows, this.altCols);
        return i + 1;

      case CMD.CLEAR_FORMAT_TABLE:
        this.clearFormatTable();
        return i;

      case CMD.WRITE_TO_DISPLAY: {
        out.trace[out.trace.length - 1] += ` ${hex(r[i], r[i + 1])}`;
        const cc2 = r[i + 1];
        if (cc2 & CC2.UNLOCK_KEYBOARD) out.unlockedKeyboard = true;
        if (cc2 & CC2.SOUND_ALARM) out.soundAlarm = true;
        if (cc2 & (CC2.CLEAR_MASTER_MDT | CC2.RESET_MDT)) for (const f of this.fields) f.mdt = false;
        return this.applyOrders(r, i + 2, out);
      }

      // The error text goes on the message row whatever the last write left the position at.
      case CMD.WRITE_ERROR_CODE:
        this.pos = this.idx(this.messageRow(), 1);
        return this.applyOrders(r, i, out);

      // The two window columns are read past, not used: tn5250 writes the text the same way.
      case CMD.WRITE_ERROR_CODE_WINDOW:
        this.pos = this.idx(this.messageRow(), 1);
        return this.applyOrders(r, i + 2, out);

      case CMD.READ_INPUT_FIELDS:
      case CMD.READ_MDT_FIELDS:
      case CMD.READ_MDT_FIELDS_ALT:
        out.unlockedKeyboard = true;
        return i + 2;

      case CMD.READ_SCREEN_IMMEDIATE:
        out.readScreenRequested = true;
        return i + 2;

      case CMD.READ_IMMEDIATE:
        out.readFieldsRequested = true;
        return i + 2;

      case CMD.WRITE_STRUCTURED_FIELD:
        // <length 2 bytes> <class> <type>, and class 0xD9 type 0x70 is the 5250 Query.
        out.trace[out.trace.length - 1] += ` ${hex(r[i + 2], r[i + 3])}`;
        if (r[i + 2] === 0xd9 && r[i + 3] === 0x70) out.queryRequested = true;
        return this.skipToNextEsc(r, i);

      case CMD.SAVE_SCREEN:
        out.saveScreenRequested = true;
        return this.skipToNextEsc(r, i);

      default:
        // Unhandled, such as restore or roll. Scan to the next ESC rather than guess an operand length.
        return this.skipToNextEsc(r, i);
    }
  }

  private skipToNextEsc(r: Buffer, i: number): number {
    while (i < r.length && r[i] !== ESC) i++;
    return i;
  }

  private applyOrders(r: Buffer, i: number, out: ParsedRecord): number {
    while (i < r.length) {
      const b = r[i];
      if (b === ESC) return i;

      const operands = OPERANDS[b];
      if (operands !== undefined && i + operands >= r.length) return r.length;

      switch (b) {
        // A header opens a new set of input fields, so it empties the format table as tn5250 does.
        // Without that, a format written over another without a clear keeps the old one's fields.
        case ORDER.SOH:
          out.trace.push(`header ${hex(...r.subarray(i + 2, i + 2 + r[i + 1]))}`);
          this.fields = [];
          this.definedHere = [];
          this.errorRow = r[i + 1] >= 4 ? (r[i + 5] ?? 0) : 0;
          this.keyMask = r[i + 1] >= 7 ? hex(r[i + 6], r[i + 7], r[i + 8]) : "";
          i += 2 + r[i + 1];
          continue;

        case ORDER.SBA:
          this.pos = this.idx(Math.max(1, r[i + 1]), Math.max(1, r[i + 2]));
          i += 3;
          continue;

        case ORDER.RA:
        case ORDER.EA: {
          const repeat = b === ORDER.RA;
          this.fillTo(r[i + 1], r[i + 2], repeat ? r[i + 3] : NULL_CELL);
          i += repeat ? 4 : 3;
          continue;
        }

        case ORDER.IC:
        case ORDER.MC:
          this.cursorRow = Math.max(1, r[i + 1]);
          this.cursorCol = Math.max(1, r[i + 2]);
          out.sawInsertCursor = true;
          i += 3;
          continue;

        case ORDER.TD: {
          const len = (r[i + 1] << 8) | r[i + 2];
          i += 3;
          for (let k = 0; k < len && i < r.length; k++, i++) this.writeCell(r[i]);
          continue;
        }

        case ORDER.WEA:
          i += 3;
          continue;

        case ORDER.WDSF:
          out.trace.push(`wdsf ${hex(r[i + 3], r[i + 4])}`);
          i += 1 + Math.max(2, (r[i + 1] << 8) | r[i + 2]);
          continue;

        case ORDER.SF:
          i = this.startField(r, i);
          continue;

        default:
          this.writeCell(b);
          i++;
          continue;
      }
    }
    return i;
  }

  // SF: an optional Field Format Word, then optional Field Control Words, then the attribute byte,
  // then a 2 byte length. From the real capture: 1d 40 20 24 00 0a
  //   1d SF | 40 20 FFW | 24 attribute (underscore) | 00 0a length 10
  private startField(r: Buffer, i: number): number {
    i++;

    let ffw1 = 0;
    let ffw2 = 0;
    if ((r[i] & FFW.PRESENT) !== 0) {
      ffw1 = r[i];
      ffw2 = r[i + 1];
      i += 2;
    }

    // Field Control Words are pairs whose first byte has the high bit set. They carry continuation
    // and magnetic stripe options, nothing we automate on.
    while (i + 1 < r.length && (r[i] & 0x80) !== 0) i += 2;

    let attr = ATTR_GREEN;
    if (isAttribute(r[i])) {
      attr = r[i];
      this.writeCell(r[i]);
      i++;
    }

    if (i + 1 >= r.length) return r.length;
    const length = (r[i] << 8) | r[i + 1];
    i += 2;

    const field: Omit<Field, "id"> = {
      row: Math.floor(this.pos / this.cols) + 1, // pos sits on the first data cell
      col: (this.pos % this.cols) + 1,
      length,
      seq: this.seq,
      attr,
      protectedField: (ffw1 & FFW.BYPASS) !== 0,
      shift: SHIFT[ffw1 & FFW.SHIFT_MASK],
      monocase: (ffw2 & FFW.MONOCASE) !== 0,
      mandatory: (ffw2 & FFW.MANDATORY) !== 0,
      autoEnter: (ffw2 & FFW.AUTO_ENTER) !== 0,
      mdt: (ffw1 & FFW.MDT) !== 0,
    };

    const at = this.fields.findIndex((f) => f.row === field.row && f.col === field.col);
    const created = { ...field, id: at >= 0 ? this.fields[at].id : `f${this.fields.length + 1}` };
    if (at >= 0) this.fields[at] = created;
    else this.fields.push(created);
    this.definedHere.push(created);

    return i;
  }
}
