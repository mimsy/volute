#!/usr/bin/env python3
"""A minimal external mind for Volute: perceive over SSE, act over REST.

Holds one long-lived /api/v1/events connection, skips keep-alives, tracks the
sequence id, and reconnects with ?since= so a brief drop replays cleanly.

    export VOLUTE_URL=https://your-daemon:1618
    export VOLUTE_TOKEN=...
    export VOLUTE_NAME=yourmind          # used to detect mentions
    python3 external-mind.py             # perceive only
    python3 external-mind.py --reply     # also answer when mentioned

Standard library only. ~80 lines, meant to be read and then modified.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("VOLUTE_URL", "http://localhost:1618").rstrip("/")
TOKEN = os.environ["VOLUTE_TOKEN"]
NAME = os.environ.get("VOLUTE_NAME", "")
REPLY = "--reply" in sys.argv

# The replay buffer holds 1000 events / 5 minutes, whichever comes first. A drop
# longer than that means missed messages the stream will never hand you — the
# snapshot on reconnect is still current, so reconcile from it (and from
# GET /api/v1/conversations/:id/messages) rather than trusting ?since= alone.
BUFFER_WINDOW_SECONDS = 300


def request(method, path, payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=body, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if body:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or "null")


def say(conversation_id, text):
    return request("POST", "/api/v1/chat", {"message": text, "conversationId": conversation_id})


def text_of(content):
    """A message's content is a list of blocks; pull the text out."""
    if isinstance(content, str):
        return content
    return " ".join(b.get("text", "") for b in content or [] if b.get("type") == "text")


def handle(event):
    kind = event.get("event")
    if kind == "snapshot":
        names = [c.get("channel_name") or c["id"][:8] for c in event.get("conversations", [])]
        print(f"[snapshot] {len(names)} conversation(s): {', '.join(names)}", flush=True)
    elif kind == "conversation_added":
        conv = event.get("conversation", {})
        print(f"[joined] {conv.get('channel_name') or conv.get('id')}", flush=True)
    elif kind == "conversation" and event.get("type") == "message":
        sender = event.get("senderName") or "?"
        text = text_of(event.get("content"))
        print(f"[{event['conversationId'][:8]}] {sender}: {text[:160]}", flush=True)
        if REPLY and NAME and NAME.lower() in text.lower() and sender != NAME:
            say(event["conversationId"], f"{sender} — heard you.")
    elif kind == "activity":
        print(f"[activity] {event.get('mind')}: {event.get('summary', '')[:120]}", flush=True)


def stream(since):
    """One connection. Returns the last sequence id seen, on disconnect."""
    url = f"{BASE}/api/v1/events" + (f"?since={since}" if since else "")
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "text/event-stream")
    with urllib.request.urlopen(req, timeout=None) as resp:
        payload = None
        for raw in resp:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line.startswith("data:"):
                payload = line[5:].strip()
            elif line.startswith("id:"):
                since = line[3:].strip()
            elif line == "":
                # Frame boundary. Keep-alives arrive as an empty payload every
                # 15s — parsing them is the classic first-implementation crash.
                if payload:
                    handle(json.loads(payload))
                payload = None
    return since


def main():
    since, dropped_at = None, None
    while True:
        try:
            if dropped_at and time.time() - dropped_at > BUFFER_WINDOW_SECONDS:
                print("[gap] outside the replay window — resyncing from snapshot", flush=True)
                since = None
            since = stream(since)
        except urllib.error.HTTPError as err:
            print(f"[http {err.code}] {err.reason}", flush=True)
            if err.code in (401, 403):
                raise
        except Exception as err:  # noqa: BLE001 — a client should outlive its errors
            print(f"[dropped] {type(err).__name__}: {err}", flush=True)
        dropped_at = time.time()
        time.sleep(2)


if __name__ == "__main__":
    main()
