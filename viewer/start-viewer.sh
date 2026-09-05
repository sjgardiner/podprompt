#!/bin/sh
# Entrypoint for --viewer.
#
# Launches, in the background, the only two things --viewer needs: server.py
# (the browser-facing broadcast relay) and driver.mjs (the Agent SDK-based
# bidirectional driver, which is what the browser actually talks to). No TUI
# is attached anymore — the browser's input box and session picker have
# proven reliable enough on their own that keeping an unused interactive
# `claude` around as a fallback wasn't earning its keep. (There used to be a
# --tui-fallback flag reserved for eventually making this the default; now
# that it *is* the default, the flag itself has been removed rather than
# left around as a no-op — passing it will just error as an unrecognized
# argument now.)
#
# Foreground is a plain `wait` on the two background jobs, so the
# container's lifetime tracks the actual services instead of a TUI process
# nothing was attached to.
#
# Session-id pinning: if the caller already pins which session gets used
# (--session-id, --resume/-r, --continue/-c, --fork-session), the resulting
# session id can't be known in advance, so we don't try to wire up the
# driver at all in that case — just server.py (idle until something posts
# to /message). Without driver.mjs there is currently no way to submit a
# prompt through the browser, so --viewer combined with a pinned session is
# not really usable yet; switch to the desired session from the browser's
# own session picker instead of pinning it at launch.

PINNED=0
for arg in "$@"; do
    case "$arg" in
        --session-id|--resume|-r|--continue|-c|--fork-session)
            PINNED=1
            ;;
    esac
done

python3 /home/claude/.claude/viewer/server.py --port "${VIEWER_PORT:-7843}" --driver-port "${VIEWER_DRIVER_PORT:-7844}" &

if [ "$PINNED" = 1 ]; then
    echo "[viewer] A session was pinned (--session-id/--resume/--continue/--fork-session), but --viewer has no TUI fallback and driver.mjs isn't wired up for a pre-pinned session — there is currently no way to submit prompts through the browser in this combination. Use the browser's own session picker instead." >&2
    wait
    exit
fi

SESSION_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')

node /home/claude/.claude/viewer/driver.mjs \
    --port "${VIEWER_DRIVER_PORT:-7844}" \
    --viewer-port "${VIEWER_PORT:-7843}" \
    --cwd "$(pwd)" \
    --session-id "$SESSION_ID" &

wait
