#!/bin/sh
# Entrypoint for --viewer.
#
# Launches, in the background, everything --viewer needs: a headless
# `opencode serve` (see backends/opencode.mjs — driver.mjs's opencode
# backend is just an HTTP+SSE client of this), server.py (the browser-facing
# broadcast relay), and driver.mjs (the multi-session, multi-backend
# bidirectional driver the browser talks to directly). No TUI is attached —
# the browser's input box, session picker, and multi-tab/multi-session
# support are the only interface now.
#
# `opencode serve` is started unconditionally, regardless of
# $VIEWER_BACKEND — driver.mjs registers BOTH backends at startup and any
# session can request either one explicitly (the browser's "+ New chat"
# picker does this), so the opencode backend needs to be reachable even when
# claude-code is the default. This used to be the missing piece: nothing
# ever started `opencode serve` inside the container, so --viewer-backend
# opencode assumed a process that never existed. Loopback-only
# (127.0.0.1) and not published to the host — driver.mjs is the only thing
# that talks to it, and they share this container's network namespace.
#
# No XDG_*_HOME overrides needed here: run-claude-docker.sh bind-mounts this
# host's own ~/.config/opencode, ~/.local/share/opencode,
# ~/.local/state/opencode, and ~/.cache/opencode directly onto opencode's
# own real default paths inside the container (see `opencode debug paths`),
# so credentials/config/sessions created via `opencode auth login` (either
# through this serve instance, or through `./run-claude-docker.sh --backend
# opencode`'s own TUI, which gets the identical mounts) persist across
# container restarts in their own standard host locations — independent of
# Claude Code's own ~/.claude-docker/, not nested inside it.
#
# A cold `opencode serve` takes roughly a second to start accepting
# connections. Not specifically waited on here: the very first thing that
# might race it is the /sessions poll loop, which already treats a backend
# failing to respond as an expected, self-healing, log-once condition (see
# driver.mjs's backendSessionsFailing) rather than a fatal error, and by the
# time a human has actually loaded the page and sent a prompt, well over a
# second has already passed.
opencode serve --hostname 127.0.0.1 --port "${OPENCODE_PORT:-7845}" &

python3 /home/claude/.claude/viewer/server.py --port "${VIEWER_PORT:-7843}" --driver-port "${VIEWER_DRIVER_PORT:-7844}" &

# driver.mjs no longer takes a pinned session id at all: it creates
# per-session state lazily the first time a prompt actually arrives for a
# given session id (browser-chosen — either freshly minted client-side for
# "new chat" or picked from the sessions panel), so there's nothing to
# pre-seed here, unlike the single-session driver this replaced. That also
# means any --session-id/--resume/--continue/--fork-session/-r/-c passed
# through to this script (from pinning the CONTAINER's own launch, e.g.
# `./run-claude-docker.sh --viewer --resume <id>`) is simply irrelevant now
# — those flags only ever meant anything to the TUI process this script
# used to also launch, which doesn't exist in viewer mode at all anymore.
node /home/claude/.claude/viewer/driver.mjs \
    --port "${VIEWER_DRIVER_PORT:-7844}" \
    --viewer-port "${VIEWER_PORT:-7843}" \
    --cwd "$(pwd)" \
    --backend "${VIEWER_BACKEND:-claude-code}" \
    --opencode-port "${OPENCODE_PORT:-7845}" &

# Foreground is a plain `wait` on all three background jobs, so the
# container's lifetime tracks the actual services.
wait
