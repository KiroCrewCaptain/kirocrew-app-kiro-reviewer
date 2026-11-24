# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""The in-gateway hook's tests. Run with an interpreter that has kiro_crew, aiohttp and
pytest-asyncio (any Kiro Crew dev venv): ``<venv>/bin/python -m pytest test_py``."""

from __future__ import annotations

import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(APP_ROOT))
