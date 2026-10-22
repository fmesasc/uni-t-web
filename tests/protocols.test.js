/*
 * Protocol tests. Run with `node tests/protocols.test.js` or open
 * tests/index.html in a browser.
 */
(function () {
  "use strict";
  const P = typeof require !== "undefined" ? require("../js/protocols.js") : globalThis.Protocols;
  const results = [];
  const test = (name, fn) => {
    try { fn(); results.push([name, null]); } catch (e) { results.push([name, e]); }
  };
  const ok = (cond, msg = "assertion failed") => { if (!cond) throw new Error(msg); };
  const near = (a, b) => Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-15;
  const bytes = (s) => [...s].map((c) => c.charCodeAt(0));
  const fs9922 = (sign, digits, dp, sb1, sb2, sb3, sb4, bar = 0) =>
    [...bytes(sign + digits + " " + dp), sb1, sb2, sb3, sb4, bar, 0x0d, 0x0a];
  const feed = (parser, ...chunks) => { const p = P.PARSERS[parser](); return chunks.flatMap((c) => p.feed(c)); };

  test("FS9922 tensión DC", () => {
    const r = P.parseFS9922(fs9922("+", "3299", "1", 0x31, 0, 0, 0x80, 23));
    ok(r.display === "3.299" && r.unit === "V" && r.coupling === "DC", JSON.stringify(r));
    ok(near(r.value, 3.299) && r.flags.includes("AUTO") && r.bargraph === 23);
  });
  test("FS9922 mV AC negativo", () => {
    const r = P.parseFS9922(fs9922("-", "1234", "4", 0x08, 0, 0x40, 0x80));
    ok(r.display === "-123.4" && r.prefix === "m" && r.coupling === "AC" && near(r.value, -0.1234), JSON.stringify(r));
  });
  test("FS9922 overload kΩ", () => {
    const r = P.parseFS9922(fs9922("+", "?0:?", "2", 0x20, 0, 0x20, 0x20));
    ok(r.overload && r.value === null && r.display === "O.L" && r.prefix === "k" && r.quantity === "resistance");
  });
  test("FS9922 diodo y continuidad", () => {
    ok(P.parseFS9922(fs9922("+", "0612", "1", 0, 0, 0x04, 0x80)).quantity === "diode");
    const r = P.parseFS9922(fs9922("+", "0012", "4", 0, 0, 0x08, 0x20));
    ok(r.quantity === "continuity" && r.flags.includes("BEEP"));
  });
  test("FS9922 rechaza paquetes incoherentes", () => {
    ok(P.parseFS9922(fs9922("+", "1000", "1", 0x18, 0, 0, 0x80)) === null, "AC+DC");
    ok(P.parseFS9922(fs9922("+", "1000", "1", 0x10, 0, 0, 0xc0)) === null, "V+A");
    ok(P.parseFS9922(fs9922("+", "1000", "1", 0x10, 0, 0x60, 0x80)) === null, "m+k");
  });
  test("FS9922 resincroniza el flujo", () => {
    const pkt = fs9922("+", "0500", "2", 0x10, 0, 0x40, 0x40);
    const out = feed("fs9922", [0x17, ...bytes("basura"), ...pkt.slice(0, 5)], [...pkt.slice(5), ...pkt, ...pkt.slice(0, 3)]);
    ok(out.length === 2, `got ${out.length}`);
    ok(out.every((r) => near(r.value, 0.005) && r.unit === "A"));
  });
  test("ES51922 (UT61E) con bit de paridad", () => {
    const pkt = [...bytes("001234"), 0x3b, 0x30, 0x30, 0x30, 0x3a, 0x30, 0x0d, 0x0a];
    pkt[1] |= 0x80; pkt[6] |= 0x80;
    const out = feed("es51922", pkt);
    ok(out.length === 1, `got ${out.length}`);
    const r = out[0];
    ok(r.display === "0.1234" && r.unit === "V" && r.coupling === "DC" && r.flags.includes("AUTO"), JSON.stringify(r));
  });
  test("FS9721 (UT60E) tensión", () => {
    const seg = { 1: 0x05, 2: 0x5b, 3: 0x1f, 5: 0x3e };
    const nib = [0b0110];
    [..."1253"].forEach((ch, i) => { const s = seg[ch]; nib.push((s >> 4) | (i === 1 ? 0x08 : 0), s & 0x0f); });
    nib.push(0, 0, 0, 0b0100, 0);
    const pkt = nib.map((n, i) => ((i + 1) << 4) | n);
    const out = feed("fs9721", [0x00, 0x99, ...pkt]);
    ok(out.length === 1 && out[0].display === "1.253" && out[0].unit === "V" && out[0].coupling === "DC", JSON.stringify(out));
  });

  const frame = (payload) => {
    const body = [0xab, 0xcd, payload.length + 2, ...payload];
    const s = body.reduce((a, c) => a + c, 0) & 0xffff;
    return [...body, s >> 8, s & 0xff];
  };
  test("UT61+ kΩ y tramas partidas", () => {
    const f = frame([6, ...bytes("2 12.345"), 1, 2, 0, 0, 0]);
    const out = feed("ut61plus", [0x00, 0x11, ...f.slice(0, 7)], [...f.slice(7), ...f]);
    ok(out.length === 2, `got ${out.length}`);
    const r = out[0];
    ok(r.quantity === "resistance" && r.prefix === "k" && near(r.value, 12345) && r.flags.includes("AUTO") && r.bargraph === 12, JSON.stringify(r));
  });
  test("UT61+ checksum malo y overload", () => {
    const bad = frame([2, ...bytes("1   1.00"), 0, 0, 0, 0, 0]);
    bad[bad.length - 1] ^= 1;
    const ol = frame([2, ...bytes("1    OL."), 0, 0, 0, 4, 8]);
    const out = feed("ut61plus", [...bad, ...ol]);
    ok(out.length === 1 && out[0].overload && out[0].coupling === "DC" && !out[0].flags.includes("AUTO"), JSON.stringify(out));
  });
  test("Invertir polaridad", () => {
    const r = P.invertReading(P.parseFS9922(fs9922("-", "1234", "1", 0x10, 0, 0, 0x80)));
    ok(r.display === "1.234" && r.value > 0 && r.flags.includes("INV"));
    ok(P.invertReading(P.parseFS9922(fs9922("+", "0000", "1", 0x10, 0, 0, 0x80))).display === "0.000");
    const ohm = P.invertReading(P.parseFS9922(fs9922("+", "1000", "1", 0, 0, 0x20, 0x20)));
    ok(ohm.value === 1000 && !ohm.flags.includes("INV"));
  });

  const failed = results.filter(([, e]) => e);
  const report = results.map(([n, e]) => (e ? `✘ ${n}: ${e.message}` : `✔ ${n}`)).join("\n")
    + `\n\n${results.length - failed.length}/${results.length} OK`;
  if (typeof process !== "undefined" && process.exit) {
    console.log(report);
    process.exit(failed.length ? 1 : 0);
  } else {
    document.body.textContent = report;
    document.body.dataset.result = failed.length ? "fail" : "pass";
  }
})();
