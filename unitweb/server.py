"""aiohttp web server: REST API, live WebSocket feed and static UI."""

from __future__ import annotations

import argparse
import asyncio
import csv
import io
import json
import logging
import os
import time
from collections import deque
from pathlib import Path

from aiohttp import WSMsgType, web

from . import __version__
from .models import DEFAULT_MODEL, MODELS
from .protocols import PARSERS
from .storage import Storage
from .transports import list_devices, make_transport

log = logging.getLogger("unitweb")
STATIC = Path(__file__).parent / "static"
HISTORY = 3000  # readings kept in memory for clients that connect late


class Meter:
    """Owns the connection to one multimeter and fans readings out."""

    def __init__(self, storage: Storage, loop: asyncio.AbstractEventLoop):
        self.storage, self.loop = storage, loop
        self.transport = None
        self.parser = None
        self.device: str | None = None
        self.model = DEFAULT_MODEL
        self.state = "disconnected"  # disconnected | connecting | connected | error
        self.error: str | None = None
        self.last = None
        self.last_rx = 0.0
        self.history: deque[dict] = deque(maxlen=HISTORY)
        self.clients: set[web.WebSocketResponse] = set()
        self.auto_reconnect = False
        self.recording: dict | None = None  # {id, name, interval, last_ts, count}
        self.invert = False  # probes swapped: flip the sign of DC V/A readings

    # -- connection -------------------------------------------------------
    def connect(self, device: str, model: str) -> None:
        self.disconnect()
        cfg = MODELS[model]
        self.device, self.model = device, model
        # the simulator always speaks FS9922, whatever model is selected
        self.parser = PARSERS["fs9922" if device == "sim" else cfg["parser"]]()
        self.history.clear()
        self.state, self.error = "connecting", None
        try:
            self.transport = make_transport(device, cfg, self._on_data_thread, self._on_error_thread)
            self.transport.start()
        except PermissionError:
            self._fail(f"Sin permiso para abrir {device}. Instala la regla udev (ver README).")
            raise
        except Exception as e:
            self._fail(f"No se pudo abrir {device}: {e}")
            raise
        self.auto_reconnect = True
        self.state = "connected"
        self._broadcast_status()

    def disconnect(self, keep_reconnect: bool = False) -> None:
        if self.transport:
            t, self.transport = self.transport, None
            t.stop()
        if not keep_reconnect:
            self.auto_reconnect = False
        if self.state != "error":
            self.state = "disconnected"
        self._broadcast_status()

    def _fail(self, msg: str) -> None:
        log.warning(msg)
        self.state, self.error = "error", msg
        self._broadcast_status()

    def _on_error_thread(self, msg: str) -> None:
        self.loop.call_soon_threadsafe(self._on_error, msg)

    def _on_error(self, msg: str) -> None:
        self._fail(f"Error de lectura: {msg}")
        self.disconnect(keep_reconnect=True)

    def _on_data_thread(self, data: bytes) -> None:
        self.loop.call_soon_threadsafe(self._on_data, data)

    def _on_data(self, data: bytes) -> None:
        if not self.parser:
            return
        for r in self.parser.feed(data):
            self.last_rx = time.time()
            d = r.to_dict()
            if self.invert:
                invert_reading(d)
            self.last = d
            self.history.append(d)
            self._record(d)
            self._send({"type": "reading", "reading": d})

    async def watchdog(self) -> None:
        """Reconnect after unplug and flag a silent meter (off / cable not seated)."""
        while True:
            await asyncio.sleep(2)
            if self.auto_reconnect and self.transport is None and self.device:
                try:
                    self.connect(self.device, self.model)
                    log.info("Reconectado a %s", self.device)
                except Exception:
                    pass
            rec = self.recording
            if rec and rec["max_duration"] and time.time() - rec["started"] >= rec["max_duration"]:
                log.info("Grabación «%s» terminada por duración", rec["name"])
                self.stop_recording()
            self._send({"type": "tick", "silent": self.state == "connected"
                        and time.time() - self.last_rx > 3})

    # -- recording --------------------------------------------------------
    def start_recording(self, name: str, interval: float, skip_hold: bool = False,
                        max_duration: float = 0) -> dict:
        if self.recording:
            self.stop_recording()
        sid = self.storage.start_session(name, self.model)
        self.recording = {"id": sid, "name": name, "interval": max(0.0, interval),
                          "last_ts": 0.0, "count": 0, "started": time.time(),
                          "skip_hold": skip_hold, "max_duration": max(0.0, max_duration)}
        self._broadcast_status()
        return self.recording

    def stop_recording(self) -> None:
        if self.recording:
            self.storage.end_session(self.recording["id"])
            self.recording = None
            self._broadcast_status()

    def _record(self, d: dict) -> None:
        rec = self.recording
        if not rec or d["ts"] - rec["last_ts"] < rec["interval"]:
            return
        if rec["skip_hold"] and "HOLD" in d["flags"]:
            return
        self.storage.add_reading(rec["id"], d)
        rec["last_ts"] = d["ts"]
        rec["count"] += 1

    # -- websocket fan-out -----------------------------------------------
    def status(self) -> dict:
        return {"state": self.state, "error": self.error, "device": self.device,
                "model": self.model, "recording": self.recording, "last": self.last,
                "invert": self.invert}

    def _broadcast_status(self) -> None:
        self._send({"type": "status", "status": self.status()})

    def _send(self, msg: dict) -> None:
        text = json.dumps(msg)
        for ws in list(self.clients):
            if ws.closed:
                self.clients.discard(ws)
            else:
                asyncio.ensure_future(ws.send_str(text))


def invert_reading(d: dict) -> None:
    """Flip polarity in place; only meaningful for DC voltage and current."""
    if d["quantity"] not in ("voltage", "current") or d["coupling"] == "AC":
        return
    if d["value"] is not None:
        d["value"] = -d["value"] if d["value"] else 0.0
    disp = d["display"]
    if disp.strip("-0.") or d["overload"]:  # never show "-0.000"
        d["display"] = disp[1:] if disp.startswith("-") else "-" + disp
    if d["bargraph"]:
        d["bargraph"] = -d["bargraph"]
    d["flags"] = d["flags"] + ["INV"]


# -- HTTP handlers ----------------------------------------------------------
routes = web.RouteTableDef()


def meter(req: web.Request) -> Meter:
    return req.app["meter"]


def store(req: web.Request) -> Storage:
    return req.app["storage"]


@routes.get("/")
async def index(req):
    return web.FileResponse(STATIC / "index.html")


@routes.get("/api/info")
async def info(req):
    return web.json_response({"version": __version__, "models": list(MODELS),
                              "devices": list_devices(), "status": meter(req).status()})


@routes.post("/api/connect")
async def connect(req):
    body = await req.json()
    model = body.get("model", DEFAULT_MODEL)
    if model not in MODELS:
        raise web.HTTPBadRequest(text=f"Modelo desconocido: {model}")
    try:
        meter(req).connect(body["device"], model)
    except Exception:
        return web.json_response(meter(req).status(), status=500)
    return web.json_response(meter(req).status())


@routes.post("/api/disconnect")
async def disconnect(req):
    m = meter(req)
    m.stop_recording()
    m.state = "disconnected"
    m.disconnect()
    return web.json_response(m.status())


@routes.post("/api/invert")
async def invert(req):
    body = await req.json()
    m = meter(req)
    m.invert = bool(body.get("on"))
    m._broadcast_status()
    return web.json_response(m.status())


@routes.post("/api/record/start")
async def record_start(req):
    body = await req.json()
    name = (body.get("name") or "").strip() or time.strftime("Sesión %Y-%m-%d %H:%M:%S")
    rec = meter(req).start_recording(name, float(body.get("interval") or 0),
                                     bool(body.get("skip_hold")),
                                     float(body.get("max_duration") or 0))
    return web.json_response(rec)


@routes.post("/api/record/stop")
async def record_stop(req):
    meter(req).stop_recording()
    return web.json_response(meter(req).status())


@routes.post("/api/snapshot")
async def snapshot(req):
    body = await req.json()
    last = meter(req).last
    if not last:
        raise web.HTTPConflict(text="No hay lectura todavía")
    rid = store(req).add_reading(None, last, body.get("note") or "")
    return web.json_response({"id": rid, **last, "note": body.get("note") or ""})


@routes.get("/api/snapshots")
async def snapshots(req):
    return web.json_response(store(req).readings(None))


@routes.delete("/api/snapshots")
async def snapshots_clear(req):
    store(req).clear_snapshots()
    return web.json_response({"ok": True})


@routes.delete("/api/readings/{rid:\\d+}")
async def delete_reading(req):
    store(req).delete_reading(int(req.match_info["rid"]))
    return web.json_response({"ok": True})


@routes.get("/api/sessions")
async def sessions(req):
    return web.json_response(store(req).sessions())


@routes.get("/api/sessions/{sid:\\d+}")
async def session(req):
    sid = int(req.match_info["sid"])
    s = store(req).session(sid)
    if not s:
        raise web.HTTPNotFound()
    return web.json_response({**s, "readings": store(req).readings(sid)})


@routes.patch("/api/sessions/{sid:\\d+}")
async def session_update(req):
    body = await req.json()
    store(req).update_session(int(req.match_info["sid"]), body.get("name"), body.get("notes"))
    return web.json_response({"ok": True})


@routes.delete("/api/sessions/{sid:\\d+}")
async def session_delete(req):
    sid = int(req.match_info["sid"])
    rec = meter(req).recording
    if rec and rec["id"] == sid:
        meter(req).stop_recording()
    store(req).delete_session(sid)
    return web.json_response({"ok": True})


def _csv_response(rows: list[dict], filename: str) -> web.Response:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["fecha", "timestamp", "valor", "unidad", "pantalla", "prefijo", "magnitud",
                "acdc", "overload", "flags", "nota"])
    for r in rows:
        w.writerow([time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r["ts"]))
                    + f".{int(r['ts'] % 1 * 1000):03d}",
                    f"{r['ts']:.3f}", "" if r["value"] is None else repr(r["value"]),
                    r["unit"], r["display"], r["prefix"], r["quantity"], r["coupling"] or "",
                    int(r["overload"]), " ".join(r["flags"]), r.get("note") or ""])
    return web.Response(text=buf.getvalue(), content_type="text/csv", charset="utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@routes.get("/api/sessions/{sid:\\d+}/csv")
async def session_csv(req):
    sid = int(req.match_info["sid"])
    return _csv_response(store(req).readings(sid), f"sesion-{sid}.csv")


@routes.get("/api/sessions/{sid:\\d+}/json")
async def session_json(req):
    sid = int(req.match_info["sid"])
    s = store(req).session(sid)
    if not s:
        raise web.HTTPNotFound()
    body = json.dumps({**s, "readings": store(req).readings(sid)}, ensure_ascii=False, indent=1)
    return web.Response(text=body, content_type="application/json", headers={
        "Content-Disposition": f'attachment; filename="sesion-{sid}.json"'})


@routes.get("/api/backup")
async def backup(req):
    data = await asyncio.to_thread(store(req).backup)
    name = time.strftime("unitweb-%Y%m%d-%H%M%S.sqlite3")
    return web.Response(body=data, content_type="application/vnd.sqlite3",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})


@routes.get("/api/last")
async def last(req):
    """Latest reading only, handy for scripts: curl -s host:8061/api/last"""
    return web.json_response(meter(req).last or {})


@routes.get("/metrics")
async def metrics(req):
    """Prometheus exposition of the latest reading."""
    m = meter(req)
    lines = ["# HELP unitweb_connected 1 when the meter is connected and sending data",
             "# TYPE unitweb_connected gauge",
             f"unitweb_connected {int(m.state == 'connected' and time.time() - m.last_rx < 5)}",
             "# HELP unitweb_recording 1 while a session is being recorded",
             "# TYPE unitweb_recording gauge",
             f"unitweb_recording {int(bool(m.recording))}"]
    r = m.last
    if r and r["value"] is not None and time.time() - r["ts"] < 10:
        labels = f'quantity="{r["quantity"]}",unit="{r["unit"]}",coupling="{r["coupling"] or ""}"'
        lines += ["# HELP unitweb_value Latest reading in base SI units",
                  "# TYPE unitweb_value gauge", f"unitweb_value{{{labels}}} {r['value']!r}"]
    return web.Response(text="\n".join(lines) + "\n", content_type="text/plain")


@routes.get("/api/snapshots/csv")
async def snapshots_csv(req):
    return _csv_response(store(req).readings(None), "capturas.csv")


@routes.get("/ws")
async def websocket(req):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(req)
    m = meter(req)
    await ws.send_json({"type": "hello", "status": m.status(), "history": list(m.history)})
    m.clients.add(ws)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
    finally:
        m.clients.discard(ws)
    return ws


async def _startup(app: web.Application) -> None:
    m = Meter(app["storage"], asyncio.get_running_loop())
    app["meter"] = m
    app["watchdog"] = asyncio.create_task(m.watchdog())
    dev, model = app["autoconnect"]
    if dev:
        try:
            m.connect(dev, model)
        except Exception as e:
            log.error("No se pudo conectar a %s: %s", dev, e)
            m.device, m.auto_reconnect = dev, True


async def _cleanup(app: web.Application) -> None:
    app["watchdog"].cancel()
    m = app["meter"]
    m.stop_recording()
    m.disconnect()


def build_app(db: str, device: str | None = None, model: str = DEFAULT_MODEL) -> web.Application:
    app = web.Application()
    app["storage"] = Storage(db)
    app["autoconnect"] = (device, model)
    app.add_routes(routes)
    app.router.add_static("/static", STATIC)
    app.on_startup.append(_startup)
    app.on_cleanup.append(_cleanup)
    return app


def main() -> None:
    env = os.environ.get
    ap = argparse.ArgumentParser(description="Interfaz web para multímetros UNI-T")
    ap.add_argument("--host", default=env("UNITWEB_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(env("UNITWEB_PORT", "8061")))
    ap.add_argument("--db", default=env("UNITWEB_DB", "unitweb.sqlite3"))
    ap.add_argument("--device", default=env("UNITWEB_DEVICE"),
                    help="conectar al arrancar: /dev/hidrawN, /dev/ttyUSB0 o 'sim'")
    ap.add_argument("--model", default=env("UNITWEB_MODEL", DEFAULT_MODEL), choices=list(MODELS))
    ap.add_argument("--list", action="store_true", help="listar dispositivos y salir")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.list:
        for d in list_devices():
            print(f"{d['path']:16} {'ok ' if d['access'] else 'SIN PERMISO'}  {d['label']}")
        return
    os.makedirs(os.path.dirname(os.path.abspath(args.db)), exist_ok=True)
    print(f"UNI-T web en http://{args.host}:{args.port}")
    web.run_app(build_app(args.db, args.device, args.model), host=args.host, port=args.port,
                print=None)
