#!/usr/bin/env python3
"""
Generate and serve the CLEO Grade Review viewer (v1.1 — API-aware SQLite-backed).

Reads grade results from GRADES.jsonl, session/token data from tasks.db,
grade run manifests from .cleo/metrics/grade-runs/, and eval results from
evals.json + grading.json files. Embeds all data into grade-review.html
as JSON in the {{EMBEDDED_DATA}} placeholder and serves via stdlib HTTP.

Sources (auto-discovered under workspace):
  - .cleo/metrics/GRADES.jsonl          (historical grade results)
  - .cleo/tasks.db                      (sessions, audit_log, token_usage)
  - .cleo/metrics/grade-runs/           (run manifests, summaries, operations)
  - evals/evals.json + grading.json     (eval report results)

Usage:
    python generate_grade_review.py <workspace-path> [options]

Options:
    --port PORT           HTTP port (default: 3118)
    --static PATH         Write standalone HTML to file instead of serving
    --skill-dir PATH      Override skill directory (default: auto-detect)
    --no-browser          Don't auto-open browser
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
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


# ---------------------------------------------------------------------------
# Workspace discovery
# ---------------------------------------------------------------------------

def find_workspace(start='.'):
    """Walk up from start to find directory containing .cleo/tasks.db."""
    p = Path(start).resolve()
    while p != p.parent:
        if (p / '.cleo' / 'tasks.db').exists():
            return p
        p = p.parent
    return Path(start).resolve()


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


def scoreToLetter(score, max_score=100):
    if score is None: return None
    pct = (score / max_score) * 100 if max_score else 0
    if pct >= 90: return 'A'
    if pct >= 80: return 'B'
    if pct >= 70: return 'C'
    if pct >= 60: return 'D'
    return 'F'


def load_sessions(workspace):
    """Load all sessions from SQLite with audit_log stats and token_usage totals."""
    import sqlite3
    db = Path(workspace) / '.cleo' / 'tasks.db'
    if not db.exists():
        return []
    try:
        conn = sqlite3.connect(str(db), timeout=5)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("""
            SELECT
                s.id, s.name, s.status, s.scope_json,
                s.started_at, s.ended_at, s.resume_count,
                s.previous_session_id, s.next_session_id, s.agent_identifier,
                s.grade_mode, s.stats_json,
                COUNT(a.id) as audit_entries,
                SUM(CASE WHEN a.gateway = 'query' AND a.source = 'mcp' THEN 1 ELSE 0 END) as mcp_calls,
                SUM(CASE WHEN a.source = 'cli' THEN 1 ELSE 0 END) as cli_calls
            FROM sessions s
            LEFT JOIN audit_log a ON a.session_id = s.id
            GROUP BY s.id
            ORDER BY s.started_at DESC
        """)
        sessions = [dict(row) for row in cur.fetchall()]

        # Parse stats_json, scope_json, and add chain/agent fields
        for s in sessions:
            stats = {}
            try:
                if s.get('stats_json'): stats = json.loads(s['stats_json'])
            except Exception: pass
            # Parse scope_json
            scope_raw = s.get('scope_json', '{}')
            try:
                scope_obj = json.loads(scope_raw) if scope_raw else {}
            except Exception:
                scope_obj = {}
            s['scope_type'] = scope_obj.get('type', '')
            s['scope_root_task_id'] = scope_obj.get('rootTaskId', '')
            s.pop('scope_json', None)
            s['totalActiveMinutes'] = stats.get('totalActiveMinutes', 0)
            s['tasksCompleted'] = stats.get('tasksCompleted', 0)
            s['tasksCreated'] = stats.get('tasksCreated', 0)
            s['previousSessionId'] = s.pop('previous_session_id', None)
            s['nextSessionId'] = s.pop('next_session_id', None)
            s['agentIdentifier'] = s.pop('agent_identifier', None)
            s['gradeMode'] = bool(s.pop('grade_mode', False))
            s.pop('stats_json', None)

        # Get token totals per session
        try:
            cur.execute("""
                SELECT session_id, SUM(total_tokens) as total_tokens, COUNT(*) as token_records
                FROM token_usage
                GROUP BY session_id
            """)
            token_map = {row['session_id']: dict(row) for row in cur.fetchall()}
            for s in sessions:
                tok = token_map.get(s['id'], {})
                s['total_tokens'] = tok.get('total_tokens', 0)
                s['token_records'] = tok.get('token_records', 0)
        except Exception:
            for s in sessions:
                s['total_tokens'] = 0
                s['token_records'] = 0

        conn.close()

        # Map to camelCase keys expected by the HTML viewer
        mapped = []
        for s in sessions:
            started = s.get('started_at', '')
            ended = s.get('ended_at', '')
            duration_ms = None
            if started and ended:
                try:
                    t0 = datetime.fromisoformat(started.replace('Z', '+00:00'))
                    t1 = datetime.fromisoformat(ended.replace('Z', '+00:00'))
                    duration_ms = int((t1 - t0).total_seconds() * 1000)
                except Exception:
                    pass
            mapped.append({
                'sessionId': s.get('id', ''),
                'name': s.get('name', ''),
                'status': s.get('status', ''),
                'scope': s.get('scope_type', ''),
                'scopeRootTaskId': s.get('scope_root_task_id', ''),
                'startedAt': started,
                'endedAt': ended,
                'durationMs': duration_ms,
                'resumeCount': s.get('resume_count', 0),
                'tasksCompleted': s.get('tasksCompleted', 0),
                'tasksCreated': s.get('tasksCreated', 0),
                'auditEntries': s.get('audit_entries', 0),
                'mcpCalls': s.get('mcp_calls', 0),
                'cliCalls': s.get('cli_calls', 0),
                'totalTokens': s.get('total_tokens', 0),
                'tokenRecords': s.get('token_records', 0),
                'totalActiveMinutes': s.get('totalActiveMinutes', 0),
                'previousSessionId': s.get('previousSessionId'),
                'nextSessionId': s.get('nextSessionId'),
                'agentIdentifier': s.get('agentIdentifier'),
                'gradeMode': s.get('gradeMode', False),
            })

        # Enrich sessions with grade data from GRADES.jsonl
        grades_path = Path(workspace) / '.cleo' / 'metrics' / 'GRADES.jsonl'
        if grades_path.exists():
            grade_map = {}  # sessionId -> best grade result
            for line in grades_path.read_text(errors='replace').splitlines():
                line = line.strip()
                if not line: continue
                try:
                    g = json.loads(line)
                    sid = g.get('sessionId', '')
                    if sid:
                        existing = grade_map.get(sid)
                        if existing is None or (g.get('totalScore', 0) or 0) > (existing.get('totalScore', 0) or 0):
                            grade_map[sid] = g
                except Exception:
                    pass
            for s in mapped:
                sid = s.get('sessionId') or s.get('id', '')
                if sid in grade_map:
                    g = grade_map[sid]
                    score = g.get('totalScore')
                    max_score = g.get('maxScore', 100)
                    s['gradeScore'] = score
                    s['gradeLetter'] = scoreToLetter(score, max_score) if score is not None else None
                    s['gradeDetails'] = g.get('dimensions', {})
                    s['gradeFlags'] = g.get('flags', [])
                    s['gradeTimestamp'] = g.get('timestamp', '')

        return mapped
    except Exception:
        return []


def load_token_analysis(workspace):
    """Query token_usage table for transport and domain breakdowns."""
    import sqlite3
    db = Path(workspace) / '.cleo' / 'tasks.db'
    if not db.exists():
        return {'by_transport': {}, 'by_domain': {}, 'confidence': 'coarse', 'total_records': 0}
    try:
        conn = sqlite3.connect(str(db), timeout=5)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        # By transport (normalize legacy api -> http per CLEO-WEB-API v2.1)
        cur.execute("""
            SELECT transport, method, confidence,
                   SUM(total_tokens) as total,
                   COUNT(*) as count,
                   AVG(total_tokens) as avg
            FROM token_usage GROUP BY transport
        """)
        by_transport = {}
        transport_aliases = {'api': 'http'}
        for row in cur.fetchall():
            raw_transport = row['transport'] or 'unknown'
            transport = transport_aliases.get(raw_transport, raw_transport)
            current = by_transport.get(transport, {
                'transport': transport,
                'raw_transports': [],
                'method': row['method'],
                'confidence': row['confidence'],
                'total': 0,
                'count': 0,
                'avg': 0,
            })
            current['raw_transports'] = sorted(set(current.get('raw_transports', []) + [raw_transport]))
            current['total'] += row['total'] or 0
            current['count'] += row['count'] or 0
            if current['count'] > 0:
                current['avg'] = round(current['total'] / current['count'], 2)
            if raw_transport == 'http' or not current.get('method'):
                current['method'] = row['method']
                current['confidence'] = row['confidence']
            by_transport[transport] = current

        # By domain
        cur.execute("""
            SELECT domain, SUM(total_tokens) as total, COUNT(*) as count
            FROM token_usage GROUP BY domain
        """)
        by_domain = {}
        for row in cur.fetchall():
            by_domain[row['domain']] = dict(row)

        # Overall confidence (most common)
        cur.execute("""
            SELECT confidence, COUNT(*) as cnt FROM token_usage
            GROUP BY confidence ORDER BY cnt DESC LIMIT 1
        """)
        row = cur.fetchone()
        confidence = row['confidence'] if row else 'coarse'

        cur.execute("SELECT COUNT(*) as total FROM token_usage")
        total_records = cur.fetchone()['total']

        conn.close()
        return {
            'by_transport': by_transport,
            'by_domain': by_domain,
            'confidence': confidence,
            'total_records': total_records,
        }
    except Exception:
        return {'by_transport': {}, 'by_domain': {}, 'confidence': 'coarse', 'total_records': 0}


def load_grade_runs(workspace):
    """Scan .cleo/metrics/grade-runs/ for run-manifest.json files."""
    runs_dir = Path(workspace) / '.cleo' / 'metrics' / 'grade-runs'
    runs = []
    if not runs_dir.exists():
        return runs
    for run_dir in sorted(runs_dir.iterdir(), reverse=True):
        if not run_dir.is_dir():
            continue
        manifest_path = run_dir / 'run-manifest.json'
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text())
                summary = None
                summary_path = run_dir / 'summary.json'
                if summary_path.exists():
                    try:
                        summary = json.loads(summary_path.read_text())
                    except Exception:
                        pass
                runs.append({
                    'runId': run_dir.name,
                    'manifest': manifest,
                    'summary': summary,
                })
            except Exception:
                pass
    return runs


def compute_per_operation_stats(workspace):
    """Aggregate operations.jsonl files from all grade runs."""
    runs_dir = Path(workspace) / '.cleo' / 'metrics' / 'grade-runs'
    stats = {}
    if not runs_dir.exists():
        return stats
    for ops_file in runs_dir.rglob('operations.jsonl'):
        for line in ops_file.read_text(errors='replace').splitlines():
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                key = '{}.{}'.format(
                    entry.get('domain', 'unknown'),
                    entry.get('operation', 'unknown'),
                )
                iface = entry.get('interface', 'mcp')
                duration = entry.get('duration_ms', 0) or 0
                if key not in stats:
                    stats[key] = {
                        'mcp_calls': 0, 'cli_calls': 0,
                        'total_mcp_ms': 0, 'total_cli_ms': 0,
                    }
                if iface == 'cli':
                    stats[key]['cli_calls'] += 1
                    stats[key]['total_cli_ms'] += duration
                else:
                    stats[key]['mcp_calls'] += 1
                    stats[key]['total_mcp_ms'] += duration
            except Exception:
                pass
    # Compute averages
    for v in stats.values():
        v['avg_mcp_ms'] = round(v['total_mcp_ms'] / v['mcp_calls'], 1) if v['mcp_calls'] > 0 else 0
        v['avg_cli_ms'] = round(v['total_cli_ms'] / v['cli_calls'], 1) if v['cli_calls'] > 0 else 0
    return stats


def load_eval_report(workspace, skill_dir=None):
    """Load grading results and attach eval names from evals.json."""
    evals_def = []
    if skill_dir:
        evals_path = Path(skill_dir) / 'evals' / 'evals.json'
        if evals_path.exists():
            try:
                raw_evals = json.loads(evals_path.read_text())
                if isinstance(raw_evals, dict):
                    evals_def = raw_evals.get('evals', [])
                elif isinstance(raw_evals, list):
                    evals_def = raw_evals
            except Exception:
                pass

    id_to_name = {}
    for e in evals_def:
        if isinstance(e, dict):
            eid = e.get('id', '')
            id_to_name[eid] = (e.get('description', e.get('prompt', '')))[:80]

    # Find grading.json files under workspace (including eval-results dir)
    results = []
    seen_paths = set()
    for search_root in [Path(workspace), Path(workspace) / '.cleo' / 'metrics' / 'eval-results']:
        if not search_root.exists():
            continue
        for grading_file in search_root.rglob('grading.json'):
            real_path = str(grading_file.resolve())
            if real_path in seen_paths:
                continue
            seen_paths.add(real_path)
            try:
                data = json.loads(grading_file.read_text())
                eval_id = data.get('evalId', '')
                data['_name'] = id_to_name.get(eval_id, '')
                results.append(data)
            except Exception:
                pass
    # Also scan eval-results for <id>-grading.json files
    eval_results_dir = Path(workspace) / '.cleo' / 'metrics' / 'eval-results'
    if eval_results_dir.exists():
        for gf in eval_results_dir.glob('*-grading.json'):
            real_path = str(gf.resolve())
            if real_path in seen_paths:
                continue
            seen_paths.add(real_path)
            try:
                data = json.loads(gf.read_text())
                eval_id = data.get('evalId', '')
                data['_name'] = id_to_name.get(eval_id, '')
                results.append(data)
            except Exception:
                pass

    # Synthesize grading.json from real grades for eval coverage
    grades_path = Path(workspace) / '.cleo' / 'metrics' / 'GRADES.jsonl'
    real_grades = []
    if grades_path.exists():
        for line in grades_path.read_text(errors='replace').splitlines():
            line = line.strip()
            if not line: continue
            try: real_grades.append(json.loads(line))
            except Exception: pass

    # Map eval expectations to grade dimensions (supports ct-grade legacy ids + keys)
    def dim_score(grade, *keys):
        dims = grade.get('dimensions', {}) if isinstance(grade.get('dimensions'), dict) else {}
        for key in keys:
            value = dims.get(key, {})
            if isinstance(value, dict):
                score = value.get('score')
                if score is not None:
                    return score
        return 0

    eval_grade_map = {
        1: lambda g: g.get('totalScore', 0) > 0,
        '1': lambda g: g.get('totalScore', 0) > 0,
        'eval-001': lambda g: g.get('totalScore', 0) > 0,
        2: lambda g: dim_score(g, 'sessionDiscipline') >= 18,
        '2': lambda g: dim_score(g, 'sessionDiscipline') >= 18,
        'eval-002': lambda g: dim_score(g, 'sessionDiscipline') >= 18,
        3: lambda g: dim_score(g, 'discoveryEfficiency', 'taskEfficiency') >= 15,
        '3': lambda g: dim_score(g, 'discoveryEfficiency', 'taskEfficiency') >= 15,
        'eval-003': lambda g: dim_score(g, 'discoveryEfficiency', 'taskEfficiency') >= 15,
        4: lambda g: dim_score(g, 'taskHygiene') >= 18,
        '4': lambda g: dim_score(g, 'taskHygiene') >= 18,
        'eval-004': lambda g: dim_score(g, 'taskHygiene') >= 18,
        5: lambda g: dim_score(g, 'errorProtocol', 'protocolAdherence') >= 15,
        '5': lambda g: dim_score(g, 'errorProtocol', 'protocolAdherence') >= 15,
        'eval-005': lambda g: dim_score(g, 'errorProtocol', 'protocolAdherence') >= 15,
        6: lambda g: dim_score(g, 'disclosureUse', 'mcpGateway') >= 15,
        '6': lambda g: dim_score(g, 'disclosureUse', 'mcpGateway') >= 15,
        'eval-006': lambda g: dim_score(g, 'disclosureUse', 'mcpGateway') >= 15,
        7: lambda g: g.get('totalScore', 0) >= 60,
        '7': lambda g: g.get('totalScore', 0) >= 60,
        'eval-007': lambda g: g.get('totalScore', 0) >= 60,
    }

    # Write grading.json for each eval based on real grade data (only if not already found)
    run_ids = {r.get('evalId') for r in results}
    if real_grades:
        evals_output_dir = Path(workspace) / '.cleo' / 'metrics' / 'eval-results'
        evals_output_dir.mkdir(parents=True, exist_ok=True)

        for e in evals_def:
            eval_id = e.get('id', '')
            if eval_id in run_ids:
                continue  # already have results
            checker = eval_grade_map.get(eval_id)
            if checker:
                passing = [g for g in real_grades if checker(g)]
                total = len(real_grades)
                pass_count = len(passing)
                grading_data = {
                    'evalId': eval_id,
                    'name': id_to_name.get(eval_id, ''),
                    'totalRuns': total,
                    'passed': pass_count,
                    'failed': total - pass_count,
                    'passRate': round(pass_count / total, 3) if total else 0,
                    'expectations': e.get('expectations', []),
                    'results': [
                        {
                            'sessionId': g.get('sessionId', ''),
                            'passed': checker(g),
                            'score': g.get('totalScore'),
                            'evidence': g.get('dimensions', {}),
                        }
                        for g in real_grades[:20]  # limit to 20 for size
                    ],
                    'generatedAt': datetime.now(timezone.utc).isoformat(),
                }
                grading_file = evals_output_dir / '{}-grading.json'.format(eval_id)
                try:
                    grading_file.write_text(json.dumps(grading_data, indent=2))
                    grading_data['_name'] = id_to_name.get(eval_id, '')
                    results.append(grading_data)
                    run_ids.add(eval_id)
                except Exception:
                    pass

    # Add NOT RUN entries for evals with no grading.json
    for e in evals_def:
        if isinstance(e, dict) and e.get('id') not in run_ids:
            results.append({
                'evalId': e.get('id'),
                '_name': id_to_name.get(e.get('id', ''), ''),
                '_not_run': True,
            })
    return results


def load_live_session(workspace):
    """Query tasks.db for current active session + last 50 audit entries + token totals."""
    import sqlite3
    db = Path(workspace) / '.cleo' / 'tasks.db'
    if not db.exists():
        return {'session_id': None, 'entries': []}
    try:
        conn = sqlite3.connect(str(db), timeout=5)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        cur.execute(
            "SELECT id, name, status, started_at FROM sessions "
            "WHERE status='active' ORDER BY started_at DESC LIMIT 1"
        )
        row = cur.fetchone()
        if not row:
            conn.close()
            return {'session_id': None, 'entries': []}

        session_id = row['id']
        session_name = row['name']
        started_at = row['started_at']

        # Last 50 audit entries
        cur.execute(
            """SELECT timestamp, domain, operation, source, gateway, duration_ms, success
               FROM audit_log
               WHERE session_id = ?
               ORDER BY timestamp DESC LIMIT 50""",
            (session_id,),
        )
        entries = [
            {
                'timestamp': r['timestamp'],
                'domain': r['domain'],
                'operation': r['operation'],
                'source': r['source'],
                'gateway': r['gateway'],
                'duration_ms': r['duration_ms'],
                'success': bool(r['success']),
            }
            for r in cur.fetchall()
        ]

        # Token totals for this session
        token_total = 0
        try:
            cur.execute(
                "SELECT SUM(total_tokens) as total FROM token_usage WHERE session_id = ?",
                (session_id,),
            )
            tok_row = cur.fetchone()
            if tok_row and tok_row['total']:
                token_total = tok_row['total']
        except Exception:
            pass

        conn.close()
        return {
            'session_id': session_id,
            'session_name': session_name,
            'started_at': started_at,
            'total_tokens': token_total,
            'entries': entries,
        }
    except Exception as e:
        return {'session_id': None, 'entries': [], 'error': str(e)}


def load_session_detail(workspace, session_id):
    """Load audit entries + token data + full session row for a specific session."""
    import sqlite3
    db = Path(workspace) / '.cleo' / 'tasks.db'
    if not db.exists() or not session_id:
        return {'entries': [], 'tokens': {}, 'session': {}}
    try:
        conn = sqlite3.connect(str(db), timeout=5)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        # Get full session row
        cur.execute("""
            SELECT id, name, status, scope_json, notes_json, tasks_completed_json, tasks_created_json,
                   handoff_json, debrief_json, stats_json, started_at, ended_at,
                   previous_session_id, next_session_id, agent_identifier,
                   handoff_consumed_at, resume_count, grade_mode
            FROM sessions WHERE id = ?
        """, (session_id,))
        srow = cur.fetchone()
        session_info = {}
        if srow:
            srow = dict(srow)
            def parse_j(v, default=None):
                if not v: return default
                try: return json.loads(v)
                except Exception: return default
            session_info = {
                'id': srow['id'],
                'name': srow['name'],
                'status': srow['status'],
                'scope': parse_j(srow['scope_json'], {}),
                'notes': parse_j(srow['notes_json'], []),
                'tasksCompleted': parse_j(srow['tasks_completed_json'], []),
                'tasksCreated': parse_j(srow['tasks_created_json'], []),
                'handoff': parse_j(srow['handoff_json']),
                'debrief': parse_j(srow['debrief_json']),
                'stats': parse_j(srow['stats_json'], {}),
                'startedAt': srow['started_at'],
                'endedAt': srow['ended_at'],
                'previousSessionId': srow['previous_session_id'],
                'nextSessionId': srow['next_session_id'],
                'agentIdentifier': srow['agent_identifier'],
                'handoffConsumedAt': srow['handoff_consumed_at'],
                'resumeCount': srow['resume_count'] or 0,
                'gradeMode': bool(srow['grade_mode']),
            }

        cur.execute(
            """SELECT timestamp, domain, operation, source, gateway, duration_ms, success
               FROM audit_log
               WHERE session_id = ?
               ORDER BY timestamp DESC LIMIT 500""",
            (session_id,),
        )
        entries = [
            {
                'timestamp': r['timestamp'],
                'domain': r['domain'],
                'operation': r['operation'],
                'source': r['source'],
                'gateway': r['gateway'],
                'duration_ms': r['duration_ms'],
                'success': bool(r['success']),
            }
            for r in cur.fetchall()
        ]

        tokens = {}
        try:
            cur.execute(
                """SELECT SUM(total_tokens) as total_tokens,
                          SUM(input_tokens) as input_tokens,
                          SUM(output_tokens) as output_tokens,
                          COUNT(*) as records
                   FROM token_usage WHERE session_id = ?""",
                (session_id,),
            )
            row = cur.fetchone()
            if row:
                tokens = dict(row)
        except Exception:
            pass

        conn.close()
        return {'entries': entries, 'tokens': tokens, 'session': session_info}
    except Exception:
        return {'entries': [], 'tokens': {}, 'session': {}}


def enrich_grades_with_tokens(grades, workspace):
    """Attach _tokenMeta from token_usage table where sessionId matches."""
    import sqlite3
    db = Path(workspace) / '.cleo' / 'tasks.db'
    if not db.exists():
        return grades
    try:
        conn = sqlite3.connect(str(db), timeout=5)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("""
            SELECT session_id, SUM(total_tokens) as total_tokens,
                   SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
                   COUNT(*) as records,
                   MAX(confidence) as confidence, MAX(method) as method
            FROM token_usage GROUP BY session_id
        """)
        token_map = {row['session_id']: dict(row) for row in cur.fetchall()}
        conn.close()
        for g in grades:
            sid = g.get('sessionId')
            if sid and sid in token_map:
                t = token_map[sid]
                g['_tokenMeta'] = {
                    'total_tokens': t['total_tokens'],
                    'input_tokens': t['input_tokens'],
                    'output_tokens': t['output_tokens'],
                    'confidence': t['confidence'] or 'coarse',
                    'method': t['method'] or 'heuristic',
                    'records': t['records'],
                }
    except Exception:
        pass
    return grades


# ---------------------------------------------------------------------------
# Canonical operation list (for operation matrix)
# ---------------------------------------------------------------------------

def _canonical_ops():
    """Return list of (op, domain, tier, gateway) for all canonical ops."""
    ops = []
    def add(domain, tier, gateway, names):
        for n in names:
            ops.append({
                'operation': domain + '.' + n,
                'domain': domain,
                'tier': tier,
                'gateway': gateway,
            })

    add('tasks', 0, 'query', ['find', 'show', 'list', 'tree', 'plan', 'exists'])
    add('tasks', 0, 'mutate', ['add', 'update', 'complete', 'cancel', 'archive', 'restore', 'relates', 'depends', 'history'])
    add('session', 0, 'query', ['status', 'list', 'briefing.show', 'handoff.show', 'context.drift'])
    add('session', 0, 'mutate', ['start', 'end', 'decision.log', 'record.decision', 'context.inject'])
    add('admin', 0, 'query', ['dash', 'health', 'help', 'stats', 'doctor', 'grade', 'grade.list', 'adr.find', 'token'])
    add('check', 0, 'query', ['grade', 'grade.list'])
    add('memory', 1, 'query', ['find', 'timeline', 'fetch', 'pattern.find', 'learning.find'])
    add('memory', 1, 'mutate', ['observe'])
    add('tools', 1, 'query', ['skill.list', 'skill.show', 'provider.list', 'provider.show'])
    add('check', 1, 'query', ['health', 'schema', 'compliance'])
    add('pipeline', 1, 'query', ['stage.status', 'manifest.list'])
    add('pipeline', 1, 'mutate', ['stage.record', 'stage.gate.pass', 'stage.validate', 'manifest.add', 'manifest.remove'])
    add('orchestrate', 2, 'query', ['analyze', 'ready', 'next'])
    add('orchestrate', 2, 'mutate', ['spawn', 'start'])
    add('nexus', 2, 'query', ['status', 'project.list', 'project.show'])
    add('nexus', 2, 'mutate', ['project.add'])
    add('sticky', 2, 'query', ['list', 'show'])
    add('sticky', 2, 'mutate', ['add', 'convert', 'archive', 'purge'])
    return ops


def build_operation_matrix(op_stats):
    """Build the canonical op list as an array, overlaid with computed stats."""
    # Start with canonical ops
    matrix_map = {}
    for co in _canonical_ops():
        key = co['operation']
        matrix_map[key] = {
            'operation': key,
            'domain': co['domain'],
            'tier': co['tier'],
            'gateway': co['gateway'],
            'mcp_calls': 0,
            'cli_calls': 0,
            'avg_mcp_ms': None,
            'avg_cli_ms': None,
            'tested': False,
        }

    # Overlay stats from grade runs
    for op_key, d in op_stats.items():
        if op_key not in matrix_map:
            parts = op_key.split('.', 1)
            matrix_map[op_key] = {
                'operation': op_key,
                'domain': parts[0] if parts else 'unknown',
                'tier': 0,
                'gateway': 'query',
                'mcp_calls': 0,
                'cli_calls': 0,
                'avg_mcp_ms': None,
                'avg_cli_ms': None,
                'tested': False,
            }
        mcp_calls = d.get('mcp_calls', 0) or 0
        cli_calls = d.get('cli_calls', 0) or 0
        matrix_map[op_key]['mcp_calls'] = mcp_calls
        matrix_map[op_key]['cli_calls'] = cli_calls
        matrix_map[op_key]['avg_mcp_ms'] = d.get('avg_mcp_ms')
        matrix_map[op_key]['avg_cli_ms'] = d.get('avg_cli_ms')
        matrix_map[op_key]['tested'] = bool(mcp_calls or cli_calls)

    # Return as sorted array (HTML viewer expects array)
    return sorted(matrix_map.values(), key=lambda o: o['operation'])


def build_api_surface():
    """Return current canonical + compatibility grade analytics API guidance."""
    return {
        'canonical': {
            'query': [
                'check.grade',
                'check.grade.list',
                'admin.token?action=summary',
                'admin.token?action=list',
                'admin.token?action=show',
            ],
            'mutate': [
                'admin.token?action=record',
                'admin.token?action=delete',
                'admin.token?action=clear',
            ],
        },
        'compatibility': {
            'query': [
                'admin.grade',
                'admin.grade.list',
                'admin.token.summary',
                'admin.token.list',
                'admin.token.show',
            ],
            'mutate': [
                'admin.token.record',
                'admin.token.delete',
                'admin.token.clear',
            ],
        },
        'handlerOnly': [
            'admin.grade.run.list',
            'admin.grade.run.show',
        ],
        'planned': [
            'admin.grade.run.slot.show',
            'admin.grade.run.timing.list',
            'admin.grade.run.timing.show',
            'admin.grade.run.comparison.list',
            'admin.grade.run.comparison.show',
            'admin.grade.run.analysis.list',
            'admin.grade.run.analysis.show',
            'admin.grade.run.summary.show',
            'admin.grade.eval.list',
            'admin.grade.eval.show',
        ],
        'webApi': {
            'queryEndpoint': '/api/query',
            'mutateEndpoint': '/api/mutate',
            'lafsHeaders': [
                'X-Cleo-Request-Id',
                'X-Cleo-Exit-Code',
                'X-Cleo-Transport',
                'X-Cleo-Operation',
                'X-Cleo-Domain',
            ],
            'transportAliasNote': 'Treat persisted transport=api as equivalent to http during the compatibility window.',
        },
    }


# ---------------------------------------------------------------------------
# Embedded data builder
# ---------------------------------------------------------------------------

def build_embedded_data(workspace, skill_dir=None):
    """Build the full embedded data dict for the viewer (9 keys)."""
    workspace = Path(workspace).resolve()

    # 1. Grades
    grades_path = workspace / '.cleo' / 'metrics' / 'GRADES.jsonl'
    grades = load_grades_jsonl(str(grades_path))

    # 2. Sessions (from SQLite)
    sessions = load_sessions(workspace)

    # 3. Grade runs (manifests + summaries)
    grade_runs = load_grade_runs(workspace)
    ab_results = grade_runs[0]['summary'] if grade_runs and grade_runs[0].get('summary') else {}
    ab_history = [r['manifest'] for r in grade_runs]

    # 4. Token analysis (from SQLite)
    token_analysis = load_token_analysis(workspace)

    # 5. Operation matrix (canonical ops + grade-run stats)
    op_stats = compute_per_operation_stats(workspace)
    operation_matrix = build_operation_matrix(op_stats)

    # 6. Eval report
    eval_report = load_eval_report(workspace, skill_dir)

    # 7. Live session
    live_session = load_live_session(workspace)

    # 8. Enrich grades with token metadata from token_usage
    grades = enrich_grades_with_tokens(grades, workspace)

    # 9. API surface guidance
    api_surface = build_api_surface()

    # 10. Grade summary stats
    def compute_grade_summary(grades_list, sessions_list):
        if not grades_list:
            return {'total': 0, 'graded': 0, 'avgScore': None, 'distribution': {}}
        scores = [g.get('totalScore') for g in grades_list if g.get('totalScore') is not None]
        by_letter = {}
        for sc in scores:
            letter = scoreToLetter(sc)
            by_letter[letter] = by_letter.get(letter, 0) + 1
        graded_sessions = sum(1 for s in sessions_list if s.get('gradeScore') is not None)
        return {
            'total': len(grades_list),
            'graded': graded_sessions,
            'avgScore': round(sum(scores) / len(scores), 1) if scores else None,
            'maxScore': max(scores) if scores else None,
            'minScore': min(scores) if scores else None,
            'distribution': by_letter,
        }

    grade_summary = compute_grade_summary(grades, sessions)

    return {
        'grades': grades,
        'sessions': sessions,
        'ab_results': ab_results,
        'ab_history': ab_history,
        'token_analysis': token_analysis,
        'operation_matrix': operation_matrix,
        'eval_report': {'evals': eval_report},
        'grade_summary': grade_summary,
        'live_session': live_session,
        'api_surface': api_surface,
        'metadata': {
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'workspace': str(workspace),
            'skill_version': '1.1.0',
            'grade_count': len(grades),
            'session_count': len(sessions),
        },
    }


# ---------------------------------------------------------------------------
# HTML generator
# ---------------------------------------------------------------------------

def generate_html(data, template):
    """Embed data into grade-review.html template. Returns full HTML string."""
    data_json = json.dumps(data, ensure_ascii=False, default=str)
    return template.replace('{{EMBEDDED_DATA}}', data_json)


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

def _kill_port(port):
    try:
        result = subprocess.run(
            ['lsof', '-ti', ':{}'.format(port)],
            capture_output=True, text=True, timeout=5,
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
    """Serves the grade review HTML and JSON API endpoints."""

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ('/', '', '/index.html'):
            self._serve_main()
        elif path == '/live-data':
            self._serve_live_data()
        elif path.startswith('/sessions-data'):
            self._serve_session_data(parsed)
        else:
            self.send_error(404)

    def _serve_main(self):
        try:
            data = build_embedded_data(self.server.workspace, self.server.skill_dir)
            html = generate_html(data, self.server.template)
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

    def _serve_live_data(self):
        try:
            live = load_live_session(self.server.workspace)
            body = json.dumps({'live_session': live}, default=str).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            err = json.dumps({'error': str(e), 'live_session': {'session_id': None, 'entries': []}}).encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(err)))
            self.end_headers()
            self.wfile.write(err)

    def _serve_session_data(self, parsed):
        try:
            params = parse_qs(parsed.query)
            session_id = params.get('sessionId', [None])[0]
            data = load_session_detail(self.server.workspace, session_id)
            body = json.dumps(data, default=str).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            err = json.dumps({'error': str(e), 'entries': [], 'tokens': {}}).encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(err)))
            self.end_headers()
            self.wfile.write(err)

    def log_message(self, fmt, *args):
        pass  # suppress access logs


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='CLEO Grade Review viewer (v1.1 API-aware)')
    parser.add_argument('workspace', type=Path, help='Project or results directory to scan')
    parser.add_argument('--port', '-p', type=int, default=3118)
    parser.add_argument('--static', '-s', type=Path, default=None,
                        help='Write standalone HTML to this path instead of serving')
    parser.add_argument('--skill-dir', default=None,
                        help='Override skill directory (default: auto-detect from __file__)')
    parser.add_argument('--no-browser', action='store_true', help='Do not auto-open browser')
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    if not workspace.exists():
        print('ERROR: workspace does not exist: {}'.format(workspace), file=sys.stderr)
        sys.exit(1)

    # Auto-detect skill_dir: generator is in eval-viewer/, skill root is one level up
    skill_dir = args.skill_dir or str(Path(__file__).parent.parent)

    # Load template once
    template_path = Path(__file__).parent / 'grade-review.html'
    if not template_path.exists():
        print('ERROR: grade-review.html not found at {}'.format(template_path), file=sys.stderr)
        sys.exit(1)
    template = template_path.read_text(encoding='utf-8')

    data = build_embedded_data(workspace, skill_dir)

    grade_count = len(data.get('grades', []))
    session_count = len(data.get('sessions', []))
    eval_count = len(data.get('eval_report', {}).get('evals', []))
    op_count = len(data.get('operation_matrix', []))

    print('\n  ct-grade Review Viewer', file=sys.stderr)
    print('  {}'.format('\u2500' * 40), file=sys.stderr)
    print('  Workspace    : {}'.format(workspace), file=sys.stderr)
    print('  Grades       : {}'.format(grade_count), file=sys.stderr)
    print('  Sessions     : {}'.format(session_count), file=sys.stderr)
    print('  Eval reports : {}'.format(eval_count), file=sys.stderr)
    print('  Op matrix    : {} operations'.format(op_count), file=sys.stderr)

    if not grade_count and not session_count:
        print('\n  WARNING: No data found. Run a grading scenario first.', file=sys.stderr)

    if args.static:
        html = generate_html(data, template)
        args.static.parent.mkdir(parents=True, exist_ok=True)
        args.static.write_text(html, encoding='utf-8')
        print('\n  Static viewer written to: {}'.format(args.static), file=sys.stderr)
        sys.exit(0)

    port = args.port
    _kill_port(port)

    try:
        server = HTTPServer(('127.0.0.1', port), GradeReviewHandler)
    except OSError:
        server = HTTPServer(('127.0.0.1', 0), GradeReviewHandler)
        port = server.server_address[1]

    # Attach workspace and template to server for handler access
    server.workspace = workspace
    server.skill_dir = skill_dir
    server.template = template

    url = 'http://localhost:{}'.format(port)
    print('  URL          : {}'.format(url), file=sys.stderr)
    print('\n  Refreshing the browser re-scans the workspace for new results.', file=sys.stderr)
    print('  /live-data and /sessions-data?sessionId=X for JSON API.', file=sys.stderr)
    print('  Press Ctrl+C to stop.\n', file=sys.stderr)

    def handle_sigint(sig, frame):
        print('\nStopped.', file=sys.stderr)
        server.server_close()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_sigint)

    if not args.no_browser:
        webbrowser.open(url)

    server.serve_forever()


if __name__ == '__main__':
    main()
