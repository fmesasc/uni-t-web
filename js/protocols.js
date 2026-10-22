/*
 * Parsers for the DMM chipset protocols used by UNI-T meters.
 *
 * Each parser has feed(bytes) -> Reading[]; framing resyncs on its own, so
 * the stream may start mid-packet. A Reading is a plain object:
 *   { value, display, prefix, unit, quantity, coupling, overload, flags, bargraph, ts }
 * value is in base SI units (V, A, Ω, F, Hz...) and null on overload.
 *
 * References: libsigrok src/dmm/{fs9922,fs9721,es519xx}.c, the chip
 * datasheets and github.com/ljakob/unit_ut61eplus for the UT61+ series.
 *
 * Plain script (no modules) so the page also works from file://; under
 * Node it is exported with module.exports for the tests.
 */
(function (root) {
  "use strict";

  const PREFIX_FACTOR = { p: 1e-12, n: 1e-9, "µ": 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6 };
  const UNIT_QUANTITY = {
    V: "voltage", A: "current", "Ω": "resistance", Hz: "frequency", F: "capacitance",
    "°C": "temperature", "°F": "temperature", "%": "duty", hFE: "hfe",
  };
  const ascii = (bytes) => String.fromCharCode(...bytes);
  const popcount = (x) => { let n = 0; for (; x; x &= x - 1) n++; return n; };

  function reading(o) {
    return {
      value: null, display: "", prefix: "", unit: "", quantity: "unknown", coupling: null,
      overload: false, flags: [], bargraph: null, ts: Date.now() / 1000, ...o,
    };
  }

  /** digits "01234", 2 decimals, sign, prefix -> [value, "012.34"] */
  function apply(digits, decimals, negative, prefix) {
    let n = parseInt(digits, 10);
    let disp = decimals ? digits.slice(0, digits.length - decimals) + "." + digits.slice(digits.length - decimals) : digits;
    if (negative) { disp = "-" + disp; n = -n; }
    return [(n / 10 ** decimals) * PREFIX_FACTOR[prefix], disp];
  }

  const pickFlags = (table) => table.filter(([bit, , reg]) => reg & bit).map(([, name]) => name);

  /** Fixed-length packets terminated by CR LF. */
  class LineParser {
    constructor(len, parse, maskParity = false) {
      this.len = len; this.parse = parse; this.maskParity = maskParity; this.buf = [];
    }
    feed(data) {
      for (const b of data) this.buf.push(this.maskParity ? b & 0x7f : b);
      const out = [];
      for (;;) {
        let i = -1;
        for (let k = 0; k + 1 < this.buf.length; k++) if (this.buf[k] === 0x0d && this.buf[k + 1] === 0x0a) { i = k; break; }
        if (i < 0) {
          if (this.buf.length > this.len) this.buf.splice(0, this.buf.length - this.len);
          break;
        }
        const end = i + 2;
        if (end >= this.len) {
          const r = this.parse(this.buf.slice(end - this.len, end));
          if (r) out.push(r);
        }
        this.buf.splice(0, end);
      }
      return out;
    }
  }

  // ------------------------------------------------------------------------
  // FS9922-DMM4 (UT61B, UT61C, UT61D; 2400 8N1)
  //  0     sign '+' / '-'
  //  1..4  four ASCII digits ("?0:?" means OL)
  //  5     space
  //  6     decimal point: '0' none, '1' d.ddd, '2' dd.dd, '4' ddd.d
  //  7     SB1: b5 AUTO, b4 DC, b3 AC, b2 REL, b1 HOLD, b0 BPN (bargraph)
  //  8     SB2: b7 Z1, b6 Z2, b5 MAX, b4 MIN, b3 APO, b2 BAT, b1 n, b0 Z3
  //  9     SB3: b7 µ, b6 m, b5 k, b4 M, b3 beep, b2 diode, b1 %, b0 Z4
  //  10    SB4: b7 V, b6 A, b5 Ω, b4 hFE, b3 Hz, b2 F, b1 °C, b0 °F
  //  11    bargraph: b7 sign, b6..0 value
  //  12,13 CR LF
  // ------------------------------------------------------------------------
  function parseFS9922(b) {
    if (b.length !== 14 || b[12] !== 0x0d || b[13] !== 0x0a || (b[0] !== 0x2b && b[0] !== 0x2d)) return null;
    const raw = b.slice(1, 5);
    const overload = ascii(raw) === "?0:?";
    if (!overload && !raw.every((c) => c >= 0x30 && c <= 0x39)) return null;
    const decimals = { 0x30: 0, 0x31: 3, 0x32: 2, 0x34: 1 }[b[6]];
    if (decimals === undefined) return null;
    const [sb1, sb2, sb3, sb4, bar] = b.slice(7, 12);
    // same sanity checks as libsigrok: one multiplier, one unit, not AC+DC
    if (popcount(sb3 & 0xf0) + (sb2 & 0x02 ? 1 : 0) > 1 || popcount(sb4) > 1 || (sb1 & 0x18) === 0x18) return null;

    const prefix = sb2 & 0x02 ? "n" : sb3 & 0x80 ? "µ" : sb3 & 0x40 ? "m" : sb3 & 0x20 ? "k" : sb3 & 0x10 ? "M" : "";
    let unit = "";
    for (const [bit, u] of [[0x80, "V"], [0x40, "A"], [0x20, "Ω"], [0x10, "hFE"], [0x08, "Hz"], [0x04, "F"], [0x02, "°C"], [0x01, "°F"]]) {
      if (sb4 & bit) { unit = u; break; }
    }
    if (sb3 & 0x02) unit = "%";
    let quantity = UNIT_QUANTITY[unit] || "unknown";
    if (sb3 & 0x04) { quantity = "diode"; unit = "V"; }
    else if (sb3 & 0x08 && unit === "Ω") quantity = "continuity";

    const flags = pickFlags([[0x20, "AUTO", sb1], [0x04, "REL", sb1], [0x02, "HOLD", sb1],
      [0x20, "MAX", sb2], [0x10, "MIN", sb2], [0x08, "APO", sb2], [0x04, "BAT", sb2], [0x08, "BEEP", sb3]]);
    const negative = b[0] === 0x2d;
    let value = null, display;
    if (overload) display = (negative ? "-" : "") + (decimals === 3 ? "0.L" : decimals === 2 ? "O.L" : "OL");
    else [value, display] = apply(ascii(raw), decimals, negative, prefix);
    return reading({
      value, display, prefix, unit, quantity, overload, flags,
      coupling: sb1 & 0x08 ? "AC" : sb1 & 0x10 ? "DC" : null,
      bargraph: sb1 & 0x01 ? (bar & 0x80 ? -(bar & 0x7f) : bar & 0x7f) : null,
    });
  }

  // ------------------------------------------------------------------------
  // FS9721_LP3 (UT60A/UT60E; 2400 8N1). 14 bytes; the high nibble of every
  // byte is its 1-based position, the low nibble carries LCD segments.
  // ------------------------------------------------------------------------
  const SEG7 = { 0x7d: "0", 0x05: "1", 0x5b: "2", 0x1f: "3", 0x27: "4", 0x3e: "5", 0x7e: "6", 0x15: "7", 0x7f: "8", 0x3f: "9", 0x00: " ", 0x68: "L" };

  function parseFS9721(b) {
    if (b.length !== 14 || b.some((c, i) => c >> 4 !== i + 1)) return null;
    const n = b.map((c) => c & 0x0f);
    let digits = "", decimals = 0;
    const negative = !!(n[1] & 0x08);
    for (let d = 0; d < 4; d++) {
      const hi = n[1 + 2 * d], lo = n[2 + 2 * d];
      if (d > 0 && hi & 0x08) decimals = 4 - d;
      const ch = SEG7[((hi & 0x07) << 4) | lo];
      if (ch === undefined) return null;
      digits += ch;
    }
    const overload = digits.includes("L");
    const [f10, f11, f12, f13, f14] = n.slice(9, 14);
    const prefix = f10 & 0x08 ? "µ" : f10 & 0x04 ? "n" : f10 & 0x02 ? "k" : f11 & 0x08 ? "m" : f11 & 0x02 ? "M" : "";
    let unit = f11 & 0x04 ? "%" : f12 & 0x08 ? "F" : f12 & 0x04 ? "Ω" : f13 & 0x08 ? "A" : f13 & 0x04 ? "V" : f13 & 0x02 ? "Hz" : f14 & 0x04 ? "°C" : "";
    let quantity = UNIT_QUANTITY[unit] || "unknown";
    if (f10 & 0x01) { quantity = "diode"; unit = "V"; }
    else if (f11 & 0x01 && unit === "Ω") quantity = "continuity";
    const flags = pickFlags([[0x02, "AUTO", n[0]], [0x02, "REL", f12], [0x01, "HOLD", f12], [0x01, "BAT", f13], [0x01, "BEEP", f11]]);
    let value = null, display = "OL";
    if (!overload) [value, display] = apply(digits.replace(/ /g, "0"), decimals, negative, prefix);
    return reading({ value, display, prefix, unit, quantity, overload, flags,
      coupling: n[0] & 0x08 ? "AC" : n[0] & 0x04 ? "DC" : null });
  }

  class FS9721Parser {
    constructor() { this.buf = []; }
    feed(data) {
      const out = [];
      for (const c of data) {
        const idx = c >> 4;
        if (idx === 1) this.buf = [c];
        else if (this.buf.length && idx === this.buf.length + 1) {
          this.buf.push(c);
          if (this.buf.length === 14) {
            const r = parseFS9721(this.buf);
            if (r) out.push(r);
            this.buf = [];
          }
        } else this.buf = [];
      }
      return out;
    }
  }

  // ------------------------------------------------------------------------
  // ES51922 (UT61E; 19200 7O1, 22000 counts)
  //  0     range (0x30 + n)
  //  1..5  five ASCII digits
  //  6     function
  //  7     status:  b3 JUDGE, b2 SIGN, b1 BATT, b0 OL
  //  8     option1: b3 MAX, b2 MIN, b1 REL, b0 RMR
  //  9     option2: b3 UL, b2 PMAX, b1 PMIN
  //  10    option3: b3 DC, b2 AC, b1 AUTO, b0 VAHZ
  //  11    option4: b2 VBAR, b1 HOLD, b0 LPF
  //  12,13 CR LF
  // ------------------------------------------------------------------------
  const ES_RANGES = {   // range index -> [prefix, decimals]
    voltage: [["", 4], ["", 3], ["", 2], ["", 1], ["m", 2]],
    current_u: [["µ", 2], ["µ", 1]],
    current_m: [["m", 3], ["m", 2]],
    current_a: [["", 3]],
    current_man: [["", 4], ["", 3], ["", 2], ["", 1], ["", 0]],
    resistance: [["", 2], ["k", 4], ["k", 3], ["k", 2], ["M", 4], ["M", 3], ["M", 2]],
    frequency: [["", 2], ["", 1], ["", 0], ["k", 3], ["k", 2], ["M", 4], ["M", 3], ["M", 2]],
    capacitance: [["n", 3], ["n", 2], ["µ", 4], ["µ", 3], ["µ", 2], ["m", 4], ["m", 3], ["m", 2]],
    continuity: [["", 2]],
    diode: [["", 4]],
  };
  const ES_FUNCS = {
    0x3b: ["voltage", "V", "voltage"], 0x3d: ["current", "A", "current_u"], 0x3f: ["current", "A", "current_m"],
    0x30: ["current", "A", "current_a"], 0x39: ["current", "A", "current_man"], 0x33: ["resistance", "Ω", "resistance"],
    0x35: ["continuity", "Ω", "continuity"], 0x31: ["diode", "V", "diode"], 0x32: ["frequency", "Hz", "frequency"],
    0x36: ["capacitance", "F", "capacitance"],
  };

  function parseES51922(b) {
    if (b.length !== 14 || b[12] !== 0x0d || b[13] !== 0x0a) return null;
    const raw = b.slice(1, 6);
    if (!raw.every((c) => c >= 0x30 && c <= 0x39)) return null;
    const func = ES_FUNCS[b[6]];
    if (!func) return null;
    let [quantity, unit, table] = func;
    const rng = b[0] - 0x30;
    const [status, op1, , op3, op4] = b.slice(7, 12);
    let prefix, decimals;
    if (quantity === "frequency" && !(status & 0x08)) {
      // JUDGE clear in the Hz position means duty cycle
      [quantity, unit, prefix, decimals] = ["duty", "%", "", 1];
    } else {
      if ((quantity === "voltage" || quantity === "current") && op3 & 0x01) {
        // VAHZ: frequency measured from the V/A input
        [quantity, unit, table] = ["frequency", "Hz", "frequency"];
      }
      const r = ES_RANGES[table][rng];
      if (!r) return null;
      [prefix, decimals] = r;
    }
    const coupling = quantity === "voltage" || quantity === "current" ? (op3 & 0x04 ? "AC" : op3 & 0x08 ? "DC" : null) : null;
    const overload = !!(status & 0x01);
    const flags = pickFlags([[0x02, "AUTO", op3], [0x02, "REL", op1], [0x02, "HOLD", op4],
      [0x08, "MAX", op1], [0x04, "MIN", op1], [0x02, "BAT", status], [0x01, "LPF", op4]]);
    let value = null, display = "OL";
    if (!overload) [value, display] = apply(ascii(raw), decimals, !!(status & 0x04), prefix);
    return reading({ value, display, prefix, unit, quantity, coupling, overload, flags });
  }

  // ------------------------------------------------------------------------
  // UT61+ series (UT61B+/D+/E+, UT161B/D/E) over the built-in CP2110
  // USB-HID bridge, 9600 8N1. The meter answers a request command with
  //   AB CD len | mode | range(ASCII) | display(7 ASCII) | bar(2) | flags(3) | sum16(BE)
  // where sum16 covers every byte before it, AB CD included.
  // ------------------------------------------------------------------------
  const UT61P_REQUEST = [0xab, 0xcd, 0x03, 0x5e, 0x01, 0xd9];
  const UP_MODES = ["ACV", "ACmV", "DCV", "DCmV", "Hz", "%", "OHM", "CONT", "DIODE", "CAP", "°C", "°F",
    "DCuA", "ACuA", "DCmA", "ACmA", "DCA", "ACA", "HFE", "Live", "NCV", "LozV", "ACA",
    "DCA", "LPF", "AC/DC", "LPF", "AC+DC", "LPF", "AC+DC2", "INRUSH"];
  // mode -> [quantity, unit, coupling, prefix per range digit]
  const UP_INFO = {
    ACV: ["voltage", "V", "AC", ""], ACmV: ["voltage", "V", "AC", "m"],
    DCV: ["voltage", "V", "DC", ""], DCmV: ["voltage", "V", "DC", "m"],
    Hz: ["frequency", "Hz", null, "  kkkMMM"], "%": ["duty", "%", null, ""],
    OHM: ["resistance", "Ω", null, " kkkMMM"], CONT: ["continuity", "Ω", null, ""],
    DIODE: ["diode", "V", null, ""], CAP: ["capacitance", "F", null, "nnµµµmmm"],
    "°C": ["temperature", "°C", null, ""], "°F": ["temperature", "°F", null, ""],
    DCuA: ["current", "A", "DC", "µ"], ACuA: ["current", "A", "AC", "µ"],
    DCmA: ["current", "A", "DC", "m"], ACmA: ["current", "A", "AC", "m"],
    DCA: ["current", "A", "DC", ""], ACA: ["current", "A", "AC", ""],
    HFE: ["hfe", "hFE", null, ""], LozV: ["voltage", "V", "AC", ""],
    LPF: ["voltage", "V", "AC", ""], "AC/DC": ["voltage", "V", null, ""],
    "AC+DC": ["current", "A", "AC+DC", ""], "AC+DC2": ["current", "A", "AC+DC", ""],
    INRUSH: ["current", "A", null, ""], NCV: ["ncv", "", null, ""], Live: ["ncv", "", null, ""],
  };
  const UP_OL = new Set([".OL", "O.L", "OL.", "OL", "-.OL", "-O.L", "-OL.", "-OL"]);

  function parseUT61Plus(b) {
    if (b.length < 14 || b[0] >= UP_MODES.length) return null;
    const mode = UP_MODES[b[0]];
    let [quantity, unit, coupling, prefixes] = UP_INFO[mode] || ["unknown", "", null, ""];
    if (mode === "AC/DC") coupling = b[13] & 0x08 ? "DC" : "AC";
    const rng = b[1] & 0x0f;
    const prefix = (rng < prefixes.length ? prefixes[rng] : prefixes.slice(0, 1)).trim();
    const display = ascii(b.slice(2, 9)).replace(/ /g, "");
    const overload = UP_OL.has(display);
    let value = overload || !/^[-+]?\d*\.?\d+$/.test(display) ? null : parseFloat(display) * PREFIX_FACTOR[prefix];
    const flags = pickFlags([[8, "MAX", b[11]], [4, "MIN", b[11]], [2, "HOLD", b[11]], [1, "REL", b[11]],
      [2, "BAT", b[12]], [1, "HV", b[12]], [4, "PMAX", b[13]], [2, "PMIN", b[13]]]);
    if (!(b[12] & 0x04)) flags.unshift("AUTO");
    return reading({ value, display: display || "----", prefix, unit, quantity, coupling, overload, flags,
      bargraph: b[9] * 10 + b[10] });
  }

  class UT61PlusParser {
    constructor() { this.buf = []; }
    feed(data) {
      this.buf.push(...data);
      const out = [];
      for (;;) {
        let i = -1;
        for (let k = 0; k + 1 < this.buf.length; k++) if (this.buf[k] === 0xab && this.buf[k + 1] === 0xcd) { i = k; break; }
        if (i < 0) { this.buf.splice(0, Math.max(0, this.buf.length - 1)); break; }
        this.buf.splice(0, i);
        if (this.buf.length < 3 || this.buf.length < 3 + this.buf[2]) break;
        const n = this.buf[2];
        const frame = this.buf.slice(0, 3 + n);
        const sum = frame.slice(0, -2).reduce((a, c) => a + c, 0) & 0xffff;
        if (n >= 3 && sum === ((frame[frame.length - 2] << 8) | frame[frame.length - 1])) {
          const r = parseUT61Plus(frame.slice(3, -2));
          if (r) out.push(r);
          this.buf.splice(0, 3 + n);
        } else this.buf.splice(0, 2);
      }
      return out;
    }
  }

  const PARSERS = {
    fs9922: () => new LineParser(14, parseFS9922),
    fs9721: () => new FS9721Parser(),
    es51922: () => new LineParser(14, parseES51922, true),
    ut61plus: () => new UT61PlusParser(),
  };

  // model -> parser, line settings, transport. "hid" is the UT-D04 cable,
  // "cp2110" the bridge built into the UT61+ meters (polled with `request`).
  const FS9922 = { parser: "fs9922", baud: 2400, dataBits: 8, parity: "none", link: "hid" };
  const FS9721 = { parser: "fs9721", baud: 2400, dataBits: 8, parity: "none", link: "hid" };
  const UT61P = { parser: "ut61plus", baud: 9600, dataBits: 8, parity: "none", link: "cp2110", request: UT61P_REQUEST };
  const MODELS = {
    UT61C: FS9922, UT61B: FS9922, UT61D: FS9922,
    UT61E: { parser: "es51922", baud: 19200, dataBits: 7, parity: "odd", link: "hid" },
    UT60A: FS9721, UT60E: FS9721,
    "UT61E+": UT61P, "UT61B+": UT61P, "UT61D+": UT61P, "UT161B/D/E": UT61P,
  };

  const canInvert = (d) => (d.quantity === "voltage" || d.quantity === "current") && d.coupling !== "AC";

  /**
   * Flip polarity in place and toggle the INV flag, so applying it twice
   * restores the original. Only DC voltage and current are touched.
   */
  function flipPolarity(d) {
    if (!canInvert(d)) return d;
    if (d.value !== null) d.value = d.value ? -d.value : 0;
    if (d.display.replace(/[-0.]/g, "") || d.overload) {   // never show "-0.000"
      d.display = d.display.startsWith("-") ? d.display.slice(1) : "-" + d.display;
    }
    if (d.bargraph) d.bargraph = -d.bargraph;
    d.flags = d.flags.includes("INV") ? d.flags.filter((f) => f !== "INV") : [...d.flags, "INV"];
    return d;
  }

  /** Inverts a fresh reading (no-op if it already is). */
  const invertReading = (d) => (d.flags.includes("INV") ? d : flipPolarity(d));

  const api = { PARSERS, MODELS, UT61P_REQUEST, PREFIX_FACTOR, invertReading, flipPolarity, canInvert,
    parseFS9922, parseFS9721, parseES51922, parseUT61Plus };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Protocols = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
