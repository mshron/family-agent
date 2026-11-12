#!/usr/bin/env python3
"""Gmail IMAP/SMTP sidecar proxy.

Exposes a Gmail REST API-compatible HTTP interface backed by IMAP/SMTP.
Runs on 127.0.0.1:8081 inside the credential-proxy container.
Caddy routes /gmail/* here via handle_path + reverse_proxy.

Only stdlib modules -- no pip dependencies required.
"""

from __future__ import annotations

import base64
import email
import email.utils
import imaplib
import json
import os
import re
import smtplib
import sys
import time
from email.message import Message
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")

IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587

BIND_HOST = os.environ.get("BIND_HOST", "127.0.0.1")
BIND_PORT = 8081

# Gmail label -> IMAP folder mapping
LABEL_TO_FOLDER: dict[str, str] = {
    "INBOX": "INBOX",
    "SENT": "[Gmail]/Sent Mail",
    "DRAFT": "[Gmail]/Drafts",
    "TRASH": "[Gmail]/Trash",
    "SPAM": "[Gmail]/Spam",
    "STARRED": "[Gmail]/Starred",
    "IMPORTANT": "[Gmail]/Important",
}

LOG_PREFIX = "[gmail-imap-proxy]"


def log(msg: str) -> None:
    print(f"{LOG_PREFIX} {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# IMAP connection management
# ---------------------------------------------------------------------------

_imap_conn: imaplib.IMAP4_SSL | None = None


def _get_imap() -> imaplib.IMAP4_SSL:
    """Return (and cache) a live IMAP connection, reconnecting if needed."""
    global _imap_conn
    if _imap_conn is not None:
        try:
            _imap_conn.noop()
            return _imap_conn
        except Exception:
            log("IMAP connection stale, reconnecting")
            try:
                _imap_conn.logout()
            except Exception:
                pass
            _imap_conn = None

    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    conn.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
    _imap_conn = conn
    log("IMAP connected")
    return conn


def _imap_select(folder: str) -> imaplib.IMAP4_SSL:
    """Get IMAP connection with the given folder selected."""
    conn = _get_imap()
    typ, data = conn.select(f'"{folder}"', readonly=True)
    if typ != "OK":
        raise RuntimeError(f"IMAP SELECT failed: {data}")
    return conn


# ---------------------------------------------------------------------------
# Query parsing helpers
# ---------------------------------------------------------------------------

_DATE_RE = re.compile(r"(\d{4})/(\d{2})/(\d{2})")

# Month abbreviations for IMAP date format
_MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


def _parse_q(q: str) -> tuple[str | None, str | None]:
    """Parse after: and before: from a Gmail-style q string.

    Returns (since_imap_date, before_imap_date) in IMAP date format
    e.g. '01-Mar-2024'.
    """
    after_date = None
    before_date = None
    for token in q.split():
        if token.startswith("after:"):
            m = _DATE_RE.search(token)
            if m:
                y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
                after_date = f"{d:02d}-{_MONTHS[mo - 1]}-{y}"
        elif token.startswith("before:"):
            m = _DATE_RE.search(token)
            if m:
                y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
                before_date = f"{d:02d}-{_MONTHS[mo - 1]}-{y}"
    return after_date, before_date


# ---------------------------------------------------------------------------
# Message formatting helpers
# ---------------------------------------------------------------------------


def _b64url_encode(data: bytes) -> str:
    """Base64url encode without padding (Gmail API style)."""
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _epoch_ms(msg: Message) -> str:
    """Extract epoch milliseconds from a parsed email message."""
    date_str = msg.get("Date", "")
    if date_str:
        parsed = email.utils.parsedate_to_datetime(date_str)
        return str(int(parsed.timestamp() * 1000))
    return "0"


def _build_payload(msg: Message, format_type: str, metadata_headers: list[str] | None = None) -> dict:
    """Build a Gmail API-compatible payload dict from an email.message.Message."""
    headers = []
    if format_type == "metadata" and metadata_headers:
        for name in metadata_headers:
            value = msg.get(name, "")
            if value:
                headers.append({"name": name, "value": value})
    elif format_type == "full":
        for name, value in msg.items():
            headers.append({"name": name, "value": value})

    mime_type = msg.get_content_type()

    # For metadata format, return only headers — skip body and parts
    if format_type == "metadata":
        return {
            "mimeType": mime_type,
            "headers": headers,
            "body": {"size": 0},
        }

    if msg.is_multipart():
        parts = []
        for part in msg.get_payload():
            if isinstance(part, Message):
                parts.append(_build_part(part))
        return {
            "mimeType": mime_type,
            "headers": headers,
            "body": {"size": 0},
            "parts": parts,
        }
    else:
        body_bytes = msg.get_payload(decode=True) or b""
        return {
            "mimeType": mime_type,
            "headers": headers,
            "body": {"data": _b64url_encode(body_bytes), "size": len(body_bytes)},
        }


def _build_part(part: Message) -> dict:
    """Recursively build a Gmail API-compatible part dict."""
    mime_type = part.get_content_type()
    headers = [{"name": n, "value": v} for n, v in part.items()]

    if part.is_multipart():
        sub_parts = []
        for sub in part.get_payload():
            if isinstance(sub, Message):
                sub_parts.append(_build_part(sub))
        return {
            "mimeType": mime_type,
            "headers": headers,
            "body": {"size": 0},
            "parts": sub_parts,
        }
    else:
        body_bytes = part.get_payload(decode=True) or b""
        return {
            "mimeType": mime_type,
            "headers": headers,
            "body": {"data": _b64url_encode(body_bytes), "size": len(body_bytes)},
        }


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------

# Pattern: /gmail/v1/users/me/messages/send
_SEND_RE = re.compile(r"^/gmail/v1/users/me/messages/send$")
# Pattern: /gmail/v1/users/me/messages/<id>
_MSG_RE = re.compile(r"^/gmail/v1/users/me/messages/([^/?]+)$")
# Pattern: /gmail/v1/users/me/messages
_LIST_RE = re.compile(r"^/gmail/v1/users/me/messages$")


def handle_list(qs: dict[str, list[str]]) -> tuple[int, dict]:
    """GET /gmail/v1/users/me/messages — list/search messages."""
    q = qs.get("q", [""])[0]
    label_ids = qs.get("labelIds", ["INBOX"])
    max_results = int(qs.get("maxResults", ["100"])[0])

    folder = LABEL_TO_FOLDER.get(label_ids[0], label_ids[0])
    since_date, before_date = _parse_q(q)

    try:
        conn = _imap_select(folder)
    except Exception as exc:
        log(f"IMAP error (list): {exc}")
        return 502, {"error": "imap_error", "detail": str(exc)}

    # Build IMAP search criteria
    criteria_parts: list[str] = []
    if since_date:
        criteria_parts.append(f'SINCE {since_date}')
    if before_date:
        criteria_parts.append(f'BEFORE {before_date}')

    criteria = " ".join(criteria_parts) if criteria_parts else "ALL"

    try:
        typ, data = conn.uid("SEARCH", None, criteria)
    except Exception as exc:
        log(f"IMAP SEARCH error: {exc}")
        return 502, {"error": "imap_error", "detail": str(exc)}

    if typ != "OK":
        return 502, {"error": "imap_search_failed", "detail": str(data)}

    uids = data[0].split() if data[0] else []
    # Limit results
    uids = uids[:max_results]

    messages = [{"id": uid.decode(), "threadId": uid.decode()} for uid in uids]
    return 200, {"messages": messages, "resultSizeEstimate": len(messages)}


def handle_get(msg_id: str, qs: dict[str, list[str]]) -> tuple[int, dict]:
    """GET /gmail/v1/users/me/messages/<id> — get a single message."""
    format_type = qs.get("format", ["full"])[0]
    metadata_headers = qs.get("metadataHeaders", [])

    try:
        conn = _imap_select("INBOX")
    except Exception as exc:
        log(f"IMAP error (get): {exc}")
        return 502, {"error": "imap_error", "detail": str(exc)}

    try:
        typ, data = conn.uid("FETCH", msg_id, "(RFC822)")
    except Exception as exc:
        log(f"IMAP FETCH error: {exc}")
        return 502, {"error": "imap_error", "detail": str(exc)}

    if typ != "OK" or not data or data[0] is None:
        return 404, {"error": "not_found", "detail": f"Message {msg_id} not found"}

    raw_email = data[0][1]
    msg = email.message_from_bytes(raw_email)

    payload = _build_payload(msg, format_type, metadata_headers or None)
    internal_date = _epoch_ms(msg)

    return 200, {
        "id": msg_id,
        "internalDate": internal_date,
        "payload": payload,
    }


def handle_send(body: bytes) -> tuple[int, dict]:
    """POST /gmail/v1/users/me/messages/send — send a message."""
    try:
        req_data = json.loads(body)
    except json.JSONDecodeError as exc:
        return 400, {"error": "bad_request", "detail": str(exc)}

    raw_b64 = req_data.get("raw", "")
    if not raw_b64:
        return 400, {"error": "bad_request", "detail": "Missing 'raw' field"}

    # base64url decode (add padding if needed)
    padded = raw_b64 + "=" * (-len(raw_b64) % 4)
    try:
        raw_bytes = base64.urlsafe_b64decode(padded)
    except Exception as exc:
        return 400, {"error": "bad_request", "detail": f"Invalid base64url: {exc}"}

    msg = email.message_from_bytes(raw_bytes)
    to_addrs = msg.get_all("To", [])
    # Flatten any comma-separated addresses
    recipients: list[str] = []
    for addr in to_addrs:
        for part in addr.split(","):
            part = part.strip()
            if part:
                recipients.append(part)

    if not recipients:
        return 400, {"error": "bad_request", "detail": "No recipients in message"}

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as smtp:
            smtp.starttls()
            smtp.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
            smtp.sendmail(GMAIL_ADDRESS, recipients, raw_bytes)
    except smtplib.SMTPAuthenticationError as exc:
        log(f"SMTP auth failed: {exc}")
        return 502, {"error": "auth_failed", "detail": str(exc)}
    except Exception as exc:
        log(f"SMTP error: {exc}")
        return 502, {"error": "smtp_error", "detail": str(exc)}

    return 200, {"id": "sent", "labelIds": ["SENT"]}


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------


class GmailProxyHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the Gmail IMAP proxy."""

    def _send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if _LIST_RE.match(path):
            status, data = handle_list(qs)
            self._send_json(status, data)
        elif m := _MSG_RE.match(path):
            msg_id = m.group(1)
            status, data = handle_get(msg_id, qs)
            self._send_json(status, data)
        else:
            self._send_json(404, {"error": "not_found", "detail": f"Unknown path: {path}"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        if _SEND_RE.match(path):
            status, data = handle_send(body)
            self._send_json(status, data)
        else:
            self._send_json(404, {"error": "not_found", "detail": f"Unknown path: {path}"})

    def log_message(self, format: str, *args: object) -> None:
        """Send access logs to stderr with our prefix."""
        log(format % args)


def main() -> None:
    if not GMAIL_ADDRESS or not GMAIL_APP_PASSWORD:
        log("GMAIL_ADDRESS and GMAIL_APP_PASSWORD must be set")
        sys.exit(1)

    server = HTTPServer((BIND_HOST, BIND_PORT), GmailProxyHandler)
    log(f"Listening on {BIND_HOST}:{BIND_PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Shutting down")
    finally:
        server.server_close()
        if _imap_conn:
            try:
                _imap_conn.logout()
            except Exception:
                pass


if __name__ == "__main__":
    main()
