"""HTTP wrapper around the scoring engine.

Deliberately stdlib-only: this service is pure computation, so it should be
trivially deployable as a container or a lambda-shaped function. The API in
``services/api`` owns storage and consent; this service owns arithmetic.

Endpoints
    GET  /healthz
    GET  /version
    POST /score   {"a": {...}, "b": {...}}
    POST /match   {"subject": {...}, "candidates": [...], "limit": 10}
"""

from __future__ import annotations

import json
import logging
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import scoring, vocab

MAX_BODY_BYTES = 4 * 1024 * 1024

log = logging.getLogger("tandem.matcher")


class Handler(BaseHTTPRequestHandler):
    server_version = f"tandem-matcher/{scoring.ENGINE_VERSION}"
    protocol_version = "HTTP/1.1"

    # -- plumbing -----------------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:  # quieter default
        log.debug("%s - %s", self.address_string(), fmt % args)

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> tuple[dict[str, Any] | None, str | None]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None, "Content-Length must be an integer"
        if length <= 0:
            return None, "request body required"
        if length > MAX_BODY_BYTES:
            return None, "request body too large"
        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            return None, f"invalid JSON: {exc.msg}"
        if not isinstance(parsed, dict):
            return None, "body must be a JSON object"
        return parsed, None

    # -- routes -------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/healthz", "/health"):
            self._send(200, {"ok": True, "service": "tandem-matcher",
                             "engine_version": scoring.ENGINE_VERSION})
        elif path == "/version":
            self._send(200, {
                "engine_version": scoring.ENGINE_VERSION,
                "vocab_version": vocab.VOCAB_VERSION,
                "weights": scoring.WEIGHTS,
                "looking_for": list(vocab.LOOKING_FOR),
                "offers": list(vocab.OFFERS),
                "display_floor": scoring.DISPLAY_FLOOR,
            })
        else:
            self._send(404, {"error": "not_found", "path": path})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        body, error = self._read_json()
        if error:
            self._send(400, {"error": "bad_request", "detail": error})
            return

        assert body is not None
        try:
            if path == "/score":
                a, b = body.get("a"), body.get("b")
                if not isinstance(a, dict) or not isinstance(b, dict):
                    self._send(400, {"error": "bad_request",
                                     "detail": "a and b must be objects"})
                    return
                left = scoring.Profile.from_json(a)
                right = scoring.Profile.from_json(b)
                self._send(200, scoring.score_pair(left, right).to_json())

            elif path == "/match":
                subject = body.get("subject")
                candidates = body.get("candidates") or []
                if not isinstance(subject, dict):
                    self._send(400, {"error": "bad_request",
                                     "detail": "subject must be an object"})
                    return
                if not isinstance(candidates, list):
                    self._send(400, {"error": "bad_request",
                                     "detail": "candidates must be an array"})
                    return
                try:
                    limit = int(body.get("limit", 10))
                except (TypeError, ValueError):
                    limit = 10
                result = scoring.match(
                    subject,
                    [c for c in candidates if isinstance(c, dict)],
                    limit=limit,
                    include_unlisted=bool(body.get("include_unlisted")),
                )
                self._send(200, result)
            else:
                self._send(404, {"error": "not_found", "path": path})
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("matcher failure")
            self._send(500, {"error": "internal", "detail": str(exc)})


def build_server(host: str | None = None, port: int | None = None) -> ThreadingHTTPServer:
    host = host or os.environ.get("MATCHER_HOST", "127.0.0.1")
    port = int(port if port is not None else os.environ.get("MATCHER_PORT", "8081"))
    return ThreadingHTTPServer((host, port), Handler)


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("MATCHER_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )
    server = build_server()
    host, port = server.server_address[:2]
    log.info("tandem matcher %s listening on http://%s:%s", scoring.ENGINE_VERSION, host, port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
