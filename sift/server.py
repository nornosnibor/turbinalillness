"""
Sift - local server for the photo organizer.

What this file does (think of it as a mail room):
  1. It hands your browser the app's files (index.html, styles.css, js/...).
  2. It forwards "please analyze this photo" requests from the browser to
     Jev (TypeSafe's API) and passes the answers back.

Why is step 2 needed? Jev's API refuses requests that come straight from a
web page (a browser safety rule called CORS). A tiny server on your own
machine is allowed to talk to it, and it also keeps your API key off the page.

Only Python's standard library is used, so there is nothing to pip install.

Run it:
    python3 server.py              # then open http://localhost:8765
    python3 server.py --demo       # fake answers, no API key needed
    python3 server.py --port 9000  # pick another port
    python3 server.py --host 0.0.0.0   # reach it from other devices on your network

Your API key (pick one):
    - set an environment variable:  export TYPESAFE_API_KEY="your-key"
    - or put a line in a file named .env next to this file:  TYPESAFE_API_KEY=your-key
    - or paste it in the app's Settings (it's then stored in your browser only)
"""

import argparse
import hashlib
import json
import os
import random
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

JEV_URL = "https://api.typesafe.ai/v1/systemone"
APP_DIR = Path(__file__).resolve().parent
MAX_BODY = 32 * 1024 * 1024  # Jev's own limit is 32 MiB per request


def load_server_key():
    """Look for the API key in the environment, then in a .env file."""
    for name in ("TYPESAFE_API_KEY", "JEV_API_KEY"):
        if os.environ.get(name):
            return os.environ[name].strip()

    env_file = APP_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                name, value = line.split("=", 1)
                if name.strip() in ("TYPESAFE_API_KEY", "JEV_API_KEY"):
                    return value.strip().strip('"').strip("'")
    return None


def fake_answers(request):
    """Demo mode: invent believable answers so the app can be tried without a key.

    The "random" numbers are seeded from the request itself, so analyzing the
    same photo twice gives the same answers.
    """
    seed = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    rng = random.Random(seed)
    answers = {}

    for qid, question in request.get("questions", {}).items():
        kind = question.get("type")
        criteria = question.get("criteria")

        if kind == "noul":
            # Most tags are "no", a few are a confident "yes".
            value = rng.random() ** 2.2 if rng.random() < 0.75 else 0.6 + rng.random() * 0.4
            answers[qid] = {"type": "noul", "noul": round(value, 4)}

        elif kind == "choice":
            options = list(criteria.keys())
            weights = [rng.random() ** 3 for _ in options]
            total = sum(weights)
            probs = {opt: round(w / total, 4) for opt, w in zip(options, weights)}
            best = max(probs, key=probs.get)
            answers[qid] = {
                "type": "choice",
                "choice": best,
                "confidence": round(probs[best], 3),
                "probabilities": probs,
            }

        elif kind == "score":
            levels = len(criteria)
            weights = [rng.random() ** 2 for _ in range(levels)]
            total = sum(weights)
            probs = {str(i): round(w / total, 4) for i, w in enumerate(weights)}
            score = sum(i * p for i, p in enumerate(probs.values()))
            answers[qid] = {
                "type": "score",
                "score": round(score, 3),
                "confidence": round(max(probs.values()), 3),
                "legend": {str(i): text for i, text in enumerate(criteria)},
                "probabilities": probs,
            }

    return {
        "model": "demo",
        "answers": answers,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }


class SiftHandler(SimpleHTTPRequestHandler):
    """Handles every browser request. Files come from APP_DIR."""

    demo = False
    server_key = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    # Don't let the browser cache JS/CSS while you're editing them.
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/status":
            return self.send_json(200, {
                "ok": True,
                "demo": self.demo,
                "serverKey": bool(self.server_key),
            })
        return super().do_GET()

    def send_head(self):
        # Never serve hidden files like .env (it holds your key) or this script.
        name = Path(self.translate_path(self.path)).name
        if name.startswith(".") or name == "server.py":
            self.send_error(404)
            return None
        return super().send_head()

    def do_POST(self):
        if self.path != "/api/jev":
            return self.send_json(404, {"error": "Not found"})

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self.send_json(413, {"error": "Request is empty or larger than 32 MiB."})
        raw = self.rfile.read(length)

        if self.demo:
            try:
                return self.send_json(200, fake_answers(json.loads(raw)))
            except ValueError:
                return self.send_json(400, {"error": "Body is not valid JSON."})

        key = self.server_key or self.headers.get("X-Jev-Key", "").strip()
        if not key:
            return self.send_json(401, {
                "error": "No API key. Add it in Settings, or set TYPESAFE_API_KEY before starting the server.",
            })

        upstream = urllib.request.Request(
            JEV_URL,
            data=raw,
            method="POST",
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "TypeSafe-Danger-Zone-Images": "true",  # images are opt-in on Jev
            },
        )
        try:
            with urllib.request.urlopen(upstream, timeout=120) as reply:
                body = reply.read()
                status = reply.status
        except urllib.error.HTTPError as err:
            # Jev answered with an error (bad key, too big, rate limit...).
            body = err.read()
            status = err.code
        except (urllib.error.URLError, TimeoutError) as err:
            return self.send_json(502, {"error": f"Could not reach Jev: {err}"})

        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Only log API calls, not every image/CSS file.
        if args and "/api/" in str(args[0]):
            super().log_message(fmt, *args)


def main():
    parser = argparse.ArgumentParser(description="Sift photo organizer server")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--demo", action="store_true", help="fake answers, no API key needed")
    args = parser.parse_args()

    SiftHandler.demo = args.demo
    SiftHandler.server_key = load_server_key()

    if args.demo:
        mode = "DEMO mode (answers are made up)"
    elif SiftHandler.server_key:
        mode = "using the API key from your environment/.env"
    else:
        mode = "no server key found - paste your key in the app's Settings"

    print(f"Sift is running at http://{'localhost' if args.host == '127.0.0.1' else args.host}:{args.port}")
    print(f"  {mode}")
    print("  Press Ctrl+C to stop.")
    try:
        ThreadingHTTPServer((args.host, args.port), SiftHandler).serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
