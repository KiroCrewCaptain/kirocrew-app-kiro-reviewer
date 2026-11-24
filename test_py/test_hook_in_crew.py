# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""The hook as Kiro Crew loads it: the real module loader, trust gate and route registry.

Copies the app's ``app.json`` and ``backend/`` into an isolated data home, trusts the app
there (``agent.apps_allow_third_party``), loads ``backend.hooks.routes``
through ``RouteRegistry.register_app_routes`` and dispatches through the registry's
catch-all, so a drift in the manifest path or the route contract fails here.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

APP = "kiro-code-reviewer"
ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.asyncio
async def test_crew_loads_the_hook_and_serves_its_routes(tmp_path, monkeypatch):
    home = tmp_path / "home"
    app_dir = home / "apps" / APP
    app_dir.mkdir(parents=True)
    shutil.copy(ROOT / "app.json", app_dir / "app.json")
    shutil.copytree(ROOT / "backend", app_dir / "backend")
    # The blanket switch, in this throwaway home only: a name grant (agent.apps_trusted)
    # also needs an install record proving local provenance, which this copy has none of.
    (home / "config.json").write_text(json.dumps({"agent": {"apps_allow_third_party": True}}))
    monkeypatch.setenv("KIROCREW_HOME", str(home))

    from kiro_crew.apps.manifest import AppManifest
    from kiro_crew.apps.module_loader import unload_app_modules
    from kiro_crew.apps.route_registry import RouteRegistry

    manifest = AppManifest.from_json_file(app_dir / "app.json")
    assert manifest.validate() == []
    hook = manifest.backend.hooks.routes
    assert hook == "backend.routes:register_routes"

    app = web.Application()
    registry = RouteRegistry(app)
    registry.ensure_catch_all()
    degraded: list[str] = []
    ctx = SimpleNamespace(
        name=APP,
        data_dir=app_dir / "data",
        health=SimpleNamespace(mark_degraded=degraded.append),
    )

    async def require_owner(request, operation):
        return None

    ctx.require_owner = require_owner
    try:
        registered = await registry.register_app_routes(APP, app_dir, hook, ctx)
        assert degraded == []
        assert sorted(registered) == [
            f"GET /api/apps/{APP}/kiro/status",
            f"POST /api/apps/{APP}/kiro/{{operation}}",
        ]
        assert registry.serves(APP, "GET", "/kiro/status")

        # The real vault on an empty home: the route answers, and says to sign in.
        client = TestClient(TestServer(app, host="127.0.0.1"))
        await client.start_server()
        try:
            status = await client.get(f"/api/apps/{APP}/kiro/status")
            body = await status.json()
            assert status.status == 200 and body["signedIn"] is False
            assert "Settings → Kiro account" in body["hint"]
            call = await client.post(f"/api/apps/{APP}/kiro/GetCodeReview", json={})
            assert call.status == 401
            assert (await call.json())["error"]["code"] == "KIRO_SIGN_IN_REQUIRED"
            unknown = await client.post(f"/api/apps/{APP}/kiro/DeleteSpace", json={})
            assert unknown.status == 404
        finally:
            await client.close()
    finally:
        registry.deregister_app_routes(APP)
        unload_app_modules(APP)


@pytest.mark.asyncio
async def test_an_untrusted_install_does_not_load_the_hook(tmp_path, monkeypatch):
    home = tmp_path / "home"
    app_dir = home / "apps" / APP
    app_dir.mkdir(parents=True)
    shutil.copy(ROOT / "app.json", app_dir / "app.json")
    shutil.copytree(ROOT / "backend", app_dir / "backend")
    (home / "config.json").write_text(json.dumps({"agent": {"apps_trusted": []}}))
    monkeypatch.setenv("KIROCREW_HOME", str(home))

    from kiro_crew.apps.module_loader import unload_app_modules
    from kiro_crew.apps.route_registry import RouteRegistry

    registry = RouteRegistry(web.Application())
    degraded: list[str] = []
    ctx = SimpleNamespace(
        name=APP, data_dir=app_dir / "data", health=SimpleNamespace(mark_degraded=degraded.append)
    )
    try:
        registered = await registry.register_app_routes(APP, app_dir, "backend.routes:register_routes", ctx)
    finally:
        unload_app_modules(APP)
    assert registered == [] and degraded and not registry.serves(APP, "GET", "/kiro/status")
