# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""The BFF client: Smithy RPC v2 CBOR over HTTPS with the Kiro sign-in.

Wire shape (Smithy ``AwsSmithyRpcV2CborProtocol``):
``POST <endpoint>/service/KiroWebBearerService/operation/<Op>`` with
``content-type`` and ``accept`` ``application/cbor``, ``smithy-protocol: rpc-v2-cbor``,
a CBOR body, and the identity headers of :mod:`kiro_token`. A reply without
``smithy-protocol: rpc-v2-cbor`` is refused, as the generated client refuses it. An
error reply names its type in the body's ``__type``.

A 401 or 403 renews the sign-in once and retries. Redirects are not followed, so the
bearer token never reaches another host. The reply is capped at
:data:`MAX_RESPONSE_BYTES`.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlsplit

import aiohttp

try:
    from . import cbor
    from .kiro_token import KiroCredential
except ImportError:  # Crew loads a hook by file path, so the module has no parent package.
    import importlib.util
    import sys
    from pathlib import Path

    def _sibling(name: str):
        key = f"{__name__.rpartition('.')[0]}.{name}"
        mod = sys.modules.get(key)
        if mod is None:
            spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(f"{name}.py"))
            mod = importlib.util.module_from_spec(spec)
            sys.modules[key] = mod
            spec.loader.exec_module(mod)
        return mod

    cbor = _sibling("cbor")
    KiroCredential = _sibling("kiro_token").KiroCredential

log = logging.getLogger(__name__)

SERVICE = "KiroWebBearerService"
DEFAULT_ENDPOINT = "https://app.kiro.dev"
#: The BFF for each Kiro region; ``kiroRegion`` in the app's config.json picks one.
REGION_ENDPOINTS = {
    "us-east-1": DEFAULT_ENDPOINT,
    "eu-central-1": "https://eu-central-1.app.kiro.dev",
}
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_TIMEOUT = aiohttp.ClientTimeout(total=120, connect=10)
_PROTOCOL = "rpc-v2-cbor"
_CBOR = "application/cbor"


class TokenSource(Protocol):
    async def credential(self, *, rejected: KiroCredential | None = None) -> KiroCredential: ...


class BffError(Exception):
    """A call that did not succeed. ``status`` is the HTTP status, when there was one."""

    def __init__(self, message: str, *, status: int | None = None, error_type: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.error_type = error_type


class BffAuthError(BffError):
    """The BFF refused the sign-in, after the one renewal."""


@dataclass(frozen=True)
class _Reply:
    status: int
    protocol: str
    body: bytes


def check_endpoint(endpoint: str) -> str:
    """*endpoint* as a base URL with no trailing slash, refused unless a bare https origin."""
    parts = urlsplit(endpoint)
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or parts.path not in ("", "/")
    ):
        raise ValueError("the BFF endpoint must be https://<host>[:port] with nothing after it")
    return endpoint.rstrip("/")


class BffClient:
    """One BFF endpoint. ``endpoint`` is trusted as given; callers pass :func:`check_endpoint`'s."""

    def __init__(self, endpoint: str, tokens: TokenSource) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._tokens = tokens

    async def call(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Invoke *operation* with *payload* and return the decoded output map."""
        url = f"{self._endpoint}/service/{SERVICE}/operation/{operation}"
        body = cbor.dumps(payload)
        credential = await self._tokens.credential()
        reply = await self._post(url, body, credential)
        if reply.status in (401, 403):
            log.info("kiro reviewer: BFF %s answered %s; renewing the sign-in once", operation, reply.status)
            credential = await self._tokens.credential(rejected=credential)
            reply = await self._post(url, body, credential)
        return _output(operation, reply)

    async def _post(self, url: str, body: bytes, credential: KiroCredential) -> _Reply:
        headers = {
            **credential.headers(),
            "content-type": _CBOR,
            "accept": _CBOR,
            "smithy-protocol": _PROTOCOL,
        }
        try:
            async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
                async with session.post(url, data=body, headers=headers, allow_redirects=False) as resp:
                    declared = resp.content_length
                    if declared is not None and declared > MAX_RESPONSE_BYTES:
                        raise BffError("the BFF reply is too large", status=resp.status)
                    raw = bytearray()
                    async for chunk in resp.content.iter_chunked(64 * 1024):
                        raw += chunk
                        if len(raw) > MAX_RESPONSE_BYTES:
                            raise BffError("the BFF reply is too large", status=resp.status)
                    return _Reply(resp.status, resp.headers.get("smithy-protocol", ""), bytes(raw))
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            # The type only: the message can carry the URL or a header.
            raise BffError(f"the BFF could not be reached ({type(exc).__name__})") from None
        except ValueError as exc:
            # aiohttp refuses a header value with a newline; the value is the token or the ARN.
            raise BffError(f"the BFF request could not be built ({type(exc).__name__})") from None


def _output(operation: str, reply: _Reply) -> dict[str, Any]:
    if reply.protocol.lower() != _PROTOCOL:
        raise BffError(f"the BFF reply to {operation} is not rpc-v2-cbor", status=reply.status)
    try:
        decoded = cbor.loads(reply.body) if reply.body else {}
    except cbor.CborError:
        raise BffError(f"the BFF reply to {operation} is not valid CBOR", status=reply.status) from None
    if not isinstance(decoded, dict):
        raise BffError(f"the BFF reply to {operation} is not a map", status=reply.status)
    if 200 <= reply.status < 300:
        return decoded
    error_type = decoded.get("__type")
    error_type = error_type.rsplit("#", 1)[-1] if isinstance(error_type, str) else ""
    message = decoded.get("message", decoded.get("Message"))
    text = message[:500] if isinstance(message, str) and message else f"HTTP {reply.status}"
    cls = BffAuthError if reply.status in (401, 403) else BffError
    raise cls(text, status=reply.status, error_type=error_type)
