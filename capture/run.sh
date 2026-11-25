#!/usr/bin/env bash
# Captures the README media with the page backed by demo data (capture/stub_bff.mjs) instead of the real Kiro
# review service. Works on a scratch copy of this repository whose dist/ui-backend.mjs is the demo build, and
# writes the media into this repository's docs/media/.
# Usage (after `npm ci`): capture/run.sh /path/to/KiroCrew [capture.py options]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
kirocrew="$1"
shift
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
copy="$tmp/kirocrew-app-kiro-reviewer"
mkdir -p "$copy"
(cd "$root" && git ls-files -z --cached --others --exclude-standard | xargs -0 -I{} rsync -R "{}" "$copy/") >/dev/null
(cd "$root" && npm run build >/dev/null && cp -R dist "$copy/")
(cd "$root" && npx esbuild capture/demo-backend.mjs --bundle --format=esm --platform=node --target=node22 \
  --keep-names --log-level=warning \
  "--banner:js=import { createRequire } from 'module'; const require = createRequire(import.meta.url);" \
  --outfile="$copy/dist/ui-backend.mjs")
python "$copy/capture/capture.py" --kirocrew "$kirocrew" --out "$root/docs/media" "$@"
# The scratch copy has no git history; name this repository's commit instead.
python - "$root" <<'PY'
import json, subprocess, sys
from pathlib import Path
root = Path(sys.argv[1])
media = root / "docs" / "media" / "media.json"
if media.is_file():
    data = json.loads(media.read_text(encoding="utf-8"))
    data["app_commit"] = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    media.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
