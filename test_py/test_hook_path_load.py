# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""The hook loaded the way the installed Crew loads it: by file path, with no parent package."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
PREFIX = "_kirocrew_app_path_load_test.backend"


def test_routes_import_without_a_parent_package():
    name = f"{PREFIX}.routes"
    spec = importlib.util.spec_from_file_location(name, BACKEND / "routes.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
        assert callable(module.register_routes)
        # bff.py and routes.py must share one KiroCredential class and one set of errors.
        assert sys.modules[f"{PREFIX}.bff"].KiroCredential is sys.modules[f"{PREFIX}.kiro_token"].KiroCredential
        assert module.NotSignedIn is sys.modules[f"{PREFIX}.kiro_token"].NotSignedIn
        assert "ListCodeReviews" in module.OPERATIONS and "SubmitCodeReview" not in module.OPERATIONS
    finally:
        for key in [k for k in sys.modules if k.startswith(PREFIX)]:
            del sys.modules[key]
