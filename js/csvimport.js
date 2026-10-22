/*
 * Reads measurement tables saved elsewhere (our own CSV export, spreadsheet
 * CSVs with ";" and decimal commas, tab separated .txt from the UNI-T
 * software...) and turns them into readings.
 *
 *  analyze(text)            -> { delimiter, header, rows, columns, own, timeCol, valueCol, unit }
 *  build(analysis, options) -> readings[]
 *
 * Plain script; exported with module.exports under Node for the tests.
 */
(function (root) {
  "use strict";

  const FACTOR = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
  const UNITS = { v: "V", a: "A", "ω": "Ω", "Ω": "Ω", ohm: "Ω", ohms: "Ω", hz: "Hz", f: "F", "°c": "°C", "ºc": "°C", c: "°C",
    "°f": "°F", "ºf": "°F", "%": "%", hfe: "hFE" };
  const QUANTITY = { V: "voltage", A: "current", "Ω": "resistance", Hz: "frequency", F: "capacitance",
    "°C": "temperature", "°F": "temperature", "%": "duty", hFE: "hfe" };
  const OWN_HEAD = ["fecha", "timestamp", "valor", "unidad"];
  const TIME_RE = /^(fecha|date|time|tiempo|hora|timestamp|ts|datetime|t|t\s*\(s\)|segundos|seconds|elapsed)\b/i;
  const VALUE_RE = /(valor|value|lectura|reading|medida|measure|volt|tensi|corriente|current|resist|ohm|temp|frec|freq)/i;
  const UNIT_COL_RE = /^(unidad|unit|units|unidades)$/i;

  /** "mV" -> {prefix:"m", unit:"V"}; "kohm" -> {prefix:"k", unit:"Ω"}; unknown -> null */
  function parseUnit(token) {
    const t = String(token || "").trim();
    if (!t) return null;
    const exact = UNITS[t.toLowerCase()] || UNITS[t];
    if (exact) return { prefix: "", unit: exact };
    const p = t[0], rest = t.slice(1);
    const u = UNITS[rest.toLowerCase()] || UNITS[rest];
    if (p in FACTOR && u) return { prefix: p === "u" || p === "μ" ? "µ" : p === "K" ? "k" : p, unit: u };
    return null;
  }

  /** Unit written in a header such as "Tensión (mV)" or "Value [V]". */
  function unitFromHeader(h) {
    const m = String(h || "").match(/[([]\s*([^)\]]+?)\s*[)\]]/);
    return m ? parseUnit(m[1]) : null;
  }

  /**
   * "3.297", "-0,512", "10.2 kΩ", "4.7k", "OL" -> {num, prefix, unit, overload}.
   * decimalComma: treat "," as the decimal separator.
   */
  function parseValue(cell, decimalComma) {
    let s = String(cell ?? "").trim().replace(/^"|"$/g, "");
    if (!s) return null;
    if (/^[-+]?(o\.?l\.?|\.ol|ol\.|overload)$/i.test(s)) return { num: null, prefix: "", unit: "", overload: true };
    if (decimalComma && s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");   // 1.234,5 -> 1234.5
    else if (!s.includes(".")) s = s.replace(/^([-+]?\d+),(\d+)/, "$1.$2");   // lone decimal comma: "2,2 µF"
    const m = s.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(.*)$/i);
    if (!m) return null;
    const num = parseFloat(m[1]);
    if (!isFinite(num)) return null;
    const tail = m[2].trim();
    if (!tail) return { num, prefix: "", unit: "", overload: false };
    const pu = parseUnit(tail);
    if (pu) return { num, ...pu, overload: false };
    if (tail.length === 1 && tail in FACTOR) return { num, prefix: tail === "u" ? "µ" : tail, unit: "", overload: false };
    return null;
  }

  /** Date/time cell -> {ts} (epoch seconds), {elapsed} (seconds) or {tod} (seconds since midnight). */
  function parseTime(cell) {
    const s = String(cell ?? "").trim().replace(/^"|"$/g, "");
    if (!s) return null;
    if (/^[-+]?\d+(?:[.,]\d+)?$/.test(s)) {
      const n = parseFloat(s.replace(",", "."));
      if (n > 1e12) return { ts: n / 1000 };
      if (n > 1e9) return { ts: n };
      return { elapsed: n };
    }
    let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?/);
    if (m) return { ts: new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), msOf(m[7])).getTime() / 1000 };
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?/);
    if (m) {   // day first, as written in Spain
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return { ts: new Date(y, m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0), msOf(m[7])).getTime() / 1000 };
    }
    m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?$/);
    if (m) return { tod: +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0) + msOf(m[4]) / 1000 };
    const t = Date.parse(s);
    return isNaN(t) ? null : { ts: t / 1000 };
  }
  const msOf = (frac) => (frac ? Math.round(parseFloat("0." + frac) * 1000) : 0);

  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
    let best = ",", score = -1;
    for (const d of ["\t", ";", ",", "|"]) {
      const counts = lines.map((l) => splitLine(l, d).length - 1);
      const min = Math.min(...counts);
      if (min > 0 && min > score) { best = d; score = min; }
    }
    return best;
  }

  function splitLine(line, d) {
    const out = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === d) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function analyze(text) {
    text = text.replace(/^﻿/, "");
    if (/\u0000/.test(text.slice(0, 2000))) {
      throw new Error("Es un fichero binario (¿un .xls de Excel?). Ábrelo en Excel o LibreOffice y guárdalo como CSV.");
    }
    const delimiter = detectDelimiter(text);
    let rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => splitLine(l, delimiter));
    if (!rows.length) throw new Error("El fichero está vacío");
    // decimal comma when the separator is not a comma and numbers carry commas
    const decimalComma = delimiter !== "," && rows.slice(0, 50).some((r) => r.some((c) => /^[-+]?\d+,\d+/.test(c)));
    const first = rows[0];
    const hasHeader = first.some((c) => c && !parseValue(c, decimalComma) && !parseTime(c));
    const header = hasHeader ? first : first.map((_, i) => `Columna ${i + 1}`);
    if (hasHeader) rows = rows.slice(1);
    const own = OWN_HEAD.every((h, i) => (header[i] || "").toLowerCase() === h);

    const sample = rows.slice(0, 200);
    const columns = header.map((name, i) => {
      const cells = sample.map((r) => r[i]).filter((c) => c !== undefined && c !== "");
      const nums = cells.filter((c) => parseValue(c, decimalComma)).length;
      const times = cells.filter((c) => { const t = parseTime(c); return t && !("elapsed" in t); }).length;
      const kind = !cells.length ? "empty"
        : times >= cells.length * 0.8 ? "time"
        : nums >= cells.length * 0.8 ? "number" : "text";
      return { name, index: i, kind };
    });

    let timeCol = columns.find((c) => c.kind === "time")?.index
      ?? columns.find((c) => c.kind === "number" && TIME_RE.test(c.name))?.index ?? -1;
    if (timeCol < 0) {   // unnamed "seconds" column: first numeric one, strictly increasing, with more numbers after it
      const nums = columns.filter((c) => c.kind === "number");
      const t = nums[0] && sample.map((r) => parseFloat(String(r[nums[0].index]).replace(",", ".")));
      if (nums.length > 1 && t.length > 1 && t.every((v, i) => i === 0 || v > t[i - 1])) timeCol = nums[0].index;
    }
    const numeric = columns.filter((c) => c.kind === "number" && c.index !== timeCol);
    const valueCol = (numeric.find((c) => VALUE_RE.test(c.name)) || numeric[0])?.index ?? -1;
    const unitCol = columns.find((c) => UNIT_COL_RE.test(c.name))?.index ?? -1;

    // unit: header "(mV)", unit column, or written next to the numbers
    let unit = "";
    if (valueCol >= 0) {
      const hu = unitFromHeader(header[valueCol]);
      const cu = unitCol >= 0 ? parseUnit(rows.find((r) => r[unitCol])?.[unitCol]) : null;
      const vu = rows.slice(0, 50).map((r) => parseValue(r[valueCol], decimalComma)).find((v) => v && (v.unit || v.prefix));
      const u = hu || cu || (vu && { prefix: vu.prefix, unit: vu.unit });
      if (u) unit = u.prefix + u.unit;
    }
    return { delimiter, decimalComma, header, rows, columns, own, timeCol, valueCol, unitCol, unit };
  }

  /**
   * options: { timeCol, valueCol, unit ("mV", "kΩ"...), baseTs (epoch s used
   * for elapsed / time-of-day columns), step (s between rows without time) }
   */
  function build(a, opts = {}) {
    if (a.own) return buildOwn(a);
    const timeCol = opts.timeCol ?? a.timeCol, valueCol = opts.valueCol ?? a.valueCol;
    if (valueCol < 0) throw new Error("No encuentro ninguna columna con números");
    const fixed = parseUnit(opts.unit ?? a.unit) || { prefix: "", unit: "" };
    const baseTs = opts.baseTs ?? Date.now() / 1000;
    const step = opts.step ?? 1;
    const out = [];
    let lastTod = null, dayOffset = 0, firstElapsed = null;
    const times = timeCol >= 0 ? a.rows.map((r) => parseTime(r[timeCol])) : [];
    const maxElapsed = Math.max(0, ...times.filter((t) => t && "elapsed" in t).map((t) => t.elapsed));
    const midnight = new Date(baseTs * 1000); midnight.setHours(0, 0, 0, 0);

    a.rows.forEach((r, i) => {
      const v = parseValue(r[valueCol], a.decimalComma);
      if (!v) return;
      let ts;
      const t = times[i];
      if (!t) ts = timeCol >= 0 ? null : baseTs - (a.rows.length - 1 - i) * step;
      else if ("ts" in t) ts = t.ts;
      else if ("elapsed" in t) { firstElapsed ??= t.elapsed; ts = baseTs - maxElapsed + t.elapsed; }
      else {   // time of day: roll over past midnight
        if (lastTod !== null && t.tod < lastTod - 43200) dayOffset += 86400;
        lastTod = t.tod;
        ts = midnight.getTime() / 1000 + t.tod + dayOffset;
      }
      if (ts === null) return;
      const cellUnit = v.unit ? { prefix: v.prefix, unit: v.unit } : null;
      const u = cellUnit || { prefix: v.prefix || fixed.prefix, unit: fixed.unit };
      const value = v.overload ? null : v.num * (FACTOR[u.prefix] ?? 1);
      out.push({
        ts, value, overload: v.overload, prefix: u.prefix, unit: u.unit,
        display: v.overload ? "OL" : a.decimalComma ? String(v.num) : String(r[valueCol]).replace(/\s*[^\d.+\-eE].*$/, "") || String(v.num),
        quantity: QUANTITY[u.unit] || "unknown", coupling: null, flags: [], note: "",
      });
    });
    out.sort((x, y) => x.ts - y.ts);
    return out;
  }

  /** Our own export: every field comes back as it was. */
  function buildOwn(a) {
    const col = (name) => a.header.findIndex((h) => h.toLowerCase() === name);
    const c = Object.fromEntries(["timestamp", "valor", "unidad", "pantalla", "prefijo", "magnitud", "acdc", "overload", "flags", "nota"]
      .map((k) => [k, col(k)]));
    const get = (r, k) => (c[k] >= 0 ? r[c[k]] ?? "" : "");
    return a.rows.map((r) => {
      const unit = get(r, "unidad");
      return {
        ts: parseFloat(get(r, "timestamp")),
        value: get(r, "valor") === "" ? null : parseFloat(get(r, "valor")),
        unit, display: get(r, "pantalla") || get(r, "valor"), prefix: get(r, "prefijo"),
        quantity: get(r, "magnitud") || QUANTITY[unit] || "unknown", coupling: get(r, "acdc") || null,
        overload: get(r, "overload") === "1", flags: get(r, "flags").split(" ").filter(Boolean), note: get(r, "nota"),
      };
    }).filter((r) => isFinite(r.ts)).sort((x, y) => x.ts - y.ts);
  }

  /** A session exported as JSON from this app. */
  function fromJSON(data) {
    const readings = Array.isArray(data) ? data : data?.readings;
    if (!Array.isArray(readings) || !readings.every((r) => typeof r.ts === "number" && "value" in r)) return null;
    return {
      name: data.name, notes: data.notes,
      readings: readings.map((r) => ({ display: "", prefix: "", unit: "", quantity: "unknown", coupling: null,
        overload: false, flags: [], note: "", ...r })),
    };
  }

  const api = { analyze, build, fromJSON, parseValue, parseTime, parseUnit, detectDelimiter };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CsvImport = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
