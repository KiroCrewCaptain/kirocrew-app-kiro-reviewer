# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""The stdlib CBOR codec, checked against the RFC 8949 Appendix A vectors."""

from __future__ import annotations

import math
from datetime import datetime, timezone

import pytest

from backend.cbor import MAX_DEPTH, CborError, dumps, loads

# (hex, value) pairs from RFC 8949 Appendix A that this codec both reads and writes.
ROUND_TRIP = [
    ("00", 0),
    ("17", 23),
    ("1818", 24),
    ("1903e8", 1000),
    ("1a000f4240", 1000000),
    ("1b000000e8d4a51000", 1000000000000),
    ("1bffffffffffffffff", 18446744073709551615),
    ("20", -1),
    ("3863", -100),
    ("3903e7", -1000),
    ("fb3ff199999999999a", 1.1),
    ("fb7e37e43c8800759c", 1.0e300),
    ("f4", False),
    ("f5", True),
    ("f6", None),
    ("40", b""),
    ("4401020304", b"\x01\x02\x03\x04"),
    ("60", ""),
    ("6161", "a"),
    ("6449455446", "IETF"),
    ("62c3bc", "\u00fc"),
    ("64f0908591", "\U00010151"),
    ("80", []),
    ("83010203", [1, 2, 3]),
    ("8301820203820405", [1, [2, 3], [4, 5]]),
    ("a0", {}),
    ("a26161016162820203", {"a": 1, "b": [2, 3]}),
    ("826161a161626163", ["a", {"b": "c"}]),
]

# Vectors this codec reads but writes in another (definite or double) form.
READ_ONLY = [
    ("f90000", 0.0),
    ("f93c00", 1.0),
    ("f93e00", 1.5),
    ("f97bff", 65504.0),
    ("f90001", 5.960464477539063e-08),
    ("f9c400", -4.0),
    ("fa47c35000", 100000.0),
    ("f7", None),
    ("5f42010243030405ff", b"\x01\x02\x03\x04\x05"),
    ("7f657374726561646d696e67ff", "streaming"),
    ("9fff", []),
    ("9f018202039f0405ffff", [1, [2, 3], [4, 5]]),
    ("bf61610161629f0203ffff", {"a": 1, "b": [2, 3]}),
    ("bf6346756ef563416d7421ff", {"Fun": True, "Amt": -2}),
    ("d74401020304", b"\x01\x02\x03\x04"),
]


@pytest.mark.parametrize("hexed, value", ROUND_TRIP)
def test_rfc_vectors_round_trip(hexed, value):
    assert dumps(value).hex() == hexed
    assert loads(bytes.fromhex(hexed)) == value


@pytest.mark.parametrize("hexed, value", READ_ONLY)
def test_rfc_vectors_decode(hexed, value):
    assert loads(bytes.fromhex(hexed)) == value


@pytest.mark.parametrize("hexed, check", [("f97c00", math.isinf), ("f97e00", math.isnan)])
def test_half_precision_specials(hexed, check):
    assert check(loads(bytes.fromhex(hexed)))


def test_epoch_timestamps():
    when = datetime(2013, 3, 21, 20, 4, tzinfo=timezone.utc)
    assert loads(bytes.fromhex("c11a514b67b0")) == when
    assert loads(bytes.fromhex("c1fb41d452d9ec200000")) == datetime(
        2013, 3, 21, 20, 4, 0, 500000, tzinfo=timezone.utc
    )
    assert loads(dumps(when)) == when


@pytest.mark.parametrize(
    "hexed",
    [
        "",  # nothing
        "18",  # head with no argument byte
        "62c3",  # text shorter than declared
        "830102",  # array shorter than declared
        "a16161",  # map pair missing its value
        "0000",  # trailing bytes
        "a2616101616102",  # repeated key
        "a10101",  # integer key
        "1f",  # indefinite integer
        "c1f6",  # epoch tag on a non-number
        "7f61614101ff",  # byte chunk inside a text string
        "5f5f4101ffff",  # nested indefinite chunk
        "62fffe",  # text that is not UTF-8
        "1c",  # reserved additional information
        "f8ff",  # unsupported simple value
        "9b7fffffffffffffff",  # array declaring more items than the buffer holds
        "bb7fffffffffffffff",  # map declaring more pairs than the buffer holds
    ],
)
def test_malformed_input_is_refused(hexed):
    with pytest.raises(CborError):
        loads(bytes.fromhex(hexed))


def test_a_deep_document_is_refused_not_a_recursion_error():
    with pytest.raises(CborError):
        loads(b"\x81" * (MAX_DEPTH + 2) + b"\x00")
    assert loads(b"\x81" * MAX_DEPTH + b"\x00") is not None


@pytest.mark.parametrize("value", [{1: "a"}, object(), datetime(2020, 1, 1), 1 << 64, -(1 << 64) - 1])
def test_values_it_cannot_write_are_refused(value):
    with pytest.raises(CborError):
        dumps(value)


def test_a_review_shaped_payload_round_trips():
    payload = {
        "reviewId": "rev-0123456789abcdef01234567",
        "iteration": 2,
        "files": [{"path": "src/a.ts", "added": 3, "binary": False, "patch": "x" * 70_000}],
        "score": 0.5,
        "blob": bytes(range(256)),
        "note": None,
    }
    assert loads(dumps(payload)) == payload
