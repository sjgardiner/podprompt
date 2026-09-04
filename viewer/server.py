#!/usr/bin/env python3
"""
Claude Code Viewer Server
=========================
Serves a browser UI that renders Claude Code responses as rich text
(markdown, KaTeX math, syntax-highlighted code).

Claude runs normally in the terminal. This server tails the session's JSONL
transcript under --projects-dir directly (no hooks involved) and emits a
message for each real user prompt, each assistant text block, and a compact
line for each tool call, as they're written.

Usage (managed by run-claude-docker.sh — you don't normally call this):
  python3 server.py --port 7843 --projects-dir /home/claude/.claude/projects/-workspace

The server binds to 0.0.0.0 so it is reachable via Docker's port mapping.
Open http://localhost:7843 (or whichever host port is mapped) in your browser.
"""

import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Empty, Queue
from urllib.parse import urlparse

VIEWER_HTML = Path(__file__).parent / "viewer.html"

# ── Shared state ───────────────────────────────────────────────────────────────
clients: list[Queue] = []
clients_lock = threading.Lock()
message_log: list[dict] = []  # full session history for late-joining tabs


def broadcast(event: str, data: str):
    payload = f"event: {event}\ndata: {data}\n\n"
    dead = []
    with clients_lock:
        for q in clients:
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            clients.remove(q)


def _emit(event: str, entry: dict):
    message_log.append(entry)
    broadcast(event, json.dumps(entry))


# ── HTTP handler ───────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(VIEWER_HTML.read_bytes())

        elif path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_cors()
            self.end_headers()

            q: Queue = Queue()
            with clients_lock:
                clients.append(q)

            try:
                # Replay history for late-joining tabs
                for entry in message_log:
                    payload = f"event: history\ndata: {json.dumps(entry)}\n\n"
                    self.wfile.write(payload.encode())
                self.wfile.flush()

                while True:
                    try:
                        chunk = q.get(timeout=15)
                        self.wfile.write(chunk.encode())
                        self.wfile.flush()
                    except Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with clients_lock:
                    if q in clients:
                        clients.remove(q)

        elif path == "/history":
            body = json.dumps(message_log).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_cors()
            self.end_headers()
            self.wfile.write(body)

        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return

        # Generic manual-testing endpoint — not used by any automated
        # mechanism. Handy for `curl -d '{"role":"user","text":"hi"}'`.
        if path == "/message":
            role = payload.get("role", "assistant")
            text = payload.get("content", payload.get("text", ""))
            _emit("message", {"type": "message", "role": role,
                               "text": text, "id": f"{role}-{int(time.time())}"})

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_cors()
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


# ── Transcript tailer ────────────────────────────────────────────────────────
# Reads the session's JSONL transcript directly — no hooks required. Each line
# is a complete, self-contained JSON object appended once it's fully written,
# so this is safe to poll rather than needing inotify.

def _extract_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            block.get("text", "") for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        return "\n\n".join(p for p in parts if p)
    return ""


def _summarize_tool_input(tool_input) -> str:
    if not isinstance(tool_input, dict):
        text = str(tool_input)
    else:
        text = None
        for key in ("command", "file_path", "pattern", "query", "url", "description"):
            if key in tool_input:
                text = str(tool_input[key])
                break
        if text is None:
            text = json.dumps(tool_input)
    return text if len(text) <= 200 else text[:200] + "…"


def _tool_uses(content):
    if not isinstance(content, list):
        return []
    return [
        (block.get("id") or str(uuid.uuid4()), block.get("name", "tool"), block.get("input", {}))
        for block in content
        if isinstance(block, dict) and block.get("type") == "tool_use"
    ]


def _is_real_user_prompt(content) -> bool:
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        has_text = any(isinstance(b, dict) and b.get("type") == "text" for b in content)
        has_tool_result = any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
        return has_text and not has_tool_result
    return False


def _emit_transcript_entry(entry: dict):
    if entry.get("isSidechain"):
        return  # subagent-internal chatter — not the main conversation

    etype = entry.get("type")
    message = entry.get("message", {})
    content = message.get("content", "")
    uid = entry.get("uuid") or str(uuid.uuid4())
    ts = entry.get("timestamp")

    if etype == "assistant":
        text = _extract_text(content)
        if text.strip():
            _emit("message", {"type": "message", "role": "assistant", "text": text, "id": uid, "ts": ts})
        for tool_id, name, tool_input in _tool_uses(content):
            summary = _summarize_tool_input(tool_input)
            _emit("message", {"type": "message", "role": "tool",
                               "text": f"`{name}` {summary}", "id": tool_id, "ts": ts})

    elif etype == "user":
        if _is_real_user_prompt(content):
            text = _extract_text(content)
            if text.strip():
                # Task-notifications (async subagent results) land back in the
                # transcript as a "user" turn structurally, but they're not
                # something Gardiner typed — flag them as their own role so
                # the viewer doesn't label them "You".
                role = "agent" if text.lstrip().startswith("<task-notification>") else "user"
                _emit("message", {"type": "message", "role": role, "text": text, "id": uid, "ts": ts})


def run_tailer(projects_dir: Path, session_id: str = None, poll_interval: float = 0.4):
    """
    If session_id is given, follows exactly that session's transcript file
    (projects_dir/<session_id>.jsonl) by name, waiting for it to be created
    if it doesn't exist yet. This is the precise path — used whenever
    start-viewer.sh generated the session ID itself and passed the same one
    to `claude --session-id`.

    Otherwise, falls back to following whichever *.jsonl file in
    projects_dir was modified most recently, switching automatically when a
    newer one appears. This heuristic is used when the caller pinned the
    session some other way (--resume, --continue, --fork-session) so the
    resulting session ID can't be known in advance — but it can silently
    follow the wrong session if some unrelated Claude Code process touches
    its own transcript file with a newer mtime while this one is running.
    """
    if session_id:
        print(f"[viewer] tailing pinned session {session_id} under {projects_dir}")
    else:
        print(f"[viewer] tailing transcripts under {projects_dir} (no pinned session id; following newest mtime)")

    current_path = None
    offset = 0
    leftover = ""

    while True:
        if session_id:
            pinned_path = projects_dir / f"{session_id}.jsonl"
            newest = pinned_path if pinned_path.exists() else None
        else:
            try:
                candidates = sorted(
                    projects_dir.glob("*.jsonl"),
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
            except FileNotFoundError:
                candidates = []
            newest = candidates[0] if candidates else None

        if newest:
            if newest != current_path:
                current_path = newest
                offset = 0
                leftover = ""
                print(f"[viewer] following {current_path.name}")

            try:
                with current_path.open("r", encoding="utf-8") as f:
                    f.seek(offset)
                    chunk = f.read()
                    offset = f.tell()
            except OSError:
                chunk = ""

            if chunk:
                leftover += chunk
                lines = leftover.split("\n")
                leftover = lines.pop()  # last element may be a partial line
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    try:
                        _emit_transcript_entry(entry)
                    except Exception as e:
                        print(f"[viewer] skipped malformed transcript entry: {e}", file=sys.stderr)

        time.sleep(poll_interval)


# ── Entry point ────────────────────────────────────────────────────────────────
def main():
    import argparse

    default_projects_dir = None
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if config_dir:
        cwd_slug = os.getcwd().replace("/", "-")
        default_projects_dir = str(Path(config_dir) / "projects" / cwd_slug)

    parser = argparse.ArgumentParser(description="Claude Code viewer server")
    parser.add_argument("--port", type=int, default=7843,
                        help="Port to listen on (default: 7843)")
    parser.add_argument("--projects-dir", default=default_projects_dir,
                        help="Directory of *.jsonl session transcripts to tail. "
                             "Defaults to $CLAUDE_CONFIG_DIR/projects/<cwd-slug>.")
    parser.add_argument("--session-id", default=None,
                        help="If given, tail exactly projects-dir/<session-id>.jsonl "
                             "instead of guessing the active session by mtime.")
    args = parser.parse_args()

    if not args.projects_dir:
        print("[viewer] requires --projects-dir (or $CLAUDE_CONFIG_DIR set)", file=sys.stderr)
        sys.exit(1)

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    print(f"[viewer] open http://localhost:{args.port} in your browser")

    try:
        run_tailer(Path(args.projects_dir), session_id=args.session_id)
    except KeyboardInterrupt:
        pass

    server.shutdown()


if __name__ == "__main__":
    main()
