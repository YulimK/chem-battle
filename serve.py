#!/usr/bin/env python3
"""
Chem Battle dev server.

Same as `python3 -m http.server`, but sends no-cache headers so the browser
always fetches the current files. Use this instead of the plain http.server
while editing, and you will never have to hard-refresh again.

    python3 serve.py            # http://localhost:8000
    python3 serve.py 8001       # different port
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # Serve a fresh copy even when the browser asks "has this changed?"
    def send_response(self, code, message=None):
        if code == 304:
            code = 200
        super().send_response(code, message)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Chem Battle → http://localhost:{port}   (캐시 비활성화, Ctrl+C 로 종료)")
    try:
        ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료했습니다.")
