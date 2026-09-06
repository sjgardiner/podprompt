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
# backend (Claude Code or OpenCode) depending on --backend, so the OS user
# shouldn't be branded to just one of them. See podprompt.sh's CONFIG_DIR /
# PODPROMPT_STATE_DIR / PODPROMPT_DATA_DIR for how the two backends' host-side
# state gets mounted onto this user's $HOME.
RUN useradd -m -s /bin/bash agent \
    && chmod -R 777 /home/agent

USER agent
WORKDIR /workspace
