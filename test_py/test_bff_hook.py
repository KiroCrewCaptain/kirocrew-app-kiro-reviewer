# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""The token source, the BFF client and the hook routes, against a fake BFF on loopback."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from backend import bff as bff_mod
from backend import cbor, kiro_token
from backend import routes as routes_mod
from backend.bff import BffAuthError, BffClient, BffError, check_endpoint
from backend.kiro_token import KiroCredential, NotSignedIn, SignInUnavailable, VaultTokenSource

TOKEN = "tok-SECRET-1"
FRESH = "tok-SECRET-2"
ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/ABC"


def _kas_token(**over: Any) -> SimpleNamespace:
    fields = {
        "access_token": TOKEN,
        "provider": "Enterprise",
        "auth_method": None,
        "identity": "identity_center",
        "profile_arn": ARN,
    }
    fields.update(over)
    return SimpleNamespace(**fields)


# ---- the token source -------------------------------------------------------------


@pytest.mark.parametrize(
    "provider, idp",
    [
        ("Google", "Google"),
        ("Github", "Github"),
        ("BuilderId", "BuilderId"),
        ("Enterprise", "AWSIdC"),
        ("Internal", "AWSIdC"),
        ("ExternalIdp", "ExternalOIDC"),
    ],
)
def test_each_provider_maps_to_the_bff_idp_header(provider, idp):
    assert kiro_token._credential(_kas_token(provider=provider)).idp == idp


def test_builder_id_gets_the_fixed_profile_arn_crew_sends():
    from kiro_crew.auth.provider import BUILDER_ID_PROFILE_ARN

    cred = kiro_token._credential(_kas_token(provider="BuilderId", identity="builder_id", profile_arn=None))
    assert cred.profile_arn == BUILDER_ID_PROFILE_ARN


@pytest.mark.parametrize(
    "auth_method, token_type",
    [("external_idp", "EXTERNAL_IDP"), ("IdC", "SSO_OIDC"), (None, None), ("social", None)],
)
def test_token_type_follows_kiro_agent(auth_method, token_type):
    assert kiro_token._credential(_kas_token(auth_method=auth_method)).token_type == token_type


def test_an_unknown_provider_is_refused():
    with pytest.raises(SignInUnavailable):
        kiro_token._credential(_kas_token(provider="ApiKey"))


def test_headers_and_repr():
    cred = KiroCredential(TOKEN, "AWSIdC", ARN, "EXTERNAL_IDP")
    assert cred.headers() == {
        "Authorization": f"Bearer {TOKEN}",
        "X-Kiro-Idp": "AWSIdC",
        "X-Kiro-Profile-Arn": ARN,
        "TokenType": "EXTERNAL_IDP",
    }
    assert KiroCredential(TOKEN, "Google").headers() == {
        "Authorization": f"Bearer {TOKEN}",
        "X-Kiro-Idp": "Google",
    }
    assert TOKEN not in repr(cred)


class _Provider:
    def __init__(self, result: Any) -> None:
        self.result = result

    async def current(self) -> Any:
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


class _Store:
    def __init__(self, stored: Any) -> None:
        self.stored = stored

    def resolve(self) -> Any:
        return self.stored


@pytest.mark.asyncio
async def test_the_vault_answer_becomes_a_credential():
    source = VaultTokenSource(lambda: (_Store(None), _Provider(_kas_token())))
    assert await source.credential() == KiroCredential(TOKEN, "AWSIdC", ARN, None)


@pytest.mark.asyncio
async def test_no_stored_sign_in_is_not_signed_in():
    from kiro_crew.auth.provider import NotAuthenticated

    with pytest.raises(NotSignedIn):
        await VaultTokenSource(lambda: (_Store(None), _Provider(NotAuthenticated("x")))).credential()


@pytest.mark.asyncio
async def test_a_failure_never_carries_the_token(caplog):
    caplog.set_level(logging.DEBUG)
    with pytest.raises(SignInUnavailable) as raised:
        await VaultTokenSource(
            lambda: (_Store(None), _Provider(RuntimeError(f"refresh said {TOKEN}")))
        ).credential()
    assert TOKEN not in str(raised.value) and TOKEN not in caplog.text


@pytest.mark.asyncio
async def test_a_rejected_token_is_renewed_through_ensure_fresh(monkeypatch):
    seen: dict[str, Any] = {}

    async def fake_ensure_fresh(store, token, *, session, rejected_access_token):
        seen["rejected"] = rejected_access_token
        return _kas_token(access_token=FRESH)

    monkeypatch.setattr("kiro_crew.auth.refresh.ensure_fresh", fake_ensure_fresh)
    source = VaultTokenSource(lambda: (_Store(_kas_token()), _Provider(_kas_token())))
    cred = await source.credential(rejected=KiroCredential(TOKEN, "AWSIdC"))
    assert cred.access_token == FRESH and seen["rejected"] == TOKEN


@pytest.mark.asyncio
async def test_the_real_vault_on_an_empty_home_is_not_signed_in_and_ignores_kiro_api_key(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("KIROCREW_HOME", str(tmp_path))
    monkeypatch.setenv("KIRO_API_KEY", "ksk_env-SECRET")
    with pytest.raises(NotSignedIn):
        await VaultTokenSource().credential()


# ---- a fake BFF -------------------------------------------------------------------


class FakeBff:
    """Records every request and answers from a queue of (status, body, headers)."""

    def __init__(self) -> None:
        self.seen: list[dict[str, Any]] = []
        self.replies: list[tuple[int, Any, dict[str, str]]] = []

    def reply(
        self,
        status: int,
        body: Any = None,
        *,
        protocol: str | None = "rpc-v2-cbor",
        raw: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        h = dict(headers or {})
        if protocol is not None:
            h["smithy-protocol"] = protocol
        self.replies.append(
            (status, raw if raw is not None else (b"" if body is None else cbor.dumps(body)), h)
        )

    async def handle(self, request: web.Request) -> web.Response:
        data = await request.read()
        self.seen.append(
            {
                "path": request.path,
                "headers": dict(request.headers),
                "body": cbor.loads(data) if data else None,
            }
        )
        status, body, headers = self.replies.pop(0)
        return web.Response(status=status, body=body, headers={"content-type": "application/cbor", **headers})


async def _start(fake: FakeBff) -> TestServer:
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", fake.handle)
    server = TestServer(app, host="127.0.0.1")
    await server.start_server()
    return server


class FakeTokens:
    def __init__(self, *creds: KiroCredential | BaseException) -> None:
        self.queue = list(creds)
        self.rejected: list[KiroCredential | None] = []

    async def credential(self, *, rejected: KiroCredential | None = None) -> KiroCredential:
        self.rejected.append(rejected)
        item = self.queue.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


CRED = KiroCredential(TOKEN, "AWSIdC", ARN, "EXTERNAL_IDP")
CRED2 = KiroCredential(FRESH, "AWSIdC", ARN, "EXTERNAL_IDP")


@pytest_asyncio.fixture
async def fake():
    f = FakeBff()
    server = await _start(f)
    f.base = f"http://127.0.0.1:{server.port}"
    yield f
    await server.close()


# ---- the client -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_call_sends_rpc_v2_cbor_with_the_identity_headers(fake):
    fake.reply(200, {"reviewId": "rev-1", "createdAt": datetime(2026, 11, 17, tzinfo=timezone.utc)})
    out = await BffClient(fake.base, FakeTokens(CRED)).call("GetCodeReview", {"reviewId": "rev-1"})
    assert out == {"reviewId": "rev-1", "createdAt": datetime(2026, 11, 17, tzinfo=timezone.utc)}
    (req,) = fake.seen
    assert req["path"] == "/service/KiroWebBearerService/operation/GetCodeReview"
    assert req["body"] == {"reviewId": "rev-1"}
    h = req["headers"]
    assert h["Content-Type"] == "application/cbor" and h["Accept"] == "application/cbor"
    assert h["smithy-protocol"] == "rpc-v2-cbor"
    assert h["Authorization"] == f"Bearer {TOKEN}"
    assert (h["X-Kiro-Idp"], h["X-Kiro-Profile-Arn"], h["TokenType"]) == ("AWSIdC", ARN, "EXTERNAL_IDP")


@pytest.mark.asyncio
async def test_an_empty_success_body_is_an_empty_map(fake):
    fake.reply(200, None)
    assert await BffClient(fake.base, FakeTokens(CRED)).call("SuppressCodeReviewFinding", {}) == {}


@pytest.mark.asyncio
async def test_a_401_renews_once_then_retries_with_the_new_token(fake):
    fake.reply(401, {"__type": "com.amazon#AccessDeniedException", "message": "expired"})
    fake.reply(200, {"ok": True})
    tokens = FakeTokens(CRED, CRED2)
    assert await BffClient(fake.base, tokens).call("GetCodeReview", {}) == {"ok": True}
    assert tokens.rejected == [None, CRED]
    assert [r["headers"]["Authorization"] for r in fake.seen] == [f"Bearer {TOKEN}", f"Bearer {FRESH}"]


@pytest.mark.asyncio
async def test_a_second_refusal_is_an_auth_error(fake):
    fake.reply(403, {"__type": "AccessDeniedException", "message": "no"})
    fake.reply(403, {"__type": "AccessDeniedException", "message": "still no"})
    with pytest.raises(BffAuthError) as raised:
        await BffClient(fake.base, FakeTokens(CRED, CRED2)).call("GetCodeReview", {})
    assert (raised.value.status, raised.value.error_type, raised.value.message) == (
        403,
        "AccessDeniedException",
        "still no",
    )


@pytest.mark.asyncio
async def test_an_error_names_its_type_without_the_namespace(fake):
    fake.reply(
        400, {"__type": "com.example.kiro#ValidationException", "message": "bad id"}
    )
    with pytest.raises(BffError) as raised:
        await BffClient(fake.base, FakeTokens(CRED)).call("GetCodeReview", {})
    assert (raised.value.status, raised.value.error_type, raised.value.message) == (
        400,
        "ValidationException",
        "bad id",
    )
    assert len(fake.seen) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("protocol", [None, "rpc-v2-json"])
async def test_a_reply_that_is_not_rpc_v2_cbor_is_refused(fake, protocol):
    fake.reply(200, {"ok": True}, protocol=protocol)
    with pytest.raises(BffError, match="not rpc-v2-cbor"):
        await BffClient(fake.base, FakeTokens(CRED)).call("GetCodeReview", {})


@pytest.mark.asyncio
async def test_a_reply_that_is_not_cbor_is_refused(fake):
    fake.reply(200, raw=b"\x83\x01")
    with pytest.raises(BffError, match="not valid CBOR"):
        await BffClient(fake.base, FakeTokens(CRED)).call("GetCodeReview", {})


@pytest.mark.asyncio
async def test_a_redirect_is_not_followed(fake):
    # The target answers a valid reply, so following the redirect would succeed.
    fake.reply(302, None, protocol=None, headers={"Location": f"{fake.base}/stolen"})
    fake.reply(200, {"ok": True})
    with pytest.raises(BffError):
        await BffClient(fake.base, FakeTokens(CRED)).call("GetCodeReview", {})
    assert [r["path"] for r in fake.seen] == ["/service/KiroWebBearerService/operation/GetCodeReview"]


@pytest.mark.asyncio
async def test_an_oversized_reply_is_refused(fake, monkeypatch):
    monkeypatch.setattr(bff_mod, "MAX_RESPONSE_BYTES", 100)
    fake.reply(200, {"x": "y" * 500})
    with pytest.raises(BffError, match="too large"):
        await BffClient(fake.base, FakeTokens(CRED)).call("GetCodeReview", {})


@pytest.mark.asyncio
async def test_an_unreachable_bff_names_no_url_or_token():
    with pytest.raises(BffError) as raised:
        await BffClient("http://127.0.0.1:1", FakeTokens(CRED)).call("GetCodeReview", {})
    assert "127.0.0.1" not in raised.value.message and TOKEN not in raised.value.message


@pytest.mark.parametrize(
    "ok", ["https://app.kiro.dev", "https://app.kiro.dev/", "https://bff.example.com:8443"]
)
def test_check_endpoint_accepts_https_origins(ok):
    assert check_endpoint(ok) == ok.rstrip("/")


@pytest.mark.parametrize(
    "bad",
    [
        "http://app.kiro.dev",
        "https://app.kiro.dev/v1",
        "https://u:p@app.kiro.dev",
        "https://app.kiro.dev?x=1",
        "app.kiro.dev",
    ],
)
def test_check_endpoint_refuses_the_rest(bad):
    with pytest.raises(ValueError):
        check_endpoint(bad)


# ---- the routes -------------------------------------------------------------------


class _Ctx:
    def __init__(self, owner: bool) -> None:
        self.owner = owner
        self.gated: list[str] = []

    async def require_owner(self, request: web.Request, operation: str) -> web.Response | None:
        self.gated.append(operation)
        return None if self.owner else web.json_response({"code": "owner_only"}, status=403)


async def _route_client(
    tokens: Any, base: str, *, app: str = "", owner: bool = True
) -> tuple[TestClient, _Ctx]:
    ctx = _Ctx(owner)
    routes = routes_mod.make_routes(tokens, lambda: base)

    @web.middleware
    async def fake_auth(request, handler):
        if app:
            request["app"] = app
        return await handler(request)

    server_app = web.Application(middlewares=[fake_auth])
    for r in routes:

        async def bound(request, _h=r.handler):
            return await _h(request, ctx)

        server_app.router.add_route(r.method, "/api/apps/kiro-code-reviewer" + r.path, bound)
    client = TestClient(TestServer(server_app, host="127.0.0.1"))
    await client.start_server()
    return client, ctx


@pytest.mark.asyncio
async def test_a_call_from_the_apps_own_token_reaches_the_bff_and_returns_json(fake):
    fake.reply(
        200, {"reviewId": "rev-1", "blob": b"\x00\x01", "at": datetime(2026, 1, 2, tzinfo=timezone.utc)}
    )
    client, ctx = await _route_client(FakeTokens(CRED), fake.base, app="kiro-code-reviewer")
    try:
        resp = await client.post(
            "/api/apps/kiro-code-reviewer/kiro/GetCodeReview", json={"reviewId": "rev-1"}
        )
        assert resp.status == 200
        assert await resp.json() == {"reviewId": "rev-1", "blob": "AAE=", "at": "2026-01-02T00:00:00+00:00"}
    finally:
        await client.close()
    assert fake.seen[0]["body"] == {"reviewId": "rev-1"}
    assert ctx.gated == []  # an app token skips the owner gate, as App Kit documents


@pytest.mark.asyncio
async def test_the_dashboard_owner_passes_the_owner_gate(fake):
    fake.reply(200, {})
    client, ctx = await _route_client(FakeTokens(CRED), fake.base)
    try:
        assert (await client.post("/api/apps/kiro-code-reviewer/kiro/GetCodeReview", json={})).status == 200
    finally:
        await client.close()
    assert ctx.gated == ["kiro_call"]


@pytest.mark.asyncio
@pytest.mark.parametrize("app, owner, status", [("other-app", True, 403), ("", False, 403)])
async def test_other_callers_are_refused_before_any_bff_call(fake, app, owner, status):
    client, _ = await _route_client(FakeTokens(CRED), fake.base, app=app, owner=owner)
    try:
        assert (
            await client.post("/api/apps/kiro-code-reviewer/kiro/GetCodeReview", json={})
        ).status == status
        assert (await client.get("/api/apps/kiro-code-reviewer/kiro/status")).status == status
    finally:
        await client.close()
    assert fake.seen == []


@pytest.mark.asyncio
async def test_an_operation_not_on_the_list_is_404(fake):
    client, _ = await _route_client(FakeTokens(CRED), fake.base, app="kiro-code-reviewer")
    try:
        resp = await client.post("/api/apps/kiro-code-reviewer/kiro/DeleteSpace", json={})
        assert resp.status == 404 and (await resp.json())["error"]["code"] == "UNKNOWN_OPERATION"
    finally:
        await client.close()
    assert fake.seen == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body, status, code", [(b"[1]", 400, "INVALID_JSON"), (b"{nope", 400, "INVALID_JSON")]
)
async def test_a_body_that_is_not_a_json_object_is_400(fake, body, status, code):
    client, _ = await _route_client(FakeTokens(CRED), fake.base, app="kiro-code-reviewer")
    try:
        resp = await client.post("/api/apps/kiro-code-reviewer/kiro/GetCodeReview", data=body)
        assert resp.status == status and (await resp.json())["error"]["code"] == code
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_an_oversized_body_is_413(fake, monkeypatch):
    monkeypatch.setattr(routes_mod, "MAX_REQUEST_BYTES", 50)
    client, _ = await _route_client(FakeTokens(CRED), fake.base, app="kiro-code-reviewer")
    try:
        resp = await client.post("/api/apps/kiro-code-reviewer/kiro/GetCodeReview", json={"x": "y" * 100})
        assert resp.status == 413
    finally:
        await client.close()
    assert fake.seen == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tokens_error, status, code",
    [
        (NotSignedIn("none"), 401, "KIRO_SIGN_IN_REQUIRED"),
        (SignInUnavailable("vault unreadable"), 503, "KIRO_SIGN_IN_UNAVAILABLE"),
    ],
)
async def test_sign_in_problems_name_the_kiro_account_tab(fake, tokens_error, status, code):
    client, _ = await _route_client(FakeTokens(tokens_error), fake.base, app="kiro-code-reviewer")
    try:
        resp = await client.post("/api/apps/kiro-code-reviewer/kiro/GetCodeReview", json={})
        payload = await resp.json()
    finally:
        await client.close()
    assert resp.status == status and payload["error"]["code"] == code
    assert "Settings → Kiro account" in payload["error"]["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply_status, body, status, code",
    [
        (
            404,
            {"__type": "ResourceNotFoundException", "message": "no review"},
            404,
            "ResourceNotFoundException",
        ),
        (500, {"__type": "InternalServerException", "message": "boom"}, 502, "InternalServerException"),
    ],
)
async def test_bff_errors_are_relayed_with_their_type(fake, reply_status, body, status, code):
    fake.reply(reply_status, body)
    client, _ = await _route_client(FakeTokens(CRED), fake.base, app="kiro-code-reviewer")
    try:
        resp = await client.post("/api/apps/kiro-code-reviewer/kiro/GetCodeReview", json={})
        payload = await resp.json()
    finally:
        await client.close()
    assert resp.status == status and payload["error"]["code"] == code


@pytest.mark.asyncio
async def test_a_refused_sign_in_is_401_refused(fake):
    fake.reply(401, {"__type": "AccessDeniedException", "message": "no"})
    fake.reply(401, {"__type": "AccessDeniedException", "message": "no"})
    client, _ = await _route_client(FakeTokens(CRED, CRED2), fake.base, app="kiro-code-reviewer")
    try:
        resp = await client.post("/api/apps/kiro-code-reviewer/kiro/GetCodeReview", json={})
        payload = await resp.json()
    finally:
        await client.close()
    assert resp.status == 401 and payload["error"]["code"] == "KIRO_SIGN_IN_REFUSED"


@pytest.mark.asyncio
async def test_status_reports_the_identity_without_the_token(fake):
    client, _ = await _route_client(FakeTokens(CRED), fake.base, app="kiro-code-reviewer")
    try:
        text = await (await client.get("/api/apps/kiro-code-reviewer/kiro/status")).text()
    finally:
        await client.close()
    assert json.loads(text) == {
        "signedIn": True,
        "idp": "AWSIdC",
        "profileArn": ARN,
        "tokenType": "EXTERNAL_IDP",
    }
    assert TOKEN not in text and fake.seen == []


def test_read_endpoint(tmp_path: Path):
    assert routes_mod.read_endpoint(tmp_path) == "https://app.kiro.dev"
    (tmp_path / "config.json").write_text(json.dumps({"bffEndpoint": "https://staging.kiro.test/"}))
    assert routes_mod.read_endpoint(tmp_path) == "https://staging.kiro.test"
    (tmp_path / "config.json").write_text(json.dumps({"bffEndpoint": "http://evil.example"}))
    with pytest.raises(ValueError):
        routes_mod.read_endpoint(tmp_path)
    (tmp_path / "config.json").write_text("{nope")
    with pytest.raises(ValueError):
        routes_mod.read_endpoint(tmp_path)


def test_read_endpoint_region(tmp_path: Path):
    (tmp_path / "config.json").write_text(json.dumps({"kiroRegion": "eu-central-1"}))
    assert routes_mod.read_endpoint(tmp_path) == "https://eu-central-1.app.kiro.dev"
    (tmp_path / "config.json").write_text(json.dumps({"kiroRegion": "us-east-1"}))
    assert routes_mod.read_endpoint(tmp_path) == "https://app.kiro.dev"
    cfg = {"kiroRegion": "eu-central-1", "bffEndpoint": "https://staging.kiro.test"}
    (tmp_path / "config.json").write_text(json.dumps(cfg))
    assert routes_mod.read_endpoint(tmp_path) == "https://staging.kiro.test"
    (tmp_path / "config.json").write_text(json.dumps({"kiroRegion": "mars-1"}))
    with pytest.raises(ValueError):
        routes_mod.read_endpoint(tmp_path)


@pytest.mark.asyncio
async def test_a_bad_config_is_a_500_before_any_call(fake):
    ctx = _Ctx(True)

    def bad() -> str:
        raise ValueError("the app's config.json is not readable JSON")

    call, _status = routes_mod.make_routes(FakeTokens(CRED), bad)
    app = web.Application()

    async def bound(request):
        request["app"] = "kiro-code-reviewer"
        return await call.handler(request, ctx)

    app.router.add_route("POST", "/api/apps/kiro-code-reviewer/kiro/{operation}", bound)
    client = TestClient(TestServer(app, host="127.0.0.1"))
    await client.start_server()
    try:
        resp = await client.post("/api/apps/kiro-code-reviewer/kiro/GetCodeReview", json={})
        assert resp.status == 500 and (await resp.json())["error"]["code"] == "CONFIG_INVALID"
    finally:
        await client.close()
    assert fake.seen == []
