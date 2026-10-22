"""Supported meter models and the protocol settings each one needs."""

from .protocols import UT61P_REQUEST

_FS9922 = {"parser": "fs9922", "baud": 2400, "framing": "8N1"}
_FS9721 = {"parser": "fs9721", "baud": 2400, "framing": "8N1"}
_UT61P = {"parser": "ut61plus", "baud": 9600, "framing": "8N1", "request": UT61P_REQUEST}

# model -> parser, line settings and, for polled meters, the request command
MODELS: dict[str, dict] = {
    "UT61C": _FS9922,
    "UT61B": _FS9922,
    "UT61D": _FS9922,
    "UT61E": {"parser": "es51922", "baud": 19200, "framing": "7O1"},
    "UT60A": _FS9721,
    "UT60E": _FS9721,
    "UT61E+": _UT61P,
    "UT61B+": _UT61P,
    "UT61D+": _UT61P,
    "UT161B/D/E": _UT61P,
}

DEFAULT_MODEL = "UT61C"
