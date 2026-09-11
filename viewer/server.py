#!/usr/bin/env python3
"""
PodPrompt Viewer Server
=======================
Serves a browser UI that renders agent responses as rich text (markdown,
KaTeX math, syntax-highlighted code).

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
(GET /session-history) and used to seed that session's log — replacing the
old driver-pushed /reset broadcast, which only made sense when there was one
shared "current" session for every tab to be reset onto. Seeding is
non-blocking: a background worker prepends the transcript (deduped against
whatever arrived live, see _seed_worker) and pushes the merge to already-open
tabs as a "history-batch" event, so neither a turn_start nor a connect ever
waits on the fetch.

It used to also tail the session's JSONL transcript directly and derive
messages from it (no driver involved at all, purely mirroring an
interactive TUI session) — that mode is retired as of the bidirectional
driver work; the read-only tailer is preserved in git history if ever
needed again, not in this file.

Usage (managed by podprompt.sh — you don't normally call this):
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
# sessionId -> {"log": [...], "seeded": bool, "seeding": bool, "retry_scheduled": bool,
#               "history_ids": set, "clients": [Queue, ...], "last_status": {type: payload}}
sessions: dict[str, dict] = {}
sessions_lock = threading.Lock()
DRIVER_PORT: int | None = None

# Which /status payload types are a *current gauge reading* (still true and
# worth showing immediately to a tab that only just connected) rather than a
# one-off event about something that just happened (turn_start/turn_end/
# stream_delta/tool_progress/thinking_tokens/...). Keyed by type so
# GAUGE_STATUS_TYPES membership doubles as the cache-and-replay allowlist.
GAUGE_STATUS_TYPES = {"plan_usage", "context_usage", "spend"}


def _get_session(session_id: str) -> dict:
    with sessions_lock:
        s = sessions.get(session_id)
        if s is None:
            s = {"log": [], "seeded": False, "seeding": False, "retry_scheduled": False,
                 "history_ids": set(), "clients": [], "last_status": {}}
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
    # one — both would render fine in order, but this avoids a duplicate in
    # the replayed log and the Markdown export.
    s = _get_session(session_id)
    entry_id = entry.get("id")
    with sessions_lock:
        replaced = False
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
    # Non-blocking by design: seeding runs in a daemon worker thread and the
    # result is pushed to already-connected tabs as a "history-batch" event
    # when it lands. The old implementation fetched synchronously here (up to
    # ~46s across _fetch_session_history's retries) whenever a turn_start
    # arrived before any tab had connected — which held up the driver's
    # outbound send queue (see enqueueSend in driver.mjs) and stalled that
    # turn's own messages behind the fetch. Nothing needs the fetch to have
    # completed BEFORE a connect or a turn_start anymore; a connect replays
    # whatever the log already holds and is topped up by a seed-drain re-check
    # (see /events), and a turn's live messages broadcast independently of the
    # log's seeding state. History simply appears above the live content when
    # it becomes available; a background retry chain (see _schedule_seed_retry)
    # — armed by turn_start and connects too — keeps an unseeded session
    # trying until it either lands or seals as genuinely empty.
    #
    # Guarded by the per-session "seeding" single-flight flag (one fetch at a
    # time, no double-fetch from concurrent connects) and the "seeded" latch.
    # The latch is set ONLY on a successful fetch — a failed fetch must never
    # permanently mark the session as seeded (details in _seed_worker).
    #
    # Note on locking: sessions_lock is a plain threading.Lock (not
    # reentrant), so every acquisition here is a standalone `with` block —
    # never nested — and _get_session is never called while holding it.
    s = _get_session(session_id)
    with sessions_lock:
        if s["seeded"] or s["seeding"]:
            return
        s["seeding"] = True
    threading.Thread(target=_seed_worker, args=(session_id, backend), daemon=True).start()


def _seed_worker(session_id: str, backend: str | None):
    s = _get_session(session_id)
    try:
        history = _fetch_session_history(session_id, backend)
    except Exception as e:
        print(f"failed to seed history for {session_id}, will retry: {e}", flush=True)
        with sessions_lock:
            s["seeding"] = False
        _schedule_seed_retry(session_id, backend)
        return

    entries = []
    for h in history:
        role = h.get("role", "assistant")
        text = h.get("text", h.get("content", ""))
        msg_id = h.get("id") or f"{role}-{uuid.uuid4()}"
        entries.append({"type": "message", "role": role, "text": text,
                         "id": msg_id, "ts": h.get("ts"), "model": h.get("model")})

    with sessions_lock:
        # Prepend: historical entries always logically precede anything that
        # could have arrived live while this fetch was in flight. Dedup is on
        # the exact (id, role, text) triple — deliberately stronger than id
        # alone (5b016a7's original rule): the two backends' live-minted ids
        # match history's ids exactly for some roles (plain user prompts, tool
        # calls) but only best-effort for others, and a best-effort pairing
        # must never be able to *suppress* a real transcript message — an
        # exact triple match is the one equality that can't be a false
        # positive. Survivors are older than everything already in the log, so
        # they go at the front as a contiguous block, and their ids are
        # recorded in s["history_ids"] so a tab that connected mid-fetch can
        # be topped up precisely (see /events' seed-drain) without ever
        # mistaking a post-snapshot LIVE entry for history.
        existing_triples = {(e.get("id"), e.get("role"), e.get("text")) for e in s["log"]}
        new_entries = [e for e in entries if (e.get("id"), e.get("role"), e.get("text")) not in existing_triples]
        s["log"] = new_entries + s["log"]
        s["history_ids"].update(e.get("id") for e in new_entries)
        s["seeding"] = False
        # An empty result fetched WITHOUT an explicit backend (backend is
        # None — this caller couldn't resolve it, e.g. a connect before the
        # viewer learned this session's real backend tag) is indistinguishable
        # from "asked the wrong backend, got a clean empty answer": both
        # backends' getSessionHistory return [] rather than erroring on a
        # foreign id, since a genuinely brand-new, never-prompted session
        # looks identical to a misrouted one from the backend's own point of
        # view (so this can't be fixed by making the backends pickier — a real
        # attempt at that regressed every brand-new session's first view,
        # since an unmapped client-minted id is normal and expected then, not
        # just possible under a mismatch). Permanently latching `seeded=True`
        # on an unlabeled empty guess is exactly the bug that used to blank a
        # real session's history forever, until a full server.py restart
        # (which wipes this whole in-memory dict) gave it another shot. Only
        # commit to "seeded" unconditionally once a real backend was actually
        # known, or once real content came back (which can't be a false
        # negative regardless of which backend answered) — an inconclusive
        # empty guess still populates *this* attempt's log (so a connected tab
        # isn't left waiting on nothing) but stays eligible for a retry,
        # hopefully by then armed with the real backend (viewer.html's boot
        # sequence resolves it before the first connect in the common case).
        if entries or backend:
            s["seeded"] = True

    if new_entries:
        broadcast_to(session_id, "history-batch", json.dumps(new_entries))

    with sessions_lock:
        sealed = s["seeded"]
    if not sealed:
        _schedule_seed_retry(session_id, backend)


def _schedule_seed_retry(session_id: str, backend: str | None):
    # Background retry until first success, chained rather than a hot loop: a
    # failed/empty attempt arms a single ~2s waiter; when it fires it clears
    # its own "armed" flag and calls _ensure_seeded afresh, whose worker — on
    # another miss — arms the next waiter itself. The guard
    # (retry_scheduled/seeded/seeding) keeps at most one waiter in flight per
    # session, and the "seeded" latch's {entries or backend} seal normally
    # ends the chain on the first attempt. turn_start and connect still
    # trigger _ensure_seeded directly on top of this timer, which mainly
    # covers the case where a session's only triggering events landed before
    # its transcript became fetchable.
    s = _get_session(session_id)
    with sessions_lock:
        if s["seeded"] or s["seeding"] or s["retry_scheduled"]:
            return
        s["retry_scheduled"] = True

    def waiter():
        time.sleep(2.0)
        with sessions_lock:
            s["retry_scheduled"] = False
        _ensure_seeded(session_id, backend)

    threading.Thread(target=waiter, daemon=True).start()


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
                status_snapshot = list(s["last_status"].values())

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

                # Restore any "current gauge reading" statuses (plan_usage/
                # context_usage/spend — see GAUGE_STATUS_TYPES) so the
                # usage bars reappear immediately on connect instead of
                # staying hidden until the next turn happens to rebroadcast
                # them. Sent as plain "status" events, same as live ones —
                # the client can't tell (and doesn't need to) the difference.
                for status_payload in status_snapshot:
                    payload = f"event: status\ndata: {json.dumps(status_payload)}\n\n"
                    self.wfile.write(payload.encode())
                self.wfile.flush()

                # Seed-drain: a background _seed_worker may have merged this
                # session's history in the gap between the log_snapshot read
                # above and this tab's queue joining the broadcast list — in
                # that window the worker's own "history-batch" broadcast went
                # only to clients already subscribed, so this tab would have
                # missed the session's one history batch for its whole life.
                # Re-scan the log for entries tagged as history-seeded
                # (s["history_ids"]) that weren't in the snapshot and replay
                # just those. The tag is what keeps this from catching
                # post-snapshot LIVE entries (which stream to this tab over
                # the queue right after anyway) and wrongly front-placing
                # them above anything older. Any double-delivery with a
                # worker broadcast is harmless — the client upserts by id.
                with sessions_lock:
                    snapshot_ids = {e.get("id") for e in log_snapshot}
                    late_history = [e for e in s["log"]
                                    if e.get("id") in s["history_ids"] and e.get("id") not in snapshot_ids]
                if late_history:
                    payload = f"event: history-batch\ndata: {json.dumps(late_history)}\n\n"
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
                                           "text": text, "id": msg_id, "ts": payload.get("ts"),
                                           "model": payload.get("model")})
            # A permission/question card just appeared or got resolved (the
            # same role, rebroadcast with resolved:true) — either way, the
            # sessions-panel badge for this session may have just changed.
            if role == "permission":
                broadcast_meta(session_id, "permission")

        # Ephemeral UI-state signals (turn_start/turn_end/stream_delta/...) —
        # broadcast only, deliberately not appended to the message log: these
        # are point-in-time signals, not something that makes sense to replay
        # as part of the conversation. A *subset* of them (GAUGE_STATUS_TYPES)
        # describe a current reading rather than a momentary event, though —
        # e.g. plan_usage/context_usage — and those ARE worth restoring to a
        # tab that (re)connects between turns, otherwise the bar just vanishes
        # on every refresh until the next turn happens to refresh it, even
        # though the underlying fact it displays hasn't changed at all. Fixed
        # 2026-09-06 after exactly that was reported: the bar showed once,
        # then a refresh alone made it disappear.
        elif path == "/status" and session_id:
            if payload.get("type") == "turn_start":
                # Kick off seeding (non-blocking — see _ensure_seeded) so a
                # session that nobody's browser tab had opened yet (so GET
                # /events never triggered it) still gets its history merged
                # over this turn. Previously this call fetched synchronously
                # and blocked the driver's outbound send queue (enqueueSend in
                # driver.mjs) for up to ~46s on a slow first fetch, stalling
                # every message of the turn behind it; now it just arms the
                # background worker and the turn's broadcasts start
                # immediately, with history filling in above once it lands
                # (delivered to open tabs as "history-batch"). `backend` is
                # required (not optional) precisely because this is the FIRST
                # time this session may ever be seen by this process — there's
                # no prior /events call to have already resolved it from.
                _ensure_seeded(session_id, payload.get("backend"))
            if payload.get("type") in GAUGE_STATUS_TYPES:
                s = _get_session(session_id)
                with sessions_lock:
                    s["last_status"][payload["type"]] = payload
            broadcast_to(session_id, "status", json.dumps(payload))
            if payload.get("type") in ("turn_start", "turn_end"):
                broadcast_meta(session_id, payload["type"])

        elif path in ("/message", "/status"):
            self.send_response(400)
            self.end_headers()
            return

        else:
            self.send_response(404)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_cors()
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


# ── Entry point ────────────────────────────────────────────────────────────────
def main():
    import argparse

    global DRIVER_PORT

    parser = argparse.ArgumentParser(description="PodPrompt viewer server")
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
