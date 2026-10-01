// 5250 data stream code tables. Adapted from green-screen-react (MIT, visionbridge-solutions),
// packages/proxy/src/tn5250/constants.ts.

export const ESC = 0x04;    // introduces a command inside a record's data
export const GDS = 0x12a0;  // General Data Stream, the header every 5250 record opens with

export const CMD = {
  CLEAR_UNIT: 0x40,
  CLEAR_UNIT_ALTERNATE: 0x20,
  CLEAR_FORMAT_TABLE: 0x50,
  WRITE_TO_DISPLAY: 0x11,
  WRITE_ERROR_CODE: 0x21,
  WRITE_ERROR_CODE_WINDOW: 0x22,
  READ_INPUT_FIELDS: 0x42,
  READ_MDT_FIELDS: 0x52,
  READ_MDT_FIELDS_ALT: 0x82,
  READ_SCREEN_IMMEDIATE: 0x62,
  READ_IMMEDIATE: 0x72,
  SAVE_SCREEN: 0x02,
  RESTORE_SCREEN: 0x12,
  WRITE_STRUCTURED_FIELD: 0xf3,
} as const;

// For the wire trace. Also names commands the parser skips, since whether IBM i sends them is what
// the trace is for.
export const CMD_NAMES: Record<number, string> = {
  [CMD.CLEAR_UNIT]: "clear unit",
  [CMD.CLEAR_UNIT_ALTERNATE]: "clear unit alternate",
  [CMD.CLEAR_FORMAT_TABLE]: "clear format table",
  [CMD.WRITE_TO_DISPLAY]: "write",
  [CMD.WRITE_ERROR_CODE]: "write error",
  [CMD.WRITE_ERROR_CODE_WINDOW]: "write error in window",
  [CMD.READ_INPUT_FIELDS]: "read input",
  [CMD.READ_MDT_FIELDS]: "read mdt",
  [CMD.READ_MDT_FIELDS_ALT]: "read mdt alt",
  [CMD.READ_SCREEN_IMMEDIATE]: "read screen",
  [CMD.READ_IMMEDIATE]: "read immediate",
  [CMD.SAVE_SCREEN]: "save screen",
  0x03: "save partial screen",
  [CMD.RESTORE_SCREEN]: "restore screen",
  0x13: "restore partial screen",
  0x23: "roll",
  [CMD.WRITE_STRUCTURED_FIELD]: "structured field",
};

// A read means the host has stopped painting and is waiting for input,
// which is the definitive readiness signal session.ts settles on.
export const READ_CMDS = new Set<number>([
  CMD.READ_INPUT_FIELDS,
  CMD.READ_MDT_FIELDS,
  CMD.READ_MDT_FIELDS_ALT,
  CMD.READ_SCREEN_IMMEDIATE,
  CMD.READ_IMMEDIATE,
]);

export const ORDER = {
  SOH: 0x01,
  RA: 0x02,
  EA: 0x03,
  TD: 0x10,
  SBA: 0x11,
  WEA: 0x12,
  IC: 0x13,
  MC: 0x14,
  WDSF: 0x15,
  SF: 0x1d,
} as const;

// An attribute byte occupies a screen cell, renders blank, and governs the cells after it.
// Ignoring that shifts every column by one.
export const ATTR_GREEN = 0x20;
export const isAttribute = (b: number) => b >= 0x20 && b <= 0x3f;

const ATTR_PAIRS = [
  ["green", "white"],
  ["red", "red"],
  ["turquoise", "yellow"],
  ["pink", "blue"],
] as const;

export interface Attr {
  colour: (typeof ATTR_PAIRS)[number][number];
  reverse: boolean;
  underline: boolean;
  nondisplay: boolean;
}

// Nondisplay outranks every other bit and is the only thing marking a password field, so the test
// for it is a bit test rather than a comparison against a name that could be misspelled.
export const isNondisplay = (a: number) => (a & 0x07) === 0x07;

// Reverse image fills the whole run, trailing blanks included, so 0x31 is a turquoise bar rather
// than turquoise text on black.
export function attrOf(a: number): Attr {
  const nondisplay = isNondisplay(a);
  return {
    colour: ATTR_PAIRS[(a >> 3) & 0x03][(a >> 1) & 0x01],
    reverse: !nondisplay && (a & 0x01) !== 0,
    underline: !nondisplay && (a & 0x04) !== 0,
    nondisplay,
  };
}

export function attrName(a: number): string {
  const { colour, nondisplay } = attrOf(a);
  return nondisplay ? "nondisplay" : colour;
}

// Field Format Word: the two bytes that may precede a field's attribute.
export const FFW = {
  PRESENT: 0x40,    // marks byte 1 as an FFW at all
  BYPASS: 0x20,     // protected, output only, the cursor skips it
  MDT: 0x08,
  SHIFT_MASK: 0x07,
  AUTO_ENTER: 0x80, // byte 2 from here
  MONOCASE: 0x20,
  MANDATORY: 0x08,
} as const;

export const SHIFT = [
  "alpha shift", "alpha only", "numeric shift", "numeric only",
  "katakana", "digits only", "io", "signed numeric",
] as const;

export type Shift = (typeof SHIFT)[number];

export const CC2 = {
  UNLOCK_KEYBOARD: 0x02, // the readiness bit the whole settle logic depends on
  SOUND_ALARM: 0x04,
  RESET_MDT: 0x20,
  CLEAR_MASTER_MDT: 0x80,
} as const;

export const AID = {
  ENTER: 0xf1,
  F1: 0x31, F2: 0x32, F3: 0x33, F4: 0x34, F5: 0x35, F6: 0x36,
  F7: 0x37, F8: 0x38, F9: 0x39, F10: 0x3a, F11: 0x3b, F12: 0x3c,
  F13: 0xb1, F14: 0xb2, F15: 0xb3, F16: 0xb4, F17: 0xb5, F18: 0xb6,
  F19: 0xb7, F20: 0xb8, F21: 0xb9, F22: 0xba, F23: 0xbb, F24: 0xbc,
  ROLL_DOWN: 0xf4,
  ROLL_UP: 0xf5,
  CLEAR: 0xbd,
  HELP: 0xf3,
  PRINT: 0xf6,
} as const;

export const KEY_TO_AID: Record<string, number> = Object.assign(Object.create(null), {
  Enter: AID.ENTER,
  F1: AID.F1, F2: AID.F2, F3: AID.F3, F4: AID.F4, F5: AID.F5, F6: AID.F6,
  F7: AID.F7, F8: AID.F8, F9: AID.F9, F10: AID.F10, F11: AID.F11, F12: AID.F12,
  F13: AID.F13, F14: AID.F14, F15: AID.F15, F16: AID.F16, F17: AID.F17, F18: AID.F18,
  F19: AID.F19, F20: AID.F20, F21: AID.F21, F22: AID.F22, F23: AID.F23, F24: AID.F24,
  PageUp: AID.ROLL_DOWN, PgUp: AID.ROLL_DOWN, RollDown: AID.ROLL_DOWN,
  PageDown: AID.ROLL_UP, PgDn: AID.ROLL_UP, RollUp: AID.ROLL_UP,
  Clear: AID.CLEAR,
  Help: AID.HELP,
  Print: AID.PRINT,
});
