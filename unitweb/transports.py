"""Byte transports: UT-D04 USB/HID cable, serial cables and a simulator.

Every transport runs a blocking reader in its own thread and hands raw
bytes to ``on_data``. They never parse anything themselves.
"""

from __future__ import annotations

import fcntl
import glob
import math
import os
import random
import select
import struct
import threading
import time
from typing import Callable

# USB IDs of the opto-isolated HID cables UNI-T ships (UT-D04 and clones)
HID_CABLES = {
    (0x1A86, 0xE008): "WCH CH9325 (UT-D04)",
    (0x04FA, 0x2490): "Hoitek HE2325U (UT-D04)",
    (0x10C4, 0xEA80): "Silabs CP2110 (UT61+/UT161)",
}


def _ioc(direction: int, typ: str, nr: int, size: int) -> int:
    return (direction << 30) | (size << 16) | (ord(typ) << 8) | nr


def HIDIOCSFEATURE(size: int) -> int:  # noqa: N802 (kernel name)
    return _ioc(3, "H", 0x06, size)


def list_devices() -> list[dict]:
    """Return candidate devices: known HID cables and serial ports."""
    devices = []
    for node in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        try:
            with open(os.path.join(node, "device", "uevent")) as f:
                uevent = dict(line.strip().split("=", 1) for line in f if "=" in line)
        except OSError:
            continue
        hid_id = uevent.get("HID_ID", "")
        try:
            _, vid, pid = (int(x, 16) for x in hid_id.split(":"))
        except ValueError:
            continue
        path = "/dev/" + os.path.basename(node)
        if (vid, pid) in HID_CABLES and os.path.exists(path):
            devices.append({
                "path": path,
                "kind": "hid",
                "label": f"{HID_CABLES[(vid, pid)]} — {path}",
                "access": os.access(path, os.R_OK | os.W_OK),
            })
    try:
        from serial.tools import list_ports

        for p in list_ports.comports():
            if p.hwid in (None, "n/a") and os.path.basename(p.device).startswith("ttyS"):
                continue  # legacy on-board UARTs that are almost never wired
            desc = p.description if p.description and p.description != "n/a" else "Puerto serie"
            devices.append({
                "path": p.device,
                "kind": "serial",
                "label": f"{desc} — {p.device}",
                "access": os.access(p.device, os.R_OK | os.W_OK),
            })
    except ImportError:
        pass
    devices.append({"path": "sim", "kind": "sim", "label": "Simulador (sin multímetro)", "access": True})
    return devices


class Transport:
    def __init__(self, on_data: Callable[[bytes], None], on_error: Callable[[str], None]):
        self.on_data = on_data
        self.on_error = on_error
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._open()
        self._thread = threading.Thread(target=self._run, daemon=True, name=type(self).__name__)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        self._close()

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                data = self._read()
                if data:
                    self.on_data(data)
        except Exception as e:  # device unplugged, permissions, ...
            if not self._stop.is_set():
                self.on_error(str(e))

    def _open(self) -> None: ...
    def _close(self) -> None: ...
    def _read(self) -> bytes: ...


class HidTransport(Transport):
    """UT-D04 cable via /dev/hidrawN (no libusb needed).

    The chip is configured with a 5-byte feature report: baud rate as a
    little-endian uint32 followed by 0x03. Each 8-byte input report then
    carries ``report[0] & 0x0F`` payload bytes starting at ``report[1]``.
    """

    def __init__(self, path: str, baud: int, **kw):
        super().__init__(**kw)
        self.path, self.baud, self.fd = path, baud, -1

    def _open(self) -> None:
        self.fd = os.open(self.path, os.O_RDWR | os.O_NONBLOCK)
        report = bytes([0x00]) + struct.pack("<IB", self.baud, 0x03)  # report id 0 + payload
        fcntl.ioctl(self.fd, HIDIOCSFEATURE(len(report)), report)

    def _close(self) -> None:
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1

    def _read(self) -> bytes:
        r, _, _ = select.select([self.fd], [], [], 0.5)
        if not r:
            return b""
        rep = os.read(self.fd, 64)
        if not rep:
            raise OSError("el cable se ha desconectado")
        n = min(rep[0] & 0x0F, len(rep) - 1)
        return bytes(rep[1 : 1 + n])


class Cp2110Transport(HidTransport):
    """UT61+/UT161 meters: CP2110 HID-UART bridge, polled with a request command.

    Reports carry their payload length in byte 0 (which the CP2110 also
    uses as the report id), both for input and output.
    """

    def __init__(self, path: str, baud: int, request: bytes, poll: float = 0.3, **kw):
        super().__init__(path, baud, **kw)
        self.request, self.poll, self.next_poll = request, poll, 0.0

    def _open(self) -> None:
        self.fd = os.open(self.path, os.O_RDWR | os.O_NONBLOCK)
        uart = struct.pack(">BI", 0x50, self.baud) + bytes([0x00, 0x00, 0x03, 0x00, 0x00])
        for report in (bytes([0x41, 0x01]), uart, bytes([0x43, 0x02])):  # enable, 8N1, purge
            fcntl.ioctl(self.fd, HIDIOCSFEATURE(len(report)), report)

    def _read(self) -> bytes:
        now = time.monotonic()
        if now >= self.next_poll:
            os.write(self.fd, bytes([len(self.request)]) + self.request)
            self.next_poll = now + self.poll
        r, _, _ = select.select([self.fd], [], [], 0.1)
        if not r:
            return b""
        rep = os.read(self.fd, 64)
        if not rep:
            raise OSError("el cable se ha desconectado")
        return bytes(rep[1 : 1 + min(rep[0], len(rep) - 1)])


class SerialTransport(Transport):
    """RS-232 (UT-D02) or USB-serial cables.

    The opto receiver of the RS-232 cable is powered from DTR/RTS, so DTR
    must be high and RTS low.
    """

    def __init__(self, path: str, baud: int, framing: str = "8N1", **kw):
        super().__init__(**kw)
        self.path, self.baud, self.framing, self.ser = path, baud, framing, None

    def _open(self) -> None:
        import serial

        bits, parity, stop = int(self.framing[0]), self.framing[1], int(self.framing[2])
        self.ser = serial.Serial(self.path, self.baud, bytesize=bits, parity=parity,
                                 stopbits=stop, timeout=0.5)
        self.ser.dtr = True
        self.ser.rts = False

    def _close(self) -> None:
        if self.ser:
            self.ser.close()
            self.ser = None

    def _read(self) -> bytes:
        return self.ser.read(64)


class SimTransport(Transport):
    """Generates FS9922 packets like a UT61C measuring a drifting DC voltage."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.t0 = time.time()

    def _read(self) -> bytes:
        time.sleep(0.4)  # the UT61C sends ~2-3 packets per second
        t = time.time() - self.t0
        v = 3.3 + 0.6 * math.sin(t / 8) + random.gauss(0, 0.004)
        counts = round(abs(v) * 1000)
        sign = b"-" if v < 0 else b"+"
        bar = min(int(abs(v) / 6.0 * 42), 0x7F)
        pkt = (sign + f"{counts:04d}".encode() + b" " + b"1"
               + bytes([0x31, 0x00, 0x00, 0x80, bar]) + b"\r\n")
        return pkt


def make_transport(path: str, cfg: dict, on_data, on_error) -> Transport:
    kw = {"on_data": on_data, "on_error": on_error}
    if path == "sim":
        return SimTransport(**kw)
    if cfg.get("request"):
        return Cp2110Transport(path, cfg["baud"], cfg["request"], **kw)
    if os.path.realpath(path).startswith("/dev/hidraw"):  # also /dev/uni-t-dmm symlink
        return HidTransport(path, cfg["baud"], **kw)
    return SerialTransport(path, cfg["baud"], cfg["framing"], **kw)
