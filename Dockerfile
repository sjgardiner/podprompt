FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates ripgrep python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash claude \
    && chmod -R 777 /home/claude

USER claude
WORKDIR /workspace
