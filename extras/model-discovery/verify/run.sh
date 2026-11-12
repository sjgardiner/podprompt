#!/usr/bin/env bash
# Verify model-discovery.ts end to end against stand-in providers.
#
# Needs only `opencode` on PATH. Uses its own config directory, its own ports
# and no network, so it cannot disturb a running PodPrompt or your own
# OpenCode. Run it after upgrading OpenCode: this plugin rides on an API
# OpenCode does not document, and this is what tells you if it still holds.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${TMPDIR:-/tmp}/model-discovery-verify.$$"
BASE_PORT="${MD_VERIFY_BASE_PORT:-8790}"
OC_PORT=$((BASE_PORT + 9))
PW="verify-$$"
XDG="$ROOT/xdg"

cleanup() {
    for p in /proc/[0-9]*; do
        pid="${p#/proc/}"; [ "$pid" = "$$" ] && continue
        cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || continue
        case "$cmd" in
            *"opencode serve"*"$OC_PORT"*|*"fake_providers.py $BASE_PORT"*)
                kill -9 "$pid" 2>/dev/null ;;
        esac
    done
    rm -rf "$ROOT"
}
trap cleanup EXIT

command -v opencode >/dev/null || { echo "FAIL: opencode is not on PATH"; exit 1; }

mkdir -p "$XDG/opencode/plugin"
cp "$HERE/../model-discovery.ts" "$XDG/opencode/plugin/"

python3 "$HERE/fake_providers.py" "$BASE_PORT" &
disown 2>/dev/null || true   # so the cleanup kill is not announced as a job death
sleep 2

# Three providers, one per shape. No "models" blocks anywhere — that is the
# whole point: everything below has to come from discovery.
cat > "$ROOT/config.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "shape-openai":  { "npm": "@ai-sdk/openai-compatible",
                       "options": { "baseURL": "http://127.0.0.1:$((BASE_PORT+1))/v1", "apiKey": "x" } },
    "shape-litellm": { "npm": "@ai-sdk/openai-compatible",
                       "options": { "baseURL": "http://127.0.0.1:$((BASE_PORT+2))/v1", "apiKey": "x" } },
    "shape-alcf":    { "npm": "@ai-sdk/openai-compatible",
                       "options": { "baseURL": "http://127.0.0.1:$((BASE_PORT+3))/v1", "apiKey": "x" } }
  }
}
JSON

cat > "$XDG/opencode/model-discovery.json" <<JSON
{
  "intervalSeconds": 30,
  "providers": {
    "shape-litellm": { "endpoint": "model/info", "shape": "litellm-info" },
    "shape-alcf":    { "endpoint": "http://127.0.0.1:$((BASE_PORT+3))/models", "shape": "alcf" }
  }
}
JSON

OPENCODE_SERVER_PASSWORD="$PW" OPENCODE_CONFIG="$ROOT/config.json" XDG_CONFIG_HOME="$XDG" \
    opencode serve --hostname 127.0.0.1 --port "$OC_PORT" > "$ROOT/serve.log" 2>&1 &
disown 2>/dev/null || true

# Discovery is asynchronous by design, so poll rather than guess a sleep.
for _ in $(seq 1 30); do
    sleep 2
    curl -s -m 5 -u "opencode:$PW" "http://127.0.0.1:$OC_PORT/api/model" -o "$ROOT/models.json" 2>/dev/null || continue
    grep -q "bare-array-model" "$ROOT/models.json" 2>/dev/null && break
done

python3 - "$HERE/expected.json" "$ROOT/models.json" <<'PY'
import json, sys
expected = json.load(open(sys.argv[1]))
try:
    got = json.load(open(sys.argv[2]))["data"]
except Exception as e:
    print(f"FAIL: no usable model list from the server ({e})"); raise SystemExit(1)

found = {}
for m in got:
    found.setdefault(m.get("providerID"), {})[m.get("id")] = (m.get("limit") or {}).get("context")

bad = 0
for provider, models in expected.items():
    for model_id, context in models.items():
        actual = found.get(provider, {}).get(model_id)
        if actual is None:
            print(f"FAIL  {provider}/{model_id}: not discovered"); bad += 1
        elif actual != context:
            print(f"FAIL  {provider}/{model_id}: context {actual}, expected {context}"); bad += 1
        else:
            print(f"ok    {provider}/{model_id}: context {actual}")
print()
print("PASS: every shape was discovered and parsed." if not bad
      else f"FAIL: {bad} check(s) failed — see {sys.argv[2]} and the server log.")
raise SystemExit(1 if bad else 0)
PY
status=$?
[ "$status" -ne 0 ] && { echo; echo "--- plugin output ---"; grep "model-discovery" "$ROOT/serve.log" | tail -10; }
exit "$status"
