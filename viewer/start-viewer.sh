#!/bin/sh
# Entrypoint for --viewer.
#
# Launches, in the background, everything --viewer needs: server.py (the
# browser-facing broadcast relay) and driver.mjs (the multi-session,
# multi-backend bidirectional driver the browser talks to directly). No TUI is
# attached — the browser's input box, session picker, and multi-tab /
# multi-session support are the only interface now.
#
# The headless `opencode serve` instance driver.mjs's opencode backend talks
# to is NOT started here anymore — driver.mjs owns and supervises that child
# process itself (spawn + crash/wedge detection + backoff restart; see the
# opencode process-ownership block in driver.mjs). It is started
# unconditionally at driver startup — the driver registers BOTH backends and
# any session can request either one explicitly (the browser's "+ New chat"
# picker does this), so the opencode backend needs to be reachable
# regardless of which backend is currently preselected there. This used to
# be the missing piece: nothing ever started `opencode serve` inside the
# container, so picking opencode from the new-chat picker assumed a process
# that never existed. Loopback-only (127.0.0.1) and not published to the host —
# driver.mjs is the only thing that talks to it, and they share this
# container's network namespace.
#
# No XDG_*_HOME overrides needed here: podprompt.sh bind-mounts this host's
# own ~/.config/opencode, ~/.local/share/opencode, ~/.local/state/opencode,
# and ~/.cache/opencode directly onto opencode's own real default paths
# inside the container (see `opencode debug paths`), so credentials/config/
# sessions created via `opencode auth login` (either through that serve
# instance, or through `./podprompt.sh --opencode`'s own TUI, which
# gets the identical mounts) persist across container restarts in their own
# standard host locations — independent of Claude Code's own ~/.claude and
# of PodPrompt's own ~/.local/{share,state}/podprompt, not nested inside
# either.
#
# A cold `opencode serve` takes ~4-8s to start serving a full response (its
# HTTP server binds sooner; the model-picker-relevant /config/providers
# endpoint is gated on the litellm plugin's live provider discovery and lags
# further behind). Not specifically waited on here: the driver spawns it and
# every fetch the browser can trigger retries through that window, and the
# very first thing that might race it is the /sessions poll loop, which
# already treats a backend failing to respond as an expected, self-healing,
# log-once condition (see driver.mjs's backendSessionsFailing) rather than a
# fatal error.
#
# Paths below are deliberately $HOME-relative, not hardcoded to a specific
# username's home directory — this exact script used to hardcode
# /home/claude/... literally, which silently broke when the container's OS
# user was later renamed. $HOME is set explicitly by podprompt.sh regardless
# of which user the image defines, so this stays correct across that kind of
# rename with no edit needed here.

# ── persistent logs ────────────────────────────────────────────────────────
# Until 2026-11-10 both services wrote only to the container's terminal and
# nowhere else, so when something went wrong during an unattended overnight run
# the only record was host scrollback: easy to lose, impossible to grep, and
# gone entirely once the container restarts. Diagnosing the turn-reservation
# race that day had to be done from Claude Code's own transcripts instead,
# which happen to timestamp tool errors — luck, not design.
#
# Both streams are timestamped and tee'd, so the terminal behaves exactly as
# before while a durable copy accumulates. One previous run is kept (.log.1),
# because the failure you want to read about is usually the one that made you
# restart.
# Logging must never be able to take a service down with it. If the directory
# cannot be created or written, `tee` would exit immediately and the service
# would take SIGPIPE on its next line of output — turning a diagnostics problem
# into an outage, which is precisely the wrong trade. So writability is probed
# up front and logging degrades to a plain pass-through if it fails.
PODPROMPT_LOG_DIR="$HOME/.local/state/podprompt/logs"
PODPROMPT_LOGGING=0
if mkdir -p "$PODPROMPT_LOG_DIR" 2>/dev/null \
   && : > "$PODPROMPT_LOG_DIR/.probe" 2>/dev/null; then
    rm -f "$PODPROMPT_LOG_DIR/.probe"
    PODPROMPT_LOGGING=1
    for _f in driver server; do
        if [ -f "$PODPROMPT_LOG_DIR/$_f.log" ]; then
            mv -f "$PODPROMPT_LOG_DIR/$_f.log" "$PODPROMPT_LOG_DIR/$_f.log.1"
        fi
    done
else
    echo "[start-viewer] $PODPROMPT_LOG_DIR is not writable; continuing without file logs" >&2
fi

# tee to the file when logging is available, otherwise just pass the stream
# through untouched. Keeps the pipeline shape identical either way.
logto() {
    if [ "$PODPROMPT_LOGGING" = 1 ]; then tee -a "$1"; else cat; fi
}

# Prefix every line with a UTC timestamp. python3 is already a hard dependency
# here (it runs server.py), whereas Debian's default awk is mawk, which has no
# strftime() — so this is the portable choice inside this image. -u keeps it
# unbuffered so a crash does not swallow the last few lines.
stamp() {
    python3 -u -c 'import sys,datetime
for line in sys.stdin:
    sys.stdout.write(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]+"Z "+line)'
}

python3 "$HOME/.local/share/podprompt/viewer/server.py" --port "${VIEWER_PORT:-7843}" --driver-port "${VIEWER_DRIVER_PORT:-7844}" 2>&1 | stamp | logto "$PODPROMPT_LOG_DIR/server.log" &

# driver.mjs no longer takes a pinned session id at all: it creates
# per-session state lazily the first time a prompt actually arrives for a
# given session id (browser-chosen — either freshly minted client-side for
# "new chat" or picked from the sessions panel), so there's nothing to
# pre-seed here, unlike the single-session driver this replaced. That also
# means any --session-id/--resume/--continue/--fork-session/-r/-c passed
# through to this script (from pinning the CONTAINER's own launch, e.g.
# `./podprompt.sh --viewer --resume <id>`) is simply irrelevant now — those
# flags only ever meant anything to the TUI process this script used to
# also launch, which doesn't exist in viewer mode at all anymore.
#
# No --backend flag anymore either: podprompt.sh's own --claude/--opencode
# now only ever select a direct TUI launch (a different, mutually exclusive
# interface from --viewer, which this script is the entrypoint for) — there
# is no more command-line "default backend" for the viewer. driver.mjs
# resolves each session's own real, fixed backend itself (see its
# sessionIdToBackend cache) and remembers whichever backend the new-chat
# picker was last used with for its own pre-selected radio button
# (defaultBackendId(), backed by viewer-last-backend.json) — neither needs
# anything from this launch script.
node "$HOME/.local/share/podprompt/viewer/driver.mjs" \
    --port "${VIEWER_DRIVER_PORT:-7844}" \
    --viewer-port "${VIEWER_PORT:-7843}" \
    --cwd "$(pwd)" \
    --opencode-port "${OPENCODE_PORT:-7845}" 2>&1 | stamp | logto "$PODPROMPT_LOG_DIR/driver.log" &

# Foreground is a plain `wait` on both background jobs, so the container's
# lifetime tracks the actual services. (The opencode serve child lives under
# driver.mjs and is killed when the driver exits; driver.mjs itself also
# passes SIGTERM on to it in its own process.on("exit") hook.)
wait
