"""
audit_analyzer.py — Read CLEO tasks.db audit_log and extract MCP vs CLI performance stats.

Usage:
    python scripts/audit_analyzer.py [--project-dir .] [--output-dir ab-results] [--json]
"""

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path


def find_tasks_db(project_dir: Path) -> Path | None:
    """Walk up from project_dir to find .cleo/tasks.db (up to 5 levels)."""
    current = project_dir.resolve()
    for _ in range(5):
        candidate = current / ".cleo" / "tasks.db"
        if candidate.exists():
            return candidate
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


def query_per_operation(conn: sqlite3.Connection) -> list[dict]:
    sql = """
        SELECT
            domain,
            operation,
            source,
            COUNT(*) AS call_count,
            SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS success_count,
            AVG(duration_ms) AS avg_ms,
            MIN(duration_ms) AS min_ms,
            MAX(duration_ms) AS max_ms,
            AVG(LENGTH(COALESCE(details_json, ''))) AS avg_chars
        FROM audit_log
        WHERE domain IS NOT NULL AND operation IS NOT NULL
        GROUP BY domain, operation, source
        ORDER BY domain, operation, source
    """
    cursor = conn.execute(sql)
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def query_session_ratio(conn: sqlite3.Connection) -> list[dict]:
    sql = """
        SELECT
            source,
            COUNT(DISTINCT session_id) AS session_count,
            COUNT(*) AS total_ops
        FROM audit_log
        WHERE source IS NOT NULL
        GROUP BY source
    """
    cursor = conn.execute(sql)
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def build_per_operation_stats(rows: list[dict], session_rows: list[dict]) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    by_operation: dict[str, dict] = {}
    total_ops = 0

    for row in rows:
        key = f"{row['domain']}.{row['operation']}"
        source = row["source"] or "unknown"
        call_count = int(row["call_count"] or 0)
        success_count = int(row["success_count"] or 0)
        avg_ms = float(row["avg_ms"]) if row["avg_ms"] is not None else 0.0
        min_ms = int(row["min_ms"]) if row["min_ms"] is not None else 0
        max_ms = int(row["max_ms"]) if row["max_ms"] is not None else 0
        avg_chars = float(row["avg_chars"]) if row["avg_chars"] is not None else 0.0

        success_rate = round(success_count / call_count, 4) if call_count > 0 else 0.0

        if key not in by_operation:
            by_operation[key] = {}

        by_operation[key][source] = {
            "calls": call_count,
            "success_rate": success_rate,
            "avg_ms": round(avg_ms, 2),
            "min_ms": min_ms,
            "max_ms": max_ms,
            "avg_chars": round(avg_chars, 2),
        }
        total_ops += call_count

    session_ratio: dict[str, dict] = {}
    for sr in session_rows:
        src = sr["source"] or "unknown"
        session_ratio[src] = {
            "session_count": int(sr["session_count"] or 0),
            "total_ops": int(sr["total_ops"] or 0),
        }

    return {
        "generated_at": now,
        "total_ops_analyzed": total_ops,
        "by_operation": by_operation,
        "session_ratio": session_ratio,
    }


def build_operation_coverage(rows: list[dict]) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    coverage: dict[str, dict] = {}
    domains_seen: set[str] = set()

    for row in rows:
        key = f"{row['domain']}.{row['operation']}"
        source = row["source"] or "unknown"
        call_count = int(row["call_count"] or 0)
        domains_seen.add(row["domain"])

        if key not in coverage:
            coverage[key] = {"tested": True, "mcp_calls": 0, "cli_calls": 0}

        if source == "mcp":
            coverage[key]["mcp_calls"] += call_count
        elif source == "cli":
            coverage[key]["cli_calls"] += call_count

    return {
        "generated_at": now,
        "coverage": coverage,
        "total_operations_seen": len(coverage),
        "domains_seen": sorted(domains_seen),
    }


def print_summary(
    db_path: Path,
    stats: dict,
    coverage: dict,
    output_dir: Path,
) -> None:
    total_ops = stats["total_ops_analyzed"]
    session_ratio = stats.get("session_ratio", {})
    mcp_ops = session_ratio.get("mcp", {}).get("total_ops", 0)
    cli_ops = session_ratio.get("cli", {}).get("total_ops", 0)
    grand_total = mcp_ops + cli_ops
    mcp_pct = round(mcp_ops / grand_total * 100) if grand_total > 0 else 0
    cli_pct = round(cli_ops / grand_total * 100) if grand_total > 0 else 0

    # Top operations by total call count (mcp + cli combined)
    by_op = stats["by_operation"]
    op_totals = []
    for op_key, sources in by_op.items():
        total = sum(s["calls"] for s in sources.values())
        mcp_calls = sources.get("mcp", {}).get("calls", 0)
        cli_calls = sources.get("cli", {}).get("calls", 0)
        op_totals.append((op_key, total, mcp_calls, cli_calls))
    op_totals.sort(key=lambda x: x[1], reverse=True)

    print("  Audit Analyzer")
    print("  " + "\u2500" * 34)
    print(f"  DB path   : {db_path}")
    print(f"  Total ops : {total_ops:,} rows analyzed")
    print(f"  Operations: {coverage['total_operations_seen']} unique domain.operation pairs")
    print(f"  MCP ops   : {mcp_ops:,} ({mcp_pct}%)")
    print(f"  CLI ops   : {cli_ops:,} ({cli_pct}%)")
    print()
    print("  Top operations by call count:")
    for op_key, _total, mcp_c, cli_c in op_totals[:10]:
        print(f"    {op_key:<20} mcp={mcp_c:<6} cli={cli_c}")
    print()
    print(f"  Written: {output_dir / 'per_operation_stats.json'}")
    print(f"  Written: {output_dir / 'operation_coverage.json'}")


def empty_stats() -> dict:
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_ops_analyzed": 0,
        "by_operation": {},
        "session_ratio": {},
    }


def empty_coverage() -> dict:
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "coverage": {},
        "total_operations_seen": 0,
        "domains_seen": [],
    }


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract MCP vs CLI performance stats from CLEO audit_log."
    )
    parser.add_argument(
        "--project-dir",
        default=".",
        help="Root of the CLEO project (default: current directory)",
    )
    parser.add_argument(
        "--output-dir",
        default="ab-results",
        help="Directory to write output JSON files (default: ab-results)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable JSON summary to stdout instead of human-readable text",
    )
    args = parser.parse_args()

    project_dir = Path(args.project_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    stats_path = output_dir / "per_operation_stats.json"
    coverage_path = output_dir / "operation_coverage.json"

    db_path = find_tasks_db(project_dir)
    if db_path is None:
        print(
            f"Warning: could not find .cleo/tasks.db under {project_dir.resolve()} "
            "(searched up to 5 levels). Writing empty output files.",
            file=sys.stderr,
        )
        write_json(stats_path, empty_stats())
        write_json(coverage_path, empty_coverage())
        return 0

    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            per_op_rows = query_per_operation(conn)
            session_rows = query_session_ratio(conn)
        except sqlite3.OperationalError as exc:
            print(
                f"Warning: audit_log table not found or query failed ({exc}). "
                "Writing empty output files.",
                file=sys.stderr,
            )
            write_json(stats_path, empty_stats())
            write_json(coverage_path, empty_coverage())
            return 0
        finally:
            conn.close()
    except sqlite3.DatabaseError as exc:
        print(f"Warning: could not open {db_path}: {exc}. Writing empty output files.", file=sys.stderr)
        write_json(stats_path, empty_stats())
        write_json(coverage_path, empty_coverage())
        return 0

    stats = build_per_operation_stats(per_op_rows, session_rows)
    coverage = build_operation_coverage(per_op_rows)

    write_json(stats_path, stats)
    write_json(coverage_path, coverage)

    if args.json:
        print(json.dumps({"stats": stats, "coverage": coverage}, indent=2))
    else:
        print_summary(db_path, stats, coverage, output_dir)

    return 0


if __name__ == "__main__":
    sys.exit(main())
