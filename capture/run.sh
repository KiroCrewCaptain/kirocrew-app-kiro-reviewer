#!/usr/bin/env bash
# Runs capture.py against the local stand-in review service (stub_bff.mjs), so the page shows made-up reviews.
# Usage: capture/run.sh /path/to/KiroCrew [capture.py options]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
kirocrew="$1"; shift
tmp="$(mktemp -d)"
trap 'kill "${stub:-0}" 2>/dev/null || true; rm -rf "$tmp"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -days 2 \
  -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" 2>/dev/null
mkdir -p "$tmp/data"
echo '{"serviceApis":{"feedback":true,"list":true,"payload":true,"unsuppress":false}}' > "$tmp/data/config.json"
(cd "$root" && node capture/stub_bff.mjs 8443 "$tmp/cert.pem" "$tmp/key.pem") &
stub=$!
sleep 1
export KIRO_CODE_REVIEWER_TRANSPORT=bff KIRO_CODE_REVIEWER_BFF_ENDPOINT=https://127.0.0.1:8443 \
  KIRO_API_KEY=ksk_demo_not_a_real_key NODE_EXTRA_CA_CERTS="$tmp/cert.pem" KIRO_CODE_REVIEWER_DATA_DIR="$tmp/data"
python "$root/capture/capture.py" --kirocrew "$kirocrew" "$@"
