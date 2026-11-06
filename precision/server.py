"""Loopback-only service. Each native operation runs in a disposable process."""
import json
import re
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
JOBS = {}
LOCK = threading.Lock()


def allowed_origin(origin):
    u = urlsplit(origin)
    return (u.scheme in ('http', 'https') and u.hostname in ('127.0.0.1', 'localhost')) or origin == 'https://nmoubarak2023-sys.github.io'


class Handler(BaseHTTPRequestHandler):
    def authorized(self):
        return self.headers.get('Host') in ('127.0.0.1:8789', 'localhost:8789') and allowed_origin(self.headers.get('Origin', ''))

    def respond(self, code, data):
        payload = json.dumps(data).encode()
        self.send_response(code)
        origin = self.headers.get('Origin', '')
        if allowed_origin(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        if not self.authorized():
            return self.respond(403, {'error': 'Origin denied'})
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()

    def do_GET(self):
        if not self.authorized():
            return self.respond(403, {'error': 'Origin denied'})
        self.respond(200 if self.path == '/health' else 404, {'engine': 'Balloon precision', 'version': 1})

    def do_DELETE(self):
        if not self.authorized():
            return self.respond(403, {'error': 'Origin denied'})
        job = self.path.removeprefix('/jobs/')
        with LOCK:
            child = JOBS.get(job)
            if child:
                child.terminate()
        self.respond(200, {'canceled': bool(child)})

    def do_POST(self):
        if not self.authorized() or self.path != '/boolean':
            return self.respond(403, {'error': 'Request denied'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 80000000:
                return self.respond(413, {'error': 'Input exceeds 80 MB'})
            data = json.loads(self.rfile.read(length))
            job = data['jobId']
            if not re.fullmatch(r'[a-zA-Z0-9-]{1,64}', job):
                raise ValueError('Invalid job ID')
            folder = ROOT / '.precision-jobs'
            folder.mkdir(exist_ok=True)
            with tempfile.TemporaryDirectory(dir=folder) as temp:
                source, target = Path(temp)/'input.json', Path(temp)/'result.json'
                source.write_text(json.dumps(data), encoding='utf-8')
                with LOCK:
                    if JOBS:
                        return self.respond(409, {'error': 'Precision engine is busy'})
                    child = subprocess.Popen([sys.executable, str(ROOT/'precision'/'engine.py'), str(source), str(target)],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    JOBS[job] = child
                try:
                    stdout, stderr = child.communicate(timeout=300)
                    if child.returncode or not target.exists():
                        raise ValueError('Native calculation failed: '+stderr.decode(errors='replace')[-1000:])
                    result = json.loads(target.read_text(encoding='utf-8'))
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate()
                    raise ValueError('Precision calculation exceeded five minutes')
                finally:
                    with LOCK:
                        JOBS.pop(job, None)
                self.respond(200, result)
        except (ValueError, KeyError, OSError) as error:
            self.respond(422, {'error': str(error)})


if __name__ == '__main__':
    print('Balloon precision engine: http://127.0.0.1:8789\nKeep this window open while using Precision output.', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8789), Handler).serve_forever()
