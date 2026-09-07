#!/usr/bin/env python3
"""
HeyReach Dashboard local server.
Serves heyreach-dashboard.html and proxies /heyreach-api/* → HeyReach API (avoids CORS).

Usage:
    python3 ~/heyreach-server.py
Then open: http://localhost:8765
"""
import json, urllib.request, urllib.error
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os

PORT = 8765
HR_BASES = [
    "https://api.heyreach.io/api/public",
]
SERVE_DIR = Path(__file__).resolve().parent  # serve the repo, not the home directory

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SERVE_DIR), **kwargs)

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path.startswith("/heyreach-api/"):
            self._proxy("POST")
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path.startswith("/heyreach-api/"):
            self._proxy("GET")
        else:
            super().do_GET()

    def _proxy(self, method):
        # Strip /heyreach-api prefix, forward to HeyReach (preserves query string)
        sub = self.path[len("/heyreach-api"):]  # e.g. /campaign/GetAll?offset=0&limit=100

        api_key = self.headers.get("X-API-KEY", "")
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len) if content_len else None

        last_code, last_body = 502, b'{"error":"no base tried"}'
        for base in HR_BASES:
            url = base + sub
            print(f"  → {method} {url}")
            req = urllib.request.Request(url, data=body, method=method)
            if api_key:
                req.add_header("X-API-KEY", api_key)
            if body:
                req.add_header("Content-Type", "application/json")

            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = resp.read()
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)
                return
            except urllib.error.HTTPError as e:
                last_code = e.code
                last_body = e.read()
                if e.code == 404:
                    print(f"    404, trying next base…")
                    continue  # try next base URL
                # Non-404 error (401, 400, 500…): return immediately, no fallback
                self.send_response(e.code)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(last_body)
                return
            except Exception as e:
                last_code, last_body = 502, json.dumps({"error": str(e)}).encode()
                break

        # All bases returned 404 (or error)
        self.send_response(last_code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(last_body)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-KEY")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} {fmt % args}")

if __name__ == "__main__":
    os.chdir(SERVE_DIR)
    print(f"HeyReach Dashboard running at http://localhost:{PORT}")
    print(f"Open: http://localhost:{PORT}/heyreach-dashboard.html")
    print("Press Ctrl+C to stop.\n")
    HTTPServer(("", PORT), Handler).serve_forever()
