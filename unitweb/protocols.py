"""Parsers for the DMM chipset protocols used by UNI-T meters.

Each parser consumes a raw byte stream (``feed``) and yields ``Reading``
objects once a complete, valid packet has been found. Framing is resynced
automatically, so the stream can start in the middle of a packet.

References: libsigrok src/dmm/{fs9922,fs9721,es519xx}.c and the chip
datasheets (Fortune Semiconductor FS9922-DMM4, FS9721_LP3, Cyrustek ES51922).
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field

PREFIX_FACTOR = {"p": 1e-12, "n": 1e-9, "µ": 1e-6, "m": 1e-3, "": 1.0, "k": 1e3, "M": 1e6}


@dataclass
class Reading:
    value: float | None  # value in base units (V, A, Ω...), None on overload
    display: str  # digits as shown on the LCD, e.g. "-1.234" or "OL"
    prefix: str  # SI prefix shown on the LCD ("m", "k", ...)
    unit: str  # base unit: V, A, Ω, F, Hz, %, °C, °F, hFE
    quantity: str  # voltage, current, resistance, continuity, diode, ...
    coupling: str | None = None  # "DC", "AC" or None
    overload: bool = False
    flags: list[str] = field(default_factory=list)  # AUTO, HOLD, REL, MAX, MIN, BAT, ...
    bargraph: int | None = None
    ts: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return asdict(self)


class Parser:
    name = "base"
    packet_len = 14

    def __init__(self) -> None:
        self.buf = bytearray()

    def feed(self, data: bytes) -> list[Reading]:
        raise NotImplementedError

    def parse(self, pkt: bytes) -> Reading | None:
        raise NotImplementedError


class LineParser(Parser):
    """Packets of fixed length terminated by CR LF."""

    mask_parity = False  # strip bit 7 (7-bit protocols read through 8-bit cables)

    def feed(self, data: bytes) -> list[Reading]:
        if self.mask_parity:
            data = bytes(b & 0x7F for b in data)
        self.buf += data
        out = []
        while True:
            i = self.buf.find(b"\r\n")
            if i < 0:
                # keep the buffer bounded when garbage arrives
                del self.buf[: max(0, len(self.buf) - self.packet_len)]
                break
            end = i + 2
            if end >= self.packet_len:
                pkt = bytes(self.buf[end - self.packet_len : end])
                r = self.parse(pkt)
                if r is not None:
                    out.append(r)
            del self.buf[:end]
        return out


def _quantity_from_unit(unit: str) -> str:
    return {
        "V": "voltage",
        "A": "current",
        "Ω": "resistance",
        "Hz": "frequency",
        "F": "capacitance",
        "°C": "temperature",
        "°F": "temperature",
        "%": "duty",
        "hFE": "hfe",
    }.get(unit, "unknown")


def _apply(digits: str, decimals: int, negative: bool, prefix: str) -> tuple[float, str]:
    n = int(digits)
    if decimals:
        disp = digits[: len(digits) - decimals] + "." + digits[len(digits) - decimals :]
    else:
        disp = digits
    if negative:
        disp = "-" + disp
        n = -n
    return n / (10**decimals) * PREFIX_FACTOR[prefix], disp


# --------------------------------------------------------------------------
# FS9922-DMM4 (UT61B, UT61C, UT61D, UT-D04/UT-D02 cable, 2400 8N1)
#
#  0     sign '+' / '-'
#  1..4  four ASCII digits ("?0:?" means OL)
#  5     space
#  6     decimal point: '0' none, '1' d.ddd, '2' dd.dd, '4' ddd.d
#  7     SB1: b5 AUTO, b4 DC, b3 AC, b2 REL, b1 HOLD, b0 BPN (bargraph)
#  8     SB2: b7 Z1, b6 Z2, b5 MAX, b4 MIN, b3 APO, b2 BAT, b1 n, b0 Z3
#  9     SB3: b7 µ, b6 m, b5 k, b4 M, b3 beep, b2 diode, b1 %, b0 Z4
#  10    SB4: b7 V, b6 A, b5 Ω, b4 hFE, b3 Hz, b2 F, b1 °C, b0 °F
#  11    bargraph: b7 sign, b6..0 value
#  12,13 CR LF
# --------------------------------------------------------------------------
class FS9922(LineParser):
    name = "fs9922"
    packet_len = 14

    def parse(self, b: bytes) -> Reading | None:
        if len(b) != 14 or b[12] != 0x0D or b[13] != 0x0A or b[0] not in (0x2B, 0x2D):
            return None
        raw = b[1:5]
        overload = raw == b"?0:?"
        if not overload and not all(0x30 <= c <= 0x39 for c in raw):
            return None
        decimals = {0x30: 0, 0x31: 3, 0x32: 2, 0x34: 1}.get(b[6])
        if decimals is None:
            return None
        sb1, sb2, sb3, sb4, bar = b[7], b[8], b[9], b[10], b[11]
        # same sanity checks as libsigrok: one multiplier, one unit, not AC+DC
        if (bin(sb3 & 0xF0).count("1") + bool(sb2 & 0x02) > 1
                or bin(sb4).count("1") > 1 or (sb1 & 0x18) == 0x18):
            return None

        prefix = ""
        if sb2 & 0x02:
            prefix = "n"
        elif sb3 & 0x80:
            prefix = "µ"
        elif sb3 & 0x40:
            prefix = "m"
        elif sb3 & 0x20:
            prefix = "k"
        elif sb3 & 0x10:
            prefix = "M"

        unit = ""
        for bit, u in ((0x80, "V"), (0x40, "A"), (0x20, "Ω"), (0x10, "hFE"),
                       (0x08, "Hz"), (0x04, "F"), (0x02, "°C"), (0x01, "°F")):
            if sb4 & bit:
                unit = u
                break
        if sb3 & 0x02:
            unit = "%"

        quantity = _quantity_from_unit(unit)
        if sb3 & 0x04:
            quantity, unit = "diode", "V"
        elif sb3 & 0x08 and unit == "Ω":
            quantity = "continuity"

        coupling = "AC" if sb1 & 0x08 else "DC" if sb1 & 0x10 else None

        flags = [name for bit, name, reg in (
            (0x20, "AUTO", sb1), (0x04, "REL", sb1), (0x02, "HOLD", sb1),
            (0x20, "MAX", sb2), (0x10, "MIN", sb2), (0x08, "APO", sb2),
            (0x04, "BAT", sb2), (0x08, "BEEP", sb3)) if reg & bit]

        negative = b[0] == 0x2D
        if overload:
            value, disp = None, ("-" if negative else "") + (
                "0.L" if decimals == 3 else "O.L" if decimals == 2 else "OL")
        else:
            value, disp = _apply(raw.decode(), decimals, negative, prefix)

        bargraph = None
        if sb1 & 0x01:
            bargraph = -(bar & 0x7F) if bar & 0x80 else bar & 0x7F

        return Reading(value=value, display=disp, prefix=prefix, unit=unit, quantity=quantity,
                       coupling=coupling, overload=overload, flags=flags, bargraph=bargraph)


# --------------------------------------------------------------------------
# FS9721_LP3 (UT60A/UT60E family, 2400 8N1). 14 bytes; the high nibble of
# every byte is its 1-based position, the low nibble carries LCD segments.
# --------------------------------------------------------------------------
_SEG7 = {0x7D: "0", 0x05: "1", 0x5B: "2", 0x1F: "3", 0x27: "4", 0x3E: "5",
         0x7E: "6", 0x15: "7", 0x7F: "8", 0x3F: "9", 0x00: " ", 0x68: "L"}


class FS9721(Parser):
    name = "fs9721"
    packet_len = 14

    def feed(self, data: bytes) -> list[Reading]:
        out = []
        for c in data:
            idx = c >> 4
            if idx == 1:
                self.buf = bytearray([c])
            elif self.buf and idx == len(self.buf) + 1:
                self.buf.append(c)
                if len(self.buf) == 14:
                    r = self.parse(bytes(self.buf))
                    if r is not None:
                        out.append(r)
                    self.buf = bytearray()
            else:
                self.buf = bytearray()
        return out

    def parse(self, b: bytes) -> Reading | None:
        if len(b) != 14 or any((c >> 4) != i + 1 for i, c in enumerate(b)):
            return None
        n = [c & 0x0F for c in b]
        digits, decimals, negative = "", 0, bool(n[1] & 0x08)
        for d in range(4):
            hi, lo = n[1 + 2 * d], n[2 + 2 * d]
            if d > 0 and hi & 0x08:
                decimals = 4 - d
            ch = _SEG7.get(((hi & 0x07) << 4) | lo)
            if ch is None:
                return None
            digits += ch
        overload = "L" in digits
        f10, f11, f12, f13, f14 = n[9], n[10], n[11], n[12], n[13]

        prefix = ("µ" if f10 & 0x08 else "n" if f10 & 0x04 else "k" if f10 & 0x02 else
                  "m" if f11 & 0x08 else "M" if f11 & 0x02 else "")
        unit = ("%" if f11 & 0x04 else "F" if f12 & 0x08 else "Ω" if f12 & 0x04 else
                "A" if f13 & 0x08 else "V" if f13 & 0x04 else "Hz" if f13 & 0x02 else
                "°C" if f14 & 0x04 else "")
        quantity = _quantity_from_unit(unit)
        if f10 & 0x01:
            quantity, unit = "diode", "V"
        elif f11 & 0x01 and unit == "Ω":
            quantity = "continuity"
        coupling = "AC" if n[0] & 0x08 else "DC" if n[0] & 0x04 else None
        flags = [name for bit, name, reg in (
            (0x02, "AUTO", n[0]), (0x02, "REL", f12), (0x01, "HOLD", f12),
            (0x01, "BAT", f13), (0x01, "BEEP", f11)) if reg & bit]

        if overload:
            value, disp = None, "OL"
        else:
            value, disp = _apply(digits.replace(" ", "0"), decimals, negative, prefix)
        return Reading(value=value, display=disp, prefix=prefix, unit=unit, quantity=quantity,
                       coupling=coupling, overload=overload, flags=flags)


# --------------------------------------------------------------------------
# ES51922 (UT61E, 19200 7O1, 22000 counts)
#
#  0     range (0x30 + n)
#  1..5  five ASCII digits
#  6     function
#  7     status:  b3 JUDGE, b2 SIGN, b1 BATT, b0 OL
#  8     option1: b3 MAX, b2 MIN, b1 REL, b0 RMR
#  9     option2: b3 UL, b2 PMAX, b1 PMIN
#  10    option3: b3 DC, b2 AC, b1 AUTO, b0 VAHZ
#  11    option4: b2 VBAR, b1 HOLD, b0 LPF
#  12,13 CR LF
# --------------------------------------------------------------------------
# range index -> (prefix, decimals)
_ES_RANGES = {
    "voltage": [("", 4), ("", 3), ("", 2), ("", 1), ("m", 2)],
    "current_u": [("µ", 2), ("µ", 1)],
    "current_m": [("m", 3), ("m", 2)],
    "current_a": [("", 3)],
    "current_man": [("", 4), ("", 3), ("", 2), ("", 1), ("", 0)],
    "resistance": [("", 2), ("k", 4), ("k", 3), ("k", 2), ("M", 4), ("M", 3), ("M", 2)],
    "frequency": [("", 2), ("", 1), ("", 0), ("k", 3), ("k", 2), ("M", 4), ("M", 3), ("M", 2)],
    "capacitance": [("n", 3), ("n", 2), ("µ", 4), ("µ", 3), ("µ", 2), ("m", 4), ("m", 3), ("m", 2)],
    "continuity": [("", 2)],
    "diode": [("", 4)],
}
_ES_FUNCS = {
    0x3B: ("voltage", "V", "voltage"),
    0x3D: ("current", "A", "current_u"),
    0x3F: ("current", "A", "current_m"),
    0x30: ("current", "A", "current_a"),
    0x39: ("current", "A", "current_man"),
    0x33: ("resistance", "Ω", "resistance"),
    0x35: ("continuity", "Ω", "continuity"),
    0x31: ("diode", "V", "diode"),
    0x32: ("frequency", "Hz", "frequency"),
    0x36: ("capacitance", "F", "capacitance"),
}


class ES51922(LineParser):
    name = "es51922"
    packet_len = 14
    mask_parity = True

    def parse(self, b: bytes) -> Reading | None:
        if len(b) != 14 or b[12] != 0x0D or b[13] != 0x0A:
            return None
        raw = b[1:6]
        if not all(0x30 <= c <= 0x39 for c in raw):
            return None
        func = _ES_FUNCS.get(b[6])
        if func is None:
            return None
        quantity, unit, table = func
        rng = b[0] - 0x30
        status, op1, op3, op4 = b[7], b[8], b[10], b[11]

        if quantity == "frequency" and not status & 0x08:
            # JUDGE clear in the Hz position means duty cycle
            quantity, unit, prefix, decimals = "duty", "%", "", 1
        elif quantity in ("voltage", "current") and op3 & 0x01:
            # VAHZ: frequency measured from the V/A input
            quantity, unit = "frequency", "Hz"
            ranges = _ES_RANGES["frequency"]
            if not 0 <= rng < len(ranges):
                return None
            prefix, decimals = ranges[rng]
        else:
            ranges = _ES_RANGES[table]
            if not 0 <= rng < len(ranges):
                return None
            prefix, decimals = ranges[rng]

        coupling = None
        if quantity in ("voltage", "current"):
            coupling = "AC" if op3 & 0x04 else "DC" if op3 & 0x08 else None
        overload = bool(status & 0x01)
        negative = bool(status & 0x04)
        flags = [name for bit, name, reg in (
            (0x02, "AUTO", op3), (0x02, "REL", op1), (0x02, "HOLD", op4),
            (0x08, "MAX", op1), (0x04, "MIN", op1), (0x02, "BAT", status),
            (0x01, "LPF", op4)) if reg & bit]

        if overload:
            value, disp = None, "OL"
        else:
            value, disp = _apply(raw.decode(), decimals, negative, prefix)
        return Reading(value=value, display=disp, prefix=prefix, unit=unit, quantity=quantity,
                       coupling=coupling, overload=overload, flags=flags)




# --------------------------------------------------------------------------
# UT61+ series (UT61B+/D+/E+, UT161B/D/E) over the built-in CP2110 USB-HID
# bridge, 9600 8N1. The meter answers a request command with
#   AB CD len | mode | range(ASCII) | display(7 ASCII) | bar(2) | flags(3) | sum16(BE)
# where sum16 covers every byte before it, AB CD included.
# Tables after github.com/ljakob/unit_ut61eplus.
# --------------------------------------------------------------------------
UT61P_REQUEST = bytes.fromhex("ABCD035E01D9")

_UP_MODES = ["ACV", "ACmV", "DCV", "DCmV", "Hz", "%", "OHM", "CONT", "DIODE", "CAP", "°C", "°F",
             "DCuA", "ACuA", "DCmA", "ACmA", "DCA", "ACA", "HFE", "Live", "NCV", "LozV", "ACA",
             "DCA", "LPF", "AC/DC", "LPF", "AC+DC", "LPF", "AC+DC2", "INRUSH"]
# mode -> (quantity, unit, coupling, prefix per range digit)
_UP_INFO = {
    "ACV": ("voltage", "V", "AC", ""), "ACmV": ("voltage", "V", "AC", "m"),
    "DCV": ("voltage", "V", "DC", ""), "DCmV": ("voltage", "V", "DC", "m"),
    "Hz": ("frequency", "Hz", None, "  kkkMMM"), "%": ("duty", "%", None, ""),
    "OHM": ("resistance", "Ω", None, " kkkMMM"), "CONT": ("continuity", "Ω", None, ""),
    "DIODE": ("diode", "V", None, ""), "CAP": ("capacitance", "F", None, "nnµµµmmm"),
    "°C": ("temperature", "°C", None, ""), "°F": ("temperature", "°F", None, ""),
    "DCuA": ("current", "A", "DC", "µ"), "ACuA": ("current", "A", "AC", "µ"),
    "DCmA": ("current", "A", "DC", "m"), "ACmA": ("current", "A", "AC", "m"),
    "DCA": ("current", "A", "DC", ""), "ACA": ("current", "A", "AC", ""),
    "HFE": ("hfe", "hFE", None, ""), "LozV": ("voltage", "V", "AC", ""),
    "LPF": ("voltage", "V", "AC", ""), "AC/DC": ("voltage", "V", None, ""),
    "AC+DC": ("current", "A", "AC+DC", ""), "AC+DC2": ("current", "A", "AC+DC", ""),
    "INRUSH": ("current", "A", None, ""), "NCV": ("ncv", "", None, ""), "Live": ("ncv", "", None, ""),
}
_UP_OL = {".OL", "O.L", "OL.", "OL", "-.OL", "-O.L", "-OL.", "-OL"}


class UT61Plus(Parser):
    name = "ut61plus"

    def feed(self, data: bytes) -> list[Reading]:
        self.buf += data
        out = []
        while True:
            i = self.buf.find(b"\xab\xcd")
            if i < 0:
                del self.buf[:-1]
                break
            del self.buf[:i]
            if len(self.buf) < 3 or len(self.buf) < 3 + self.buf[2]:
                break
            n = self.buf[2]
            frame = bytes(self.buf[: 3 + n])
            if n >= 3 and sum(frame[:-2]) & 0xFFFF == int.from_bytes(frame[-2:], "big"):
                r = self.parse(frame[3:-2])
                if r is not None:
                    out.append(r)
                del self.buf[: 3 + n]
            else:
                del self.buf[:2]
        return out

    def parse(self, b: bytes) -> Reading | None:
        if len(b) < 14 or b[0] >= len(_UP_MODES):
            return None
        mode = _UP_MODES[b[0]]
        quantity, unit, coupling, prefixes = _UP_INFO.get(mode, ("unknown", "", None, ""))
        if mode == "AC/DC":
            coupling = "DC" if b[13] & 0x08 else "AC"
        rng = b[1] & 0x0F
        prefix = prefixes[rng].strip() if rng < len(prefixes) else prefixes[:1].strip()
        disp = b[2:9].decode("ascii", "replace").replace(" ", "")
        overload = disp in _UP_OL
        try:
            value = None if overload else float(disp) * PREFIX_FACTOR[prefix]
        except ValueError:
            value = None  # NCV bars ("---"), "EF", ...
        flags = [name for bit, name, reg in (
            (8, "MAX", b[11]), (4, "MIN", b[11]), (2, "HOLD", b[11]), (1, "REL", b[11]),
            (2, "BAT", b[12]), (1, "HV", b[12]), (4, "PMAX", b[13]), (2, "PMIN", b[13])) if reg & bit]
        if not b[12] & 0x04:
            flags.insert(0, "AUTO")
        return Reading(value=value, display=disp or "----", prefix=prefix, unit=unit,
                       quantity=quantity, coupling=coupling, overload=overload, flags=flags,
                       bargraph=b[9] * 10 + b[10])


PARSERS = {p.name: p for p in (FS9922, FS9721, ES51922, UT61Plus)}
