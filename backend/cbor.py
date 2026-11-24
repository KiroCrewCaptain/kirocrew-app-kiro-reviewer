# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""The subset of CBOR (RFC 8949) that Smithy RPC v2 CBOR carries, with the stdlib only.

Hook code runs in the gateway's interpreter, which has no CBOR library and, on the
desktop build, cannot be installed into. This codec covers the types a Smithy shape
maps to: maps with text keys, arrays, text and byte strings, integers, floats,
booleans and null. ``undefined`` decodes as ``None``; a tag 1 epoch timestamp decodes
as a timezone-aware ``datetime``. Other tags decode as their content.

The encoder writes definite-length items only. The decoder also reads
indefinite-length strings, arrays and maps, which RPC v2 CBOR lets a server send.
Input is bounded: a document may be at most :data:`MAX_DEPTH` levels deep and every
declared length must fit in what is left of the buffer.
"""

from __future__ import annotations

import math
import struct
from datetime import datetime, timezone
from typing import Any

MAX_DEPTH = 64

_UINT, _NEGINT, _BYTES, _TEXT, _ARRAY, _MAP, _TAG, _SIMPLE = range(8)
_BREAK = 0xFF
_EPOCH_TAG = 1


class CborError(ValueError):
    """The bytes are not CBOR this codec reads, or the value is not one it writes."""


# ---- encoding ---------------------------------------------------------------------


def _head(major: int, value: int) -> bytes:
    if value < 24:
        return bytes([major << 5 | value])
    if value < 1 << 8:
        return bytes([major << 5 | 24, value])
    if value < 1 << 16:
        return bytes([major << 5 | 25]) + value.to_bytes(2, "big")
    if value < 1 << 32:
        return bytes([major << 5 | 26]) + value.to_bytes(4, "big")
    if value < 1 << 64:
        return bytes([major << 5 | 27]) + value.to_bytes(8, "big")
    raise CborError("integer out of CBOR range")


def _encode(value: Any, out: bytearray, depth: int) -> None:
    if depth > MAX_DEPTH:
        raise CborError("value nests too deeply")
    if value is None:
        out.append(0xF6)
    elif value is True:
        out.append(0xF5)
    elif value is False:
        out.append(0xF4)
    elif isinstance(value, int):
        out += _head(_UINT, value) if value >= 0 else _head(_NEGINT, -1 - value)
    elif isinstance(value, float):
        out += b"\xfb" + struct.pack(">d", value)
    elif isinstance(value, str):
        raw = value.encode("utf-8")
        out += _head(_TEXT, len(raw)) + raw
    elif isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        out += _head(_BYTES, len(raw)) + raw
    elif isinstance(value, datetime):
        if value.tzinfo is None:
            raise CborError("a timestamp must be timezone-aware")
        out += _head(_TAG, _EPOCH_TAG)
        _encode(value.timestamp(), out, depth + 1)
    elif isinstance(value, (list, tuple)):
        out += _head(_ARRAY, len(value))
        for item in value:
            _encode(item, out, depth + 1)
    elif isinstance(value, dict):
        out += _head(_MAP, len(value))
        for key, item in value.items():
            if not isinstance(key, str):
                raise CborError("map keys must be text")
            _encode(key, out, depth + 1)
            _encode(item, out, depth + 1)
    else:
        raise CborError(f"cannot encode {type(value).__name__}")


def dumps(value: Any) -> bytes:
    """Encode *value* as one CBOR data item."""
    out = bytearray()
    _encode(value, out, 0)
    return bytes(out)


# ---- decoding ---------------------------------------------------------------------


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def take(self, n: int) -> bytes:
        if n < 0 or n > len(self.data) - self.pos:
            raise CborError("truncated CBOR")
        chunk = self.data[self.pos : self.pos + n]
        self.pos += n
        return chunk

    def byte(self) -> int:
        return self.take(1)[0]

    def peek_break(self) -> bool:
        if self.pos >= len(self.data):
            raise CborError("truncated CBOR")
        if self.data[self.pos] == _BREAK:
            self.pos += 1
            return True
        return False


def _argument(r: _Reader, info: int) -> int | None:
    """The head's argument, or ``None`` for an indefinite length (info 31)."""
    if info < 24:
        return info
    if info in (24, 25, 26, 27):
        return int.from_bytes(r.take(1 << (info - 24)), "big")
    if info == 31:
        return None
    raise CborError(f"reserved additional information {info}")


def _half(raw: bytes) -> float:
    bits = int.from_bytes(raw, "big")
    sign = -1.0 if bits & 0x8000 else 1.0
    exponent, fraction = (bits >> 10) & 0x1F, bits & 0x3FF
    if exponent == 0:
        return sign * math.ldexp(fraction, -24)
    if exponent == 31:
        return sign * math.inf if fraction == 0 else math.nan
    return sign * math.ldexp(fraction + 1024, exponent - 25)


def _string(r: _Reader, major: int, length: int | None, depth: int) -> bytes:
    if length is not None:
        return r.take(length)
    parts: list[bytes] = []
    while not r.peek_break():
        head = r.byte()
        if head >> 5 != major:
            raise CborError("an indefinite string chunk has the wrong type")
        size = _argument(r, head & 0x1F)
        if size is None:
            raise CborError("an indefinite string chunk is itself indefinite")
        parts.append(r.take(size))
    return b"".join(parts)


def _decode(r: _Reader, depth: int) -> Any:
    if depth > MAX_DEPTH:
        raise CborError("document nests too deeply")
    head = r.byte()
    major, info = head >> 5, head & 0x1F
    if major == _SIMPLE:
        if info == 20:
            return False
        if info == 21:
            return True
        if info in (22, 23):
            return None
        if info == 25:
            return _half(r.take(2))
        if info == 26:
            return struct.unpack(">f", r.take(4))[0]
        if info == 27:
            return struct.unpack(">d", r.take(8))[0]
        raise CborError(f"unsupported simple value {info}")
    arg = _argument(r, info)
    if major == _UINT:
        if arg is None:
            raise CborError("an integer cannot be indefinite")
        return arg
    if major == _NEGINT:
        if arg is None:
            raise CborError("an integer cannot be indefinite")
        return -1 - arg
    if major == _BYTES:
        return _string(r, _BYTES, arg, depth)
    if major == _TEXT:
        try:
            return _string(r, _TEXT, arg, depth).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise CborError("text is not UTF-8") from exc
    if major == _ARRAY:
        items: list[Any] = []
        if arg is None:
            while not r.peek_break():
                items.append(_decode(r, depth + 1))
        else:
            if arg > len(r.data) - r.pos:  # every item is at least one byte
                raise CborError("truncated CBOR")
            items = [_decode(r, depth + 1) for _ in range(arg)]
        return items
    if major == _MAP:
        result: dict[str, Any] = {}
        if arg is not None and arg > (len(r.data) - r.pos) // 2:  # every pair is at least two bytes
            raise CborError("truncated CBOR")
        read = 0
        while (not r.peek_break()) if arg is None else read < arg:
            key = _decode(r, depth + 1)
            if not isinstance(key, str):
                raise CborError("map keys must be text")
            if key in result:
                raise CborError("map repeats a key")
            result[key] = _decode(r, depth + 1)
            read += 1
        return result
    # major == _TAG
    if arg is None:
        raise CborError("a tag cannot be indefinite")
    content = _decode(r, depth + 1)
    if arg == _EPOCH_TAG:
        if isinstance(content, bool) or not isinstance(content, (int, float)):
            raise CborError("an epoch timestamp must be a number")
        try:
            return datetime.fromtimestamp(content, tz=timezone.utc)
        except (OverflowError, OSError, ValueError) as exc:
            raise CborError("epoch timestamp out of range") from exc
    return content


def loads(data: bytes) -> Any:
    """Decode exactly one CBOR data item from *data*."""
    r = _Reader(bytes(data))
    value = _decode(r, 0)
    if r.pos != len(r.data):
        raise CborError("trailing bytes after the CBOR item")
    return value
