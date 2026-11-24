# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Registers the hook through the installed Crew's RouteRegistry in a throwaway home.

Run with the installed Crew's Python, from the package root:
    <KiroCrew.app>/Contents/Resources/backend-dist/kirocrew-backend-arm64/bin/python3 \
        scripts/check_hook_in_installed_crew.py "$PWD"
Exits non-zero unless both hook routes register.
"""

import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

SRC = Path(sys.argv[1])
APP = "kiro-code-reviewer"
home = Path(tempfile.mkdtemp(prefix="kcr-reg-"))
os.environ["KIROCREW_HOME"] = str(home)
app_dir = home / "apps" / APP
app_dir.mkdir(parents=True)
shutil.copy(SRC / "app.json", app_dir / "app.json")
shutil.copytree(SRC / "backend", app_dir / "backend")
(home / "config.json").write_text(json.dumps({"agent": {"apps_allow_third_party": True}}))

from aiohttp import web  # noqa: E402
from kiro_crew.apps.route_registry import RouteRegistry  # noqa: E402


async def main() -> int:
    registry = RouteRegistry(web.Application())
    degraded: list[str] = []
    ctx = SimpleNamespace(name=APP, data_dir=app_dir / "data", health=SimpleNamespace(mark_degraded=degraded.append))
    out = await registry.register_app_routes(APP, app_dir, "backend.routes:register_routes", ctx)
    print("registered", out, "degraded", degraded)
    return 0 if len(out) == 2 and not degraded else 1


try:
    code = asyncio.run(main())
finally:
    shutil.rmtree(home)
sys.exit(code)
