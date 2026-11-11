FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates ripgrep python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# OpenCode: alternate backend under evaluation for the viewer (see
# podprompt.sh / viewer/ for the Claude Agent SDK-based path this is meant to
# sit alongside). Installs a per-platform prebuilt binary via
# optionalDependencies + a postinstall script (same pattern as esbuild/sharp)
# — no separate "server" package exists; `opencode serve`/`opencode`/TUI are
# all the one binary. Pulls in its own binary only; ripgrep (already
# installed above for Claude Code) covers its stated dependency too.
RUN npm install -g opencode-ai

# OpenCode v2 — a SEPARATE npm package, not a newer release of opencode-ai
# above. The two are different product lines with independent version numbers
# (opencode-ai is 1.x; @opencode/cli is 2.x), which is why "we're already on
# the latest opencode" was true and still left v2 missing.
#
# WHY IT IS HERE. v2 is what can actually execute `delivery: "steer"` —
# admitting a message into a turn that is ALREADY RUNNING, folded in at the
# next step boundary instead of aborting the turn or waiting for it to end.
# 1.19.5 advertises that field on POST /api/session/{id}/prompt and then
# silently drops it: its model resolver only understands the legacy `aisdk`
# provider descriptors, while every currently-active model (including the
# free ones) is now published against the native `@opencode/ai/providers/*`
# adapters, so no turn ever runs on that path. Verified on 2.2.7: a steer
# posted 1.5s into a 50s turn entered the transcript at the first step
# boundary and the final reply acted on it, with no abort and no lost work.
#
# INSTALLED INTO ITS OWN PREFIX, DELIBERATELY. Both packages declare a bin
# named `opencode`, so a plain `npm install -g` would hand /usr/local/bin/
# opencode to whichever ran last — a decision made by line ORDER in this file,
# which is exactly the kind of thing that flips silently when someone moves a
# block. A private prefix means npm never competes for that name at all:
#   opencode  -> 1.x, untouched, what every existing caller already expects
#   opencode2 -> 2.x, the v2 API server (`opencode2 serve`)
# (@opencode/cli declares `opencode2` itself, so this exposes its own name
# rather than inventing one.)
#
# Unpinned, matching opencode-ai above: both track their latest stable.
RUN npm install -g --prefix /opt/opencode-v2 @opencode/cli \
    && ln -sf /opt/opencode-v2/bin/opencode2 /usr/local/bin/opencode2

# Fail the BUILD, not a session. A clobbered symlink or a postinstall that
# selected the wrong platform binary is invisible until something tries to
# start a turn — by which point it looks like a backend bug and gets debugged
# as one. Asserting the MAJOR version of each link also catches the specific
# failure this layout exists to prevent: the two binaries swapping places.
RUN opencode --version | grep -q '^1\.' \
    && opencode2 --version | grep -q 'v\?2\.' \
    && echo "opencode v1=$(opencode --version) v2=$(opencode2 --version)"

# Username is deliberately "agent", not "claude" — this container runs either
# backend (Claude Code or OpenCode, or both at once under --viewer) depending
# on --claude/--opencode/--viewer, so the OS user shouldn't be branded to just
# one of them. See podprompt.sh's CONFIG_DIR /
# PODPROMPT_STATE_DIR / PODPROMPT_DATA_DIR for how the two backends' host-side
# state gets mounted onto this user's $HOME.
RUN useradd -m -s /bin/bash agent

# Bake the viewer's own Node dependency (Claude Agent SDK) into the image at
# build time instead of installing it on the host and bind-mounting the
# result in — npm's optionalDependencies resolve to whatever platform is
# running `npm install`, so a host-side install (macOS, e.g.) would pull
# darwin-* binaries instead of the linux-* ones this container needs at
# runtime. Building here guarantees the installed variant always matches
# this image's own actual platform, regardless of host OS/arch.
#
# Installed one directory ABOVE viewer/ (podprompt/node_modules, not
# podprompt/viewer/node_modules) deliberately: podprompt.sh bind-mounts the
# whole viewer/ directory as one unit from the host (for fast edit-and-
# restart iteration on server.py/viewer.html/driver.mjs/start-viewer.sh/
# backends/), which would completely shadow anything baked directly inside
# it. Node's module resolution walks up the directory tree looking for
# node_modules (true for both require() and ESM import), so a bare `import
# '@anthropic-ai/claude-agent-sdk'` from driver.mjs finds this one directory
# up with no symlink, NODE_PATH, or per-file mount list needed.
COPY viewer/package.json viewer/package-lock.json /home/agent/.local/share/podprompt/
RUN cd /home/agent/.local/share/podprompt && npm install

RUN chmod -R 777 /home/agent

# Marks this as an image podprompt can run. The launcher refuses anything
# without it, which is what makes `--image` safe to point at a local variant:
# labels are inherited through FROM, so an image built `FROM podprompt` carries
# this automatically and passes the check without its author doing anything.
LABEL org.podprompt.base=1

USER agent
WORKDIR /workspace
