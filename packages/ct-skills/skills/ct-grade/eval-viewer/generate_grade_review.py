#!/usr/bin/env python3
"""
Generate and serve the CLEO Grade Review viewer (v3 — 6-tab edition).

Reads grade results from multiple sources, embeds them into grade-review.html,
and serves the page via a tiny stdlib HTTP server with a /live-data endpoint.

Sources (auto-discovered under --workspace):
  - .cleo/metrics/GRADES.jsonl          (historical grade results)
  - **/metrics.json                      (scenario run metrics from run_scenario.py)
  - **/summary.json with global_wins     (A/B test summaries from run_ab_test.py)
  - **/per_operation_stats.json          (audit analyzer output for operation matrix)
  - /tmp/ct-grade-evals/*/grading.json   (eval report results)
  - tasks.db audit_log                   (live session entries)

Usage:
    python generate_grade_review.py <workspace-path> [options]

Options:
    --port PORT           HTTP port (default: 3118)
    --static PATH         Write standalone HTML to file instead of serving
    --grades-file PATH    Override GRADES.jsonl path
    --ab-dir PATH         Override A/B results directory
    --skill-name NAME     Override title in viewer header
    --no-browser          Don't auto-open browser
    --background          Start server and exit immediately (caller owns the process)

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
        g['_scenarioId'] = data.get('scenario', '')
        if data.get('token_meta'):
            g['_tokenMeta'] = {
                'estimationMethod': data['token_meta'].get('estimation_method', 'output_chars'),
                'totalEstimatedTokens': data['token_meta'].get('total_estimated_tokens'),
                'confidence': data['token_meta'].get('confidence', 'ESTIMATED'),
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

    candidates.sort(key=lambda x: x[0], reverse=True)
    data = candidates[0][1]

    # Normalize per_operation: list → dict keyed by operation name
    per_op = data.get('per_operation', [])
    if isinstance(per_op, list):
        data['per_operation'] = {s['operation']: s for s in per_op if 'operation' in s}

    return data


def load_token_analysis(workspace, grades_file=None):
    """
    Build token analysis data from available sources.
    Tries to read token_tracker output files, falls back to computing from grades.
    """
    analysis = {}

    # Priority 1: timing.json files (from agent-based runs via task notifications)
    timings = []
    for tf in Path(workspace).rglob('timing.json'):
        try:
            t = json.loads(tf.read_text())
            timings.append(t)
        except Exception:
            pass
    real_toks = [t['total_tokens'] for t in timings if t.get('total_tokens') is not None]
    if real_toks:
        by_iface = {}
        for t in timings:
            iface = t.get('interface', t.get('arm', 'unknown'))
            tok = t.get('total_tokens')
            if tok is not None:
                if iface not in by_iface:
                    by_iface[iface] = []
                by_iface[iface].append(tok)
        analysis['confidence'] = 'ESTIMATED'
        analysis['method'] = 'task_notifications'
        analysis['by_interface'] = {
            iface: {
                'samples': len(vals),
                'mean': round(sum(vals) / len(vals), 0),
                'min': min(vals),
                'max': max(vals),
            }
            for iface, vals in sorted(by_iface.items())
        }
        analysis['total_samples'] = len(real_toks)
        analysis['overall_mean'] = round(sum(real_toks) / len(real_toks), 0)

        # Build mcp_vs_cli from by_interface if possible
        mcp_val = 0
        cli_val = 0
        for iface_key, stats in analysis['by_interface'].items():
            if 'mcp' in iface_key.lower():
                mcp_val += stats.get('mean', 0) * stats.get('samples', 1)
            elif 'cli' in iface_key.lower():
                cli_val += stats.get('mean', 0) * stats.get('samples', 1)
        if mcp_val or cli_val:
            analysis['mcp_vs_cli'] = {
                'mcp': {'estimated_tokens': int(mcp_val)},
                'cli': {'estimated_tokens': int(cli_val)},
            }

    # Priority 2: domain-token-report.json
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
        analysis['by_domain'] = {
            domain: {
                'estimated_tokens': int(round(sum(vals) / len(vals))),
                'ops_count': len(vals),
            }
            for domain, vals in sorted(domain_tokens.items())
        }
    else:
        analysis['by_domain'] = {
            'tasks':    {'estimated_tokens': 750,  'ops_count': 0},
            'session':  {'estimated_tokens': 400,  'ops_count': 0},
            'admin':    {'estimated_tokens': 600,  'ops_count': 0},
            'memory':   {'estimated_tokens': 500,  'ops_count': 0},
        }
        analysis['confidence'] = analysis.get('confidence', 'COARSE')

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
            'per_operation': per_op,
        }

    return analysis


def load_operation_stats(workspace, ab_dir=None):
    """Load per_operation_stats.json from audit_analyzer output."""
    search_roots = []
    if ab_dir:
        search_roots.append(Path(ab_dir))
    search_roots.append(Path(workspace))

    for root in search_roots:
        if not root.exists():
            continue
        for p in root.rglob('per_operation_stats.json'):
            try:
                data = json.loads(p.read_text())
                if 'by_operation' in data:
                    return data.get('by_operation', {})
            except Exception:
                pass
    return {}


def load_eval_report(workspace):
    """Load grading.json files from /tmp/ct-grade-evals/*/outputs/."""
    reports = []
    eval_base = Path('/tmp/ct-grade-evals')
    if not eval_base.exists():
        eval_base = Path(workspace) / '.ct-grade-evals'
    if not eval_base.exists():
        return reports
    for gf in sorted(eval_base.rglob('grading.json')):
        try:
            data = json.loads(gf.read_text())
            reports.append(data)
        except Exception:
            pass
    return reports


def load_live_session(workspace):
    """Query tasks.db for current session's audit entries."""
    import sqlite3

    db_path = None
    for candidate in [
        Path(workspace) / '.cleo' / 'tasks.db',
        Path(workspace).parent / '.cleo' / 'tasks.db',
    ]:
        if candidate.exists():
            db_path = candidate
            break

    if not db_path:
        return {'session_id': None, 'entries': []}

    try:
        conn = sqlite3.connect(str(db_path), timeout=5)
        cur = conn.execute(
            "SELECT id FROM sessions WHERE status='active' ORDER BY started_at DESC LIMIT 1"
        )
        row = cur.fetchone()
        if not row:
            conn.close()
            return {'session_id': None, 'entries': []}

        session_id = row[0]
        cur = conn.execute(
            """SELECT timestamp, domain, operation, source, gateway, duration_ms, success
               FROM audit_log
               WHERE session_id = ?
               ORDER BY timestamp DESC LIMIT 50""",
            (session_id,)
        )
        entries = [
            {
                'timestamp': r[0], 'domain': r[1], 'operation': r[2],
                'source': r[3], 'gateway': r[4], 'duration_ms': r[5],
                'success': bool(r[6])
            }
            for r in cur.fetchall()
        ]
        conn.close()
        return {'session_id': session_id, 'entries': entries}
    except Exception as e:
        return {'session_id': None, 'entries': [], 'error': str(e)}


# ---------------------------------------------------------------------------
# Canonical operation list (fallback for operation matrix)
# ---------------------------------------------------------------------------

def _canonical_ops():
    """Return list of (op, domain, tier, gateway) for all canonical 202 ops."""
    ops = []
    def add(domain, tier, gateway, names):
        for n in names:
            ops.append({'op': domain + '.' + n, 'domain': domain, 'tier': tier, 'gateway': gateway})

    add('tasks', 0, 'query',  ['find','show','list','tree','plan','exists'])
    add('tasks', 0, 'mutate', ['add','update','complete','cancel','archive','restore','relates','depends','history'])
    add('session', 0, 'query',  ['status','list','briefing.show','handoff.show','context.drift'])
    add('session', 0, 'mutate', ['start','end','decision.log','record.decision','context.inject'])
    add('admin', 0, 'query',  ['dash','health','help','stats','doctor','grade','grade.list','adr.find'])
    add('memory', 1, 'query',  ['find','timeline','fetch','pattern.find','learning.find'])
    add('memory', 1, 'mutate', ['observe'])
    add('tools', 1, 'query',  ['skill.list','skill.show','provider.list','provider.show'])
    add('check', 1, 'query',  ['health','schema','compliance'])
    add('pipeline', 1, 'query',  ['stage.status','manifest.list'])
    add('pipeline', 1, 'mutate', ['stage.record','stage.gate.pass','stage.validate','manifest.add','manifest.remove'])
    add('orchestrate', 2, 'query',  ['analyze','ready','next'])
    add('orchestrate', 2, 'mutate', ['spawn','start'])
    add('nexus', 2, 'query',  ['status','project.list','project.show'])
    add('nexus', 2, 'mutate', ['project.add'])
    add('sticky', 2, 'query',  ['list'])
    add('sticky', 2, 'mutate', ['add','archive'])
    return ops


def build_operation_matrix(workspace, ab_dir=None):
    """Merge canonical op list with audit stats to form operation matrix."""
    # Start with canonical ops
    matrix = {}
    for co in _canonical_ops():
        matrix[co['op']] = {
            'tier': co['tier'],
            'gateway': co['gateway'],
            'mcp_calls': 0,
            'cli_calls': 0,
            'avg_mcp_ms': None,
            'avg_cli_ms': None,
            'tested': False,
        }

    # Overlay audit stats
    audit_stats = load_operation_stats(workspace, ab_dir)
    for op_key, d in audit_stats.items():
        if op_key not in matrix:
            # Include unknown ops from audit
            matrix[op_key] = {
                'tier': d.get('tier', 0),
                'gateway': d.get('gateway', 'query'),
                'mcp_calls': 0,
                'cli_calls': 0,
                'avg_mcp_ms': None,
                'avg_cli_ms': None,
                'tested': False,
            }
        mcp_calls = d.get('mcp_calls', 0) or 0
        cli_calls = d.get('cli_calls', 0) or 0
        matrix[op_key]['mcp_calls'] = mcp_calls
        matrix[op_key]['cli_calls'] = cli_calls
        matrix[op_key]['avg_mcp_ms'] = d.get('avg_mcp_ms')
        matrix[op_key]['avg_cli_ms'] = d.get('avg_cli_ms')
        matrix[op_key]['tested'] = bool(d.get('tested') or mcp_calls or cli_calls)

    return matrix


# ---------------------------------------------------------------------------
# Embedded data builder
# ---------------------------------------------------------------------------

def build_embedded_data(workspace, grades_file=None, ab_dir=None, skill_name=None):
    """Build the full EMBEDDED_GRADE_DATA dict for the viewer."""
    workspace = Path(workspace).resolve()

    # 1. Grades
    gf = grades_file or (workspace / '.cleo' / 'metrics' / 'GRADES.jsonl')
    historical_grades = load_grades_jsonl(gf)
    scenario_grades = load_scenario_metrics(workspace)

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
            all_grades_map['__noid_{}'.format(len(all_grades_map))] = g

    all_grades = sorted(
        all_grades_map.values(),
        key=lambda g: g.get('timestamp', ''),
        reverse=True
    )

    # 2. A/B results
    ab_results = load_ab_summary(workspace, ab_dir)

    # 3. Token analysis
    token_analysis = load_token_analysis(workspace, grades_file=str(gf))

    # 4. Operation matrix
    operation_matrix = build_operation_matrix(workspace, ab_dir)

    # 5. Eval report
    eval_report = load_eval_report(workspace)

    # 6. Live session (initial snapshot — will be refreshed via /live-data polling)
    live_session = load_live_session(workspace)

    return {
        'title': (skill_name or 'ct-grade') + ' \u2014 Grade Review',
        'subtitle': str(workspace.name),
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'grades': all_grades,
        'ab_results': ab_results,
        'token_analysis': token_analysis,
        'operation_matrix': operation_matrix,
        'eval_report': eval_report,
        'live_session': live_session,
        'metadata': {
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'total_grades': len(all_grades),
            'project_dir': str(workspace),
        },
    }


# ---------------------------------------------------------------------------
# HTML generator
# ---------------------------------------------------------------------------

def generate_html(data):
    """Embed data into grade-review.html template. Returns full HTML string."""
    template_path = Path(__file__).parent / 'grade-review.html'
    if not template_path.exists():
        raise FileNotFoundError('grade-review.html not found at {}'.format(template_path))
    template = template_path.read_text(encoding='utf-8')
    data_js = json.dumps(data, ensure_ascii=False)
    return template.replace('/*__EMBEDDED_GRADE_DATA__*/', 'const EMBEDDED_GRADE_DATA = {};'.format(data_js))


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

def _kill_port(port):
    try:
        result = subprocess.run(
            ['lsof', '-ti', ':{}'.format(port)],
            capture_output=True, text=True, timeout=5
        )
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
    """Serves the grade review HTML and /live-data JSON endpoint."""

    def __init__(self, workspace, grades_file, ab_dir, skill_name, *args, **kwargs):
        self.workspace = workspace
        self.grades_file = grades_file
        self.ab_dir = ab_dir
        self.skill_name = skill_name
        super().__init__(*args, **kwargs)

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            try:
                data = build_embedded_data(
                    self.workspace, self.grades_file, self.ab_dir, self.skill_name
                )
                html = generate_html(data)
                content = html.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(content)))
                self.end_headers()
                self.wfile.write(content)
            except Exception as e:
                msg = 'Error generating review: {}'.format(e).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'text/plain')
                self.send_header('Content-Length', str(len(msg)))
                self.end_headers()
                self.wfile.write(msg)

        elif self.path == '/live-data':
            try:
                live_data = load_live_session(self.workspace)
                body = json.dumps(live_data).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                err = json.dumps({'error': str(e), 'session_id': None, 'entries': []}).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(err)))
                self.end_headers()
                self.wfile.write(err)

        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        pass  # suppress access logs


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='CLEO Grade Review viewer (v3 — 6-tab)')
    parser.add_argument('workspace', type=Path, help='Project or results directory to scan')
    parser.add_argument('--port', '-p', type=int, default=3118)
    parser.add_argument('--static', '-s', type=Path, default=None,
                        help='Write standalone HTML to this path instead of serving')
    parser.add_argument('--grades-file', default=None, help='Override GRADES.jsonl path')
    parser.add_argument('--ab-dir', default=None, help='Override A/B results directory')
    parser.add_argument('--skill-name', '-n', default='ct-grade', help='Skill name for viewer title')
    parser.add_argument('--no-browser', action='store_true', help='Do not auto-open browser')
    parser.add_argument('--background', action='store_true',
                        help='Start server and exit immediately (caller owns the process). Implies --no-browser.')
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    if not workspace.exists():
        print('ERROR: workspace does not exist: {}'.format(workspace), file=sys.stderr)
        sys.exit(1)

    data = build_embedded_data(workspace, args.grades_file, args.ab_dir, args.skill_name)

    grade_count = len(data.get('grades', []))
    ab_runs = data.get('ab_results', {}).get('total_runs', 0)
    eval_count = len(data.get('eval_report', []))
    op_count = len(data.get('operation_matrix', {}))

    print('\n  ct-grade Review Viewer (v3)')
    print('  {}'.format('\u2500' * 40))
    print('  Workspace  : {}'.format(workspace))
    print('  Grades     : {}'.format(grade_count))
    print('  A/B runs   : {}'.format(ab_runs))
    print('  Eval reports: {}'.format(eval_count))
    print('  Op matrix  : {} operations'.format(op_count))

    if not grade_count and not ab_runs:
        print('\n  WARNING: No grade data found. Run run_scenario.py or run_ab_test.py first.')

    if args.static:
        html = generate_html(data)
        args.static.parent.mkdir(parents=True, exist_ok=True)
        args.static.write_text(html, encoding='utf-8')
        print('\n  Static viewer written to: {}'.format(args.static))
        sys.exit(0)

    port = args.port
    _kill_port(port)
    handler = partial(GradeReviewHandler, workspace, args.grades_file, args.ab_dir, args.skill_name)
    try:
        server = HTTPServer(('127.0.0.1', port), handler)
    except OSError:
        server = HTTPServer(('127.0.0.1', 0), handler)
        port = server.server_address[1]

    url = 'http://localhost:{}'.format(port)
    print('  URL        : {}'.format(url))
    print('\n  Refreshing the browser re-scans the workspace for new results.')
    print('  /live-data endpoint updates every 5 seconds (polled by the Live tab).')
    print('  Press Ctrl+C to stop.\n')

    no_browser = args.no_browser or args.background
    if not no_browser:
        webbrowser.open(url)

    if args.background:
        # Background mode: server is running, caller owns the process.
        # We still serve forever — the caller is responsible for lifecycle.
        pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
        server.server_close()


if __name__ == '__main__':
    main()
