"""SQLite storage for recording sessions and saved snapshots."""

from __future__ import annotations

import json
import sqlite3
import threading
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    model TEXT,
    notes TEXT DEFAULT '',
    started REAL NOT NULL,
    ended REAL
);
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    ts REAL NOT NULL,
    value REAL,
    display TEXT,
    prefix TEXT,
    unit TEXT,
    quantity TEXT,
    coupling TEXT,
    overload INTEGER,
    flags TEXT,
    note TEXT
);
CREATE INDEX IF NOT EXISTS readings_session ON readings(session_id, ts);
"""

COLS = ("ts", "value", "display", "prefix", "unit", "quantity", "coupling", "overload", "flags", "note")


class Storage:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        with self.lock:
            self.db.execute("PRAGMA foreign_keys = ON")
            self.db.execute("PRAGMA journal_mode = WAL")
            self.db.executescript(SCHEMA)
            # a session left open by a crash is closed at its last reading
            self.db.execute("""UPDATE sessions SET ended = COALESCE(
                (SELECT MAX(ts) FROM readings WHERE session_id = sessions.id), started)
                WHERE ended IS NULL""")
            self.db.commit()

    def _q(self, sql: str, args=()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def _x(self, sql: str, args=()) -> int:
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur.lastrowid

    def start_session(self, name: str, model: str) -> int:
        return self._x("INSERT INTO sessions (name, model, started) VALUES (?, ?, ?)",
                       (name, model, time.time()))

    def end_session(self, sid: int) -> None:
        self._x("UPDATE sessions SET ended = ? WHERE id = ?", (time.time(), sid))

    def add_reading(self, sid: int | None, r: dict, note: str | None = None) -> int:
        return self._x(
            f"INSERT INTO readings (session_id, {', '.join(COLS)}) VALUES (?{', ?' * len(COLS)})",
            (sid, r["ts"], r["value"], r["display"], r["prefix"], r["unit"], r["quantity"],
             r["coupling"], int(r["overload"]), json.dumps(r["flags"]), note))

    def sessions(self) -> list[dict]:
        return self._q("""SELECT s.*, COUNT(r.id) AS count, MIN(r.value) AS min, MAX(r.value) AS max,
                          AVG(r.value) AS avg, MAX(r.unit) AS unit
                          FROM sessions s LEFT JOIN readings r ON r.session_id = s.id
                          GROUP BY s.id ORDER BY s.started DESC""")

    def session(self, sid: int) -> dict | None:
        rows = self._q("SELECT * FROM sessions WHERE id = ?", (sid,))
        return rows[0] if rows else None

    def readings(self, sid: int | None) -> list[dict]:
        if sid is None:
            rows = self._q("SELECT * FROM readings WHERE session_id IS NULL ORDER BY ts DESC")
        else:
            rows = self._q("SELECT * FROM readings WHERE session_id = ? ORDER BY ts", (sid,))
        for r in rows:
            r["flags"] = json.loads(r["flags"] or "[]")
            r["overload"] = bool(r["overload"])
        return rows

    def update_session(self, sid: int, name: str | None, notes: str | None) -> None:
        if name is not None:
            self._x("UPDATE sessions SET name = ? WHERE id = ?", (name, sid))
        if notes is not None:
            self._x("UPDATE sessions SET notes = ? WHERE id = ?", (notes, sid))

    def delete_session(self, sid: int) -> None:
        self._x("DELETE FROM sessions WHERE id = ?", (sid,))

    def clear_snapshots(self) -> None:
        self._x("DELETE FROM readings WHERE session_id IS NULL")

    def backup(self) -> bytes:
        """Consistent copy of the whole database, safe while recording."""
        dst = sqlite3.connect(":memory:")
        with self.lock:
            self.db.backup(dst)
        data = dst.serialize()
        dst.close()
        return data

    def delete_reading(self, rid: int) -> None:
        self._x("DELETE FROM readings WHERE id = ?", (rid,))
