#!/usr/bin/env python3
"""
generate_review.py — Serve an interactive eval review for ct-grade.

Reads eval run outputs from a workspace directory, embeds all data into
the viewer.html template, and serves it at localhost:3118.

Usage:
    # Serve (live-reloading on refresh):
    python eval-viewer/generate_review.py <workspace-path> [--port 3118]

    # Write static HTML file instead:
    python eval-viewer/generate_review.py <workspace-path> --static output.html

    # Include benchmark data:
    python eval-viewer/generate_review.py <workspace-path> --benchmark benchmark.json

No external dependencies — stdlib only.
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import webbrowser
from functools import partial
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path


TEXT_EXTENSIONS = {
    ".txt", ".md", ".json", ".jsonl", ".csv", ".py", ".ts", ".js",
    ".yaml", ".yml", ".sh", ".html", ".css",
}

METADATA_FILES = {"transcript.md", "user_notes.md", "metrics.json"}


def find_runs(workspace: Path) -> list[dict]:
    """Find eval run dirs — directories with an outputs/ subdir."""
    runs = []
    _find_recursive(workspace, workspace, runs)
    runs.sort(key=lambda r: (r.get("eval_id") or float("inf"), r["id"]))
    return runs


def _find_recursive(root: Path, current: Path, runs: list) -> None:
    if not current.is_dir():
        return
    skip = {"node_modules", ".git", "__pycache__", "eval-viewer", "assets", "scripts"}
    outputs_dir = current / "outputs"
    if outputs_dir.is_dir():
        run = _build_run(root, current)
        if run:
            runs.append(run)
        return
    for child in sorted(current.iterdir()):
        if child.is_dir() and child.name not in skip:
            _find_recursive(root, child, runs)


def _build_run(root: Path, run_dir: Path) -> dict | None:
    prompt = ""
    eval_id = None

    for candidate in [run_dir / "eval_metadata.json", run_dir.parent / "eval_metadata.json"]:
        if candidate.exists():
            try:
                meta = json.loads(candidate.read_text())
                prompt = meta.get("prompt", "")
                eval_id = meta.get("eval_id")
            except Exception:
                pass
            if prompt:
                break

    if not prompt:
        for candidate in [run_dir / "transcript.md", run_dir / "outputs" / "transcript.md"]:
            if candidate.exists():
                try:
                    text = candidate.read_text()
                    m = re.search(r"## Eval Prompt\n\n([\s\S]*?)(?=\n##|$)", text)
                    if m:
                        prompt = m.group(1).strip()
                except Exception:
                    pass
                if prompt:
                    break

    prompt = prompt or "(No prompt found)"
    run_id = str(run_dir.relative_to(root)).replace("/", "-").replace("\\", "-")

    outputs_dir = run_dir / "outputs"
    output_files = []
    if outputs_dir.is_dir():
        for f in sorted(outputs_dir.iterdir()):
            if f.is_file() and f.name not in METADATA_FILES:
                output_files.append(_embed_file(f))

    grading = None
    for candidate in [run_dir / "grading.json", run_dir.parent / "grading.json"]:
        if candidate.exists():
            try:
                grading = json.loads(candidate.read_text())
            except Exception:
                pass
            if grading:
                break

    return {
        "id": run_id,
        "prompt": prompt,
        "eval_id": eval_id,
        "outputs": output_files,
        "grading": grading,
    }


def _embed_file(path: Path) -> dict:
    ext = path.suffix.lower()
    if ext in TEXT_EXTENSIONS:
        try:
            content = path.read_text(errors="replace")
        except OSError:
            content = "(Error reading file)"
        return {"name": path.name, "type": "text", "content": content}
    else:
        import base64
        try:
            raw = path.read_bytes()
            b64 = base64.b64encode(raw).decode("ascii")
        except OSError:
            return {"name": path.name, "type": "error", "content": "(Error reading file)"}
        return {"name": path.name, "type": "binary", "data_b64": b64}


def _generate_html(runs: list[dict], skill_name: str, benchmark: dict | None = None) -> str:
    template_path = Path(__file__).parent / "viewer.html"
    template = template_path.read_text()
    embedded = {"skill_name": skill_name, "runs": runs, "previous_feedback": {}, "previous_outputs": {}}
    if benchmark:
        embedded["benchmark"] = benchmark
    data_json = json.dumps(embedded)
    return template.replace("/*__EMBEDDED_DATA__*/", f"const EMBEDDED_DATA = {data_json};")


def _kill_port(port: int) -> None:
    try:
        result = subprocess.run(["lsof", "-ti", f":{port}"], capture_output=True, text=True, timeout=5)
        for pid_str in result.stdout.strip().split("\n"):
            if pid_str.strip():
                try:
                    os.kill(int(pid_str.strip()), signal.SIGTERM)
                except (ProcessLookupError, ValueError):
                    pass
        if result.stdout.strip():
            time.sleep(0.5)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass


class Handler(BaseHTTPRequestHandler):
    def __init__(self, workspace, skill_name, feedback_path, benchmark_path, *args, **kwargs):
        self.workspace = workspace
        self.skill_name = skill_name
        self.feedback_path = feedback_path
        self.benchmark_path = benchmark_path
        super().__init__(*args, **kwargs)

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            runs = find_runs(self.workspace)
            benchmark = None
            if self.benchmark_path and self.benchmark_path.exists():
                try:
                    benchmark = json.loads(self.benchmark_path.read_text())
                except Exception:
                    pass
            html = _generate_html(runs, self.skill_name, benchmark)
            content = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        elif self.path == "/api/feedback":
            data = self.feedback_path.read_bytes() if self.feedback_path.exists() else b"{}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_error(404)

    def do_POST(self) -> None:
        if self.path == "/api/feedback":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                self.feedback_path.write_text(json.dumps(data, indent=2) + "\n")
                resp = b'{"ok":true}'
                self.send_response(200)
            except Exception as e:
                resp = json.dumps({"error": str(e)}).encode()
                self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(resp)))
            self.end_headers()
            self.wfile.write(resp)
        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="ct-grade eval review viewer")
    parser.add_argument("workspace", type=Path, help="Workspace directory with eval runs")
    parser.add_argument("--port", "-p", type=int, default=3118)
    parser.add_argument("--skill-name", "-n", default="ct-grade")
    parser.add_argument("--benchmark", type=Path, default=None)
    parser.add_argument("--static", "-s", type=Path, default=None, help="Write static HTML, don't serve")
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    if not workspace.is_dir():
        print(f"Error: {workspace} is not a directory", file=sys.stderr)
        sys.exit(1)

    runs = find_runs(workspace)
    if not runs:
        print(f"No eval runs found in {workspace}", file=sys.stderr)
        print("Runs need an outputs/ subdirectory with result files.", file=sys.stderr)
        sys.exit(1)

    benchmark = None
    if args.benchmark and args.benchmark.exists():
        try:
            benchmark = json.loads(args.benchmark.read_text())
        except Exception:
            pass

    if args.static:
        html = _generate_html(runs, args.skill_name, benchmark)
        args.static.parent.mkdir(parents=True, exist_ok=True)
        args.static.write_text(html)
        print(f"\n  Static viewer: {args.static}\n")
        sys.exit(0)

    port = args.port
    _kill_port(port)
    feedback_path = workspace / "feedback.json"
    handler = partial(Handler, workspace, args.skill_name, feedback_path, args.benchmark)
    try:
        server = HTTPServer(("127.0.0.1", port), handler)
    except OSError:
        server = HTTPServer(("127.0.0.1", 0), handler)
        port = server.server_address[1]

    url = f"http://localhost:{port}"
    print(f"\n  ct-grade Eval Viewer")
    print(f"  ───────────────────────────")
    print(f"  URL:       {url}")
    print(f"  Workspace: {workspace}")
    print(f"  Runs:      {len(runs)} found")
    print(f"\n  Press Ctrl+C to stop.\n")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
