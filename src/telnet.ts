// TN5250E transport: telnet option negotiation and record framing over a plain socket.
// It opens with IAC DO NEW-ENVIRON then IAC DO TERMINAL-TYPE and needs all
// four options below before it will send a 5250 record.

import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";
import type { Profile } from "./types.js";

const IAC = 255;
const SE = 240, SB = 250, WILL = 251, WONT = 252, DO = 253, DONT = 254;
const EOR = 239;

const OPT = { BINARY: 0, TERMTYPE: 24, EOR: 25, NEWENV: 39 } as const;
const NE = { IS: 0, VALUE: 1, USERVAR: 3 } as const; // NEW-ENVIRON sub options, RFC 1572
const TT = { IS: 0, SEND: 1 } as const;              // TERMINAL-TYPE sub options, RFC 1091

// Only these four are agreed to. Anything else is refused.
const AGREE_DO: number[] = [OPT.TERMTYPE, OPT.NEWENV, OPT.EOR, OPT.BINARY];
const AGREE_WILL: number[] = [OPT.EOR, OPT.BINARY];

const CONNECT_TIMEOUT_MS = 5000;

type TelnetOptions = Pick<Profile, "host" | "port" | "tls" | "tlsInsecure" | "deviceName" | "terminalType" | "ccsid">;

// Emits whole records with the IAC escaping already undone, so the parser never sees telnet framing.
export class Telnet5250Connection extends EventEmitter {
  private readonly deviceName: string;
  private sock?: net.Socket | tls.TLSSocket;
  private buf = Buffer.alloc(0); // raw, still telnet escaped
  private pending: number[] = []; // unescaped bytes of the record in progress
  private lastError?: Error; // a reset after connect() resolves has nowhere else to go

  constructor(private opts: TelnetOptions) {
    super();
    this.deviceName = (opts.deviceName || "").toUpperCase();
  }

  connect(): Promise<void> {
    const port = this.opts.port;
    return new Promise((resolve, reject) => {
      const onFail = (e: Error) => {
        clearTimeout(timer);
        reject(this.describe(e, port));
      };
      const timer = setTimeout(() => {
        this.sock?.destroy();
        onFail(new Error(`timed out after ${CONNECT_TIMEOUT_MS}ms`));
      }, CONNECT_TIMEOUT_MS);

      // The certificate is verified unless the profile opts out. The only reason to be on 992 is
      // that signOn() sends the password inside this.
      const sock = this.opts.tls
        ? tls.connect({
            host: this.opts.host,
            port,
            rejectUnauthorized: this.opts.tlsInsecure !== true,
            // RFC 6066 forbids an IP literal in SNI, and Node warns it will start ignoring one.
            ...(/^[\d.]+$/.test(this.opts.host) || this.opts.host.includes(":")
              ? {}
              : { servername: this.opts.host }),
          })
        : net.connect({ host: this.opts.host, port });
      if (this.opts.tls && this.opts.tlsInsecure) {
        console.error("[ibm-i-5250] IBMI_5250_TLS_INSECURE is set, the certificate is NOT verified");
      }
      this.sock = sock;

      // Nagle would hold a small write waiting for the ACK of the previous one, which is exactly
      // wrong for a protocol that sends one record and waits.
      sock.setNoDelay(true);

      sock.once(this.opts.tls ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        resolve();
      });
      sock.on("data", (d) => this.onData(d));
      sock.on("error", (e) => {
        this.lastError = e;
        onFail(e);
      });
      sock.on("close", () => this.emit("close", this.lastError));
    });
  }

  private describe(e: Error, port: number): Error {
    const code = (e as NodeJS.ErrnoException).code;
    const where = `${this.opts.host}:${port}`;
    if (code === "ECONNREFUSED") {
      return new Error(`${where} refused the connection. Is the telnet server started (strtcpsvr *telnet)?`);
    }
    if (code === "ENOTFOUND") return new Error(`cannot resolve ${this.opts.host}`);
    if (code === "ETIMEDOUT" || /timed out/.test(e.message)) {
      return new Error(`${where} did not answer. Check the VPN is up and the host is reachable.`);
    }
    return new Error(`${where}: ${e.message}`);
  }

  private write(bytes: number[] | Buffer) {
    this.sock?.write(Buffer.from(bytes));
  }

  // One socket data event is not one record: TCP splits records across events and packs several into
  // one. The classic 5250 client bug. Folding buf into pending double unescapes a 0xff that spans a
  // boundary, which is why they stay apart.
  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let i = 0;

    while (i < this.buf.length) {
      const b = this.buf[i];
      if (b !== IAC) {
        this.pending.push(b);
        i++;
        continue;
      }
      if (i + 1 >= this.buf.length) break; // a lone trailing IAC, wait for more

      const b1 = this.buf[i + 1];
      if (b1 === IAC) {
        this.pending.push(IAC); // an escaped 0xff is one real data byte
        i += 2;
        continue;
      }
      if (b1 === EOR) {
        if (this.pending.length) {
          this.emit("record", Buffer.from(this.pending));
          this.pending = [];
        }
        i += 2;
        continue;
      }
      if (b1 === SB) {
        let j = i + 3;
        while (j + 1 < this.buf.length && !(this.buf[j] === IAC && this.buf[j + 1] === SE)) j++;
        if (j + 1 >= this.buf.length) break; // subnegotiation not complete yet
        this.onSubnegotiation(this.buf[i + 2], this.buf.subarray(i + 3, j));
        i = j + 2;
        continue;
      }
      if (b1 >= WILL && b1 <= DONT) {
        if (i + 2 >= this.buf.length) break;
        this.onNegotiate(b1, this.buf[i + 2]);
        i += 3;
        continue;
      }
      i += 2; // any other telnet command, ignored
    }

    this.buf = this.buf.subarray(i);
  }

  private onNegotiate(verb: number, opt: number) {
    if (verb === DO) {
      const ok = AGREE_DO.includes(opt);
      this.write([IAC, ok ? WILL : WONT, opt]);
    } else if (verb === WILL) {
      const ok = AGREE_WILL.includes(opt);
      this.write([IAC, ok ? DO : DONT, opt]);
    }
  }

  private onSubnegotiation(opt: number, data: Buffer) {
    if (opt === OPT.TERMTYPE && data[0] === TT.SEND) {
      this.write([IAC, SB, OPT.TERMTYPE, TT.IS, ...Buffer.from(this.opts.terminalType, "ascii"), IAC, SE]);
      return;
    }
    if (opt === OPT.NEWENV) {
      const body: number[] = [IAC, SB, OPT.NEWENV, NE.IS];
      const uservar = (name: string, value: string) => {
        body.push(NE.USERVAR, ...Buffer.from(name, "ascii"), NE.VALUE, ...Buffer.from(value, "ascii"));
      };
      // A chosen DEVNAME makes a run reproducible: without it the host allocates QPADEVxxxx.
      if (this.deviceName) uservar("DEVNAME", this.deviceName);
      // Without CODEPAGE the host keeps the device default and only our own decoding changes.
      uservar("CODEPAGE", String(this.opts.ccsid));
      body.push(IAC, SE);
      this.write(body);
    }
  }

  sendRecord(record: Buffer) {
    const esc: number[] = [];
    for (const b of record) {
      esc.push(b);
      if (b === IAC) esc.push(IAC); // double a real 0xff so it is not a command
    }
    esc.push(IAC, EOR);
    this.write(esc);
  }

  close() {
    this.sock?.destroy();
    this.sock = undefined;
  }
}
