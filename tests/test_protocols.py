from unitweb.protocols import ES51922, FS9721, FS9922


def fs9922(sign, digits, dp, sb1, sb2, sb3, sb4, bar=0):
    return sign + digits + b" " + dp + bytes([sb1, sb2, sb3, sb4, bar]) + b"\r\n"


def test_fs9922_dc_volts():
    r = FS9922().parse(fs9922(b"+", b"3299", b"1", 0x31, 0, 0, 0x80, 23))
    assert r.display == "3.299" and r.unit == "V" and r.coupling == "DC"
    assert abs(r.value - 3.299) < 1e-9 and "AUTO" in r.flags and r.bargraph == 23


def test_fs9922_ac_millivolts_negative_and_prefix():
    r = FS9922().parse(fs9922(b"-", b"1234", b"4", 0x08, 0, 0x40, 0x80))
    assert r.display == "-123.4" and r.prefix == "m" and r.coupling == "AC"
    assert abs(r.value + 0.1234) < 1e-12


def test_fs9922_overload_kohm():
    r = FS9922().parse(fs9922(b"+", b"?0:?", b"2", 0x20, 0, 0x20, 0x20))
    assert r.overload and r.value is None and r.display == "O.L" and r.prefix == "k"
    assert r.quantity == "resistance"


def test_fs9922_diode_and_continuity():
    assert FS9922().parse(fs9922(b"+", b"0612", b"1", 0, 0, 0x04, 0x80)).quantity == "diode"
    r = FS9922().parse(fs9922(b"+", b"0012", b"4", 0, 0, 0x08, 0x20))
    assert r.quantity == "continuity" and "BEEP" in r.flags


def test_fs9922_stream_resync():
    pkt = fs9922(b"+", b"0500", b"2", 0x10, 0, 0x40, 0x40)
    p = FS9922()
    out = p.feed(b"\x17garbage" + pkt[:5]) + p.feed(pkt[5:] + pkt + pkt[:3])
    assert len(out) == 2
    assert all(abs(r.value - 0.005) < 1e-12 and r.unit == "A" for r in out)


def test_es51922_volts_with_parity_bit():
    # 2.2000 V range, "01234" -> 0.1234 V, DC AUTO; set bit 7 on some bytes (parity)
    pkt = bytearray(b"0" + b"01234" + bytes([0x3B, 0x30, 0x30, 0x30, 0x3A, 0x30]) + b"\r\n")
    pkt[1] |= 0x80; pkt[6] |= 0x80
    (r,) = ES51922().feed(bytes(pkt))
    assert r.display == "0.1234" and r.unit == "V" and r.coupling == "DC" and "AUTO" in r.flags


def test_fs9721_volts():
    seg = {"0": 0x7D, "1": 0x05, "2": 0x5B, "3": 0x1F, "5": 0x3E}
    nib = [0b0110]  # byte1: DC + AUTO
    for i, ch in enumerate("1253"):
        s = seg[ch]
        hi = (s >> 4) | (0x08 if i == 1 else 0)  # decimal point before 2nd digit
        nib += [hi, s & 0x0F]
    nib += [0, 0, 0, 0b0100, 0]  # byte 13: V
    pkt = bytes(((i + 1) << 4) | n for i, n in enumerate(nib))
    (r,) = FS9721().feed(b"\x00\x99" + pkt)
    assert r.display == "1.253" and r.unit == "V" and r.coupling == "DC"


def test_fs9922_rejects_inconsistent_packets():
    assert FS9922().parse(fs9922(b"+", b"1000", b"1", 0x18, 0, 0, 0x80)) is None  # AC+DC
    assert FS9922().parse(fs9922(b"+", b"1000", b"1", 0x10, 0, 0, 0xC0)) is None  # V+A
    assert FS9922().parse(fs9922(b"+", b"1000", b"1", 0x10, 0, 0x60, 0x80)) is None  # m+k


def _ut61p_frame(payload: bytes) -> bytes:
    body = b"\xab\xcd" + bytes([len(payload) + 2]) + payload
    return body + (sum(body) & 0xFFFF).to_bytes(2, "big")


def test_ut61plus_kohm_and_framing():
    from unitweb.protocols import UT61Plus
    # mode 6 (OHM), range '2' (kΩ), display " 12.345", bar, flags: none -> AUTO
    frame = _ut61p_frame(bytes([6]) + b"2" + b" 12.345" + bytes([1, 2, 0, 0, 0]))
    p = UT61Plus()
    out = p.feed(b"\x00\x11" + frame[:7]) + p.feed(frame[7:] + frame)
    assert len(out) == 2
    r = out[0]
    assert r.quantity == "resistance" and r.prefix == "k" and abs(r.value - 12345) < 1e-6
    assert "AUTO" in r.flags and r.bargraph == 12


def test_ut61plus_bad_checksum_and_overload():
    from unitweb.protocols import UT61Plus
    bad = bytearray(_ut61p_frame(bytes([2]) + b"1" + b"   1.00" + bytes(5)))
    bad[-1] ^= 1
    ol = _ut61p_frame(bytes([2]) + b"1" + b"    OL." + bytes([0, 0, 0, 4, 8]))
    out = UT61Plus().feed(bytes(bad) + ol)
    assert len(out) == 1 and out[0].overload and out[0].coupling == "DC" and "AUTO" not in out[0].flags


def test_invert_reading():
    from unitweb.server import invert_reading
    r = FS9922().parse(fs9922(b"-", b"1234", b"1", 0x10, 0, 0, 0x80)).to_dict()
    invert_reading(r)
    assert r["display"] == "1.234" and r["value"] > 0 and "INV" in r["flags"]
    z = FS9922().parse(fs9922(b"+", b"0000", b"1", 0x10, 0, 0, 0x80)).to_dict()
    invert_reading(z)
    assert z["display"] == "0.000"
    ohm = FS9922().parse(fs9922(b"+", b"1000", b"1", 0, 0, 0x20, 0x20)).to_dict()
    invert_reading(ohm)
    assert ohm["value"] == 1000 and "INV" not in ohm["flags"]
