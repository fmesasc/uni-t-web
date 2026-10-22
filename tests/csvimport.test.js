/*
 * CSV import tests. Run with `node tests/csvimport.test.js` or open
 * tests/index.html in a browser.
 */
(function () {
  "use strict";
  const C = typeof require !== "undefined" ? require("../js/csvimport.js") : globalThis.CsvImport;
  const results = [];
  const test = (name, fn) => {
    try { fn(); results.push([name, null]); } catch (e) { results.push([name, e]); }
  };
  const ok = (cond, msg = "assertion failed") => { if (!cond) throw new Error(msg); };
  const near = (a, b) => Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-12;
  const load = (text, opts) => { const a = C.analyze(text); return [a, C.build(a, opts)]; };

  test("CSV exportado por esta web (todos los campos)", () => {
    const [a, r] = load("fecha,timestamp,valor,unidad,pantalla,prefijo,magnitud,acdc,overload,flags,nota\n"
      + "2026-10-22 10:00:00.000,1792656000.000,0.003297,V,3.297,m,voltage,DC,0,AUTO INV,hola\n"
      + "2026-10-22 10:00:00.400,1792656000.400,,Ω,O.L,k,resistance,,1,AUTO,\n");
    ok(a.own && r.length === 2, JSON.stringify(a.header));
    ok(near(r[0].value, 0.003297) && r[0].display === "3.297" && r[0].prefix === "m" && r[0].coupling === "DC", JSON.stringify(r[0]));
    ok(r[0].flags.join() === "AUTO,INV" && r[0].note === "hola" && r[1].overload && r[1].value === null);
  });

  test("Hoja de cálculo en español: ';', coma decimal, unidad en la cabecera", () => {
    const [a, r] = load("Fecha;Tensión (mV)\n22/10/2026 10:00:00;3,297\n22/10/2026 10:00:01;-0,512\n");
    ok(a.delimiter === ";" && a.decimalComma && a.unit === "mV", JSON.stringify([a.delimiter, a.decimalComma, a.unit]));
    ok(r.length === 2 && near(r[0].value, 0.003297) && near(r[1].value, -0.000512) && r[0].quantity === "voltage", JSON.stringify(r));
    ok(r[1].ts - r[0].ts === 1 && new Date(r[0].ts * 1000).getDate() === 22);
  });

  test("Tabla copiada de esta web (tabuladores)", () => {
    const [a, r] = load("fecha\tvalor\tunidad\n2026-10-22 10:00:00.000\t3,297\tV\n2026-10-22 10:00:00.500\t3,301\tV\n");
    ok(a.delimiter === "\t" && a.timeCol === 0 && a.valueCol === 1 && a.unit === "V", JSON.stringify(a.columns));
    ok(r.length === 2 && near(r[1].value, 3.301) && near(r[1].ts - r[0].ts, 0.5), JSON.stringify(r));
  });

  test("Sin cabecera, segundos y unidad dentro de cada celda", () => {
    const [a, r] = load("0,10.2 kΩ\n0.5,10.3 kΩ\n1,OL\n", { baseTs: 1000 });
    ok(a.timeCol === 0 && a.valueCol === 1, JSON.stringify([a.timeCol, a.valueCol]));
    ok(r.length === 3 && near(r[0].value, 10200) && r[0].prefix === "k" && r[0].unit === "Ω" && r[2].overload, JSON.stringify(r));
    ok(r[2].ts === 1000 && r[0].ts === 999, "los segundos terminan en la fecha del fichero");
  });

  test("Hora del día que pasa de medianoche", () => {
    const [, r] = load("hora,valor\n23:59:59,1.5\n00:00:01,1.6\n", { baseTs: new Date(2026, 9, 22, 12).getTime() / 1000 });
    ok(r.length === 2 && r[1].ts - r[0].ts === 2, JSON.stringify(r.map((x) => x.ts)));
  });

  test("Sin columna de tiempo: una fila por segundo", () => {
    const [a, r] = load("Lectura (A)\n0.12\n0.13\n0.11\n", { baseTs: 500 });
    ok(a.timeCol === -1 && a.unit === "A" && r.length === 3 && r[0].ts === 498 && r[2].ts === 500, JSON.stringify([a, r]));
  });

  test("Valores sueltos y unidades", () => {
    ok(near(C.parseValue("4.7k").num, 4.7) && C.parseValue("4.7k").prefix === "k");
    ok(C.parseValue("2,2 µF").unit === "F" && C.parseValue("2,2 µF").prefix === "µ");
    ok(C.parseValue("1.234,5", true).num === 1234.5 && C.parseValue("O.L").overload);
    ok(C.parseValue("12:00:01") === null && C.parseValue("2026-10-22") === null);
    ok(C.parseUnit("kohm").unit === "Ω" && C.parseUnit("mV").prefix === "m" && C.parseUnit("°C").unit === "°C");
  });

  test("Fichero binario da un error claro", () => {
    let msg = "";
    try { C.analyze("ÐÏ\u0011à\u0000\u0000\u0000"); } catch (e) { msg = e.message; }
    ok(/binario/.test(msg), msg);
  });

  test("JSON de sesión exportado por esta web", () => {
    const j = C.fromJSON({ name: "x", readings: [{ ts: 1, value: 2, unit: "V" }] });
    ok(j && j.name === "x" && j.readings[0].flags.length === 0);
    ok(C.fromJSON({ foo: 1 }) === null);
  });

  const failed = results.filter(([, e]) => e);
  const report = results.map(([n, e]) => (e ? `✘ ${n}: ${e.message}` : `✔ ${n}`)).join("\n")
    + `\n\n${results.length - failed.length}/${results.length} OK`;
  if (typeof process !== "undefined" && process.exit) {
    console.log(report);
    process.exit(failed.length ? 1 : 0);
  } else {
    document.body.textContent += report + "\n\n";
    if (failed.length || !document.body.dataset.result) document.body.dataset.result = failed.length ? "fail" : "pass";
  }
})();
