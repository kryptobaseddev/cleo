#!/usr/bin/env python3
"""
Generate and serve the CLEO Grade Review viewer.

Reads grade results from multiple sources, embeds them into viewer.html,
and serves the page via a tiny stdlib HTTP server.

Sources (auto-discovered under --workspace):
  - .cleo/metrics/GRADES.jsonl          (historical grade results)
  - **/metrics.json                      (scenario run metrics from run_scenario.py)
  - **/summary.json with global_wins     (A/B test summaries from run_ab_test.py)
  - token_tracker output (domain/gateway breakdown)

Usage:
    python generate_grade_review.py <workspace-path> [options]

Options:
    --port PORT           HTTP port (default: 3118)
    --static PATH         Write standalone HTML to file instead of serving
    --grades-file PATH    Override GRADES.jsonl path
    --ab-dir PATH         Override A/B results directory
    --skill-name NAME     Override title in viewer header
    --no-browser          Don't auto-open browser

Examples:
    # Serve live viewer for current project
    python generate_grade_review.py /path/to/project

    # Export static HTML
    python generate_grade_review.py ./grade-results --static ./grade-report.html

    # Custom sources
    python generate_grade_review.py . --grades-file .cleo/metrics/GRADES.jsonl --ab-dir ./ab-results
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import webbrowser
from datetime import datetime, timezone
from functools import partial
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


# ---------------------------------------------------------------------------
# Data loaders
# ---------------------------------------------------------------------------

def load_grades_jsonl(path):
    """Load GRADES.jsonl. Returns list of grade result dicts."""
    p = Path(path)
    if not p.exists():
        return []
    results = []
    for line in p.read_text(errors='replace').splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            results.append(json.loads(line))
        except Exception:
            pass
    return results


def load_scenario_metrics(workspace):
    """
    Find all metrics.json files from run_scenario.py runs.
    Merges grade data into a list, tagging each with _scenarioId.
    """
    grades = []
    for mf in Path(workspace).rglob('metrics.json'):
        try:
            data = json.loads(mf.read_text())
        except Exception:
            continue
        if 'grade' not in data:
            continue
        g = data['grade']
        if not isinstance(g, dict):
            continue
        # Tag with scenario ID and token meta from run_scenario.py
        g['_scenarioId'] = data.get('scenario', '')
        if data.get('token_meta'):
            g['_tokenMeta'] = {
                'estimationMethod': data['token_meta'].get('estimation_method', 'output_chars'),
                'totalEstimatedTokens': data['token_meta'].get('total_estimated_tokens'),
            }
        if not g.get('timestamp'):
            g['timestamp'] = data.get('timestamp', '')
        grades.append(g)
    return grades


def load_ab_summary(workspace, ab_dir=None):
    """Load A/B test summary. Returns the most recent summary dict or empty."""
    search_roots = []
    if ab_dir:
        search_roots.append(Path(ab_dir))
    search_roots.append(Path(workspace))

    candidates = []
    for root in search_roots:
        if not root.exists():
            continue
        for sf in root.rglob('summary.json'):
            try:
                data = json.loads(sf.read_text())
                if 'global_wins' in data:
                    candidates.append((sf.stat().st_mtime, data))
            except Exception:
                pass

    if not candidates:
        return {}

    # Return the most recently modified
    candidates.sort(key=lambda x: x[0], reverse=True)
    data = candidates[0][1]

    # Normalize per_operation: list → dict keyed by operation name
    per_op = data.get("per_operation", [])
    if isinstance(per_op, list):
        data["per_operation"] = {s["operation"]: s for s in per_op if "operation" in s}

    return data


def load_token_analysis(workspace, grades_file=None):
    """
    Build token analysis data from available sources.
    Tries to read token_tracker output files, falls back to computing from grades.
    """
    analysis = {}

    # Priority 1: timing.json files (from agent-based runs via task notifications)
    timings = []
    for tf in Path(workspace).rglob("timing.json"):
        try:
            t = json.loads(tf.read_text())
            timings.append(t)
        except Exception:
            pass
    real_toks = [t["total_tokens"] for t in timings if t.get("total_tokens") is not None]
    if real_toks:
        by_iface = {}
        for t in timings:
            iface = t.get("interface", t.get("arm", "unknown"))
            tok = t.get("total_tokens")
            if tok is not None:
                if iface not in by_iface:
                    by_iface[iface] = []
                by_iface[iface].append(tok)
        analysis["method"] = "task_notifications"
        analysis["by_interface"] = {
            iface: {
                "samples": len(vals),
                "mean": round(sum(vals) / len(vals), 0),
                "min": min(vals),
                "max": max(vals),
            }
            for iface, vals in sorted(by_iface.items())
        }
        analysis["total_samples"] = len(real_toks)
        analysis["overall_mean"] = round(sum(real_toks) / len(real_toks), 0)

    # Look for existing token_tracker output files
    for tf in Path(workspace).rglob('domain-token-report.json'):
        try:
            data = json.loads(tf.read_text())
            if 'breakdown_by_domain' in data:
                analysis.update(data)
                return analysis
        except Exception:
            pass

    # Build domain breakdown from grade _tokenMeta fields
    domain_tokens = {}
    grades_path = grades_file or (Path(workspace) / '.cleo' / 'metrics' / 'GRADES.jsonl')
    all_grades = load_grades_jsonl(grades_path)
    for g in all_grades:
        meta = g.get('_tokenMeta', {})
        per_domain = meta.get('perDomain') or meta.get('per_domain') or {}
        for domain, tokens in per_domain.items():
            if tokens and isinstance(tokens, (int, float)):
                if domain not in domain_tokens:
                    domain_tokens[domain] = []
                domain_tokens[domain].append(tokens)

    if domain_tokens:
        analysis['breakdown_by_domain'] = {
            domain: {
                'samples': len(vals),
                'mean': round(sum(vals) / len(vals), 0),
                'min': min(vals),
                'max': max(vals),
            }
            for domain, vals in sorted(domain_tokens.items())
        }
    else:
        # Emit standard domain estimates as reference data
        analysis['breakdown_by_domain'] = {
            'tasks (find)':  {'samples': 0, 'mean': 750,  'note': 'typical estimate'},
            'tasks (list)':  {'samples': 0, 'mean': 3000, 'note': 'heavy — use find'},
            'session':       {'samples': 0, 'mean': 400,  'note': 'typical estimate'},
            'admin (dash)':  {'samples': 0, 'mean': 500,  'note': 'typical estimate'},
            'admin (help)':  {'samples': 0, 'mean': 800,  'note': 'typical estimate'},
            'memory (find)': {'samples': 0, 'mean': 600,  'note': 'typical estimate'},
        }

    # Gateway split
    analysis['breakdown_by_gateway'] = {
        'mcp_query': {'samples': 0, 'mean': 0},
        'cli':       {'samples': 0, 'mean': 0},
        'note': 'CLI-only sessions score 0 on S5 — metadata.gateway not set by CLI adapter',
    }

    # A/B aggregation from summary files
    ab = load_ab_summary(workspace)
    if ab and ab.get('per_operation'):
        per_op = {}
        for op_key, op_data in ab['per_operation'].items():
            mcp_chars = op_data.get('avg_mcp_chars', 0)
            cli_chars = op_data.get('avg_cli_chars', 0)
            per_op[op_key] = {
                'avg_mcp_estimated_tokens': round(mcp_chars / 4, 1),
                'avg_cli_estimated_tokens': round(cli_chars / 4, 1),
                'avg_delta': round((mcp_chars - cli_chars) / 4, 1),
            }
        analysis['ab_aggregation'] = {
            'summaries_found': 1,
            'avg_token_delta_mcp_minus_cli': ab.get('avg_token_delta_mcp_minus_cli'),
            'interpretation': 'MCP vs CLI delta from A/B test',
            'per_operation': per_op,
        }

    return analysis


def build_embedded_data(workspace, grades_file=None, ab_dir=None, skill_name=None):
    """Build the full EMBEDDED_GRADE_DATA dict for the viewer."""
    workspace = Path(workspace).resolve()

    # 1. Load grades from GRADES.jsonl
    gf = grades_file or (workspace / '.cleo' / 'metrics' / 'GRADES.jsonl')
    historical_grades = load_grades_jsonl(gf)

    # 2. Load grades from scenario run metrics.json files
    scenario_grades = load_scenario_metrics(workspace)

    # Merge: prefer scenario grades (richer data); deduplicate by sessionId
    all_grades_map = {}
    for g in historical_grades:
        sid = g.get('sessionId', '')
        if sid and sid not in all_grades_map:
            all_grades_map[sid] = g
    for g in scenario_grades:
        sid = g.get('sessionId', '')
        if sid:
            all_grades_map[sid] = g  # scenario data wins (has more metadata)
        else:
            all_grades_map[f'__noid_{len(all_grades_map)}'] = g

    all_grades = sorted(all_grades_map.values(),
                        key=lambda g: g.get('timestamp', ''), reverse=True)

    # 3. A/B results
    ab_results = load_ab_summary(workspace, ab_dir)

    # 4. Token analysis
    token_analysis = load_token_analysis(workspace, grades_file=str(gf))

    return {
        'title': (skill_name or 'ct-grade') + ' \u2014 Grade Review',
        'subtitle': str(workspace.name),
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'grades': all_grades,
        'ab_results': ab_results,
        'token_analysis': token_analysis,
    }


# ---------------------------------------------------------------------------
# HTML generator
# ---------------------------------------------------------------------------

def generate_html(data):
    """Embed data into viewer.html template. Returns full HTML string."""
    template_path = Path(__file__).parent / 'viewer.html'
    if not template_path.exists():
        raise FileNotFoundError(f'viewer.html not found at {template_path}')
    template = template_path.read_text(encoding='utf-8')
    data_js = json.dumps(data, ensure_ascii=False)
    return template.replace('/*__EMBEDDED_GRADE_DATA__*/', f'const EMBEDDED_GRADE_DATA = {data_js};')


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

def _kill_port(port):
    try:
        result = subprocess.run(['lsof', '-ti', f':{port}'], capture_output=True, text=True, timeout=5)
        for pid_str in result.stdout.strip().split('\n'):
            if pid_str.strip():
                try:
                    os.kill(int(pid_str.strip()), signal.SIGTERM)
                except (ProcessLookupError, ValueError):
                    pass
        if result.stdout.strip():
            time.sleep(0.5)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass


class GradeReviewHandler(BaseHTTPRequestHandler):
    """Serves the grade review HTML, regenerating on each request."""

    def __init__(self, workspace, grades_file, ab_dir, skill_name, *args, **kwargs):
        self.workspace = workspace
        self.grades_file = grades_file
        self.ab_dir = ab_dir
        self.skill_name = skill_name
        super().__init__(*args, **kwargs)

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            try:
                data = build_embedded_data(self.workspace, self.grades_file, self.ab_dir, self.skill_name)
                html = generate_html(data)
                content = html.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                self.wfile.write(content)
            except Exception as e:
                msg = f'Error generating review: {e}'.encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'text/plain')
                self.send_header('Content-Length', str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)
        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        pass  # suppress access logs


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='CLEO Grade Review viewer')
    parser.add_argument('workspace', type=Path, help='Project or results directory to scan')
    parser.add_argument('--port', '-p', type=int, default=3119)
    parser.add_argument('--static', '-s', type=Path, default=None,
                        help='Write standalone HTML to this path instead of serving')
    parser.add_argument('--grades-file', default=None, help='Override GRADES.jsonl path')
    parser.add_argument('--ab-dir', default=None, help='Override A/B results directory')
    parser.add_argument('--skill-name', '-n', default='ct-grade', help='Skill name for viewer title')
    parser.add_argument('--no-browser', action='store_true', help='Do not auto-open browser')
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    if not workspace.exists():
        print(f'ERROR: workspace does not exist: {workspace}', file=sys.stderr)
        sys.exit(1)

    data = build_embedded_data(workspace, args.grades_file, args.ab_dir, args.skill_name)

    grade_count = len(data.get('grades', []))
    ab_runs = data.get('ab_results', {}).get('total_runs', 0)
    print(f'\n  ct-grade Review Viewer')
    print(f'  {"─" * 40}')
    print(f'  Workspace : {workspace}')
    print(f'  Grades    : {grade_count}')
    print(f'  A/B runs  : {ab_runs}')

    if not grade_count and not ab_runs:
        print('\n  WARNING: No grade data found. Run run_scenario.py or run_ab_test.py first.')

    if args.static:
        html = generate_html(data)
        args.static.parent.mkdir(parents=True, exist_ok=True)
        args.static.write_text(html, encoding='utf-8')
        print(f'\n  Static viewer written to: {args.static}')
        sys.exit(0)

    port = args.port
    _kill_port(port)
    handler = partial(GradeReviewHandler, workspace, args.grades_file, args.ab_dir, args.skill_name)
    try:
        server = HTTPServer(('127.0.0.1', port), handler)
    except OSError:
        server = HTTPServer(('127.0.0.1', 0), handler)
        port = server.server_address[1]

    url = f'http://localhost:{port}'
    print(f'  URL       : {url}')
    print(f'\n  Refreshing the browser re-scans the workspace for new results.')
    print(f'  Press Ctrl+C to stop.\n')

    if not args.no_browser:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
        server.server_close()


if __name__ == '__main__':
    main()
