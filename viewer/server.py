#!/usr/bin/env python3
"""
Claude Code Viewer Server
=========================
Serves a browser UI that renders Claude Code responses as rich text
(markdown, KaTeX math, syntax-highlighted code).

This server is a plain broadcast relay: driver.mjs (the Agent SDK-based
bidirectional driver) POSTs every message the browser should see to
/message, and this server fans it out over Server-Sent Events to any
connected browser tabs.

Multi-session: state is keyed by session id, not global. Each browser tab
opens /events?session=<id> for whatever session it's currently viewing, and
only ever sees that session's messages — a different tab (or the same tab,
later) can independently view a different session at the same time, and a
turn running in one session has zero effect on any other session's feed.
There is deliberately no server-side notion of "the current session"
anymore; that lived entirely in each tab's own choice of which id to
connect with.

The first time any tab asks to view a session this process hasn't seen live
traffic for yet, its persisted history is pulled on demand from driver.mjs
(GET /session-history) and used to seed that session's log before replaying
it — this replaces the old driver-pushed /reset broadcast, which only made
sense when there was one shared "current" session for every tab to be reset
onto.

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
import time
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Empty, Queue
from urllib.parse import parse_qs, urlparse

VIEWER_HTML = Path(__file__).parent / "viewer.html"

# ── Per-session shared state ────────────────────────────────────────────────────
# sessionId -> {"log": [...], "seeded": bool, "seeding": bool, "clients": [Queue, ...]}
sessions: dict[str, dict] = {}
sessions_lock = threading.Lock()
DRIVER_PORT: int | None = None


def _get_session(session_id: str) -> dict:
    with sessions_lock:
        s = sessions.get(session_id)
        if s is None:
            s = {"log": [], "seeded": False, "seeding": False, "clients": []}
            sessions[session_id] = s
        return s


def broadcast_to(session_id: str, event: str, data: str):
    s = _get_session(session_id)
    payload = f"event: {event}\ndata: {data}\n\n"
    dead = []
    with sessions_lock:
        for q in s["clients"]:
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            s["clients"].remove(q)


# ── Cross-session "something changed" notifications ─────────────────────────
# The sessions panel wants near-instant badge updates not just for whatever
# session a tab happens to be viewing (that already gets pokes over the
# per-session channel above), but for *any* session — including ones this
# tab has no live connection to at all, since each /events stream is scoped
# to one session by design. This is a separate, global, log-free broadcast
# list (not nested under any one session's state) that any tab subscribes to
# only while its sessions panel is open, receiving a lightweight ping
# whenever a turn starts/ends or a permission/question appears or resolves
# in *any* session. The client doesn't need to know which session or what
# changed — the payload is carried mostly for future use, not because the
# client acts on it today — it just triggers a refetch of the full list
# either way.
meta_clients: list[Queue] = []


def broadcast_meta(session_id: str, kind: str):
    payload = f"event: change\ndata: {json.dumps({'sessionId': session_id, 'kind': kind})}\n\n"
    dead = []
    with sessions_lock:
        for q in meta_clients:
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            meta_clients.remove(q)


def _emit(session_id: str, event: str, entry: dict):
    # Upsert by id rather than blind-append: driver.mjs can broadcast an
    # updated version of a message it already sent (e.g. a permission bubble
    # rebroadcast with the decision baked in once it's answered) under the
    # same id. Replacing in place means a late-joining tab only ever sees
    # the final state for that id, not a stale copy followed by the real
    # one — both would render fine in order, but this avoids doubling it up
    # in /history and the Markdown export.
    s = _get_session(session_id)
    entry_id = entry.get("id")
    with sessions_lock:
        replaced = False
        if entry_id is not None:
            for i, existing in enumerate(s["log"]):
                if existing.get("id") == entry_id:
                    s["log"][i] = entry
                    replaced = True
                    break
        if not replaced:
            s["log"].append(entry)
    broadcast_to(session_id, event, json.dumps(entry))


def _fetch_session_history(session_id: str, backend: str | None = None) -> list:
    """Ask driver.mjs to convert this session's persisted transcript into
    our {role, text, id, ts} shape. The optional backend is the one the
    viewing tab learned for this session (its /sessions `backend` marker);
    relayed so a session this driver run hasn't touched yet still gets its
    history from the backend that owns it rather than the CLI default.

    A few escalating retries absorb the startup race where a browser tab
    connects before driver.mjs and the opencode serve have finished
    warming up (server.py is started first by start-viewer.sh). On
    persistent failure this RAISES rather than returning []: a swallowed
    empty list was indistinguishable from a genuinely empty session, so
    _ensure_seeded would lock the session in a state where its (real,
    large) history was never shown again."""
    url = f"http://127.0.0.1:{DRIVER_PORT}/session-history?sessionId={urllib.parse.quote(session_id)}"
    if backend:
        url += f"&backend={urllib.parse.quote(backend)}"
    last_exc = None
    for delay in (0.0, 0.4, 1.0):
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                return json.loads(resp.read())
        except Exception as e:
            last_exc = e
            if delay:
                time.sleep(delay)
    raise last_exc


def _ensure_seeded(session_id: str, backend: str | None = None):
    # One fetch per connect, guarded by a per-session "seeding" in-progress
    # flag so concurrent tabs don't both fetch (a double fetch would
    # double-splice the history). The splice and the "seeded" flag are set
    # together under the lock ONLY on a successful fetch.
    #
    # Crucially, a failed fetch must NOT permanently mark the session as
    # seeded: before this fix the flag was claimed up front and an empty
    # result during the startup window (server.py boots before driver.mjs /
    # the opencode serve are ready) locked in a permanently blank transcript
    # for a session that in fact had full history — while live messages
    # still streamed in fine, since those don't depend on the seeded log.
    #
    # Note on locking: sessions_lock is a plain threading.Lock (not
    # reentrant), so every acquisition here is a standalone `with` block —
    # never nested — and _get_session is never called while holding it.
    s = _get_session(session_id)
    with sessions_lock:
        seeded = s["seeded"]
        seeding = s["seeding"]
    if seeded:
        return
    if seeding:
        # Another connect is mid-fetch; wait briefly for it to land so this
        # connect's replay isn't taken from an unseeded log, then skip
        # without fetching again.
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            with sessions_lock:
                if not s["seeding"]:
                    break
            time.sleep(0.1)
        return
    with sessions_lock:
        if s["seeded"] or s["seeding"]:
            return  # lost a claim race after the read above
        s["seeding"] = True

    try:
        history = _fetch_session_history(session_id, backend)
    except Exception as e:
        with sessions_lock:
            s["seeding"] = False
        print(f"failed to seed history for {session_id}, retrying on next connect: {e}",
              flush=True)
        return

    entries = []
    for h in history:
        role = h.get("role", "assistant")
        text = h.get("text", h.get("content", ""))
        msg_id = h.get("id") or f"{role}-{uuid.uuid4()}"
        entries.append({"type": "message", "role": role, "text": text,
                         "id": msg_id, "ts": h.get("ts")})

    with sessions_lock:
        # Prepend: historical entries always logically precede anything
        # that could have arrived live while this fetch was in flight.
        s["log"] = entries + s["log"]
        s["seeding"] = False
        s["seeded"] = True


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
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        session_id = (qs.get("session") or [None])[0]
        backend = (qs.get("backend") or [None])[0]

        if path == "/":
            # This page changes across deploys of a locally-edited file, not
            # a versioned release — without an explicit no-store, a refresh
            # can still serve a stale cached copy in some browsers (there
            # was never any cache-control header on this route at all
            # before), which would silently make a real, already-deployed
            # fix look like it isn't working.
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(VIEWER_HTML.read_bytes())

        elif path == "/events":
            if not session_id:
                self.send_response(400)
                self.end_headers()
                return

            _ensure_seeded(session_id, backend)
            s = _get_session(session_id)

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_cors()
            self.end_headers()

            q: Queue = Queue()
            with sessions_lock:
                s["clients"].append(q)
                log_snapshot = list(s["log"])

            try:
                # Browsers' EventSource doesn't fire 'open' on response
                # headers alone — in practice it waits for the first actual
                # body byte. A brand-new session (e.g. just minted client-side
                # for "New chat") has an empty log_snapshot below, so without
                # this, nothing would be written at all until either a real
                # message arrives or the idle-ping timeout below first fires
                # — up to 15s during which the browser's 'open' handler (and
                # everything gated behind it, like the turn-in-flight resync)
                # never runs. Confirmed via a HAR capture: an empty session's
                # /events response was 0 bytes until the 15s ping. Sending
                # this unconditionally, before the history replay, means
                # there's always at least one byte on the wire immediately
                # regardless of whether this session has any history yet.
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()

                # Replay this session's history for late-joining/reconnecting
                # tabs, or for a tab switching to view this session for the
                # first time in this browser session.
                for entry in log_snapshot:
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
                with sessions_lock:
                    if q in s["clients"]:
                        s["clients"].remove(q)

        elif path == "/events-meta":
            # No session param, no history replay — this is a live-only
            # "something changed somewhere, go refetch /sessions" channel,
            # not a per-session message log. A tab only holds this open
            # while its sessions panel is actually open.
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_cors()
            self.end_headers()

            q: Queue = Queue()
            with sessions_lock:
                meta_clients.append(q)

            try:
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
                with sessions_lock:
                    if q in meta_clients:
                        meta_clients.remove(q)

        elif path == "/history":
            log = _get_session(session_id)["log"] if session_id else []
            body = json.dumps(log).encode()
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

        session_id = payload.get("sessionId")

        # The only ingress point for chat content: driver.mjs posts every
        # message the browser should see here, tagged with which session it
        # belongs to (also handy for manual testing, e.g.
        # `curl -d '{"sessionId":"...","role":"user","text":"hi"}'`).
        if path == "/message" and session_id:
            role = payload.get("role", "assistant")
            text = payload.get("content", payload.get("text", ""))
            msg_id = payload.get("id") or f"{role}-{uuid.uuid4()}"
            _emit(session_id, "message", {"type": "message", "role": role,
                                           "text": text, "id": msg_id, "ts": payload.get("ts")})
            # A permission/question card just appeared or got resolved (the
            # same role, rebroadcast with resolved:true) — either way, the
            # sessions-panel badge for this session may have just changed.
            if role == "permission":
                broadcast_meta(session_id, "permission")

        # Ephemeral UI-state signals (turn_start/turn_end/stream_delta/...) —
        # broadcast only, deliberately not appended to any log: these are
        # point-in-time signals, not something that makes sense to replay.
        elif path == "/status" and session_id:
            broadcast_to(session_id, "status", json.dumps(payload))
            if payload.get("type") in ("turn_start", "turn_end"):
                broadcast_meta(session_id, payload["type"])

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
                             "prompts/permission-responses, and used directly "
                             "by this process to pull a session's persisted "
                             "history on demand (default: 7844)")
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
