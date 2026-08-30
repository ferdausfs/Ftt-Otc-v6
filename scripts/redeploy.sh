#!/usr/bin/env bash
# redeploy.sh — Termux → Cloudflare direct-API deploy for the fttotcv6 worker
# (manual path; the GitHub Action in .github/workflows/deploy.yml remains the
# primary path on merge to main).
#
# ── Why this rewrite (2026-08-12) ─────────────────────────────────────────────
# The previous version printed "Uploading <bundle> + triggers..." and then died
# with a python json.JSONDecodeError: it piped curl's stdout straight into
# json.load(). When curl produced NO body (or a non-JSON one), the failure was
# silent — no HTTP status, no Cloudflare error, no curl error. The four ways
# that happens, and what this script does about each:
#
#   1. Bundle missing / zero-size (e.g. failed download).
#      curl -F "x=@missing.js" exits 26 ("couldn't open file") and prints
#      NOTHING to stdout → empty pipe → JSONDecodeError.
#      FIX: preflight -s check + byte count + optional EXPECTED_BYTES compare.
#    → most likely cause of the 2026-08-12 failure (check: ls -la $BUNDLE).
#
#   2. Cloudflare 429 / rate-limit or edge error page (HTML/text, not JSON).
#      FIX: every call captures %{http_code} + raw body to a file; the body is
#      only JSON-parsed AFTER it is shown verbatim. Retry-After is surfaced.
#
#   3. Metadata main_module mismatch: wmeta.json said a different filename
#      than the uploaded bundle (sed rename missed it) → Cloudflare 10006-style
#      error, previously hidden.
#      FIX: wmeta.json is validated (parses + main_module == bundle basename +
#      part name == main_module). --fix-metadata regenerates it from the
#      defaults below.
#
#   4. Unquoted -F part breaking the multipart on filenames with spaces.
#      FIX: every -F argument is fully quoted; the upload part name is pinned
#      to main_module regardless of the local path.
#
# New behaviour on ANY failure: the HTTP status, the RAW response body, and
# curl's own stderr are printed, and the script exits non-zero. It can no
# longer fail silently.
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#   export CLOUDFLARE_ACCOUNT_ID=...        # required
#   export CLOUDFLARE_API_TOKEN=...         # required (Workers Scripts:Edit)
#   bash redeploy.sh [path/to/bundle.js]
#
# Env overrides:
#   SCRIPT_NAME     default fttotcv6
#   META            default $HOME/wmeta.json
#   EXPECTED_BYTES  if set, bundle size must match exactly (v6.10.4 bundle
#                   rebuild after merge; set to its exact byte size)
#   CRONS           comma list, default "*/2 * * * *,*/5 * * * *,0 0 * * 1"
#   HEALTH_URL      default https://fttotcv6.umuhammadiswa.workers.dev/health
#   SKIP_HEALTH=1   skip the post-deploy /health verification
# Flags:
#   --fix-metadata  rewrite $META with the correct main_module + bindings
#   --health-only   skip upload, just run the /health verification block
set -u -o pipefail

SCRIPT_NAME="${SCRIPT_NAME:-fttotcv6}"
META="${META:-$HOME/wmeta.json}"
EXPECTED_BYTES="${EXPECTED_BYTES:-}"
CRONS="${CRONS:-*/2 * * * *,*/5 * * * *,0 0 * * 1}"
EXPECTED_VERSION="${EXPECTED_VERSION:-6.12.0}"
HEALTH_URL="${HEALTH_URL:-https://fttotcv6.umuhammadiswa.workers.dev/health}"
API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"   # overridable for tests
FIX_METADATA=0
HEALTH_ONLY=0
BUNDLE=""

for arg in "$@"; do
  case "$arg" in
    --fix-metadata) FIX_METADATA=1 ;;
    --health-only)  HEALTH_ONLY=1 ;;
    -h|--help)      sed -n '1,55p' "$0"; exit 0 ;;
    *)              BUNDLE="$arg" ;;
  esac
done
BUNDLE="${BUNDLE:-${BUNDLE_FILE:-worker-v6101-20260812.js}}"

say()  { printf '%s\n' "$*"; }
die()  { say "ERROR: $*" >&2; exit 1; }

# ── JSON helpers (python3 on Termux; never assume the input IS json) ────────
json_valid() { python3 -c 'import sys,json; json.load(open(sys.argv[1]))' "$1" 2>/dev/null; }
json_get()   { python3 -c 'import sys,json; d=json.load(open(sys.argv[1]));
import functools
cur=d
for k in sys.argv[2].split("."):
    cur = cur.get(k) if isinstance(cur, dict) else None
print("" if cur is None else cur)' "$1" "$2" 2>/dev/null; }

# cf_call <METHOD> <URL> [--data-json <body> | --upload <bundle> <meta>]
# Prints status + RAW body always. Returns 0 only when HTTP 2xx AND
# body parses as JSON with success:true. Never hides Cloudflare's error.
cf_call() {
  local method="$1" url="$2"; shift 2
  local body curlerr http rc
  body="$(mktemp)"; curlerr="$(mktemp)"
  local args=(-sS -X "$method" "$url"
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
    -o "$body" -w '%{http_code}')
  if [ "${1:-}" = "--data-json" ]; then
    args+=(-H "Content-Type: application/json" --data "$2")
  elif [ "${1:-}" = "--upload" ]; then
    local bundle="$2" meta="$3" part
    part="$(basename "$bundle")"
    args+=(-F "metadata=@${meta};type=application/json"
           -F "${part}=@${bundle};type=application/javascript+module")
  fi
  if ! http="$(curl "${args[@]}" 2>"$curlerr")"; then
    say "✗ curl transport error (request may never have reached Cloudflare):"
    sed 's/^/  /' "$curlerr" >&2
    rm -f "$body" "$curlerr"
    return 2
  fi
  say "  HTTP $http"
  say "  Raw response body:"
  if [ -s "$body" ]; then sed 's/^/  | /' "$body"; [ -n "$(tail -c 1 "$body")" ] && printf '\n'; else say "  | <empty>"; fi
  if [ -s "$curlerr" ]; then say "  curl stderr:"; sed 's/^/  /' "$curlerr" >&2; fi
  if [ "$http" = "429" ]; then
    say "  → rate-limited by Cloudflare. Wait for Retry-After and re-run."
    rc=3
  elif ! json_valid "$body"; then
    say "  → response was NOT valid JSON (edge error page / empty body). See raw body above."
    rc=4
  elif [ "$(json_get "$body" success)" != "True" ]; then
    say "  → Cloudflare API error(s):"
    python3 -c 'import sys,json
d=json.load(open(sys.argv[1]))
for e in d.get("errors") or []:
    print("    code={} message={}".format(e.get("code"), e.get("message")))' "$body" >&2
    rc=5
  elif [ "${http#2}" = "$http" ]; then
    say "  → non-2xx status with success body? Treating as failure."
    rc=6
  else
    rc=0
  fi
  rm -f "$body" "$curlerr"
  return $rc
}

verify_health() {
  say ""
  say "── Post-deploy verify: GET $HEALTH_URL"
  local hbody
  hbody="$(mktemp)"
  if ! curl -sS --max-time 20 "$HEALTH_URL" -o "$hbody"; then
    say "  ✗ /health unreachable (network?). Deploy itself may still be fine."
    rm -f "$hbody"; return 1
  fi
  if ! json_valid "$hbody"; then
    say "  ✗ /health returned non-JSON:"; sed 's/^/  | /' "$hbody" | head -20
    rm -f "$hbody"; return 1
  fi
  python3 - "$hbody" "$EXPECTED_VERSION" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
p = d.get("push") or {}
print("  version        =", d.get("version"))
print("  push.enabled   =", p.get("enabled"))
print("  push.tokenValid=", p.get("tokenValid"), "(" + str(p.get("tokenUsername")) + ")")
print("  push.noTokenReason =", p.get("noTokenReason"))
print("  push.subscribers   =", len(p.get("subscribers") or []), "subscriber(s)")
print("  push.lastAttempt   =", json.dumps(p.get("lastAttempt"))[:300])
print("  push.delivered24h  =", p.get("delivered24h"))
if str(d.get("version")) != sys.argv[2]:
    print("  ✗ version is not " + sys.argv[2] + " — deploy did not take effect (or this is the old script).")
    sys.exit(2)
if p.get("enabled") and p.get("tokenValid") is False:
    print("  ✗ BOT_TOKEN on fttotcv6 is NOT a valid live bot token.")
    print("    Fix: wrangler secret put BOT_TOKEN --name fttotcv6")
    print("    (use the SAME value the ftt-telegram-bot worker uses; then re-check /health)")
    sys.exit(3)
print("  ✓ live worker is " + sys.argv[2] + " with push diagnostics visible (R1)")
PY
  local rc=$?
  rm -f "$hbody"
  return $rc
}

# ── Preflight ──────────────────────────────────────────────────────────────
[ "$HEALTH_ONLY" = "1" ] && { verify_health; exit $?; }

[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is not set"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ]  || die "CLOUDFLARE_API_TOKEN is not set"
command -v curl    >/dev/null || die "curl not installed"
command -v python3 >/dev/null || die "python3 not installed (pkg install python)"

say "── Preflight: bundle '$BUNDLE'"
if [ ! -e "$BUNDLE" ]; then
  die "bundle file does not exist (cause #1 — re-download it first: ls -la $(dirname "$BUNDLE"))"
fi
SIZE="$(wc -c < "$BUNDLE" | tr -d ' ')"
[ "$SIZE" -gt 0 ] || die "bundle is ZERO bytes (cause #1 — failed download; re-fetch before deploying)"
say "  size = $SIZE bytes"
if [ -n "$EXPECTED_BYTES" ] && [ "$SIZE" != "$EXPECTED_BYTES" ]; then
  die "size mismatch: expected $EXPECTED_BYTES bytes, got $SIZE — truncated/wrong bundle, refusing to upload"
fi
head -c 200 "$BUNDLE" | grep -q '[[:alpha:]]' || die "bundle does not look like JS/binary source — refusing to upload"

BASE="$(basename "$BUNDLE")"
say "── Preflight: metadata '$META' (main_module must be '$BASE')"
if [ "$FIX_METADATA" = "1" ] || [ ! -f "$META" ]; then
  [ "$FIX_METADATA" = "1" ] || say "  $META missing — generating it (same content as --fix-metadata)"
  python3 - "$META" "$BASE" <<'PY'
import json, sys
meta = {
  "main_module": sys.argv[2],
  "compatibility_date": "2025-01-01",
  "bindings": [
    {"name": "SIGNAL_CACHE", "type": "kv_namespace", "namespace_id": "f553a3f10915478fa1b8165dd58ff6ea"},
    {"name": "BOT_KV",       "type": "kv_namespace", "namespace_id": "39653d1f9b5147259cf3791658f131d7"},
  ],
}
json.dump(meta, open(sys.argv[1], "w"), indent=2)
print("  wrote", sys.argv[1], "with main_module =", sys.argv[2])
PY
fi
json_valid "$META" || die "$META is not valid JSON (cause #3). Fix it or re-run with --fix-metadata"
MM="$(json_get "$META" main_module)"
if [ "$MM" != "$BASE" ]; then
  die "main_module in $META is '$MM' but bundle is '$BASE' (cause #3 — the sed rename missed main_module).
     Exact fix:  python3 - <<'PY'
       import json; m=json.load(open('$META')); m['main_module']='$BASE'; json.dump(m,open('$META','w'),indent=2)
     PY
     or re-run with --fix-metadata"
fi
say "  main_module = $MM ✓"

# ── 1) Upload the script ───────────────────────────────────────────────────
say ""
say "Uploading $BASE + metadata to workers/scripts/$SCRIPT_NAME ..."
cf_call PUT "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$SCRIPT_NAME" --upload "$BUNDLE" "$META" \
  || die "script upload failed — real Cloudflare/curl error is printed above (this is what the old script hid)"

# ── 2) Cron triggers (separate endpoint — NOT part of the upload payload) ──
say ""
say "Setting cron triggers on $SCRIPT_NAME ..."
SCHED="$(python3 -c 'import sys,json; print(json.dumps([{"cron":c.strip()} for c in sys.argv[1].split(",") if c.strip()]))' "$CRONS")"
say "  schedules = $SCHED"
cf_call PUT "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$SCRIPT_NAME/schedules" --data-json "$SCHED" \
  || die "schedule update failed — see raw response above"

say ""
say "✓ Deploy API calls succeeded."
[ "${SKIP_HEALTH:-0}" = "1" ] && exit 0
sleep 3   # give the edge a moment to pick up the new version
verify_health
