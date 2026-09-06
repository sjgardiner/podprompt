FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates ripgrep python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# OpenCode: alternate backend under evaluation for the viewer (see
# run-claude-docker.sh / viewer/ for the Claude Agent SDK-based path this is
# meant to sit alongside). Installs a per-platform prebuilt binary via
# optionalDependencies + a postinstall script (same pattern as esbuild/sharp)
# — no separate "server" package exists; `opencode serve`/`opencode`/TUI are
# all the one binary. Pulls in its own binary only; ripgrep (already
# installed above for Claude Code) covers its stated dependency too.
RUN npm install -g opencode-ai

RUN useradd -m -s /bin/bash claude \
    && chmod -R 777 /home/claude

USER claude
WORKDIR /workspace
