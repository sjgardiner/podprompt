#!/bin/bash
# Source ~/.podprompt.env (or export the required variables in your shell)
# before running. Run with --help for full usage information.

usage() {
    cat <<'USAGE'
Usage: podprompt.sh [OPTIONS] [PASSTHROUGH_ARGS...]

Launches a coding agent (Claude Code or OpenCode) inside a Docker sandbox,
mounting your current directory as the workspace, your real ~/.claude for
persistent Claude Code auth/settings, and PodPrompt's own state/data
directories for the viewer app and its bookkeeping.

PROVIDER OPTIONS (mutually exclusive; --direct is the default):

  (default)       Authenticate via your claude.ai subscription (OAuth). No API
  --direct        key required. On first run you will be walked through a browser-
                  based OAuth flow; credentials are saved into ~/.claude/
                  and reused on subsequent runs. Usage is billed to your Claude
                  subscription (Pro / Team / Enterprise), not to an API account.

  --direct-api    Use the Anthropic API directly with an API key, billed per token
                  to your Anthropic Console account. Requires ANTHROPIC_API_KEY to
                  be set. Claude Code connects to api.anthropic.com and uses its
                  built-in default model.

  --litellm       Route requests through your LiteLLM proxy instance.
                  Requires LITELLM_URL and LITELLM_API_KEY. An interactive
                  model picker runs automatically before launch — you select
                  the primary model and optionally a small/fast model for
                  background tasks. The following env vars are set automatically
                  to make Claude Code work correctly against a non-Anthropic
                  endpoint:
                    ANTHROPIC_BASE_URL              → LITELLM_URL
                    ANTHROPIC_AUTH_TOKEN            → LITELLM_API_KEY
                    ANTHROPIC_MODEL                 → your picked model
                    ANTHROPIC_DEFAULT_HAIKU_MODEL   → your picked small model
                    ANTHROPIC_SMALL_FAST_MODEL      → your picked small model
                    DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 (if no small model picked)
                    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
                    DISABLE_TELEMETRY=1

INTERFACE OPTIONS (mutually exclusive; --viewer is the default):

  (default)       Start PodPrompt's browser-based viewer/driver UI (see
  --viewer        --viewer below) — a bare ./podprompt.sh with no interface
                  flag now gives you this, not a terminal session.

  --claude, --claude-code
                  Skip the viewer and drop straight into Claude Code's own
                  interactive terminal UI (`claude`) inside the container
                  instead — a plain terminal session with no browser
                  involved. Mutually exclusive with --viewer and with
                  --opencode: pick exactly one interface per launch.

  --opencode      Same, but OpenCode's own terminal UI (`opencode`) instead
                  of Claude Code's. OpenCode manages its own provider/model
                  credentials entirely separately from --direct/--direct-api
                  above (see `opencode auth login`, or just use this flag
                  once — its first-run login flow persists to this host's
                  own standard config/data directories, e.g.
                  ~/.config/opencode/, independent of ~/.claude/ — see
                  PERSISTENT STATE below).

                  --litellm IS meaningful with --opencode, though —
                  LiteLLM's default wire protocol is OpenAI-compatible,
                  which is a first-class, arguably simpler fit for OpenCode
                  than for Claude Code (which needs the Anthropic-shaped env
                  vars documented under --litellm above; OpenCode has no use
                  for those). `--opencode --litellm` skips Claude Code's
                  interactive model picker (nothing here would ever read
                  its result) and instead passes LITELLM_URL/LITELLM_API_KEY
                  into the container as plain env vars, for a custom
                  provider block in opencode.jsonc to pick up via OpenCode's
                  own {env:LITELLM_URL}/{env:LITELLM_API_KEY} config
                  substitution:

                    { "$schema": "https://opencode.ai/config.json",
                      "provider": { "litellm": {
                        "npm": "@ai-sdk/openai-compatible",
                        "options": { "baseURL": "{env:LITELLM_URL}/v1",
                                     "apiKey": "{env:LITELLM_API_KEY}" },
                        "models": { "your-model-name": {} } } } }

                  List what LiteLLM actually exposes first with
                  --list-models. If {env:...} substitution for apiKey
                  doesn't seem to take (a known rough edge in some OpenCode
                  versions), store the key via the TUI's /connect flow under
                  the same provider id instead and drop apiKey from the
                  config entirely.

  --viewer        Start PodPrompt, the browser-based viewer/driver UI — the
                  default (this flag only ever needs to be explicit, e.g.
                  from a script). Opens a rendered view of the agent's
                  responses (markdown, math, syntax-highlighted code) at
                  http://localhost:VIEWER_PORT, with a bidirectional driver
                  (built on the Claude Agent SDK) so the browser drives
                  prompts directly — no terminal UI is attached at all.
                  Requires the viewer/ directory (server.py, viewer.html,
                  start-viewer.sh, driver.mjs, backends/, package.json +
                  installed node_modules) to be copied into
                  ~/.local/share/podprompt/viewer/ first (see
                  --deploy-viewer below). Both the claude-code and opencode
                  backends are always available to pick per-session from
                  the browser's "+ New chat" picker — this also starts a
                  headless `opencode serve` instance inside the container
                  for you, so nothing needs to be started by hand first.
                  There is no command-line flag for "the default backend"
                  anymore: the new-chat picker just remembers whichever
                  backend you started your last new chat with, falling back
                  to Claude Code on a fresh install with no history yet.

  --viewer-port PORT
                  Port for the viewer server (browser page + SSE feed).
                  Default: 7843.

  --viewer-driver-port PORT
                  Port for the bidirectional driver (accepts prompts/
                  permission responses from the browser). Default: 7844.

  --opencode-port PORT
                  Loopback-only port `opencode serve` listens on inside the
                  container, and that driver.mjs's opencode backend connects
                  to. Never published to the host (driver.mjs and
                  `opencode serve` talk to each other inside the container's
                  own network namespace) — only worth changing if something
                  else inside the image ever collides with the default.
                  Relevant whenever `opencode serve` might run at all: under
                  --viewer (always) or under a plain --opencode launch.
                  Default: 7845.

UTILITY OPTIONS:

  --list-models   Print all models currently available on the LiteLLM instance
                  and exit. Does not start a Claude Code session.
                  Requires LITELLM_URL and LITELLM_API_KEY.

  --deploy-viewer Copy this repo's viewer/ directory (server.py, viewer.html,
                  start-viewer.sh, driver.mjs, backends/, package.json,
                  package-lock.json) into ~/.local/share/podprompt/viewer/
                  and refresh its node_modules there when the dependency
                  manifests have changed (which npm reconciles incrementally
                  against the lockfile; no reinstall is triggered if they
                  haven't). This is
                  the supported way to deploy the viewer — run it after
                  pulling updated viewer code, then start with --viewer
                  (which restarts the container and serves the fresh files).
                  Only the app payload is copied; node_modules, bytecode
                  caches, and scratch/notes are never carried over.

  --help, -h      Show this message and exit.

PASS-THROUGH ARGUMENTS:

  Any option not listed above is passed directly to whichever binary
  --claude/--opencode selects (`claude` or `opencode`) — only meaningful
  alongside one of those two flags, since --viewer (the default) never
  execs either binary directly; passthrough args given alongside --viewer
  are ignored, with a warning, rather than silently dropped. For
  --claude/--claude-code, this includes Claude Code's own flags, for
  example:

    --dangerously-skip-permissions   Disable Claude Code's permission prompts.
                                     Only use this against repos you trust fully.
    --print "some prompt"            Run non-interactively and print output.
    --agent AGENT_NAME               Launch a specific subagent at startup.

  For --opencode, these are opencode's own flags instead (see
  `opencode --help`), for example:

    --continue                       Continue the last session.
    --model PROVIDER/MODEL           Use a specific model for this run.

  Pass-through args are forwarded after all recognised flags have been consumed,
  so you can freely mix them:

    ./podprompt.sh --claude --litellm --dangerously-skip-permissions
    ./podprompt.sh --opencode --continue

ENVIRONMENT VARIABLES:

  Keep these in ~/.podprompt.env (chmod 600) rather than hardcoding them
  in this script.

    ANTHROPIC_API_KEY      API key for --direct-api mode only. Not needed for
                           OAuth (--direct) or LiteLLM (--litellm) modes.

    LITELLM_URL            Base URL of your LiteLLM proxy instance.
                           e.g. https://llm.example.com

    LITELLM_API_KEY        API key accepted by your LiteLLM instance.

PERSISTENT STATE:

  ~/.claude (your real, standard Claude Code config directory — the same one
  a native, non-Docker `claude` install would use) is bind-mounted into the
  container as /home/agent/.claude. This directory holds your Claude Code
  OAuth credentials, settings.json, session history, and per-project trust
  decisions — shared with any native install on this host, not a
  container-only copy.

  OpenCode gets its own separate, standard set of mounts instead — each of
  the host's own ~/.config/opencode/, ~/.local/share/opencode/,
  ~/.local/state/opencode/, and ~/.cache/opencode/ is bind-mounted straight
  onto the identical default path inside the container (no XDG_*_HOME
  redirection needed — that's already where a plain `opencode` looks; see
  `opencode debug paths`). A login done via `--opencode`'s TUI is
  what --viewer's headless `opencode serve` then uses too, and vice versa,
  since both get the same four mounts.

  PodPrompt's own state — the deployed viewer app (server.py, viewer.html,
  driver.mjs, etc.) and its bookkeeping files (viewer-session-hosts.json,
  viewer-model-picks.json, viewer-last-backend.json) — lives in its own
  XDG-style directories, independent of both of the above, so neither Claude
  Code's nor OpenCode's own config directory gets polluted with
  PodPrompt-internal files:
  ~/.local/share/podprompt/viewer/ (the deployed app, --viewer only) and
  ~/.local/state/podprompt/ (bookkeeping). ~/.config/podprompt/ is reserved
  for future use; nothing reads it yet.

  All of the above directories are created by Docker on first use if they
  don't already exist on the host, and all of it persists across container
  restarts. Back it up if it matters to you.

EXAMPLES:

  # First-time setup: build the image
  docker build -t podprompt .

  # Normal session — browser viewer, both backends available (default)
  ./podprompt.sh

  # Claude Code's own terminal UI instead of the viewer
  ./podprompt.sh --claude

  # OpenCode's own terminal UI instead of the viewer
  ./podprompt.sh --opencode

  # API-key billing instead of subscription (viewer, or --claude)
  ./podprompt.sh --direct-api

  # LiteLLM — interactive model picker runs automatically (Claude Code TUI
  # only; skipped for --opencode, meaningless for --viewer — see --litellm
  # above)
  ./podprompt.sh --claude --litellm

  # List available LiteLLM models without launching
  ./podprompt.sh --list-models

  # Viewer on a different port
  ./podprompt.sh --viewer-port 7900

  # OpenCode's own terminal UI against your LiteLLM instance
  # (LITELLM_URL/LITELLM_API_KEY passed through for opencode.jsonc's own
  # custom-provider config)
  ./podprompt.sh --opencode --litellm

  # Pass a flag through to claude (only meaningful with --claude)
  ./podprompt.sh --claude --dangerously-skip-permissions
USAGE
}

# --- Credentials & config -----------------------------------------------
# All of these can come from ~/.podprompt.env instead of being set here.
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
LITELLM_URL="${LITELLM_URL:-<MY-LITELLM-URL>}"
LITELLM_API_KEY="${LITELLM_API_KEY:-}"

VIEWER_PORT=7843
VIEWER_DRIVER_PORT=7844
# Claude Code's own real, standard config directory — the same one a native,
# non-Docker `claude` install already uses (~/.claude, plus the .claude.json
# CLAUDE_CONFIG_DIR consolidates into it below), not a PodPrompt-branded copy.
CONFIG_DIR="$HOME/.claude"
# OpenCode's own config/data/state/cache — real, standard host locations
# (matching what a native, non-Docker opencode install already uses; see
# `opencode debug paths`), independent of CONFIG_DIR. Kept separate so
# OpenCode's state doesn't get bundled with Claude Code's, and so it can be
# inspected/backed up on its own terms.
OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
OPENCODE_DATA_DIR="$HOME/.local/share/opencode"
OPENCODE_STATE_DIR="$HOME/.local/state/opencode"
OPENCODE_CACHE_DIR="$HOME/.cache/opencode"
# PodPrompt's own state — XDG-style, same shape as OpenCode's block above,
# and independent of both backends' own directories so PodPrompt's internal
# bookkeeping (viewer-session-hosts.json, viewer-model-picks.json) never
# ends up inside the real ~/.claude a native install also uses.
# PODPROMPT_DATA_DIR/viewer holds the deployed viewer app itself (server.py,
# viewer.html, driver.mjs, ...) — see --viewer's usage note above for what
# needs to be copied there before --viewer works.
PODPROMPT_DATA_DIR="$HOME/.local/share/podprompt"
PODPROMPT_STATE_DIR="$HOME/.local/state/podprompt"
# ------------------------------------------------------------------------

# ── Port cleanup ──────────────────────────────────────────────────────────────
free_host_port() {
    local port="$1"
    local pid cmd
    pid=$(lsof -ti tcp:"$port" 2>/dev/null)
    [ -n "$pid" ] || return 0

    # Only ever reap a PID we can positively identify as this project's — a
    # leftover docker-proxy for the podprompt container, or a stale
    # server.py/driver.mjs/start-viewer.sh. A port that's happened to collide
    # with some unrelated service must NOT be killed out from under it: abort
    # with a clear message instead.
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)

    local ours=0
    if [[ "$cmd" == *docker-proxy* ]] \
       && command -v docker >/dev/null 2>&1 \
       && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx podprompt; then
        ours=1   # stale proxy from a previous podprompt container
    elif [[ "$cmd" == *podprompt* || "$cmd" == *server.py* \
            || "$cmd" == *start-viewer.sh* || "$cmd" == *driver.mjs* ]]; then
        ours=1   # our own viewer/driver process
    fi

    if [ "$ours" != 1 ]; then
        echo "[viewer] Port $port is in use by an unrecognized process (PID $pid): $cmd" >&2
        echo "[viewer] Refusing to kill it. Free the port yourself, or use --viewer-port/--viewer-driver-port to avoid the collision." >&2
        return 1
    fi

    echo "[viewer] Reaping stale process on port $port (PID $pid)..."
    kill "$pid" 2>/dev/null
    # Wait up to 2s for it to die
    local i=0
    while kill -0 "$pid" 2>/dev/null && [ $i -lt 10 ]; do
        sleep 0.2
        i=$((i+1))
    done
    kill -9 "$pid" 2>/dev/null || true
    return 0
}

cleanup() {
    if [ "$VIEWER_ENABLED" = 1 ]; then
        [ -n "$VIEWER_OPEN_PID" ] && kill "$VIEWER_OPEN_PID" 2>/dev/null
        free_host_port "$VIEWER_PORT"
    fi
}
trap cleanup EXIT INT TERM

# ── Browser auto-open ─────────────────────────────────────────────────────────
open_browser() {
    local url="$1"
    if command -v open >/dev/null 2>&1; then
        open "$url" >/dev/null 2>&1
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$url" >/dev/null 2>&1
    elif command -v wslview >/dev/null 2>&1; then
        wslview "$url" >/dev/null 2>&1
    else
        echo "[viewer] Couldn't find a command to open a browser automatically. Open $url manually." >&2
        return 1
    fi
}

wait_and_open_viewer() {
    local port="$1"
    local url="http://localhost:$port"
    local i=0
    while [ $i -lt 50 ]; do
        if curl -s --max-time 1 -o /dev/null "$url"; then
            open_browser "$url"
            return
        fi
        sleep 0.2
        i=$((i+1))
    done
    echo "[viewer] Timed out waiting for $url to come up; open it manually." >&2
}

fetch_litellm_models() {
    if [ -z "$LITELLM_API_KEY" ]; then
        echo "Error: LITELLM_API_KEY is not set." >&2
        exit 1
    fi
    local result
    result=$(curl -s "$LITELLM_URL/v1/models" \
        -H "Authorization: Bearer $LITELLM_API_KEY")
    if ! echo "$result" | jq -e '.data' >/dev/null 2>&1; then
        echo "Error: couldn't parse a model list from $LITELLM_URL/v1/models" >&2
        echo "$result" >&2
        exit 1
    fi
    echo "$result"
}

list_models() {
    echo "Models available on $LITELLM_URL:"
    fetch_litellm_models | jq -r '.data[].id' | sort
}

deploy_viewer() {
    # The supported way to get the viewer deployed: copy this repo's viewer/
    # app into PodPrompt's own data directory and (re)install its one
    # dependency, so the mounted ~/.local/share/podprompt/viewer is always a
    # fresh mirror of this checkout rather than whatever a hand-copied
    # deploy last put there. Run it after pulling updated viewer code; then
    # start with --viewer, which restarts the container around the new files.
    # Deliberately copies only the canonical app payload — node_modules,
    # __pycache__, and scratch/notes never migrate, so a re-deploy can't
    # resurrect stale state.
    local src_dir target_dir
    src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/viewer"
    target_dir="${PODPROMPT_DATA_DIR}/viewer"

    if [ ! -d "$src_dir" ]; then
        echo "Error: no viewer/ directory next to this script ($src_dir)." >&2
        echo "Run this from your podprompt checkout (the directory containing podprompt.sh and viewer/)." >&2
        exit 1
    fi

    local required=(server.py viewer.html start-viewer.sh driver.mjs package.json package-lock.json backends)
    local missing=()
    local f
    for f in "${required[@]}"; do
        [ -e "$src_dir/$f" ] || missing+=("$f")
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        echo "Error: this repo's viewer/ is missing required files:" >&2
        printf '  %s\n' "${missing[@]}" >&2
        exit 1
    fi

    mkdir -p "$target_dir"

    # npm install already reconciles node_modules against the shipped
    # package-lock.json: it installs what's missing, upgrades what drifted,
    # and prunes what's extraneous. So we only invoke it when node_modules is
    # absent/incomplete, or when the dependency manifests are changing in
    # THIS deploy — which we must detect against the target's pre-copy state,
    # since we overwrite the manifests with the source's a moment later. A
    # deploy that only touched app code (viewer.html, driver.mjs, ...) never
    # pays for a reinstall, and a stale hand-copy of the lockfile tree is
    # caught by the missing .package-lock.json marker rather than trusted
    # sight-unseen.
    local needs_npm_install=false
    if [ ! -d "$target_dir/node_modules" ] \
       || [ ! -f "$target_dir/node_modules/.package-lock.json" ]; then
        needs_npm_install=true
    elif ! cmp -s "$src_dir/package.json" "$target_dir/package.json" \
      || ! cmp -s "$src_dir/package-lock.json" "$target_dir/package-lock.json"; then
        needs_npm_install=true
    fi

    for f in "${required[@]}"; do
        cp -r "$src_dir/$f" "$target_dir/"
    done
    chmod +x "$target_dir/start-viewer.sh"

    if [ "$needs_npm_install" = true ]; then
        if ! (cd "$target_dir" && npm install); then
            echo "Error: npm install failed in $target_dir." >&2
            exit 1
        fi
    else
        echo "Dependencies already up to date in $target_dir (skipping npm install)."
    fi

    if grep -q '<title>PodPrompt</title>' "$target_dir/viewer.html"; then
        echo "Viewer deployed to $target_dir."
        echo "Start it with --viewer (container restart happens automatically); hard-refresh the browser tab if you were already connected."
    else
        echo "Viewer deployed to $target_dir." >&2
        echo "Warning: deployed viewer.html title is not 'PodPrompt' — source checkout may be out of date." >&2
        exit 1
    fi
}

pick_model() {
    local models_json
    models_json=$(fetch_litellm_models)
    local model_list
    mapfile -t model_list < <(echo "$models_json" | jq -r '.data[].id' | sort)

    if [ ${#model_list[@]} -eq 0 ]; then
        echo "Error: no models returned from LiteLLM." >&2
        exit 1
    fi

    # ── Primary model ──────────────────────────────────────────────────────
    echo ""
    echo "Available models on $LITELLM_URL:"
    echo ""
    local i=1
    for m in "${model_list[@]}"; do
        printf "  %3d) %s\n" "$i" "$m"
        ((i++))
    done
    echo ""

    local choice
    while true; do
        read -rp "Select primary model [1-${#model_list[@]}]: " choice
        if [[ "$choice" =~ ^[0-9]+$ ]] && \
           [ "$choice" -ge 1 ] && \
           [ "$choice" -le "${#model_list[@]}" ]; then
            LITELLM_MODEL="${model_list[$((choice-1))]}"
            echo "Primary model: $LITELLM_MODEL"
            break
        fi
        echo "Invalid selection, please enter a number between 1 and ${#model_list[@]}."
    done

    # ── Small/fast model ───────────────────────────────────────────────────
    echo ""
    echo "Select small/fast model for background tasks (title generation, summaries):"
    echo ""
    echo "    0) Disable background model calls (default)"
    echo "    1) Same as primary ($LITELLM_MODEL)"
    local j=2
    for m in "${model_list[@]}"; do
        printf "  %3d) %s\n" "$j" "$m"
        ((j++))
    done
    echo ""

    local small_choice
    while true; do
        read -rp "Select small model [0-${#model_list[@]}] (Enter = disable): " small_choice
        small_choice="${small_choice:-0}"
        if [ "$small_choice" = "0" ]; then
            LITELLM_SMALL_MODEL=""
            echo "Background model calls: disabled"
            break
        elif [ "$small_choice" = "1" ]; then
            LITELLM_SMALL_MODEL="$LITELLM_MODEL"
            echo "Small model: $LITELLM_SMALL_MODEL (same as primary)"
            break
        elif [[ "$small_choice" =~ ^[0-9]+$ ]] && \
             [ "$small_choice" -ge 2 ] && \
             [ "$small_choice" -le $(( ${#model_list[@]} + 1 )) ]; then
            LITELLM_SMALL_MODEL="${model_list[$((small_choice-2))]}"
            echo "Small model: $LITELLM_SMALL_MODEL"
            break
        fi
        echo "Invalid selection, please enter a number between 0 and $(( ${#model_list[@]} + 1 ))."
    done
    echo ""
}

remove_stale_viewer_hooks() {
    # Earlier versions of this script injected Stop/UserPromptSubmit hooks
    # that POSTed to the viewer server. The viewer has never needed hooks
    # since (first a transcript tailer, now the Agent SDK driver), so this
    # strips any such hooks a previous run may have left behind in
    # settings.json.
    # Safe to call unconditionally and repeatedly — a no-op once cleaned,
    # and it never touches the file if nothing matches.
    local settings_file="$CONFIG_DIR/settings.json"
    [ -f "$settings_file" ] || return 0
    grep -q '/hook/\(stop\|user\)' "$settings_file" || return 0

    local cleaned
    cleaned=$(jq '
        def is_stale_cmd:
            (type == "object")
            and ((.command // "") | test("/hook/(stop|user)"));
        if has("hooks") then
            .hooks |= (
                with_entries(
                    .value = (
                        .value
                        | map(.hooks |= map(select(is_stale_cmd | not)))
                        | map(select((.hooks | length) > 0))
                    )
                )
            )
        else
            .
        end
    ' "$settings_file" 2>/dev/null) || return 0
    [ -n "$cleaned" ] || return 0

    echo "$cleaned" > "${settings_file}.tmp" && mv "${settings_file}.tmp" "$settings_file"
    echo "Removed stale viewer hooks from $settings_file."
}

remove_stale_viewer_hooks   # self-heal settings.json regardless of flags used this run

PROVIDER="direct"
PROVIDER_EXPLICIT=0
TUI_BACKEND=""      # "" (viewer, the default), "claude-code", or "opencode"
VIEWER_ENABLED=1    # the viewer is now the default interface; --claude/--opencode flip this off below
VIEWER_EXPLICIT=0   # did the user actually type --viewer, vs it just being the default
OPENCODE_PORT=7845
PASSTHROUGH_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --help|-h)
            usage
            exit 0
            ;;
        --list-models)
            list_models
            exit 0
            ;;
        --deploy-viewer)
            deploy_viewer
            exit 0
            ;;
        --direct)
            PROVIDER="direct"
            PROVIDER_EXPLICIT=1
            shift
            ;;
        --direct-api)
            PROVIDER="direct-api"
            PROVIDER_EXPLICIT=1
            shift
            ;;
        --litellm)
            PROVIDER="litellm"
            PROVIDER_EXPLICIT=1
            shift
            ;;
        --claude|--claude-code)
            if [ -n "$TUI_BACKEND" ] && [ "$TUI_BACKEND" != "claude-code" ]; then
                echo "Error: --claude/--claude-code and --opencode are mutually exclusive — pick one interface." >&2
                exit 1
            fi
            TUI_BACKEND="claude-code"
            VIEWER_ENABLED=0
            shift
            ;;
        --opencode)
            if [ -n "$TUI_BACKEND" ] && [ "$TUI_BACKEND" != "opencode" ]; then
                echo "Error: --claude/--claude-code and --opencode are mutually exclusive — pick one interface." >&2
                exit 1
            fi
            TUI_BACKEND="opencode"
            VIEWER_ENABLED=0
            shift
            ;;
        --viewer)
            VIEWER_ENABLED=1
            VIEWER_EXPLICIT=1
            shift
            ;;
        --viewer-port)
            VIEWER_PORT="$2"
            shift 2
            ;;
        --viewer-driver-port)
            VIEWER_DRIVER_PORT="$2"
            shift 2
            ;;
        --opencode-port)
            OPENCODE_PORT="$2"
            shift 2
            ;;
        *)
            PASSTHROUGH_ARGS+=("$1")
            shift
            ;;
    esac
done

# --viewer and --claude/--claude-code/--opencode are two different launch
# modes entirely — the browser viewer, with both backends live per session,
# vs. a direct single-backend terminal session — and combining them doesn't
# mean anything sensible (there's only one foreground process in the
# container to hand to either interface). --claude/--opencode already flip
# VIEWER_ENABLED off above; this only needs to catch an *explicit* --viewer
# alongside one of them, which would otherwise look like --viewer was just
# silently ignored rather than actively rejected.
if [ "$VIEWER_EXPLICIT" = 1 ] && [ -n "$TUI_BACKEND" ]; then
    echo "Error: --viewer is mutually exclusive with --claude/--claude-code/--opencode — the viewer already supports both backends live, per session; pick one interface." >&2
    exit 1
fi

# Passthrough args only ever mean anything to the binary --claude/--opencode
# execs directly — --viewer (the default) never execs either binary at all,
# so silently accepting them would look like they did something. Surfaced as
# a warning rather than a hard error, since this used to be the unconditional
# default behavior (bare `./podprompt.sh --dangerously-skip-permissions` used
# to work) and a warning is enough to catch the now-missing --claude/--opencode
# without breaking anything further.
if [ "$VIEWER_ENABLED" = 1 ] && [ "${#PASSTHROUGH_ARGS[@]}" -gt 0 ]; then
    echo "Warning: ignoring passthrough argument(s) (${PASSTHROUGH_ARGS[*]}) — they only apply to --claude/--opencode's direct terminal session; --viewer never execs either binary directly." >&2
fi

# --direct-api only ever configures Claude Code's own credentials
# (ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL below) — meaningless, not just
# unused, for a plain `--opencode` TUI launch, which execs `opencode`
# directly and never reads those env vars at all. Only checked for that
# direct-TUI case: under --viewer, a claude-code-backed session can still
# exist alongside opencode ones and would legitimately use this config,
# since both backends are always registered regardless of which one any
# given session picks.
#
# --litellm is deliberately NOT included here: LiteLLM is a perfectly good
# (arguably easier, since it's plain OpenAI-compatible) backend for OpenCode
# too — see the --litellm doc above and PERSISTENT STATE below for how to
# point OpenCode's own config at it. It just doesn't go through Claude
# Code's ANTHROPIC_* env vars to get there, so the interactive Claude-Code
# model picker is skipped for a plain opencode launch (see below) and
# LITELLM_URL/LITELLM_API_KEY are passed through as plain env vars instead,
# for opencode.jsonc's own {env:...} substitution to use.
if [ "$TUI_BACKEND" = "opencode" ] && [ "$PROVIDER_EXPLICIT" = 1 ] \
   && [ "$PROVIDER" = "direct-api" ]; then
    echo "Error: --direct-api configures Claude Code's own credentials and has no effect on --opencode." >&2
    echo "OpenCode manages its own provider auth — run './podprompt.sh --opencode' and use its" >&2
    echo "TUI's own first-run login (or 'opencode auth login' inside the container); it persists to this host's" >&2
    echo "own ~/.config/opencode/ and ~/.local/share/opencode/, independent of ~/.claude/." >&2
    exit 1
fi

# Resolve provider-specific settings
if [ "$PROVIDER" = "litellm" ]; then
    if [ -z "$LITELLM_API_KEY" ]; then
        echo "Error: LITELLM_API_KEY is not set."
        exit 1
    fi

    echo "Checking LiteLLM server..."
    status=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "$LITELLM_URL/health")
    if [ "$status" = "000" ]; then
        echo "Warning: LiteLLM server at $LITELLM_URL is not reachable."
        echo "Continue anyway? [y/N]"
        read -r answer
        [[ "$answer" =~ ^[Yy]$ ]] || exit 1
    else
        echo "LiteLLM server OK (HTTP $status)."
    fi

    if [ "$TUI_BACKEND" = "opencode" ]; then
        # Plain `--opencode --litellm`: opencode picks its own
        # model via its own config (or its TUI's own /models, /connect),
        # not Claude Code's ANTHROPIC_MODEL env var — so skip Claude Code's
        # interactive model picker here, since a launch that never execs
        # `claude` would never read its result anyway. (`--list-models` is
        # still there if you just want to see what LiteLLM exposes before
        # writing opencode.jsonc's model list.) LITELLM_URL/LITELLM_API_KEY
        # still get passed through as plain env vars below either way.
        EFFECTIVE_BASE_URL=""
        EFFECTIVE_TOKEN=""
        EFFECTIVE_MODEL=""
        EFFECTIVE_SMALL_MODEL=""
    else
        pick_model   # always run the interactive picker when Claude Code will read the result

        EFFECTIVE_BASE_URL="$LITELLM_URL"
        EFFECTIVE_TOKEN="$LITELLM_API_KEY"
        EFFECTIVE_MODEL="$LITELLM_MODEL"
        EFFECTIVE_SMALL_MODEL="$LITELLM_SMALL_MODEL"
    fi

elif [ "$PROVIDER" = "direct-api" ]; then
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        echo "Error: ANTHROPIC_API_KEY is not set (required for --direct-api)."
        exit 1
    fi
    EFFECTIVE_BASE_URL=""
    EFFECTIVE_TOKEN="$ANTHROPIC_API_KEY"
    EFFECTIVE_MODEL=""
    EFFECTIVE_SMALL_MODEL=""
    echo "Using Anthropic API (key-based billing)."

else
    # Default: OAuth via claude.ai subscription.
    # No token injected — Claude Code reads OAuth credentials from the
    # mounted ~/.claude directory. On first run it will prompt for login.
    EFFECTIVE_BASE_URL=""
    EFFECTIVE_TOKEN=""
    EFFECTIVE_MODEL=""
    EFFECTIVE_SMALL_MODEL=""
    echo "Using claude.ai subscription (OAuth)."
fi

docker rm -f podprompt 2>/dev/null

# Saves OAuth credentials, settings, session history, and per-project trust.
# CLAUDE_CONFIG_DIR makes Claude Code write .claude.json into this same
# directory instead of splitting it out to $HOME/.claude.json.
CONNECT_CONFIG="${CONFIG_DIR}:/home/agent/.claude:z"

# ── Viewer setup ──────────────────────────────────────────────────────────────
VIEWER_PORT_FLAGS=()

if [ "$VIEWER_ENABLED" = 1 ]; then
    for f in server.py viewer.html start-viewer.sh driver.mjs package.json; do
        if [ ! -f "$PODPROMPT_DATA_DIR/viewer/$f" ]; then
            echo "Error: $PODPROMPT_DATA_DIR/viewer/$f not found."
            echo "Run './podprompt.sh --deploy-viewer' from this repo to install/update the viewer there."
            exit 1
        fi
    done
    if [ ! -d "$PODPROMPT_DATA_DIR/viewer/node_modules" ]; then
        echo "Error: $PODPROMPT_DATA_DIR/viewer/node_modules not found."
        echo "Run './podprompt.sh --deploy-viewer' from this repo (it reinstalls node_modules for driver.mjs's Agent SDK dependency)."
        exit 1
    fi

    VIEWER_PORT_FLAGS=(-p "127.0.0.1:${VIEWER_PORT}:${VIEWER_PORT}" -p "127.0.0.1:${VIEWER_DRIVER_PORT}:${VIEWER_DRIVER_PORT}")
    free_host_port "$VIEWER_PORT" || exit 1
    free_host_port "$VIEWER_DRIVER_PORT" || exit 1

    # server.py is a plain broadcast relay; driver.mjs (Agent SDK-based) is
    # what actually drives either backend and is what the browser will talk
    # to once it has an input box; start-viewer.sh also launches a headless
    # `opencode serve` alongside them, loopback-only, so the opencode backend
    # is always usable regardless of which backend any given session picks.
    # All three start inside the container.
    echo "Viewer: opening http://localhost:$VIEWER_PORT in your browser once it's up..."
    wait_and_open_viewer "$VIEWER_PORT" &
    VIEWER_OPEN_PID=$!
fi

# ── Interface (plain terminal) ────────────────────────────────────────────────
# The base image's Node entrypoint execs any bare command that's actually on
# PATH as-is (falls back to prefixing `node` only for things it can't find,
# or scripts without +x) — `claude` and `opencode` both work as bare
# commands unmodified. Only --viewer needs --entrypoint, since it launches a
# custom script instead of a single binary.

ENTRYPOINT_FLAG=()   # empty = use image default (Node, which runs claude/opencode fine)

if [ "$VIEWER_ENABLED" = 1 ]; then
    ENTRYPOINT_FLAG=(--entrypoint /home/agent/.local/share/podprompt/viewer/start-viewer.sh)
    RUN_CMD=("${PASSTHROUGH_ARGS[@]}")
elif [ "$TUI_BACKEND" = "opencode" ]; then
    RUN_CMD=(opencode "${PASSTHROUGH_ARGS[@]}")
else
    RUN_CMD=(claude "${PASSTHROUGH_ARGS[@]}")
fi

# OpenCode's own credentials/config/sessions (see `opencode debug paths`)
# persist by bind-mounting this host's own standard XDG directories
# straight onto opencode's identical default paths inside the container —
# no XDG_*_HOME override needed, since that's already where a plain
# `opencode` looks. Populated whenever opencode might actually run in this
# container: --viewer (the default) always starts a headless `opencode
# serve` regardless of which backend any given session picks, and a plain
# --opencode launch runs its TUI directly. A container that's neither
# (--claude) doesn't touch opencode at all, so skip the mounts rather than
# exposing host directories it'll never use.
OPENCODE_MOUNT_FLAGS=()
if [ "$VIEWER_ENABLED" = 1 ] || [ "$TUI_BACKEND" = "opencode" ]; then
    OPENCODE_MOUNT_FLAGS+=(
        -v "${OPENCODE_CONFIG_DIR}:/home/agent/.config/opencode:z"
        -v "${OPENCODE_DATA_DIR}:/home/agent/.local/share/opencode:z"
        -v "${OPENCODE_STATE_DIR}:/home/agent/.local/state/opencode:z"
        -v "${OPENCODE_CACHE_DIR}:/home/agent/.cache/opencode:z"
    )
fi

# PodPrompt's own state (deployed viewer app + its bookkeeping files) — only
# relevant when --viewer is actually running; a plain terminal session (either
# backend) never touches either of these, so skip the mounts otherwise.
PODPROMPT_MOUNT_FLAGS=()
if [ "$VIEWER_ENABLED" = 1 ]; then
    PODPROMPT_MOUNT_FLAGS+=(
        -v "${PODPROMPT_DATA_DIR}/viewer:/home/agent/.local/share/podprompt/viewer:z"
        -v "${PODPROMPT_STATE_DIR}:/home/agent/.local/state/podprompt:z"
    )
fi

# Build the litellm-specific env flags separately for clarity.
# DISABLE_NON_ESSENTIAL_MODEL_CALLS suppresses background model calls
# (title generation, summaries) when no small/fast model is configured.
# CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS prevents beta headers that some
# LiteLLM versions reject with HTTP 400.
# DISABLE_TELEMETRY stops telemetry pings to Anthropic's servers.
# These ANTHROPIC_* vars are Claude-Code-specific and only make sense when
# EFFECTIVE_BASE_URL/EFFECTIVE_TOKEN are actually set — which the block
# above deliberately leaves empty for a plain `--opencode --litellm`
# launch, so none of this is emitted into a container that never execs
# `claude` at all.
LITELLM_ENV_FLAGS=()
if [ "$PROVIDER" = "litellm" ] && [ -n "$EFFECTIVE_TOKEN" ]; then
    LITELLM_ENV_FLAGS+=(
        -e ANTHROPIC_BASE_URL="$EFFECTIVE_BASE_URL"
        -e ANTHROPIC_AUTH_TOKEN="$EFFECTIVE_TOKEN"
        -e DISABLE_NON_ESSENTIAL_MODEL_CALLS=1
        -e CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
        -e DISABLE_TELEMETRY=1
    )
    if [ -n "$EFFECTIVE_MODEL" ]; then
        LITELLM_ENV_FLAGS+=(-e ANTHROPIC_MODEL="$EFFECTIVE_MODEL")
    fi
    if [ -n "$EFFECTIVE_SMALL_MODEL" ]; then
        LITELLM_ENV_FLAGS+=(
            -e ANTHROPIC_DEFAULT_HAIKU_MODEL="$EFFECTIVE_SMALL_MODEL"
            -e ANTHROPIC_SMALL_FAST_MODEL="$EFFECTIVE_SMALL_MODEL"
        )
    fi
fi

# Plain (non-ANTHROPIC_*) LITELLM_URL/LITELLM_API_KEY, passed through
# whenever --litellm is used regardless of backend, so a hand-written
# opencode.jsonc custom provider can reference them via OpenCode's own
# {env:LITELLM_URL}/{env:LITELLM_API_KEY} config substitution instead of
# hardcoding the key into a file. (That substitution has had reliability
# issues for some custom-provider fields in some OpenCode versions — if it
# doesn't seem to take, store the key via the TUI's /connect flow instead
# and drop apiKey from opencode.jsonc entirely; see --opencode doc above.)
OPENCODE_LITELLM_ENV_FLAGS=()
if [ "$PROVIDER" = "litellm" ]; then
    OPENCODE_LITELLM_ENV_FLAGS+=(
        -e LITELLM_URL="$LITELLM_URL"
        -e LITELLM_API_KEY="$LITELLM_API_KEY"
    )
fi

docker run -it --rm \
  --name podprompt \
  --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --security-opt label=disable \
  --init \
  "${ENTRYPOINT_FLAG[@]}" \
  -e HOME=/home/agent \
  -e CLAUDE_CONFIG_DIR=/home/agent/.claude \
  -e VIEWER_PORT="$VIEWER_PORT" \
  -e VIEWER_DRIVER_PORT="$VIEWER_DRIVER_PORT" \
  -e OPENCODE_PORT="$OPENCODE_PORT" \
  -e HOST_WORKSPACE_PATH="$(pwd)" \
  ${EFFECTIVE_TOKEN:+-e ANTHROPIC_AUTH_TOKEN="$EFFECTIVE_TOKEN"} \
  ${EFFECTIVE_MODEL:+-e ANTHROPIC_MODEL="$EFFECTIVE_MODEL"} \
  "${LITELLM_ENV_FLAGS[@]}" \
  "${OPENCODE_LITELLM_ENV_FLAGS[@]}" \
  "${VIEWER_PORT_FLAGS[@]}" \
  -v "$(pwd):/workspace:z" \
  --workdir /workspace \
  -v "${CONNECT_CONFIG}" \
  "${OPENCODE_MOUNT_FLAGS[@]}" \
  "${PODPROMPT_MOUNT_FLAGS[@]}" \
  podprompt \
  "${RUN_CMD[@]}"
