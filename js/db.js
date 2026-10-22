/*
 * Local storage in IndexedDB. Nothing leaves the browser.
 *
 *  sessions  {id, name, model, notes, started, ended, count, min, max, unit}
 *  readings  {id, sessionId, ts, value, display, prefix, unit, quantity, coupling, overload, flags, note}
 *            sessionId 0 = loose snapshot ("captura")
 */
(function (root) {
  "use strict";

  const SNAPSHOTS = 0;
  let dbp = null;

  function open() {
    dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("unitweb", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
        const r = db.createObjectStore("readings", { keyPath: "id", autoIncrement: true });
        r.createIndex("session", ["sessionId", "ts"]);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
  const result = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  async function tx(stores, mode, fn) {
    const db = await open();
    const t = db.transaction(stores, mode);
    const out = await fn(...[].concat(stores).map((s) => t.objectStore(s)));
    await done(t);
    return out;
  }

  const range = (sid) => IDBKeyRange.bound([sid, -Infinity], [sid, Infinity]);
  const pick = (r) => ({ ts: r.ts, value: r.value, display: r.display, prefix: r.prefix, unit: r.unit,
    quantity: r.quantity, coupling: r.coupling, overload: r.overload, flags: r.flags });

  const DB = {
    async init() {
      // a session left open by a closed tab ends at its last reading
      const open = (await this.sessions()).filter((s) => !s.ended);
      for (const s of open) {
        const rs = await this.readings(s.id);
        await tx("sessions", "readwrite", (st) => st.put({ ...s, ended: rs.length ? rs[rs.length - 1].ts : s.started }));
      }
      try { await navigator.storage?.persist?.(); } catch {}
    },

    startSession(name, model) {
      return tx("sessions", "readwrite", (s) => result(s.add({
        name, model, notes: "", started: Date.now() / 1000, ended: null, count: 0, min: null, max: null, unit: "" })));
    },

    endSession(id) {
      return tx("sessions", "readwrite", async (s) => {
        const ses = await result(s.get(id));
        if (ses) s.put({ ...ses, ended: Date.now() / 1000 });
      });
    },

    /** Stores a reading and keeps the session's summary up to date. */
    addReading(sessionId, r, note = "") {
      return tx(["sessions", "readings"], "readwrite", async (s, rd) => {
        const id = await result(rd.add({ ...pick(r), sessionId, note }));
        if (sessionId !== SNAPSHOTS) {
          const ses = await result(s.get(sessionId));
          if (ses) {
            ses.count++;
            if (r.value !== null) {
              ses.min = ses.min === null ? r.value : Math.min(ses.min, r.value);
              ses.max = ses.max === null ? r.value : Math.max(ses.max, r.value);
            }
            ses.unit ||= r.unit;
            s.put(ses);
          }
        }
        return id;
      });
    },

    async sessions() {
      const all = await tx("sessions", "readonly", (s) => result(s.getAll()));
      return all.sort((a, b) => b.started - a.started);
    },
    session: (id) => tx("sessions", "readonly", (s) => result(s.get(id))),
    readings: (sid) => tx("readings", "readonly", (r) => result(r.index("session").getAll(range(sid)))),
    async snapshots() { return (await this.readings(SNAPSHOTS)).reverse(); },

    updateSession(id, patch) {
      return tx("sessions", "readwrite", async (s) => {
        const ses = await result(s.get(id));
        if (ses) s.put({ ...ses, ...patch });
      });
    },

    deleteSession(id) {
      return tx(["sessions", "readings"], "readwrite", async (s, r) => {
        s.delete(id);
        const keys = await result(r.index("session").getAllKeys(range(id)));
        keys.forEach((k) => r.delete(k));
      });
    },
    deleteReading: (id) => tx("readings", "readwrite", (r) => { r.delete(id); }),
    clearSnapshots() { return this.deleteSession(SNAPSHOTS); },

    /** Whole database as a JSON-able object. */
    async exportAll() {
      const [sessions, readings] = await tx(["sessions", "readings"], "readonly",
        (s, r) => Promise.all([result(s.getAll()), result(r.getAll())]));
      return { app: "unitweb", version: 1, exported: new Date().toISOString(), sessions, readings };
    },

    /** Merges a backup; ids are renumbered so nothing gets overwritten. */
    async importAll(data) {
      if (data?.app !== "unitweb" || !Array.isArray(data.sessions) || !Array.isArray(data.readings)) {
        throw new Error("No es una copia de seguridad de UNI-T Web");
      }
      return tx(["sessions", "readings"], "readwrite", async (s, r) => {
        const map = { [SNAPSHOTS]: SNAPSHOTS };
        for (const ses of data.sessions) {
          const { id, ...rest } = ses;
          map[id] = await result(s.add(rest));
        }
        for (const rd of data.readings) {
          const { id, ...rest } = rd;
          if (rest.sessionId in map) r.add({ ...rest, sessionId: map[rest.sessionId] });
        }
        return { sessions: data.sessions.length, readings: data.readings.length };
      });
    },

    async usage() {
      try { return await navigator.storage.estimate(); } catch { return null; }
    },
  };

  root.DB = { ...DB, SNAPSHOTS };
  // methods use `this`
  for (const k of Object.keys(DB)) if (typeof DB[k] === "function") root.DB[k] = DB[k].bind(root.DB);
})(globalThis);
