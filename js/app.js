"use strict";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const QUANTITY = {
  voltage: "Tensión", current: "Corriente", resistance: "Resistencia", continuity: "Continuidad",
  diode: "Diodo", frequency: "Frecuencia", duty: "Ciclo de trabajo", capacitance: "Capacidad",
  temperature: "Temperatura", hfe: "hFE", ncv: "Detector NCV", unknown: "—",
};
const STATE = { disconnected: "Desconectado", connecting: "Conectando…", connected: "Conectado", error: "Error" };

let live = [];            // every reading of this page session, all modes
let stats = null;         // stats of the current mode since statsSince
let statsSince = 0;
let paused = false;
let windowSec = 120;
let liveZoom = null;      // {t0, t1} while zoomed into the live chart
let silent = false;
let rel = null;           // {value, key, unit}
let voice = false;

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const modeKey = (r) => `${r.quantity}|${r.unit}|${r.coupling || ""}`;
const modeLabel = (r) => (r ? `${QUANTITY[r.quantity] || r.quantity}${r.coupling ? " " + r.coupling : ""}` : "—");
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "medium" });
const fmtDur = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${x} s` : `${x} s`;
};
const SI = [[1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]];
function fmtSI(v, unit, digits = 4) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  if (unit === "%" || unit === "hFE" || unit.startsWith("°")) return `${+v.toPrecision(digits)} ${unit}`;
  const a = Math.abs(v);
  const [f, p] = a === 0 ? [1, ""] : SI.find(([f]) => a >= f * 0.9999) || SI[SI.length - 1];
  return `${+(v / f).toPrecision(digits)} ${p}${unit}`;
}
/** "4.7k", "4,7 kΩ", "220m", "10u" -> number; "" -> null; garbage -> NaN */
function parseSI(text) {
  const s = String(text).trim().replace(",", ".").replace(/\s+/g, "");
  if (!s) return null;
  const m = s.match(/^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)([pnuµmkM]?)/i);
  if (!m) return NaN;
  const f = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6 }[m[2]] ?? 1;
  return parseFloat(m[1]) * f;
}
const stepOf = (r) => {  // value of one count on the display
  const dec = (r.display.split(".")[1] || "").length;
  const f = { p: 1e-12, n: 1e-9, "µ": 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6 }[r.prefix] ?? 1;
  return 10 ** -dec * f;
};
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("unitweb." + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("unitweb." + k, JSON.stringify(v)); } catch {} },
};
function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), ms);
}
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
let audio;
function beep(freq = 1760, ms = 120, n = 1) {
  try {
    audio ??= new AudioContext();
    for (let i = 0; i < n; i++) {
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * (ms / 1000) * 1.6;
      o.frequency.value = freq; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
      o.start(t); o.stop(t + ms / 1000);
    }
  } catch {}
}

// ---------- tabs & menus ----------
function setupTabs(tabs) {
  const card = tabs.closest(".card");
  const show = (name) => {
    $$("button[data-tab]", tabs).forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    $$(":scope > [data-pane]", card).forEach((p) => (p.hidden = p.dataset.pane !== name));
  };
  tabs.addEventListener("click", (e) => { const t = e.target.dataset.tab; if (t) show(t); });
  return show;
}
const showToolTab = setupTabs($("#tool-tabs"));
const showListTab = setupTabs($("#list-tabs"));
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-menu]");
  $$(".menu-list").forEach((m) => { if (!btn || m !== btn.nextElementSibling) m.hidden = true; });
  if (btn) btn.nextElementSibling.hidden = !btn.nextElementSibling.hidden;
  else if (e.target.closest(".menu-list button")) e.target.closest(".menu-list").hidden = true;
});

// ---------- connection (everything runs in the browser) ----------
const meter = {
  state: "disconnected", error: null, label: "", model: "UT61C", kind: "hid",
  link: null, parser: null, hidDevice: null, lastRx: 0, last: null,
  invert: false, recording: null, autoReconnect: false,
};
const hasHid = "hid" in navigator, hasSerial = "serial" in navigator;

function setupConnection() {
  const prefs = store.get("conn", {});
  $("#model").innerHTML = Object.keys(Protocols.MODELS).map((m) => `<option>${esc(m)}</option>`).join("");
  $("#model").value = Protocols.MODELS[prefs.model] ? prefs.model : "UT61C";
  $("#link").value = prefs.kind || "serial";
  $("#link option[value=hid]").disabled = !hasHid;
  $("#link option[value=serial]").disabled = !hasSerial;
  if (!hasHid && !hasSerial) { $("#support").hidden = false; $("#link").value = "sim"; }
  meter.invert = !!prefs.invert;

  if (hasHid) {
    navigator.hid.addEventListener("disconnect", (e) => {
      if (e.device === meter.hidDevice) linkLost("Se ha desconectado el cable USB");
    });
    navigator.hid.addEventListener("connect", (e) => {
      const cfg = Protocols.MODELS[meter.model];
      const ids = cfg.link === "cp2110" ? Drivers.CP2110_IDS : Drivers.UTD04_IDS;
      if (meter.autoReconnect && meter.kind === "hid" && !meter.link && Drivers.matches(e.device, ids)) {
        connect("hid", meter.model, { device: e.device }).then(() => toast("Cable reconectado"));
      }
    });
  }
  if (hasSerial) {
    navigator.serial.addEventListener("connect", (e) => {
      if (meter.autoReconnect && meter.kind === "serial" && !meter.link) connect("serial", meter.model, { port: e.target });
    });
  }
}

async function connect(kind, model, { device, port, pick = false } = {}) {
  await disconnect(true);
  const cfg = Protocols.MODELS[model];
  Object.assign(meter, { kind, model, error: null });
  $("#link").value = kind; $("#model").value = model;
  store.set("conn", { kind, model, invert: meter.invert });
  try {
    let link;
    if (kind === "sim") link = new Drivers.SimLink();
    else if (kind === "hid") {
      const dev = device || (!pick && (await Drivers.grantedHid(cfg))[0]) || (await Drivers.requestHid(cfg));
      if (!dev) return setState("disconnected");
      meter.hidDevice = dev;
      link = Drivers.makeHidLink(dev, cfg);
    } else {
      if (!port && (pick || !(await navigator.serial.getPorts()).length)) {
        toast("En la lista elige el adaptador USB-serie (p. ej. «USB-Serial Controller» o ttyUSB0)", 6000);
      }
      port ||= (!pick && (await navigator.serial.getPorts())[0]) || (await navigator.serial.requestPort());
      link = new Drivers.SerialLink(port, cfg);
    }
    setState("connecting");
    meter.parser = Protocols.PARSERS[kind === "sim" ? "fs9922" : cfg.parser]();
    await link.open(onData, linkLost);
    Object.assign(meter, { link, label: link.label, lastRx: Date.now() / 1000, autoReconnect: kind !== "sim" });
    setState("connected");
  } catch (e) {
    if (e.name === "NotFoundError" || e.name === "AbortError") return setState("disconnected");   // picker cancelled
    let msg = e.message || String(e);
    if (e.name === "NotAllowedError" || e.name === "SecurityError" || /open|access/i.test(msg)) {
      msg = `No se pudo abrir el dispositivo (${msg}). En Linux hace falta la regla udev para el cable; mira las instrucciones en GitHub.`;
    }
    meter.error = msg;
    setState("error");
  }
}

async function disconnect(keepReconnect = false) {
  const link = meter.link;
  meter.link = null;
  if (!keepReconnect) meter.autoReconnect = false;
  if (link) await link.close();
  if (meter.state !== "error" || !keepReconnect) setState("disconnected");
}

function linkLost(msg) {
  if (!meter.link) return;
  meter.link.close();
  meter.link = null;
  meter.error = `${msg}. Se reconectará solo al volver a enchufarlo.`;
  setState("error");
}

function setState(s) { meter.state = s; renderStatus(); }

function onData(bytes) {
  if (!meter.parser) return;
  for (const r of meter.parser.feed(bytes)) {
    meter.lastRx = Date.now() / 1000;
    if (meter.invert) Protocols.invertReading(r);
    meter.last = r;
    record(r);
    onReading(r);
  }
}

$("#connect").onclick = () => (meter.state === "connected" ? stopAndDisconnect() : connect($("#link").value, $("#model").value));
$("#pick").onclick = () => connect($("#link").value, $("#model").value, { pick: true });
async function stopAndDisconnect() { await stopRecording(); await disconnect(); }

// silence detection and recording time limit
setInterval(() => {
  const now = Date.now() / 1000;
  const s = meter.state === "connected" && now - meter.lastRx > 3;
  if (s !== silent) { silent = s; renderStatus(); }
  const rec = meter.recording;
  if (rec && rec.maxDuration && now - rec.started >= rec.maxDuration) { stopRecording(); toast("Grabación terminada por duración"); }
  else if (rec) renderStatus();
  if (!paused && !liveZoom && windowSec) drawLive();
}, 1000);

function renderStatus() {
  const pill = $("#state");
  const st = meter.state === "connected" && silent ? "silent" : meter.state;
  pill.className = "pill " + st;
  pill.textContent = st === "silent" ? "Sin datos — ¿multímetro encendido y en modo RS232?"
    : st === "connected" ? `Conectado · ${meter.label}` : STATE[meter.state] || meter.state;
  $("#connect").textContent = meter.state === "connected" ? "Desconectar" : "Conectar";
  $("#pick").hidden = $("#link").value === "sim";
  const err = $("#error");
  err.hidden = !(meter.state === "error" && meter.error);
  err.textContent = meter.error || "";
  $("#lcd").classList.toggle("stale", meter.state !== "connected" || silent);
  $("#inv-btn").classList.toggle("on", meter.invert);

  const rec = meter.recording;
  $("#rec-idle").hidden = !!rec;
  $("#rec-active").hidden = !rec;
  if (rec) {
    $("#rec-title").textContent = rec.name;
    const left = rec.maxDuration ? ` · quedan ${fmtDur(rec.started + rec.maxDuration - Date.now() / 1000)}` : "";
    $("#rec-info").textContent = `${rec.count} lecturas · ${fmtDur(Date.now() / 1000 - rec.started)}${left}`;
  }
}

// ---------- live readings ----------
function newStats() { return { n: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity }; }
function addStat(s, v) {
  s.n++; const d = v - s.mean; s.mean += d / s.n; s.m2 += d * (v - s.mean);
  s.min = Math.min(s.min, v); s.max = Math.max(s.max, v);
}
function statsOf(pts) { const s = newStats(); pts.forEach((p) => p.value !== null && addStat(s, p.value)); return s; }
const sd = (s) => (s.n > 1 ? Math.sqrt(s.m2 / (s.n - 1)) : 0);

/** Readings of the mode currently shown on the meter. */
function modeLive() {
  const last = live[live.length - 1];
  if (!last) return [];
  const k = modeKey(last);
  return live.filter((p) => modeKey(p) === k);
}
function recomputeStats() {
  stats = statsOf(modeLive().filter((p) => p.ts >= statsSince && !p.flags.includes("HOLD")));
}

function onReading(r, redraw = true) {
  const modeChanged = live.length && modeKey(live[live.length - 1]) !== modeKey(r);
  live.push(r);
  if (live.length > 100000) live.splice(0, live.length - 100000);
  if (modeChanged) {   // the other mode's data stays in the buffer and comes back with it
    liveZoom = null;
    if (rel && rel.key !== modeKey(r)) { rel = null; $("#rel-btn").classList.remove("on"); }
    recomputeStats();
  } else if (r.value !== null && !r.flags.includes("HOLD")) addStat((stats ??= newStats()), r.value);
  if (!redraw) return;
  detectStable(r);
  checkAlarm(r);
  renderLCD(r);
  renderStats(r);
  if (!paused && !liveZoom) drawLive();
}

function renderLCD(r) {
  $("#mode").textContent = modeLabel(r);
  $("#value").textContent = r.display;
  $("#unit").textContent = r.quantity === "diode" ? "V ⏵|" : r.prefix + r.unit;
  $("#flags").innerHTML = r.flags.filter((f) => f !== "BEEP" || r.quantity === "continuity")
    .map((f) => `<span${f === "INV" ? ' class="inv"' : ""}>${f === "BAT" ? "🔋 BAT" : f === "INV" ? "± INV" : f}</span>`).join("");
  $("#bar").style.width = r.bargraph == null ? "0" : `${Math.min(100, (Math.abs(r.bargraph) / 42) * 100)}%`;

  const relEl = $("#rel");
  relEl.hidden = !rel;
  if (rel) {
    const d = r.value === null ? null : r.value - rel.value;
    const pct = d !== null && rel.value ? ` (${d >= 0 ? "+" : ""}${((d / Math.abs(rel.value)) * 100).toFixed(2)} %)` : "";
    relEl.textContent = `Δ ${d !== null && d >= 0 ? "+" : ""}${fmtSI(d, r.unit, 5)}${pct} · ref ${fmtSI(rel.value, r.unit, 5)}`;
  }
  renderVerdict(r);
}

function renderStats(r) {
  const u = r?.unit || "";
  const ok = stats && stats.n;
  $("#s-min").textContent = ok ? fmtSI(stats.min, u) : "—";
  $("#s-max").textContent = ok ? fmtSI(stats.max, u) : "—";
  $("#s-avg").textContent = ok ? fmtSI(stats.mean, u, 5) : "—";
  $("#s-sd").textContent = ok ? fmtSI(sd(stats), u, 3) : "—";
  $("#s-pp").textContent = ok ? fmtSI(stats.max - stats.min, u, 4) : "—";
  $("#s-n").textContent = ok ? stats.n : 0;
  const recent = live.filter((p) => p.ts > (r?.ts ?? 0) - 10);
  $("#s-rate").textContent = recent.length > 1
    ? `${((recent.length - 1) / (recent[recent.length - 1].ts - recent[0].ts)).toFixed(1)} /s` : "—";

}
$("#s-reset").onclick = () => { statsSince = Date.now() / 1000; stats = null; renderStats(live[live.length - 1]); };

// ---------- REL / invert / voice / fullscreen ----------
function toggleRel() {
  const r = live[live.length - 1];
  if (rel || !r || r.value === null) { rel = null; toast("REL desactivado"); }
  else { rel = { value: r.value, key: modeKey(r), unit: r.unit }; toast(`Referencia: ${fmtSI(r.value, r.unit, 5)}`); }
  $("#rel-btn").classList.toggle("on", !!rel);
  if (r) renderLCD(r);
}
$("#rel-btn").onclick = toggleRel;

/** Flips polarity from now on and on everything already measured, recording included. */
async function toggleInvert() {
  meter.invert = !meter.invert;
  store.set("conn", { kind: meter.kind, model: meter.model, invert: meter.invert });
  live.forEach(Protocols.flipPolarity);   // meter.last is the same object as the newest one
  if (rel && Protocols.canInvert({ quantity: rel.key.split("|")[0], coupling: rel.key.split("|")[2] || null })) rel.value = -rel.value;
  recomputeStats();
  renderStatus();
  const last = live[live.length - 1];
  if (last) { renderLCD(last); renderStats(last); }
  drawLive();
  let msg = meter.invert ? "Polaridad invertida" : "Polaridad normal";
  if (meter.recording) {
    const n = await DB.flipSession(meter.recording.id);
    if (n) msg += ` · corregidas ${n} lecturas ya grabadas`;
  }
  toast(msg + " (solo tensión y corriente DC)", 3500);
}
$("#inv-btn").onclick = toggleInvert;

const UNIT_WORDS = { V: "voltios", A: "amperios", "Ω": "ohmios", Hz: "hercios", F: "faradios",
  "°C": "grados", "°F": "grados Fahrenheit", "%": "por ciento", hFE: "" };
const PREFIX_WORDS = { n: "nano", "µ": "micro", m: "mili", k: "kilo", M: "mega", "": "" };
function speak(r) {
  if (!voice || !("speechSynthesis" in window)) return;
  const txt = r.overload ? "fuera de rango"
    : `${r.display.replace("-", "menos ").replace(".", ",")} ${PREFIX_WORDS[r.prefix] ?? ""}${UNIT_WORDS[r.unit] ?? r.unit}`;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(txt);
  u.lang = "es-ES";
  speechSynthesis.speak(u);
}
function toggleVoice() {
  voice = !voice;
  $("#voice-btn").classList.toggle("on", voice);
  $("#voice-btn").textContent = voice ? "🔊 Voz" : "🔈 Voz";
  toast(voice ? "Leeré el valor cuando se estabilice" : "Voz desactivada");
  if (voice && live.length) speak(live[live.length - 1]);
}
$("#voice-btn").onclick = toggleVoice;

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("#meter").requestFullscreen?.().catch(() => {});
}
$("#fs-btn").onclick = toggleFullscreen;

// ---------- stability detection (voice + auto capture) ----------
let lastStable = null, armed = true;
function detectStable(r) {
  if (r.value === null || r.overload) { armed = true; lastStable = null; return; }
  if (r.flags.includes("HOLD")) return;
  const win = live.slice(-4);
  if (win.length < 4 || win.some((p) => p.value === null || modeKey(p) !== modeKey(r))) return;
  const vs = win.map((p) => p.value), mean = vs.reduce((a, b) => a + b) / vs.length;
  const spread = Math.max(...vs) - Math.min(...vs);
  if (spread > Math.max(Math.abs(mean) * 0.003, 2 * stepOf(r))) return;
  if (lastStable !== null && Math.abs(r.value - lastStable) <= Math.max(Math.abs(lastStable) * 0.005, 2 * stepOf(r))) return;
  lastStable = r.value;
  speak(r);
  if (sorter.on && sorter.auto && armed) {
    armed = false;
    captureSorted(r);
  }
}

// ---------- alarms ----------
const alarm = { on: false, lo: null, hi: null, key: null, tripped: false, ...store.get("alarm", {}) };
alarm.on = false;
["lo", "hi"].forEach((k) => ($(`#al-${k}`).value = alarm[k + "Txt"] || ""));
["sound", "notify", "stop"].forEach((k) => { if (k in alarm) $(`#al-${k}`).checked = alarm[k]; });

$("#al-on").onclick = async () => {
  if (alarm.on) { alarm.on = false; renderAlarm(); return; }
  const lo = parseSI($("#al-lo").value), hi = parseSI($("#al-hi").value);
  if (Number.isNaN(lo) || Number.isNaN(hi)) return toast("No entiendo alguno de los límites");
  if (lo === null && hi === null) return toast("Pon al menos un límite");
  const r = live[live.length - 1];
  Object.assign(alarm, { on: true, lo, hi, key: r ? modeKey(r) : null, unit: r?.unit || "", tripped: false,
    loTxt: $("#al-lo").value, hiTxt: $("#al-hi").value,
    sound: $("#al-sound").checked, notify: $("#al-notify").checked, stop: $("#al-stop").checked });
  store.set("alarm", { loTxt: alarm.loTxt, hiTxt: alarm.hiTxt, sound: alarm.sound, notify: alarm.notify, stop: alarm.stop });
  if (alarm.notify && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  renderAlarm();
};
function renderAlarm() {
  $("#al-on").textContent = alarm.on ? "Desactivar alarma" : "Activar alarma";
  $("#al-on").classList.toggle("on", alarm.on);
  const range = [alarm.lo !== null ? `≥ ${fmtSI(alarm.lo, alarm.unit || "")}` : "", alarm.hi !== null ? `≤ ${fmtSI(alarm.hi, alarm.unit || "")}` : ""]
    .filter(Boolean).join(" y ");
  $("#al-state").textContent = alarm.on ? `Vigilando ${range}${alarm.key ? " en " + modeLabel(Object.fromEntries(
    ["quantity", "unit", "coupling"].map((k, i) => [k, alarm.key.split("|")[i] || null]))) : ""}` : "";
  if (!alarm.on) { $("#lcd").classList.remove("alarm"); $("#alarm").hidden = true; }
  if (!paused && !liveZoom) drawLive();
}
function checkAlarm(r) {
  if (!alarm.on || r.value === null || r.flags.includes("HOLD")) return;
  alarm.key ??= modeKey(r);
  if (alarm.key !== modeKey(r)) return;
  const low = alarm.lo !== null && r.value < alarm.lo, high = alarm.hi !== null && r.value > alarm.hi;
  const out = low || high;
  $("#lcd").classList.toggle("alarm", out);
  $("#alarm").hidden = !out;
  if (out) $("#alarm").textContent = `⚠ ${low ? "por debajo de " + fmtSI(alarm.lo, r.unit) : "por encima de " + fmtSI(alarm.hi, r.unit)}`;
  if (out && !alarm.tripped) {
    if (alarm.sound) beep(880, 180, 3);
    const msg = `${modeLabel(r)}: ${r.display} ${r.prefix}${r.unit}`;
    if (alarm.notify && "Notification" in window && Notification.permission === "granted")
      new Notification("Alarma del multímetro", { body: msg });
    if (alarm.stop && meter.recording) stopRecording().then(() => toast("Grabación parada por la alarma"));
  }
  alarm.tripped = out;
}

// ---------- component sorter ----------
const sorter = { on: false, nom: null, tol: 5, auto: false, count: 0, pass: 0, ...store.get("sorter", {}) };
sorter.on = false;
$("#so-nom").value = sorter.nomTxt || "";
$("#so-tol").value = String(sorter.tol);
$("#so-auto").checked = !!sorter.auto;
$("#so-on").onclick = () => {
  if (sorter.on) { sorter.on = false; renderSorter(); return; }
  const nom = parseSI($("#so-nom").value);
  if (!nom) return toast("Indica un valor nominal, p. ej. 10k o 100n");
  Object.assign(sorter, { on: true, nom, nomTxt: $("#so-nom").value, tol: +$("#so-tol").value,
    auto: $("#so-auto").checked, count: 0, pass: 0 });
  store.set("sorter", { nomTxt: sorter.nomTxt, tol: sorter.tol, auto: sorter.auto });
  armed = true;
  renderSorter();
};
function renderSorter() {
  $("#so-on").textContent = sorter.on ? "Desactivar" : "Activar";
  $("#so-on").classList.toggle("on", sorter.on);
  $("#so-count").textContent = sorter.on && sorter.count ? `${sorter.pass} dentro / ${sorter.count - sorter.pass} fuera` : "";
  const r = live[live.length - 1];
  if (r) renderVerdict(r); else $("#verdict").hidden = true;
}
function verdictOf(r) {
  if (!sorter.on || r.value === null) return null;
  const dev = ((r.value - sorter.nom) / sorter.nom) * 100;
  return { ok: Math.abs(dev) <= sorter.tol, dev };
}
function renderVerdict(r) {
  const v = verdictOf(r), el = $("#verdict");
  el.hidden = !v;
  if (!v) return;
  el.className = v.ok ? "ok" : "bad";
  el.textContent = `${v.ok ? "✔ DENTRO" : "✘ FUERA"} ±${String(sorter.tol).replace(".", ",")} % (${v.dev >= 0 ? "+" : ""}${v.dev.toFixed(2)} %)`;
}
async function captureSorted(r) {
  const v = verdictOf(r);
  await DB.addReading(DB.SNAPSHOTS, r, sorterNote(r, $("#snap-note").value));
  sorter.count++; if (v.ok) sorter.pass++;
  v.ok ? beep(1760, 90) : beep(440, 250);
  renderSorter(); loadSnaps();
}

// ---------- chart ----------
function niceStep(range, ticks) {
  const raw = range / ticks, mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
}

/** Draws pts on canvas. opts: unit, t0, t1, hover, sel, W, H, title, subtitle, lines[{v,label,color}] */
function drawChart(canvas, pts, opts = {}) {
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const dpr = opts.W ? 1 : window.devicePixelRatio || 1;
  const W = opts.W || canvas.clientWidth, H = opts.H || canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  if (opts.W) { g.fillStyle = col("--card"); g.fillRect(0, 0, W, H); }
  const fs = opts.W ? 16 : 12;
  g.font = `${fs}px system-ui, sans-serif`;
  const L = opts.W ? 110 : 74, R = 16, B = opts.W ? 40 : 26;
  let T = 10;
  if (opts.title) {
    g.fillStyle = col("--ink"); g.textAlign = "left"; g.textBaseline = "top";
    g.font = `600 24px system-ui, sans-serif`; g.fillText(opts.title, L, 20);
    g.font = `${fs}px system-ui, sans-serif`; g.fillStyle = col("--muted");
    if (opts.subtitle) g.fillText(opts.subtitle, L, 54);
    T = 90;
  }
  const unit = opts.unit || "";
  let t0 = opts.t0 ?? pts[0]?.ts, t1 = opts.t1 ?? pts[pts.length - 1]?.ts;
  const vals = pts.filter((p) => p.value !== null && p.ts >= t0 && p.ts <= t1);
  if (!vals.length) {
    g.fillStyle = col("--muted"); g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(pts.length ? "Sin valores en esta zona" : "Esperando lecturas…", W / 2, (H + T) / 2);
    canvas._map = null; return;
  }
  if (t1 - t0 < 1) t0 = t1 - 1;
  let lo = Infinity, hi = -Infinity;
  for (const p of vals) { if (p.value < lo) lo = p.value; if (p.value > hi) hi = p.value; }
  for (const l of opts.lines || []) if (l.v !== null && l.v !== undefined && isFinite(l.v)) { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); }
  if (hi - lo < Math.abs(hi) * 1e-4 || hi === lo) { const d = Math.abs(hi) * 0.01 || 1e-3; lo -= d; hi += d; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  // grid + y labels
  const ys = niceStep(hi - lo, 5);
  g.strokeStyle = col("--grid"); g.fillStyle = col("--muted"); g.lineWidth = 1;
  g.textAlign = "right"; g.textBaseline = "middle";
  for (let v = Math.ceil(lo / ys) * ys; v <= hi; v += ys) {
    g.beginPath(); g.moveTo(L, Math.round(y(v)) + 0.5); g.lineTo(W - R, Math.round(y(v)) + 0.5); g.stroke();
    g.fillText(fmtSI(Math.abs(v) < ys / 1e6 ? 0 : v, unit), L - 8, y(v));
  }
  // x labels
  const span = t1 - t0;
  const xs = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400]
    .find((s) => span / s <= Math.max(2, Math.floor((W - L) / (opts.W ? 130 : 90)))) || 86400;
  g.textAlign = "center"; g.textBaseline = "top";
  for (let t = Math.ceil(t0 / xs) * xs; t <= t1; t += xs) {
    const d = new Date(t * 1000);
    const lbl = span > 86400 ? d.toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : d.toLocaleTimeString("es-ES", xs < 60 ? {} : { hour: "2-digit", minute: "2-digit" });
    g.fillText(lbl, x(t), H - B + 7);
  }

  // reference lines (alarm limits, REL, nominal)
  for (const l of opts.lines || []) {
    if (l.v === null || l.v === undefined || !isFinite(l.v)) continue;
    g.strokeStyle = l.color; g.fillStyle = l.color; g.setLineDash([6, 4]);
    g.beginPath(); g.moveTo(L, y(l.v)); g.lineTo(W - R, y(l.v)); g.stroke(); g.setLineDash([]);
    g.textAlign = "right"; g.textBaseline = "bottom"; g.fillText(l.label, W - R - 4, y(l.v) - 2);
  }

  // data line (gaps on overload / long silences)
  g.save();
  g.beginPath(); g.rect(L, T, W - L - R, H - T - B); g.clip();
  g.strokeStyle = col("--plot"); g.lineWidth = opts.W ? 2.25 : 1.75; g.lineJoin = "round";
  g.beginPath();
  let pen = false, prevT = null;
  const gap = Math.max(5, span / 50);
  for (const p of pts) {
    if (p.ts < t0 - gap || p.ts > t1 + gap) continue;
    if (p.value === null || (prevT !== null && p.ts - prevT > gap)) pen = false;
    if (p.value !== null) { pen ? g.lineTo(x(p.ts), y(p.value)) : g.moveTo(x(p.ts), y(p.value)); pen = true; }
    prevT = p.ts;
  }
  g.stroke();
  if (vals.length < 80) {
    g.fillStyle = col("--plot");
    for (const p of vals) { g.beginPath(); g.arc(x(p.ts), y(p.value), 2.5, 0, 7); g.fill(); }
  }
  g.restore();

  canvas._map = { t0, t1, L, R, W };
  // drag selection
  if (opts.sel) {
    const [a, b] = opts.sel.sort((m, n) => m - n);
    g.fillStyle = col("--plot"); g.globalAlpha = 0.12; g.fillRect(a, T, b - a, H - T - B); g.globalAlpha = 1;
  }
  // hover readout
  if (opts.hover != null && !opts.sel) {
    const t = t0 + ((opts.hover - L) / (W - L - R)) * (t1 - t0);
    let best = null;
    for (const p of vals) if (!best || Math.abs(p.ts - t) < Math.abs(best.ts - t)) best = p;
    if (best) {
      const px = x(best.ts), py = y(best.value);
      g.strokeStyle = col("--muted"); g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(px, T); g.lineTo(px, H - B); g.stroke(); g.setLineDash([]);
      g.fillStyle = col("--plot"); g.beginPath(); g.arc(px, py, 4, 0, 7); g.fill();
      const txt = `${fmtSI(best.value, unit, 5)} · ${new Date(best.ts * 1000).toLocaleTimeString("es-ES")}`;
      const tw = g.measureText(txt).width + 14;
      const bx = Math.min(Math.max(px - tw / 2, L), W - R - tw);
      g.fillStyle = col("--ink"); g.fillRect(bx, T, tw, 22);
      g.fillStyle = col("--card"); g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(txt, bx + tw / 2, T + 11);
    }
  }
}

/** Hover readout, drag-to-zoom and double-click reset. */
function attachInteractions(canvas, redraw, setZoom) {
  let start = null;
  const tAt = (px) => { const m = canvas._map; return m.t0 + ((px - m.L) / (m.W - m.L - m.R)) * (m.t1 - m.t0); };
  canvas.addEventListener("pointerdown", (e) => {
    if (!canvas._map || e.button) return;
    start = e.offsetX; canvas._sel = null; canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    canvas._hover = e.offsetX;
    if (start !== null && Math.abs(e.offsetX - start) > 4) canvas._sel = [start, e.offsetX];
    redraw();
  });
  canvas.addEventListener("pointerup", (e) => {
    if (start !== null && canvas._sel && canvas._map) {
      const [a, b] = [start, e.offsetX].sort((m, n) => m - n);
      setZoom({ t0: tAt(a), t1: tAt(b) });
    }
    start = null; canvas._sel = null; redraw();
  });
  canvas.addEventListener("pointerleave", () => { if (start === null) { canvas._hover = null; redraw(); } });
  canvas.addEventListener("dblclick", () => { setZoom(null); redraw(); });
}

function chartLines(unit) {
  const lines = [];
  if (alarm.on) {
    lines.push({ v: alarm.lo, label: "mín " + fmtSI(alarm.lo, unit), color: "#d33a2c" });
    lines.push({ v: alarm.hi, label: "máx " + fmtSI(alarm.hi, unit), color: "#d33a2c" });
  }
  if (rel) lines.push({ v: rel.value, label: "REL", color: "#8a6d00" });
  if (sorter.on) {
    lines.push({ v: sorter.nom * (1 - sorter.tol / 100), label: `−${sorter.tol} %`, color: "#2f9e5b" });
    lines.push({ v: sorter.nom * (1 + sorter.tol / 100), label: `+${sorter.tol} %`, color: "#2f9e5b" });
  }
  return lines;
}

function liveView() {
  const pts = modeLive(), last = pts[pts.length - 1];
  if (liveZoom) return { ...liveZoom, pts: pts.filter((p) => p.ts >= liveZoom.t0 && p.ts <= liveZoom.t1), unit: last?.unit || "" };
  const now = last ? Math.max(last.ts, Date.now() / 1000) : Date.now() / 1000;
  if (!windowSec) return { t0: pts[0]?.ts, t1: last?.ts, pts, unit: last?.unit || "" };
  const t0 = now - windowSec;
  return { t0, t1: now, pts: pts.filter((p) => p.ts >= t0 - 1), unit: last?.unit || "" };
}
function drawLive() {
  const c = $("#chart"), v = liveView();
  drawChart(c, v.pts, { unit: v.unit, t0: v.t0, t1: v.t1, hover: c._hover, sel: c._sel, lines: chartLines(v.unit) });
  $(".chart-hint").textContent = liveZoom ? "Ampliado — doble clic para volver al directo"
    : "Arrastra sobre la gráfica para ampliar · doble clic para volver";
}
attachInteractions($("#chart"), drawLive, (z) => { liveZoom = z; });
function setWindow(sec) {
  windowSec = sec; liveZoom = null;
  let match = false;
  $$("#window button").forEach((x) => { const on = +x.dataset.w === sec; x.classList.toggle("on", on); match ||= on; });
  $(".win-custom").classList.toggle("on", !match);
  $("#win-min").value = match ? "" : +(sec / 60).toFixed(2);
  store.set("window", windowSec);
  drawLive();
}
$("#window").onclick = (e) => { const b = e.target.closest("button"); if (b) setWindow(+b.dataset.w); };
$("#win-min").onchange = () => {
  const m = parseFloat($("#win-min").value.replace(",", "."));
  if (m > 0) setWindow(Math.round(Math.min(m, 1440) * 60));
  else setWindow(windowSec);
};
$("#win-min").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); };
setWindow(store.get("window", 120));
function togglePause() { paused = !paused; $("#pause").textContent = paused ? "Reanudar" : "Pausar"; drawLive(); }
$("#pause").onclick = togglePause;
window.addEventListener("resize", () => { drawLive(); if ($("#viewer").open) drawViewer(); });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => drawLive());
document.addEventListener("fullscreenchange", () => setTimeout(drawLive, 50));

// ---------- export ----------
const CSV_HEAD = ["fecha", "timestamp", "valor", "unidad", "pantalla", "prefijo", "magnitud", "acdc", "overload", "flags", "nota"];
const isoLocal = (ts) => {
  const d = new Date(ts * 1000), p = (n, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
const rowOf = (r) => [isoLocal(r.ts), r.ts.toFixed(3), r.value ?? "", r.unit, r.display, r.prefix, r.quantity,
  r.coupling || "", r.overload ? 1 : 0, r.flags.join(" "), r.note || ""];
function toCSV(rows) {
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  return [CSV_HEAD, ...rows.map(rowOf)].map((r) => r.map(q).join(",")).join("\n") + "\n";
}
function exportPNG(pts, { unit, t0, t1, title, subtitle, lines, filename }) {
  const c = document.createElement("canvas");
  drawChart(c, pts, { unit, t0, t1, title, subtitle, lines, W: 1600, H: 800 });
  c.toBlob((b) => download(filename, b));
}
function summary(pts, unit) {
  const s = statsOf(pts);
  if (!s.n) return "sin valores";
  return `mín ${fmtSI(s.min, unit)} · máx ${fmtSI(s.max, unit)} · media ${fmtSI(s.mean, unit, 5)} · σ ${fmtSI(sd(s), unit, 3)} · ${s.n} lecturas`;
}
$("#live-png").onclick = () => {
  const v = liveView(), last = live[live.length - 1];
  if (!last) return toast("No hay datos todavía");
  const pts = v.pts.filter((p) => p.ts >= v.t0 && p.ts <= v.t1);
  exportPNG(v.pts, { ...v, title: `${modeLabel(last)} — ${meter.model}`, lines: chartLines(v.unit),
    subtitle: `${fmtTime(v.t0)} → ${fmtTime(v.t1)} · ${summary(pts, v.unit)}`, filename: `grafica-${stamp()}.png` });
};
const visibleLive = () => { const v = liveView(); return v.pts.filter((p) => p.ts >= v.t0 && p.ts <= v.t1); };
$("#live-csv").onclick = () => download(`lecturas-${stamp()}.csv`, toCSV(visibleLive()), "text/csv");
$("#live-clear").onclick = () => {
  if (!confirm("¿Vaciar la gráfica en vivo? Las sesiones grabadas y las capturas no se tocan.")) return;
  live = []; stats = null; liveZoom = null; drawLive(); renderStats(null);
};
$("#live-json").onclick = () => download(`lecturas-${stamp()}.json`, JSON.stringify(visibleLive(), null, 1), "application/json");
$("#live-copy").onclick = async () => {
  // tab separated with decimal comma, pastes straight into a spanish spreadsheet
  const rows = visibleLive().map((r) => [isoLocal(r.ts), r.value === null ? "OL"
    : r.value.toLocaleString("es-ES", { maximumSignificantDigits: 12, useGrouping: false }), r.unit].join("\t"));
  try { await navigator.clipboard.writeText(["fecha\tvalor\tunidad", ...rows].join("\n")); toast(`${rows.length} filas copiadas`); }
  catch { toast("El navegador no deja copiar (hace falta https o localhost)"); }
};

// ---------- recording & snapshots ----------
const recPrefs = store.get("rec", {});
if (recPrefs.interval !== undefined) $("#rec-interval").value = recPrefs.interval;
if (recPrefs.max !== undefined) $("#rec-max").value = recPrefs.max;
$("#rec-skiphold").checked = !!recPrefs.skipHold;
let wakeLock = null;

async function startRecording() {
  const name = $("#rec-name").value.trim() || `Sesión ${new Date().toLocaleString("es-ES")}`;
  const interval = +$("#rec-interval").value, maxDuration = +$("#rec-max").value, skipHold = $("#rec-skiphold").checked;
  store.set("rec", { interval, max: maxDuration, skipHold });
  if (meter.recording) await stopRecording();
  const id = await DB.startSession(name, meter.model);
  meter.recording = { id, name, interval, maxDuration, skipHold, started: Date.now() / 1000, lastTs: 0, count: 0 };
  $("#rec-name").value = "";
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  renderStatus(); loadSessions();
}
async function stopRecording() {
  const rec = meter.recording;
  if (!rec) return;
  meter.recording = null;
  await DB.endSession(rec.id);
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
  renderStatus(); loadSessions();
}
function record(r) {
  const rec = meter.recording;
  if (!rec || r.ts - rec.lastTs < rec.interval || (rec.skipHold && r.flags.includes("HOLD"))) return;
  rec.lastTs = r.ts; rec.count++;
  DB.addReading(rec.id, r).catch((e) => toast("No se pudo guardar: " + e.message));
}
$("#rec-start").onclick = startRecording;
$("#rec-stop").onclick = stopRecording;
window.addEventListener("beforeunload", (e) => { if (meter.recording) { e.preventDefault(); e.returnValue = ""; } });
document.addEventListener("visibilitychange", async () => {   // the wake lock drops when the tab is hidden
  if (meter.recording && document.visibilityState === "visible") try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
});

function sorterNote(r, extra) {
  const v = r && verdictOf(r);
  if (!v) return extra;
  return `${v.ok ? "DENTRO" : "FUERA"} · nominal ${sorter.nomTxt} ±${sorter.tol} % (${v.dev >= 0 ? "+" : ""}${v.dev.toFixed(2)} %)` + (extra ? " · " + extra : "");
}
async function snapshot() {
  const r = meter.last;
  if (!r) return toast("Todavía no hay ninguna lectura que capturar");
  await DB.addReading(DB.SNAPSHOTS, r, sorterNote(r, $("#snap-note").value));
  if (!sorter.on) $("#snap-note").value = "";
  toast(`Capturado: ${r.display} ${r.prefix}${r.unit}`);
  loadSnaps();
  showListTab("snaps");
}
$("#snap").onclick = snapshot;

async function loadSnaps() {
  const rows = await DB.snapshots();
  $("#snaps-empty").hidden = rows.length > 0;
  $("#snaps").innerHTML = rows.map((r) => `<tr>
    <td>${fmtTime(r.ts)}</td><td class="r"><b>${esc(r.display)} ${esc(r.prefix + r.unit)}</b></td>
    <td>${esc(modeLabel(r))}</td><td class="note ${/^DENTRO/.test(r.note) ? "ok" : /^FUERA/.test(r.note) ? "bad" : ""}">${esc(r.note)}</td>
    <td><button class="ghost small" data-del="${r.id}" title="Borrar">✕</button></td></tr>`).join("");
  updateUsage();
}
$("#snaps").onclick = async (e) => {
  const id = e.target.dataset.del;
  if (id) { await DB.deleteReading(+id); loadSnaps(); }
};
$("#snaps-clear").onclick = async () => {
  if (!confirm("¿Borrar todas las capturas?")) return;
  await DB.clearSnapshots(); loadSnaps();
};
$("#snaps-csv").onclick = async () => download(`capturas-${stamp()}.csv`, toCSV(await DB.snapshots()), "text/csv");

async function loadSessions() {
  const rows = await DB.sessions();
  $("#sessions-empty").hidden = rows.length > 0;
  $("#sessions").innerHTML = rows.map((s) => `<tr class="click" data-id="${s.id}">
    <td><b>${esc(s.name)}</b>${s.ended ? "" : " <small class='live-tag'>● grabando</small>"}</td>
    <td>${fmtTime(s.started)}</td><td>${fmtDur((s.ended || Date.now() / 1000) - s.started)}</td>
    <td class="r">${s.count}</td>
    <td class="r">${s.count && s.min !== null ? `${fmtSI(s.min, s.unit || "")} / ${fmtSI(s.max, s.unit || "")}` : "—"}</td>
    <td><button class="ghost small" data-csv="${s.id}" title="Descargar CSV">CSV</button></td></tr>`).join("");
  updateUsage();
}
$("#sessions").onclick = async (e) => {
  const csv = e.target.dataset.csv;
  if (csv) return download(`sesion-${csv}.csv`, toCSV(await DB.readings(+csv)), "text/csv");
  const tr = e.target.closest("tr[data-id]");
  if (tr) openSession(+tr.dataset.id);
};

async function updateUsage() {
  const u = await DB.usage();
  $("#usage").textContent = u?.usage ? `${(u.usage / 1048576).toFixed(1)} MB usados` : "";
}
$("#backup-export").onclick = async () => {
  download(`unit-web-copia-${stamp()}.json`, JSON.stringify(await DB.exportAll()), "application/json");
};
$("#backup-import").onclick = () => $("#backup-file").click();
$("#backup-file").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const n = await DB.importAll(JSON.parse(await f.text()));
    toast(`Restauradas ${n.sessions} sesiones y ${n.readings} lecturas`);
    loadSessions(); loadSnaps();
  } catch (err) { toast(err.message, 4000); }
};

// ---------- session viewer ----------
let viewing = null;   // {session, pts (dominant mode), unit, zoom}
async function openSession(id) {
  const s = { ...(await DB.session(id)), readings: await DB.readings(id) };
  const counts = {};
  s.readings.forEach((r) => (counts[modeKey(r)] = (counts[modeKey(r)] || 0) + 1));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const pts = s.readings.filter((r) => modeKey(r) === top);   // mixed units can't share an axis
  viewing = { s, pts, unit: pts[0]?.unit || "", zoom: null, modes: Object.keys(counts).length };
  $("#v-name").value = s.name;
  $("#v-notes").value = s.notes || "";
  if (!$("#viewer").open) $("#viewer").showModal();
  drawViewer();
}
function viewerRange() {
  const { pts, zoom } = viewing;
  return zoom || { t0: pts[0]?.ts, t1: pts[pts.length - 1]?.ts };
}
function chargeAh(pts) {   // ∫ I dt, skipping gaps longer than 30 s
  let q = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dt = b.ts - a.ts;
    if (a.value !== null && b.value !== null && dt < 30) q += ((a.value + b.value) / 2) * dt;
  }
  return q / 3600;
}
function drawViewer() {
  if (!viewing) return;
  const { s, pts, unit } = viewing, { t0, t1 } = viewerRange();
  const vis = pts.filter((p) => p.ts >= t0 && p.ts <= t1);
  const st = statsOf(vis), first = pts[0];
  const meta = [
    ["Modelo", s.model], ["Inicio", fmtTime(s.started)], ["Duración", fmtDur((s.ended || Date.now() / 1000) - s.started)],
    ["Modo", first ? modeLabel(first) + (viewing.modes > 1 ? ` (+${viewing.modes - 1} modos más, ver CSV)` : "") : "—"],
    ["Lecturas", vis.length + (viewing.zoom ? ` de ${pts.length}` : "")],
    ["Mín", fmtSI(st.n ? st.min : null, unit)], ["Máx", fmtSI(st.n ? st.max : null, unit)],
    ["Media", fmtSI(st.n ? st.mean : null, unit, 5)], ["σ", fmtSI(st.n ? sd(st) : null, unit, 3)],
  ];
  if (first?.quantity === "current" && first.coupling !== "AC") meta.push(["Carga", fmtSI(chargeAh(vis), "Ah", 4)]);
  if (viewing.zoom) meta.push(["Zona", `${fmtTime(t0)} → ${new Date(t1 * 1000).toLocaleTimeString("es-ES")}`]);
  $("#v-meta").innerHTML = meta.map(([k, v]) => `<span>${k}: <b>${esc(v)}</b></span>`).join("");
  const c = $("#v-chart");
  drawChart(c, pts, { unit, t0, t1, hover: c._hover, sel: c._sel });
}
attachInteractions($("#v-chart"), drawViewer, (z) => { viewing.zoom = z; });
$("#v-png").onclick = () => {
  const { s, pts, unit } = viewing, { t0, t1 } = viewerRange();
  exportPNG(pts, { unit, t0, t1, title: s.name, filename: `sesion-${s.id}.png`,
    subtitle: `${s.model} · ${pts[0] ? modeLabel(pts[0]) : ""} · ${fmtTime(t0)} → ${fmtTime(t1)} · ${summary(pts.filter((p) => p.ts >= t0 && p.ts <= t1), unit)}` });
};
$("#v-csv").onclick = () => download(`sesion-${viewing.s.id}.csv`, toCSV(viewing.s.readings), "text/csv");
$("#v-json").onclick = () => download(`sesion-${viewing.s.id}.json`, JSON.stringify(viewing.s, null, 1), "application/json");
$("#v-invert").onclick = async () => {
  const n = await DB.flipSession(viewing.s.id);
  if (!n) return toast("Esta sesión no tiene lecturas de tensión o corriente DC");
  toast(`Invertidas ${n} lecturas`);
  await openSession(viewing.s.id);
  loadSessions();
};
$("#v-save").onclick = async () => {
  await DB.updateSession(viewing.s.id, { name: $("#v-name").value.trim() || viewing.s.name, notes: $("#v-notes").value });
  $("#viewer").close(); loadSessions(); toast("Guardado");
};
$("#v-delete").onclick = async () => {
  if (!confirm(`¿Borrar la sesión «${viewing.s.name}» y sus ${viewing.s.readings.length} lecturas?`)) return;
  await DB.deleteSession(viewing.s.id);
  $("#viewer").close(); loadSessions();
};

// ---------- open a saved CSV / TXT / JSON ----------
let importing = null;   // {file, a (analysis), name, pts}
$("#open-file").onclick = () => $("#open-input").click();
$("#open-input").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); };
document.addEventListener("dragover", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault(); document.body.classList.add("dropping");
});
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault(); document.body.classList.remove("dropping");
  openFile(e.dataTransfer.files[0]);
});

async function openFile(file) {
  const name = file.name.replace(/\.[^.]+$/, "");
  try {
    const text = await file.text();
    if (/\.json$/i.test(file.name) || /^\s*[{[]/.test(text)) {
      const data = JSON.parse(text);
      if (data?.app === "unitweb") {   // full backup
        const n = await DB.importAll(data);
        toast(`Restauradas ${n.sessions} sesiones y ${n.readings} lecturas`);
        return Promise.all([loadSessions(), loadSnaps()]);
      }
      const j = CsvImport.fromJSON(data);
      if (!j) throw new Error("Este JSON no tiene lecturas que pueda mostrar");
      return saveImported({ name: j.name || name, notes: j.notes || `Importado de ${file.name}` }, j.readings);
    }
    const a = CsvImport.analyze(text);
    if (a.own) return saveImported({ name, notes: `Importado de ${file.name}` }, CsvImport.build(a));
    importing = { file, a, name };
    showImporter();
  } catch (err) { toast(err.message || String(err), 5000); }
}

async function saveImported(meta, readings) {
  if (!readings.length) return toast("No he encontrado lecturas en el fichero", 4000);
  const id = await DB.importSession(meta, readings);
  toast(`«${meta.name}»: ${readings.length} lecturas, guardado en Sesiones`, 4000);
  showListTab("sessions");
  await loadSessions();
  openSession(id);
}

function showImporter() {
  const { a, file, name } = importing;
  const opt = (c) => `<option value="${c.index}">${esc(c.name)}</option>`;
  $("#im-title").textContent = `Abrir ${file.name}`;
  $("#im-name").value = name;
  $("#im-time").innerHTML = `<option value="-1">(sin tiempo: una fila por segundo)</option>` + a.columns.map(opt).join("");
  $("#im-time").value = a.timeCol;
  const numeric = a.columns.filter((c) => c.kind === "number");
  $("#im-value").innerHTML = (numeric.length ? numeric : a.columns).map(opt).join("");
  $("#im-value").value = a.valueCol;
  $("#im-unit").value = a.unit;
  const sep = { "\t": "tabulador", ";": "punto y coma", ",": "coma", "|": "barra" }[a.delimiter];
  $("#im-info").textContent = `${a.rows.length} filas · separador: ${sep}${a.decimalComma ? " · coma decimal" : ""}`;
  $("#im-preview").innerHTML = `<thead><tr>${a.header.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>`
    + a.rows.slice(0, 5).map((r) => `<tr>${a.header.map((_, i) => `<td>${esc(r[i])}</td>`).join("")}</tr>`).join("") + "</tbody>";
  $("#importer").showModal();
  previewImport();
}
function previewImport() {
  let pts = [];
  try {
    pts = CsvImport.build(importing.a, { timeCol: +$("#im-time").value, valueCol: +$("#im-value").value,
      unit: $("#im-unit").value, baseTs: importing.file.lastModified / 1000 });
  } catch {}
  importing.pts = pts;
  const c = $("#im-chart");
  drawChart(c, pts, { unit: pts[0]?.unit || "", hover: c._hover });
  $("#im-ok").disabled = !pts.length;
  $("#im-ok").textContent = pts.length ? `Abrir ${pts.length} lecturas y guardar como sesión` : "No hay lecturas válidas";
}
["#im-time", "#im-value", "#im-unit"].forEach((s) => $(s).addEventListener("input", previewImport));
attachInteractions($("#im-chart"), () => importing && drawChart($("#im-chart"), importing.pts, { unit: importing.pts[0]?.unit || "", hover: $("#im-chart")._hover }), () => {});
$("#im-ok").onclick = async () => {
  $("#importer").close();
  await saveImported({ name: $("#im-name").value.trim() || importing.name, notes: `Importado de ${importing.file.name}` }, importing.pts);
};

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey || $("dialog[open]")) return;
  const k = e.key.toLowerCase();
  const act = { " ": snapshot, r: toggleRel, v: toggleVoice, f: toggleFullscreen, i: toggleInvert, p: togglePause }[k];
  if (act) { e.preventDefault(); act(); }
});

// ---------- start ----------
setupConnection();
renderStatus();
drawLive();
DB.init().then(() => { loadSessions(); loadSnaps(); }).catch((e) => toast("Base de datos no disponible: " + e.message, 5000));
if (new URLSearchParams(location.search).has("demo")) connect("sim", $("#model").value);
