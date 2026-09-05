#!/usr/bin/env python3
"""
Claude Code Viewer Server
=========================
Serves a browser UI that renders Claude Code responses as rich text
(markdown, KaTeX math, syntax-highlighted code).

This server is a plain broadcast relay: driver.mjs (the Agent SDK-based
bidirectional driver) POSTs every message the browser should see to
/message, and this server fans it out over Server-Sent Events to any
connected browser tabs, keeping a log for late-joining/reconnecting tabs.

It used to also tail the session's JSONL transcript directly and derive
messages from it (no driver involved at all, purely mirroring an
interactive TUI session) — that mode is retired as of the bidirectional
driver work; the read-only tailer is preserved in git history if ever
needed again, not in this file.

Usage (managed by run-claude-docker.sh — you don't normally call this):
  python3 server.py --port 7843

The server binds to 0.0.0.0 so it is reachable via Docker's port mapping.
Open http://localhost:7843 (or whichever host port is mapped) in your browser.
"""

import json
import threading
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
DRIVER_PORT: int | None = None  # reported to the browser via /config


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
    # Upsert by id rather than blind-append: driver.mjs can now broadcast an
    # updated version of a message it already sent (e.g. a permission bubble
    # rebroadcast with the decision baked in once it's answered) under the
    # same id. Replacing in place means a late-joining tab's history/reset
    # replay only ever sees the final state for that id, not a stale
    # unresolved copy followed by the real one — both render fine in order,
    # but keeping just one entry is cleaner and avoids doubling it up in
    # /history and the Markdown export.
    entry_id = entry.get("id")
    if entry_id is not None:
        for i, existing in enumerate(message_log):
            if existing.get("id") == entry_id:
                message_log[i] = entry
                broadcast(event, json.dumps(entry))
                return
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

        elif path == "/config":
            body = json.dumps({"driverPort": DRIVER_PORT}).encode()
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

        # The only ingress point for chat content: driver.mjs posts every
        # message the browser should see here (also handy for manual
        # testing, e.g. `curl -d '{"role":"user","text":"hi"}'`).
        if path == "/message":
            role = payload.get("role", "assistant")
            text = payload.get("content", payload.get("text", ""))
            msg_id = payload.get("id") or f"{role}-{uuid.uuid4()}"
            _emit("message", {"type": "message", "role": role,
                               "text": text, "id": msg_id, "ts": payload.get("ts")})

        # Ephemeral UI-state signals (turn_start/turn_end) — broadcast only,
        # deliberately not appended to message_log: these are point-in-time
        # signals, not something that makes sense to replay on reconnect.
        elif path == "/status":
            broadcast("status", json.dumps(payload))

        # Session switch / new chat: driver.mjs replaces the whole visible
        # history wholesale. Connected tabs wipe their feed and re-render
        # from this — see viewer.html's "reset" SSE handler. Note this
        # affects every connected tab at once (broadcast is global, not
        # per-connection), a known limitation for the rare multi-tab case.
        elif path == "/reset":
            entries = []
            for m in payload.get("messages", []):
                role = m.get("role", "assistant")
                text = m.get("content", m.get("text", ""))
                msg_id = m.get("id") or f"{role}-{uuid.uuid4()}"
                entries.append({"type": "message", "role": role, "text": text,
                                 "id": msg_id, "ts": m.get("ts")})
            message_log.clear()
            message_log.extend(entries)
            broadcast("reset", json.dumps(entries))

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_cors()
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


# ── Entry point ────────────────────────────────────────────────────────────────
def main():
    import argparse

    global DRIVER_PORT

    parser = argparse.ArgumentParser(description="Claude Code viewer server")
    parser.add_argument("--port", type=int, default=7843,
                        help="Port to listen on (default: 7843)")
    parser.add_argument("--driver-port", type=int, default=7844,
                        help="Port driver.mjs listens on — reported to the "
                             "browser via /config so it knows where to POST "
                             "prompts/permission-responses (default: 7844)")
    args = parser.parse_args()
    DRIVER_PORT = args.driver_port

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"[viewer] open http://localhost:{args.port} in your browser")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
