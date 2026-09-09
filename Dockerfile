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

USER agent
WORKDIR /workspace
