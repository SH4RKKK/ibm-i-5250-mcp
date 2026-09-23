// The record that goes back to the host when a key is pressed: which key, where the cursor was, and
// every field whose modified data tag is set. Nothing goes back until an AID key.

import { CMD, ESC, FFW, GDS, ORDER, SHIFT } from "./codes.js";
import type { Field, ScreenBuffer } from "./screen.js";

const SAVE_SCREEN_OPCODE = 0x04;

interface InboundOptions {
  allFields?: boolean;      // Read Input Fields wants every field, Read MDT Fields only the touched ones
  suppressFields?: boolean; // CA style keys discard changed data, so only key and cursor go back
}

// GDS header: 0..1 total length, 2..3 type, 4..5 reserved, 6 header length, 7..8 flags, 9 opcode.
function gdsRecord(body: Uint8Array | number[], opcode = 0x00): Buffer {
  const b = Buffer.from(body);
  const rec = Buffer.alloc(10 + b.length);
  rec.writeUInt16BE(rec.length, 0);
  rec.writeUInt16BE(GDS, 2);
  rec.writeUInt16BE(0, 4);
  rec[6] = 4;
  rec.writeUInt16BE(0, 7);
  rec[9] = opcode;
  b.copy(rec, 10);
  return rec;
}

// Row and column travel as single bytes, so a wild value would corrupt the record silently.
function clampByte(n: number): number {
  return Math.max(1, Math.min(255, Math.round(n)));
}

export function buildInbound(screen: ScreenBuffer, aid: number, opts: InboundOptions = {}): Buffer {
  const body: number[] = [clampByte(screen.cursorRow), clampByte(screen.cursorCol), aid];
  if (!opts.suppressFields) {
    // Only the fields the operator touched, or an RPG program sees changes nobody made.
    for (const f of screen.inputFields().filter((f) => opts.allFields || f.mdt)) {
      // The buffer's own bytes. decode() then encode() turns every null cell into a 0x40 blank.
      body.push(ORDER.SBA, clampByte(f.row), clampByte(f.col), ...screen.bytesOf(f));
    }
  }
  return gdsRecord(body);
}

// The host sends a Write Structured Field of class 0xD9 type 0x70 right after sign on and will not
// proceed until answered. Layout from the 5250 Functions Reference, QUERY command, table 89.
export function buildQueryReply(terminalType: string, encodeFn: (s: string) => Buffer): Buffer {
  const q = Buffer.alloc(61, 0x00);

  q[2] = 0x88; // AID: inbound Write Structured Field, cursor row and col stay zero
  q[3] = 0x00; // length of the reply that follows, 0x003A = 58
  q[4] = 0x3a;
  q[5] = 0xd9; // command class
  q[6] = 0x70; // command type: query
  q[7] = 0x80; // flag byte: a display reply, with nothing following it

  q[8] = 0x06;  // controller hardware class: other WSF or another emulator
  q[10] = 0x01; // controller code level, version 1 release 1.0
  q[11] = 0x01;
  q[29] = 0x01; // display emulation, as opposed to printer. q[13..28] stay zero: reserved

  // Must agree with the TERMINAL-TYPE negotiation or the host is told two different things. A non
  // numeric model reports as 00: IBM-3477-FC has model "FC".
  const m = /^IBM-(\d{4})(?:-(\w+))?/i.exec(terminalType);
  const rawModel = m?.[2] ?? "";
  encodeFn(m ? m[1] : "3179").copy(q, 30); // 4 digits at 30..33, 34 stays zero
  encodeFn((/^\d+$/.test(rawModel) ? rawModel.padStart(2, "0").slice(-2) : "00").slice(0, 2)).copy(q, 35);

  q[37] = 0x02; // standard keyboard
  q[41] = 0x61; // display serial number, zero when there is none
  q[42] = 0x50;
  q[44] = 0xff; // maximum number of input fields
  q[45] = 0xff;
  q[49] = 0x23; // controller and display capability
  q[50] = 0x31;
  // q[51..60] stay zero: claiming enhanced 5250 would invite windows and selection fields we do not parse.
  // ponytail: set q[53] and q[54] when WDSF support arrives.

  return gdsRecord(q);
}

// IBM i sends Read Screen Immediate before opening a window and will not paint it until answered.
export function buildReadScreenReply(chars: Uint8Array): Buffer {
  return gdsRecord(chars);
}

// The terminal holds the screen, not the host, so before covering it the host asks for it back and
// stops until it hears one. It keeps this record verbatim and plays it back as a Restore Screen. An
// empty one leaves IBM i nothing to restore and it ends the job on the next key with no message.
export function buildSaveScreenReply(screen: ScreenBuffer): Buffer {
  // The stream names its own geometry: the host clears to 24x80 before replaying it, so a 27x132
  // screen without this pours 3564 cells into an 80 column buffer. Clearing the unit also empties
  // the format table, so the restore replaces rather than adds.
  const body: number[] = [ESC];
  if (screen.cols === 80) body.push(CMD.CLEAR_UNIT);
  else body.push(CMD.CLEAR_UNIT_ALTERNATE, 0x00);
  body.push(ESC, CMD.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 1, 1);

  // A field's attribute lives in the cell before its data, and Start Field writes that cell itself.
  const starts = new Map<number, Field>();
  for (const f of screen.fields) starts.set((f.row - 1) * screen.cols + f.col - 2, f);

  for (let p = 0; p < screen.chars.length; p++) {
    const f = starts.get(p);
    if (f) body.push(ORDER.SF, ffw1(f), ffw2(f), f.attr, f.length >> 8, f.length & 0xff);
    else body.push(screen.chars[p]);
  }
  body.push(ORDER.IC, clampByte(screen.cursorRow), clampByte(screen.cursorCol));
  return gdsRecord(body, SAVE_SCREEN_OPCODE);
}

function ffw1(f: Field): number {
  const shift = SHIFT.indexOf(f.shift);
  return FFW.PRESENT | (f.protectedField ? FFW.BYPASS : 0) | (f.mdt ? FFW.MDT : 0) | shift;
}

function ffw2(f: Field): number {
  return (f.monocase ? FFW.MONOCASE : 0) | (f.mandatory ? FFW.MANDATORY : 0) | (f.autoEnter ? FFW.AUTO_ENTER : 0);
}
