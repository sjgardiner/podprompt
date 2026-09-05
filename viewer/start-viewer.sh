#!/bin/sh
# Entrypoint for --viewer.
#
# Launches, in the background, the only two things --viewer needs: server.py
# (the browser-facing broadcast relay) and driver.mjs (the multi-session,
# Agent-SDK-based bidirectional driver the browser talks to directly). No
# TUI is attached — the browser's input box, session picker, and multi-tab/
# multi-session support are the only interface now.
#
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
#
# Foreground is a plain `wait` on the two background jobs, so the
# container's lifetime tracks the actual services.

python3 /home/claude/.claude/viewer/server.py --port "${VIEWER_PORT:-7843}" --driver-port "${VIEWER_DRIVER_PORT:-7844}" &

node /home/claude/.claude/viewer/driver.mjs \
    --port "${VIEWER_DRIVER_PORT:-7844}" \
    --viewer-port "${VIEWER_PORT:-7843}" \
    --cwd "$(pwd)" &

wait
