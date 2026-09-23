// GENERATED from the Python standard library codecs:
//   python -c "import json;[print(c, json.dumps(bytes(range(0x40,0x100)).decode('cp%d'%c))) for c in (37,273,500,1140)]"
// The \uXXXX escapes are what stops an encoding slip mangling a table in transit.
const TABLES: Record<number, string> = {
  37:
    " \u00a0\u00e2\u00e4\u00e0\u00e1\u00e3\u00e5\u00e7\u00f1\u00a2.<(+|&\u00e9\u00ea\u00eb\u00e8\u00ed\u00ee\u00ef\u00ec\u00df!$*);\u00ac-/\u00c2\u00c4\u00c0\u00c1\u00c3\u00c5\u00c7\u00d1\u00a6,%_>?\u00f8\u00c9\u00ca\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc`:#@'=\"\u00d8abcdefghi\u00ab\u00bb\u00f0\u00fd\u00fe\u00b1\u00b0jklmnopqr\u00aa\u00ba\u00e6\u00b8\u00c6\u00a4\u00b5~stuvwxyz\u00a1\u00bf\u00d0\u00dd\u00de\u00ae^\u00a3\u00a5\u00b7\u00a9\u00a7\u00b6\u00bc\u00bd\u00be[]\u00af\u00a8\u00b4\u00d7{ABCDEFGHI\u00ad\u00f4\u00f6\u00f2\u00f3\u00f5}JKLMNOPQR\u00b9\u00fb\u00fc\u00f9\u00fa\u00ff\\\u00f7STUVWXYZ\u00b2\u00d4\u00d6\u00d2\u00d3\u00d50123456789\u00b3\u00db\u00dc\u00d9\u00da\u009f",
  273:
    " \u00a0\u00e2{\u00e0\u00e1\u00e3\u00e5\u00e7\u00f1\u00c4.<(+!&\u00e9\u00ea\u00eb\u00e8\u00ed\u00ee\u00ef\u00ec~\u00dc$*);^-/\u00c2[\u00c0\u00c1\u00c3\u00c5\u00c7\u00d1\u00f6,%_>?\u00f8\u00c9\u00ca\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc`:#\u00a7'=\"\u00d8abcdefghi\u00ab\u00bb\u00f0\u00fd\u00fe\u00b1\u00b0jklmnopqr\u00aa\u00ba\u00e6\u00b8\u00c6\u00a4\u00b5\u00dfstuvwxyz\u00a1\u00bf\u00d0\u00dd\u00de\u00ae\u00a2\u00a3\u00a5\u00b7\u00a9@\u00b6\u00bc\u00bd\u00be\u00ac|\u203e\u00a8\u00b4\u00d7\u00e4ABCDEFGHI\u00ad\u00f4\u00a6\u00f2\u00f3\u00f5\u00fcJKLMNOPQR\u00b9\u00fb}\u00f9\u00fa\u00ff\u00d6\u00f7STUVWXYZ\u00b2\u00d4\\\u00d2\u00d3\u00d50123456789\u00b3\u00db]\u00d9\u00da\u009f",
  500:
    " \u00a0\u00e2\u00e4\u00e0\u00e1\u00e3\u00e5\u00e7\u00f1[.<(+!&\u00e9\u00ea\u00eb\u00e8\u00ed\u00ee\u00ef\u00ec\u00df]$*);^-/\u00c2\u00c4\u00c0\u00c1\u00c3\u00c5\u00c7\u00d1\u00a6,%_>?\u00f8\u00c9\u00ca\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc`:#@'=\"\u00d8abcdefghi\u00ab\u00bb\u00f0\u00fd\u00fe\u00b1\u00b0jklmnopqr\u00aa\u00ba\u00e6\u00b8\u00c6\u00a4\u00b5~stuvwxyz\u00a1\u00bf\u00d0\u00dd\u00de\u00ae\u00a2\u00a3\u00a5\u00b7\u00a9\u00a7\u00b6\u00bc\u00bd\u00be\u00ac|\u00af\u00a8\u00b4\u00d7{ABCDEFGHI\u00ad\u00f4\u00f6\u00f2\u00f3\u00f5}JKLMNOPQR\u00b9\u00fb\u00fc\u00f9\u00fa\u00ff\\\u00f7STUVWXYZ\u00b2\u00d4\u00d6\u00d2\u00d3\u00d50123456789\u00b3\u00db\u00dc\u00d9\u00da\u009f",
  1140:
    " \u00a0\u00e2\u00e4\u00e0\u00e1\u00e3\u00e5\u00e7\u00f1\u00a2.<(+|&\u00e9\u00ea\u00eb\u00e8\u00ed\u00ee\u00ef\u00ec\u00df!$*);\u00ac-/\u00c2\u00c4\u00c0\u00c1\u00c3\u00c5\u00c7\u00d1\u00a6,%_>?\u00f8\u00c9\u00ca\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc`:#@'=\"\u00d8abcdefghi\u00ab\u00bb\u00f0\u00fd\u00fe\u00b1\u00b0jklmnopqr\u00aa\u00ba\u00e6\u00b8\u00c6\u20ac\u00b5~stuvwxyz\u00a1\u00bf\u00d0\u00dd\u00de\u00ae^\u00a3\u00a5\u00b7\u00a9\u00a7\u00b6\u00bc\u00bd\u00be[]\u00af\u00a8\u00b4\u00d7{ABCDEFGHI\u00ad\u00f4\u00f6\u00f2\u00f3\u00f5}JKLMNOPQR\u00b9\u00fb\u00fc\u00f9\u00fa\u00ff\\\u00f7STUVWXYZ\u00b2\u00d4\u00d6\u00d2\u00d3\u00d50123456789\u00b3\u00db\u00dc\u00d9\u00da\u009f",
};

export const DEFAULT_CCSID = 37;

function tableFor(ccsid: number): string {
  const t = TABLES[ccsid];
  if (!t) throw new Error(`unsupported CCSID ${ccsid}, have ${Object.keys(TABLES).join(", ")}`);
  return t;
}

// One input byte to one output character.
// Every position this server reports is a column.
export function decode(bytes: Uint8Array | number[], ccsid = DEFAULT_CCSID): string {
  const t = tableFor(ccsid);
  let out = "";
  for (const b of bytes) out += b < 0x40 ? " " : t[b - 0x40];
  return out;
}

// Forward order, so the first byte mapping to a character wins where a CCSID maps two to one glyph.
const reverse = new Map<number, Map<string, number>>();

function reverseFor(ccsid: number): Map<string, number> {
  let m = reverse.get(ccsid);
  if (!m) {
    m = new Map();
    const t = tableFor(ccsid);
    for (let i = 0; i < t.length; i++) if (!m.has(t[i])) m.set(t[i], 0x40 + i);
    reverse.set(ccsid, m);
  }
  return m;
}

// Unrepresentable characters become 0x6F, EBCDIC "?".
export function encode(text: string, ccsid = DEFAULT_CCSID): Buffer {
  const m = reverseFor(ccsid);
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) out[i] = m.get(text[i]) ?? 0x6f;
  return out;
}
