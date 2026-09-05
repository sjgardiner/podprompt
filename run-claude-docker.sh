#!/bin/bash
# Source ~/.claude-docker.env (or export the required variables in your shell)
# before running. Run with --help for full usage information.

usage() {
    cat <<'USAGE'
Usage: run-claude-docker.sh [OPTIONS] [CLAUDE_ARGS...]

Launches Claude Code inside a Docker sandbox, mounting your current directory
as the workspace and your ~/.claude-docker config directory for persistent
auth and settings.

PROVIDER OPTIONS (mutually exclusive; --direct is the default):

  (default)       Authenticate via your claude.ai subscription (OAuth). No API
  --direct        key required. On first run you will be walked through a browser-
                  based OAuth flow; credentials are saved into ~/.claude-docker/
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

UTILITY OPTIONS:

  --list-models   Print all models currently available on the LiteLLM instance
                  and exit. Does not start a Claude Code session.
                  Requires LITELLM_URL and LITELLM_API_KEY.

  --viewer        Start the claude-viewer browser UI instead of launching an
                  interactive terminal session. Opens a rendered view of
                  Claude's responses (markdown, math, syntax-highlighted code)
                  at http://localhost:VIEWER_PORT, with a bidirectional driver
                  (built on the Claude Agent SDK) so the browser drives
                  prompts directly — no terminal UI is attached at all.
                  Requires the viewer/ directory (server.py, viewer.html,
                  start-viewer.sh, driver.mjs, package.json + installed
                  node_modules) to be copied into ~/.claude-docker/viewer/ first.

  --viewer-port PORT
                  Port for the viewer server (browser page + SSE feed).
                  Default: 7843.

  --viewer-driver-port PORT
                  Port for the bidirectional driver (accepts prompts/
                  permission responses from the browser). Default: 7844.

  --help, -h      Show this message and exit.

PASS-THROUGH ARGUMENTS:

  Any option not listed above is passed directly to the `claude` binary inside
  the container. This includes Claude Code's own flags, for example:

    --dangerously-skip-permissions   Disable Claude Code's permission prompts.
                                     Only use this against repos you trust fully.
    --print "some prompt"            Run non-interactively and print output.
    --agent AGENT_NAME               Launch a specific subagent at startup.

  Pass-through args are forwarded after all recognised flags have been consumed,
  so you can freely mix them:

    ./run-claude-docker.sh --litellm --dangerously-skip-permissions

ENVIRONMENT VARIABLES:

  Keep these in ~/.claude-docker.env (chmod 600) rather than hardcoding them
  in this script.

    ANTHROPIC_API_KEY      API key for --direct-api mode only. Not needed for
                           OAuth (--direct) or LiteLLM (--litellm) modes.

    LITELLM_URL            Base URL of your LiteLLM proxy instance.
                           e.g. https://llm.example.com

    LITELLM_API_KEY        API key accepted by your LiteLLM instance.

PERSISTENT STATE:

  ~/.claude-docker/ is bind-mounted into the container as /home/claude/.claude.
  This directory holds your Claude Code OAuth credentials, settings.json,
  session history, and per-project trust decisions. It persists across container
  restarts. Back it up if it matters to you.

EXAMPLES:

  # First-time setup: build the image
  docker build -t claude-sandbox .

  # Normal interactive session (subscription OAuth, default)
  ./run-claude-docker.sh

  # API-key billing instead of subscription
  ./run-claude-docker.sh --direct-api

  # LiteLLM — interactive model picker runs automatically
  ./run-claude-docker.sh --litellm

  # List available LiteLLM models without launching
  ./run-claude-docker.sh --list-models

  # Any mode + rendered browser viewer (markdown, math, syntax highlighting)
  ./run-claude-docker.sh --viewer
  ./run-claude-docker.sh --litellm --viewer
  ./run-claude-docker.sh --viewer --viewer-port 7900

  # Pass a flag through to claude
  ./run-claude-docker.sh --dangerously-skip-permissions
USAGE
}

# --- Credentials & config -----------------------------------------------
# All of these can come from ~/.claude-docker.env instead of being set here.
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
LITELLM_URL="${LITELLM_URL:-<MY-LITELLM-URL>}"
LITELLM_API_KEY="${LITELLM_API_KEY:-}"

VIEWER_PORT=7843
VIEWER_DRIVER_PORT=7844
CONFIG_DIR="$HOME/.claude-docker"
# ------------------------------------------------------------------------

# ── Port cleanup ──────────────────────────────────────────────────────────────
free_host_port() {
    local port="$1"
    local pid
    pid=$(lsof -ti tcp:"$port" 2>/dev/null)
    if [ -n "$pid" ]; then
        echo "[viewer] Freeing host port $port (PID $pid)..."
        kill "$pid" 2>/dev/null
        # Wait up to 2s for it to die
        local i=0
        while kill -0 "$pid" 2>/dev/null && [ $i -lt 10 ]; do
            sleep 0.2
            i=$((i+1))
        done
        kill -9 "$pid" 2>/dev/null || true
    fi
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
VIEWER_ENABLED=0
CLAUDE_ARGS=()
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
        --direct)
            PROVIDER="direct"
            shift
            ;;
        --direct-api)
            PROVIDER="direct-api"
            shift
            ;;
        --litellm)
            PROVIDER="litellm"
            shift
            ;;
        --viewer)
            VIEWER_ENABLED=1
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
        *)
            CLAUDE_ARGS+=("$1")
            shift
            ;;
    esac
done

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

    pick_model   # always run the interactive picker for --litellm

    EFFECTIVE_BASE_URL="$LITELLM_URL"
    EFFECTIVE_TOKEN="$LITELLM_API_KEY"
    EFFECTIVE_MODEL="$LITELLM_MODEL"
    EFFECTIVE_SMALL_MODEL="$LITELLM_SMALL_MODEL"

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
    # mounted ~/.claude-docker/ directory. On first run it will prompt for login.
    EFFECTIVE_BASE_URL=""
    EFFECTIVE_TOKEN=""
    EFFECTIVE_MODEL=""
    EFFECTIVE_SMALL_MODEL=""
    echo "Using claude.ai subscription (OAuth)."
fi

docker rm -f claude-sandbox 2>/dev/null

# Saves OAuth credentials, settings, session history, and per-project trust.
# CLAUDE_CONFIG_DIR makes Claude Code write .claude.json into this same
# directory instead of splitting it out to $HOME/.claude.json.
CONNECT_CONFIG="${CONFIG_DIR}:/home/claude/.claude:z"

# ── Viewer setup ──────────────────────────────────────────────────────────────
VIEWER_PORT_FLAGS=()

if [ "$VIEWER_ENABLED" = 1 ]; then
    for f in server.py viewer.html start-viewer.sh driver.mjs package.json; do
        if [ ! -f "$CONFIG_DIR/viewer/$f" ]; then
            echo "Error: $CONFIG_DIR/viewer/$f not found."
            echo "Copy the whole viewer/ directory into $CONFIG_DIR/viewer/ first, then run 'npm install' there."
            exit 1
        fi
    done
    if [ ! -d "$CONFIG_DIR/viewer/node_modules" ]; then
        echo "Error: $CONFIG_DIR/viewer/node_modules not found."
        echo "Run 'npm install' in $CONFIG_DIR/viewer/ first (needed for driver.mjs's Agent SDK dependency)."
        exit 1
    fi

    VIEWER_PORT_FLAGS=(-p "127.0.0.1:${VIEWER_PORT}:${VIEWER_PORT}" -p "127.0.0.1:${VIEWER_DRIVER_PORT}:${VIEWER_DRIVER_PORT}")
    free_host_port "$VIEWER_PORT"
    free_host_port "$VIEWER_DRIVER_PORT"

    # server.py is a plain broadcast relay; driver.mjs (Agent SDK-based) is
    # what actually drives Claude and is what the browser will talk to once
    # it has an input box. Both start inside the container.
    echo "Viewer: opening http://localhost:$VIEWER_PORT in your browser once it's up..."
    wait_and_open_viewer "$VIEWER_PORT" &
    VIEWER_OPEN_PID=$!
fi

# ── Interface (plain terminal) ────────────────────────────────────────────────
# The base image inherits Node's entrypoint, so only `claude` (a Node script)
# works as a bare command. Any other entrypoint needs --entrypoint to override it.

ENTRYPOINT_FLAG=()   # empty = use image default (Node, which runs claude fine)

if [ "$VIEWER_ENABLED" = 1 ]; then
    ENTRYPOINT_FLAG=(--entrypoint /home/claude/.claude/viewer/start-viewer.sh)
    RUN_CMD=("${CLAUDE_ARGS[@]}")
else
    # Plain claude — Node entrypoint handles this correctly, no override needed
    RUN_CMD=(claude "${CLAUDE_ARGS[@]}")
fi

# Build the litellm-specific env flags separately for clarity.
# DISABLE_NON_ESSENTIAL_MODEL_CALLS suppresses background model calls
# (title generation, summaries) when no small/fast model is configured.
# CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS prevents beta headers that some
# LiteLLM versions reject with HTTP 400.
# DISABLE_TELEMETRY stops telemetry pings to Anthropic's servers.
LITELLM_ENV_FLAGS=()
if [ "$PROVIDER" = "litellm" ]; then
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

docker run -it --rm \
  --name claude-sandbox \
  --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --security-opt label=disable \
  --init \
  "${ENTRYPOINT_FLAG[@]}" \
  -e HOME=/home/claude \
  -e CLAUDE_CONFIG_DIR=/home/claude/.claude \
  -e VIEWER_PORT="$VIEWER_PORT" \
  -e VIEWER_DRIVER_PORT="$VIEWER_DRIVER_PORT" \
  ${EFFECTIVE_TOKEN:+-e ANTHROPIC_AUTH_TOKEN="$EFFECTIVE_TOKEN"} \
  ${EFFECTIVE_MODEL:+-e ANTHROPIC_MODEL="$EFFECTIVE_MODEL"} \
  "${LITELLM_ENV_FLAGS[@]}" \
  "${VIEWER_PORT_FLAGS[@]}" \
  -v "$(pwd):/workspace:z" \
  --workdir /workspace \
  -v "${CONNECT_CONFIG}" \
  claude-sandbox \
  "${RUN_CMD[@]}"
