"""Dev server: serves the project and injects dev/mock-chrome.js into the
extension's HTML pages so they run in a normal tab.

  python3 dev/serve.py 8765
  http://localhost:8765/extension/popup/popup.html?seed
  http://localhost:8765/extension/options/options.html
  http://localhost:8765/dev/fixture-2fa.html
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INJECT = '<head>\n  <script src="/dev/mock-chrome.js"></script>'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        file = os.path.normpath(os.path.join(ROOT, path.lstrip('/')))
        if path.startswith('/extension/') and path.endswith('.html') and os.path.isfile(file):
            with open(file, encoding='utf-8') as f:
                body = f.read().replace('<head>', INJECT, 1).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'Serving {ROOT} on http://localhost:{port}')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
