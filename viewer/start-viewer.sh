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
# unconditionally at driver startup, regardless of $VIEWER_BACKEND — the
# driver registers BOTH backends and any session can request either one
# explicitly (the browser's "+ New chat" picker does this), so the opencode
# backend needs to be reachable even when claude-code is the default. This
# used to be the missing piece: nothing ever started `opencode serve` inside
# the container, so --viewer-backend opencode assumed a process that never
# existed. Loopback-only (127.0.0.1) and not published to the host —
# driver.mjs is the only thing that talks to it, and they share this
# container's network namespace.
#
# No XDG_*_HOME overrides needed here: podprompt.sh bind-mounts this host's
# own ~/.config/opencode, ~/.local/share/opencode, ~/.local/state/opencode,
# and ~/.cache/opencode directly onto opencode's own real default paths
# inside the container (see `opencode debug paths`), so credentials/config/
# sessions created via `opencode auth login` (either through that serve
# instance, or through `./podprompt.sh --backend opencode`'s own TUI, which
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

python3 "$HOME/.local/share/podprompt/viewer/server.py" --port "${VIEWER_PORT:-7843}" --driver-port "${VIEWER_DRIVER_PORT:-7844}" &

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
node "$HOME/.local/share/podprompt/viewer/driver.mjs" \
    --port "${VIEWER_DRIVER_PORT:-7844}" \
    --viewer-port "${VIEWER_PORT:-7843}" \
    --cwd "$(pwd)" \
    --backend "${VIEWER_BACKEND:-claude-code}" \
    --opencode-port "${OPENCODE_PORT:-7845}" &

# Foreground is a plain `wait` on both background jobs, so the container's
# lifetime tracks the actual services. (The opencode serve child lives under
# driver.mjs and is killed when the driver exits; driver.mjs itself also
# passes SIGTERM on to it in its own process.on("exit") hook.)
wait
