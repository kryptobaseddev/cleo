#!/usr/bin/env python3
"""
build_op_stats.py — Aggregate operations.jsonl files from grade runs into per-operation statistics.

Reads all operations.jsonl files under --grade-runs-dir and computes per-operation stats
split by interface (mcp/cli). Output is a JSON object keyed by "domain.operation".

Usage:
    python build_op_stats.py [options]

Options:
    --grade-runs-dir PATH    Directory containing grade run subdirectories
                             (default: .cleo/metrics/grade-runs relative to cwd)
    --output PATH            Output JSON file path
                             (default: .cleo/metrics/per_operation_stats.json)
    --pretty                 Pretty-print JSON output (default: compact)
    --verbose                Print progress to stderr

Output format (per key "domain.operation"):
{
    "mcp_calls": 42,
    "cli_calls": 10,
    "total_mcp_ms": 1234.5,
    "total_cli_ms": 456.7,
    "avg_mcp_ms": 29.4,
    "avg_cli_ms": 45.7,
    "runs_seen": 3
}

Also importable as a module:
    from build_op_stats import compute_stats
    stats = compute_stats(grade_runs_dir="/path/to/grade-runs")
"""

import argparse
import json
import sys
from pathlib import Path


def compute_stats(grade_runs_dir, verbose=False):
    """
    Aggregate operations.jsonl files under grade_runs_dir.

    Returns dict keyed by "domain.operation" with accumulated stats.
    """
    runs_dir = Path(grade_runs_dir)
    stats = {}
    files_processed = 0
    lines_processed = 0

    if not runs_dir.exists():
        if verbose:
            print(f"[build_op_stats] Grade runs dir not found: {runs_dir}", file=sys.stderr)
        return stats

    for ops_file in sorted(runs_dir.rglob('operations.jsonl')):
        files_processed += 1
        if verbose:
            print(f"[build_op_stats] Processing: {ops_file}", file=sys.stderr)

        for line in ops_file.read_text(errors='replace').splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            domain = entry.get('domain', 'unknown')
            operation = entry.get('operation', 'unknown')
            key = f"{domain}.{operation}"
            interface = entry.get('interface', 'mcp')
            duration = float(entry.get('duration_ms', 0) or 0)

            if key not in stats:
                stats[key] = {
                    'mcp_calls': 0,
                    'cli_calls': 0,
                    'total_mcp_ms': 0.0,
                    'total_cli_ms': 0.0,
                    'avg_mcp_ms': 0.0,
                    'avg_cli_ms': 0.0,
                    'runs_seen': set(),
                }

            # Track which run directory this came from
            # ops_file is e.g. .../grade-runs/run-20260308/s1/run-01/arm-mcp/operations.jsonl
            # run_id is the first path component relative to runs_dir (e.g. "run-20260308")
            run_id = ops_file.relative_to(runs_dir).parts[0]
            stats[key]['runs_seen'].add(run_id)

            if interface == 'cli':
                stats[key]['cli_calls'] += 1
                stats[key]['total_cli_ms'] += duration
            else:
                stats[key]['mcp_calls'] += 1
                stats[key]['total_mcp_ms'] += duration

            lines_processed += 1

    # Compute averages and convert sets to counts
    for key, v in stats.items():
        mc = v['mcp_calls']
        cc = v['cli_calls']
        v['avg_mcp_ms'] = round(v['total_mcp_ms'] / mc, 2) if mc > 0 else 0.0
        v['avg_cli_ms'] = round(v['total_cli_ms'] / cc, 2) if cc > 0 else 0.0
        v['total_mcp_ms'] = round(v['total_mcp_ms'], 2)
        v['total_cli_ms'] = round(v['total_cli_ms'], 2)
        v['runs_seen'] = len(v['runs_seen'])

    if verbose:
        print(f"[build_op_stats] Processed {files_processed} files, {lines_processed} lines → {len(stats)} unique operations", file=sys.stderr)

    return stats


def find_cleo_dir(start='.'):
    """Walk up from start to find directory containing .cleo/tasks.db."""
    p = Path(start).resolve()
    while p != p.parent:
        if (p / '.cleo' / 'tasks.db').exists():
            return p
        p = p.parent
    return Path(start).resolve()


def main():
    parser = argparse.ArgumentParser(
        description='Aggregate grade run operations.jsonl files into per-operation stats.'
    )
    parser.add_argument(
        '--grade-runs-dir',
        default=None,
        help='Directory containing grade run subdirectories (default: .cleo/metrics/grade-runs)'
    )
    parser.add_argument(
        '--output',
        default=None,
        help='Output JSON path (default: .cleo/metrics/per_operation_stats.json)'
    )
    parser.add_argument(
        '--pretty',
        action='store_true',
        help='Pretty-print JSON output'
    )
    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Print progress to stderr'
    )
    args = parser.parse_args()

    workspace = find_cleo_dir('.')

    grade_runs_dir = args.grade_runs_dir or str(workspace / '.cleo' / 'metrics' / 'grade-runs')
    output_path = args.output or str(workspace / '.cleo' / 'metrics' / 'per_operation_stats.json')

    stats = compute_stats(grade_runs_dir, verbose=args.verbose)

    indent = 2 if args.pretty else None
    output_json = json.dumps(stats, indent=indent)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(output_json)

    print(f"Wrote {len(stats)} operation stats to {output_path}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
