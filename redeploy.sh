#!/usr/bin/env bash
# Deploy the pre-built Worker module through the Cloudflare Workers API.
#
# Required environment:
#   CF_ACCOUNT_ID=<Cloudflare account id>
#   CF_API_TOKEN=<API token with Workers Scripts:Edit>
# Optional environment:
#   BUNDLE_FILE=worker-v6101-20260812.js
#   WMETA_FILE=$HOME/wmeta.json
#   EXPECTED_BUNDLE_BYTES=322007  # set to 0 to only require a non-empty bundle
#   WORKER_NAME=fttotcv6
#
# This deliberately does not use `curl -f` alone: Cloudflare/proxy failures can
# have an empty or HTML body. Preserve and print the raw body before parsing so
# a failed Termux deploy is diagnosable instead of becoming JSONDecodeError.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"

WORKER_NAME="${WORKER_NAME:-fttotcv6}"
BUNDLE_FILE="${BUNDLE_FILE:-worker-v6101-20260812.js}"
WMETA_FILE="${WMETA_FILE:-$HOME/wmeta.json}"
EXPECTED_BUNDLE_BYTES="${EXPECTED_BUNDLE_BYTES:-322007}"

: "${CF_ACCOUNT_ID:?Set CF_ACCOUNT_ID to the Cloudflare account ID.}"
: "${CF_API_TOKEN:?Set CF_API_TOKEN to a Cloudflare API token; do not put it in this script.}"

if [[ ! -f "$BUNDLE_FILE" ]]; then
  printf 'ERROR: bundle is missing: %s\n' "$BUNDLE_FILE" >&2
  exit 2
fi
if [[ ! -s "$BUNDLE_FILE" ]]; then
  printf 'ERROR: bundle is zero bytes: %s\n' "$BUNDLE_FILE" >&2
  exit 2
fi
if [[ ! -f "$WMETA_FILE" ]]; then
  printf 'ERROR: Worker metadata is missing: %s\n' "$WMETA_FILE" >&2
  exit 2
fi

bundle_bytes="$(wc -c < "$BUNDLE_FILE" | tr -d '[:space:]')"
printf 'Bundle: %s (%s bytes)\n' "$BUNDLE_FILE" "$bundle_bytes"
if [[ "$EXPECTED_BUNDLE_BYTES" != "0" && "$bundle_bytes" != "$EXPECTED_BUNDLE_BYTES" ]]; then
  printf 'ERROR: bundle size mismatch: expected %s bytes, got %s. Refusing to upload an incomplete/wrong file.\n' \
    "$EXPECTED_BUNDLE_BYTES" "$bundle_bytes" >&2
  printf '       For an intentionally rebuilt bundle, set EXPECTED_BUNDLE_BYTES=0 (after reviewing it).\n' >&2
  exit 2
fi

# Cloudflare matches the multipart module part name to metadata.main_module.
# Catch the old sed-rename failure locally, before a confusing API rejection.
python3 - "$WMETA_FILE" "$BUNDLE_FILE" <<'PY'
import json, os, sys
metadata_path, bundle_path = sys.argv[1:]
try:
    with open(metadata_path, encoding='utf-8') as fh:
        metadata = json.load(fh)
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f"ERROR: invalid metadata JSON ({metadata_path}): {exc}")
main = metadata.get("main_module")
expected = os.path.basename(bundle_path)
if not isinstance(main, str) or not main:
    raise SystemExit("ERROR: metadata.main_module is missing or empty")
if main != expected:
    raise SystemExit(
        f"ERROR: metadata.main_module is {main!r}, but bundle is {expected!r}. "
        "Update wmeta.json before deploy."
    )
print(f"Metadata: {metadata_path} (main_module={main})")
PY

response_file="$(mktemp "${TMPDIR:-/tmp}/fttotcv6-deploy.XXXXXX")"
trap 'rm -f "$response_file"' EXIT
url="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}"
module_name="$(basename -- "$BUNDLE_FILE")"

printf 'Uploading %s + triggers to worker %s...\n' "$BUNDLE_FILE" "$WORKER_NAME"
set +e
http_code="$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
  --request PUT "$url" \
  --header "Authorization: Bearer ${CF_API_TOKEN}" \
  --form "metadata=@${WMETA_FILE};type=application/json" \
  --form "${module_name}=@${BUNDLE_FILE};type=application/javascript")"
curl_status=$?
set -e

# Always retain the exact server/proxy payload on failure, including empty
# bodies. This is the evidence needed to distinguish missing-file, 429,
# authentication, and metadata/module-name failures.
if [[ $curl_status -ne 0 || ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
  printf 'ERROR: Cloudflare upload failed (curl=%s HTTP=%s). Raw response follows:\n' \
    "$curl_status" "${http_code:-no-response}" >&2
  if [[ -s "$response_file" ]]; then
    cat "$response_file" >&2
  else
    printf '<empty response body>\n' >&2
  fi
  exit 1
fi

printf 'Cloudflare upload HTTP %s. Raw response:\n' "$http_code"
cat "$response_file"
printf '\n'
# A 2xx response should be JSON, but do not hide it if a proxy returns another
# body. The raw response above remains the source of truth.
python3 - "$response_file" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding="utf-8").read()
try:
    body = json.loads(raw)
except json.JSONDecodeError as exc:
    raise SystemExit(f"ERROR: Cloudflare returned HTTP 2xx but non-JSON response: {exc}")
if not body.get("success", False):
    raise SystemExit("ERROR: Cloudflare returned success=false; see raw response above")
print("Deploy succeeded.")
PY
