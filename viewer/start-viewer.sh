#!/bin/sh
# Entrypoint for --viewer. Starts the transcript-tailing viewer server in
# the background, then runs claude in the foreground so it keeps the
# container's TTY for normal interactive use.
#
# If nothing on the command line already pins which session gets used
# (--session-id, --resume/-r, --continue/-c, --fork-session), we generate a
# session ID ourselves and hand the exact same UUID to both claude and the
# viewer server. That lets the server tail that one file by name instead of
# guessing "whichever *.jsonl has the newest mtime" — a guess that can
# silently follow the wrong session if some unrelated Claude Code process
# touches its own transcript with a newer mtime while this one runs.
#
# When one of those flags IS present, the resulting session ID can't be
# known in advance (resume/continue may reuse or fork an id, or open an
# interactive picker), so the server falls back to the mtime heuristic.
PINNED=0
for arg in "$@"; do
    case "$arg" in
        --session-id|--resume|-r|--continue|-c|--fork-session)
            PINNED=1
            ;;
    esac
done

if [ "$PINNED" = 1 ]; then
    python3 /home/claude/.claude/viewer/server.py --port "${VIEWER_PORT:-7843}" &
    exec claude "$@"
else
    SESSION_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
    python3 /home/claude/.claude/viewer/server.py --port "${VIEWER_PORT:-7843}" --session-id "$SESSION_ID" &
    exec claude --session-id "$SESSION_ID" "$@"
fi
