# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""In-gateway routes: the review calls made to the BFF with Kiro Crew's own Kiro sign-in.

Served at ``/api/apps/kiro-code-reviewer/kiro/...`` by the gateway's route registry
(``app.json`` ``backend.hooks.routes``). They run here, in the gateway, because only this
process can read the sign-in vault (:mod:`kiro_token`).

* ``POST /kiro/{operation}``: a JSON object in, the BFF's output map out as JSON. Only the
  operations in :data:`OPERATIONS` are forwarded. A byte string in the output is sent as
  base64 text and a timestamp as ISO-8601.
* ``GET /kiro/status``: whether a sign-in is stored and which identity it names, with no
  BFF call.

Callers: this app's own backend (its app token) and the dashboard owner. Every other
caller is refused. The BFF endpoint is ``https://app.kiro.dev`` unless the app's
``data/config.json`` names another as ``bffEndpoint`` or picks a ``kiroRegion``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable

from aiohttp import web

try:
    from .bff import DEFAULT_ENDPOINT, REGION_ENDPOINTS, BffAuthError, BffClient, BffError, check_endpoint
    from .kiro_token import NotSignedIn, SignInUnavailable, VaultTokenSource
except ImportError:  # Crew loads a hook by file path, so the module has no parent package.
    import importlib.util
    import sys

    def _sibling(name: str):
        key = f"{__name__.rpartition('.')[0]}.{name}"
        mod = sys.modules.get(key)
        if mod is None:
            spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(f"{name}.py"))
            mod = importlib.util.module_from_spec(spec)
            sys.modules[key] = mod
            spec.loader.exec_module(mod)
        return mod

    _token = _sibling("kiro_token")  # first, so bff.py shares this KiroCredential class
    _bff = _sibling("bff")
    DEFAULT_ENDPOINT, REGION_ENDPOINTS, BffAuthError, BffClient, BffError, check_endpoint = (
        _bff.DEFAULT_ENDPOINT,
        _bff.REGION_ENDPOINTS,
        _bff.BffAuthError,
        _bff.BffClient,
        _bff.BffError,
        _bff.check_endpoint,
    )
    NotSignedIn, SignInUnavailable, VaultTokenSource = (
        _token.NotSignedIn,
        _token.SignInUnavailable,
        _token.VaultTokenSource,
    )

log = logging.getLogger(__name__)

APP_NAME = "kiro-code-reviewer"

#: The BFF operations this app calls (the names `src/client/bffApi.ts` sends).
OPERATIONS = frozenset(
    {
        "CreateCodeReview",
        "UpdateCodeReview",
        "GetCodeReview",
        "ListCodeReviews",
        "GetCodeReviewIterationPayload",
        "UpdateCodeReviewContext",
        "UpdateCodeReviewFinding",
        "UpdateCodeReviewFeedback",
    }
)
#: A review payload is capped at 200,000 bytes by the service; this leaves room for the envelope.
MAX_REQUEST_BYTES = 1024 * 1024
SIGN_IN_HINT = "Sign in to Kiro in Kiro Crew: Settings → Kiro account."


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    handler: Callable[[web.Request, Any], Awaitable[web.StreamResponse]]


def _error(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": {"code": code, "message": message}}, status=status)


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def read_endpoint(data_dir: Path) -> str:
    """The BFF endpoint: ``bffEndpoint``, else the ``kiroRegion`` BFF, from ``<data_dir>/config.json``."""
    try:
        raw = json.loads((data_dir / "config.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return DEFAULT_ENDPOINT
    except (OSError, ValueError):
        raise ValueError("the app's config.json is not readable JSON") from None
    if not isinstance(raw, dict):
        return DEFAULT_ENDPOINT
    value = raw.get("bffEndpoint")
    if isinstance(value, str) and value:
        return check_endpoint(value)
    region = raw.get("kiroRegion")
    if region is None:
        return DEFAULT_ENDPOINT
    if region not in REGION_ENDPOINTS:
        raise ValueError(f"kiroRegion must be one of {', '.join(REGION_ENDPOINTS)}")
    return REGION_ENDPOINTS[region]


async def _caller_refused(request: web.Request, ctx: Any, operation: str) -> web.Response | None:
    """``None`` for this app's own token or the dashboard owner; the refusal otherwise."""
    app = request.get("app")
    if app:
        return None if app == APP_NAME else _error(403, "FORBIDDEN", "another app may not call these routes")
    gate = getattr(ctx, "require_owner", None)
    if gate is None:
        return _error(403, "owner_only", "owner authorization required")
    return await gate(request, operation)


async def _read_object(request: web.Request) -> dict[str, Any] | web.Response:
    if request.content_length is not None and request.content_length > MAX_REQUEST_BYTES:
        return _error(413, "BODY_TOO_LARGE", "the request body is too large")
    raw = await request.content.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        return _error(413, "BODY_TOO_LARGE", "the request body is too large")
    try:
        body = json.loads(raw) if raw else {}
    except ValueError:
        return _error(400, "INVALID_JSON", "the request body must be a JSON object")
    if not isinstance(body, dict):
        return _error(400, "INVALID_JSON", "the request body must be a JSON object")
    return body


def make_routes(
    tokens: Any,
    endpoint: Callable[[], str],
) -> list[Route]:
    """The routes, with the token source and the endpoint reader given (tests pass fakes)."""

    async def call(request: web.Request, ctx: Any) -> web.StreamResponse:
        operation = request.match_info.get("operation", "")
        refused = await _caller_refused(request, ctx, "kiro_call")
        if refused is not None:
            return refused
        if operation not in OPERATIONS:
            return _error(404, "UNKNOWN_OPERATION", f"no BFF operation named {operation!r}")
        body = await _read_object(request)
        if isinstance(body, web.Response):
            return body
        try:
            base = await asyncio.to_thread(endpoint)
        except ValueError as exc:
            return _error(500, "CONFIG_INVALID", str(exc))
        try:
            output = await BffClient(base, tokens).call(operation, body)
        except NotSignedIn:
            return _error(401, "KIRO_SIGN_IN_REQUIRED", f"Not signed in to Kiro. {SIGN_IN_HINT}")
        except SignInUnavailable as exc:
            return _error(503, "KIRO_SIGN_IN_UNAVAILABLE", f"{exc} {SIGN_IN_HINT}")
        except BffAuthError as exc:
            return _error(401, "KIRO_SIGN_IN_REFUSED", f"The BFF refused the Kiro sign-in: {exc.message}")
        except BffError as exc:
            status = exc.status if exc.status is not None and 400 <= exc.status < 500 else 502
            return _error(status, exc.error_type or "BFF_ERROR", exc.message)
        return web.json_response(_jsonable(output))

    async def status(request: web.Request, ctx: Any) -> web.StreamResponse:
        refused = await _caller_refused(request, ctx, "kiro_status")
        if refused is not None:
            return refused
        try:
            credential = await tokens.credential()
        except NotSignedIn:
            return web.json_response({"signedIn": False, "hint": SIGN_IN_HINT})
        except SignInUnavailable as exc:
            return web.json_response({"signedIn": False, "error": str(exc), "hint": SIGN_IN_HINT})
        return web.json_response(
            {
                "signedIn": True,
                "idp": credential.idp,
                "profileArn": credential.profile_arn,
                "tokenType": credential.token_type,
            }
        )

    return [Route("POST", "/kiro/{operation}", call), Route("GET", "/kiro/status", status)]


def register_routes(ctx: Any) -> list[Any]:
    """``backend.hooks.routes``: the gateway calls this once when the app is wired up.

    The gateway registers only its own ``AppRoute`` instances and skips anything else.
    """
    from kiro_crew.apps.route_registry import AppRoute

    data_dir = Path(ctx.data_dir)
    routes = make_routes(VaultTokenSource(), lambda: read_endpoint(data_dir))
    return [AppRoute(method=r.method, path=r.path, handler=r.handler) for r in routes]
