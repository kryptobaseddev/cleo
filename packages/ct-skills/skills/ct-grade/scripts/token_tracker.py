#!/usr/bin/env python3
"""
token_tracker.py — Three-layer token estimation chain for ct-grade v3.

Three estimation layers (tried in order, first success wins):
  Layer 1 — OTel (REAL):      Read ~/.cleo/metrics/otel/ telemetry
  Layer 2 — chars/4 (ESTIMATED): response_chars / 4 approximation
  Layer 3 — Coarse (COARSE):  entry_count × op_type_average

Usage:
    python scripts/token_tracker.py --run-dir ./ab-results/run-001
    python scripts/token_tracker.py --grades-file .cleo/metrics/GRADES.jsonl
    python scripts/token_tracker.py --run-dir ./ab-results/run-001 \\
        --grades-file .cleo/metrics/GRADES.jsonl \\
        --project-dir . \\
        --output token-summary.json
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CONFIDENCE_LEVELS = {
    "otel": "REAL",
    "chars": "ESTIMATED",
    "coarse": "COARSE",
}

OP_TOKEN_AVERAGES = {
    "tasks.find": 750,
    "tasks.list": 3000,
    "tasks.show": 600,
    "tasks.exists": 300,
    "tasks.tree": 800,
    "tasks.plan": 900,
    "session.status": 350,
    "session.list": 400,
    "session.briefing.show": 500,
    "admin.dash": 500,
    "admin.help": 800,
    "admin.health": 300,
    "admin.stats": 600,
    "memory.find": 600,
    "memory.timeline": 500,
    "tools.skill.list": 400,
    "tools.skill.show": 350,
    "default": 400,
}

MCP_OVERHEAD_PER_OP = 200  # approximate MCP framing tokens per operation


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mean(values):
    return sum(values) / len(values) if values else 0


def _stddev(values):
    if len(values) < 2:
        return 0
    m = _mean(values)
    return math.sqrt(sum((x - m) ** 2 for x in values) / (len(values) - 1))


def _stats(values):
    if not values:
        return {"mean": None, "stddev": None, "min": None, "max": None, "count": 0}
    return {
        "mean": round(_mean(values), 1),
        "stddev": round(_stddev(values), 1),
        "min": min(values),
        "max": max(values),
        "count": len(values),
    }


def _op_key(domain, operation):
    """Return OP_TOKEN_AVERAGES lookup key for a domain+operation pair."""
    full = f"{domain}.{operation}"
    return full if full in OP_TOKEN_AVERAGES else "default"


def _tokens_for_op(domain, operation):
    return OP_TOKEN_AVERAGES[_op_key(domain, operation)]


# ---------------------------------------------------------------------------
# Layer 1 — OTel (REAL)
# ---------------------------------------------------------------------------

def _scan_otel(otel_dir: Path, session_id: str | None = None) -> int | None:
    """
    Scan ~/.cleo/metrics/otel/ for claude_code.token.usage entries.

    Returns total token count if any relevant entries found, else None.
    """
    if not otel_dir.is_dir():
        return None

    total = 0
    found = False
    for fpath in otel_dir.iterdir():
        if fpath.suffix not in (".jsonl", ".json"):
            continue
        try:
            with open(fpath, encoding="utf-8") as fh:
                for raw_line in fh:
                    raw_line = raw_line.strip()
                    if not raw_line:
                        continue
                    try:
                        entry = json.loads(raw_line)
                    except json.JSONDecodeError:
                        continue
                    if entry.get("name") != "claude_code.token.usage":
                        continue
                    attrs = entry.get("attributes", {})
                    if session_id and attrs.get("session_id") not in (None, session_id):
                        continue
                    value = entry.get("value")
                    if isinstance(value, (int, float)):
                        total += int(value)
                        found = True
        except OSError:
            continue

    return total if found else None


def layer1_otel(session_id: str | None = None) -> dict | None:
    """
    Layer 1: OTel telemetry.

    Returns dict with total_tokens and method/confidence, or None if unavailable.
    """
    otel_dir = Path.home() / ".cleo" / "metrics" / "otel"
    tokens = _scan_otel(otel_dir, session_id)
    if tokens is None:
        return None
    return {
        "method": "otel",
        "confidence": CONFIDENCE_LEVELS["otel"],
        "total_tokens": tokens,
    }


# ---------------------------------------------------------------------------
# Layer 2 — chars/4 (ESTIMATED)
# ---------------------------------------------------------------------------

def _collect_response_chars(run_dir: Path) -> int:
    """
    Recursively find response.json files and sum their serialised character lengths.
    """
    total_chars = 0
    for rpath in run_dir.rglob("response.json"):
        try:
            with open(rpath, encoding="utf-8") as fh:
                data = json.load(fh)
            total_chars += len(json.dumps(data))
        except (OSError, json.JSONDecodeError):
            continue
    return total_chars


def _collect_timing_tokens(run_dir: Path) -> int | None:
    """
    Collect total_tokens from timing.json files that already have the field.
    Returns sum if any found, else None.
    """
    total = 0
    found = False
    for tpath in run_dir.rglob("timing.json"):
        try:
            with open(tpath, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data.get("total_tokens"), (int, float)):
                total += int(data["total_tokens"])
                found = True
        except (OSError, json.JSONDecodeError):
            continue
    return total if found else None


def layer2_chars(run_dir_str: str | None) -> dict | None:
    """
    Layer 2: chars/4 approximation from run directory.

    Prefers timing.json total_tokens where already set; falls back to
    response.json character counts / 4.

    Returns dict with total_tokens, method, confidence, or None if no run_dir.
    """
    if not run_dir_str:
        return None
    run_dir = Path(run_dir_str)
    if not run_dir.is_dir():
        return None

    # Prefer pre-computed timing tokens
    timing_tokens = _collect_timing_tokens(run_dir)
    if timing_tokens is not None and timing_tokens > 0:
        return {
            "method": "chars",
            "confidence": CONFIDENCE_LEVELS["chars"],
            "total_tokens": timing_tokens,
            "source": "timing.json",
        }

    # Fall back to response char counting
    total_chars = _collect_response_chars(run_dir)
    if total_chars == 0:
        return None

    estimated = max(1, total_chars // 4)
    return {
        "method": "chars",
        "confidence": CONFIDENCE_LEVELS["chars"],
        "total_tokens": estimated,
        "source": "response_chars/4",
        "total_chars": total_chars,
    }


# ---------------------------------------------------------------------------
# Layer 3 — Coarse (COARSE)
# ---------------------------------------------------------------------------

def _parse_audit_ops(project_dir_str: str | None) -> list[dict]:
    """
    Attempt to read operation records from tasks.db audit log or any
    audit-log.jsonl file under project_dir. Returns list of op dicts with
    keys: domain, operation, gateway.
    """
    if not project_dir_str:
        return []

    project_dir = Path(project_dir_str)
    ops = []

    # Look for a JSONL audit log
    for candidate in (
        project_dir / ".cleo" / "audit-log.jsonl",
        project_dir / ".cleo" / "audit.jsonl",
        project_dir / "audit-log.jsonl",
    ):
        if candidate.is_file():
            try:
                with open(candidate, encoding="utf-8") as fh:
                    for raw in fh:
                        raw = raw.strip()
                        if not raw:
                            continue
                        try:
                            entry = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        domain = entry.get("domain", "")
                        operation = entry.get("operation", "")
                        gateway = entry.get("gateway", "mcp")
                        if domain and operation:
                            ops.append(
                                {"domain": domain, "operation": operation, "gateway": gateway}
                            )
            except OSError:
                pass
            if ops:
                return ops

    return ops


def layer3_coarse(
    ops: list[dict] | None = None, entry_count: int = 0
) -> dict:
    """
    Layer 3: Coarse estimation using OP_TOKEN_AVERAGES.

    Uses ops list if available, otherwise assumes entry_count operations of
    the default average type.
    """
    if ops:
        total = 0
        per_op: dict[str, int] = {}
        for op in ops:
            key = f"{op.get('domain', '')}.{op.get('operation', '')}"
            avg = OP_TOKEN_AVERAGES.get(key, OP_TOKEN_AVERAGES["default"])
            total += avg
            per_op[key] = per_op.get(key, 0) + avg
        return {
            "method": "coarse",
            "confidence": CONFIDENCE_LEVELS["coarse"],
            "total_tokens": total,
            "per_operation": per_op,
        }

    # No ops available — multiply entry_count by default average
    fallback_count = max(entry_count, 1)
    total = fallback_count * OP_TOKEN_AVERAGES["default"]
    return {
        "method": "coarse",
        "confidence": CONFIDENCE_LEVELS["coarse"],
        "total_tokens": total,
        "per_operation": {},
    }


# ---------------------------------------------------------------------------
# Three-layer resolution
# ---------------------------------------------------------------------------

def resolve_tokens(
    run_dir: str | None = None,
    project_dir: str | None = None,
    session_id: str | None = None,
    entry_count: int = 0,
) -> dict:
    """
    Try layers in order: OTel → chars/4 → coarse.
    Returns the first successful result, always guaranteed to return something.
    """
    # Layer 1
    result = layer1_otel(session_id)
    if result:
        return result

    # Layer 2
    result = layer2_chars(run_dir)
    if result:
        return result

    # Layer 3
    ops = _parse_audit_ops(project_dir)
    return layer3_coarse(ops=ops if ops else None, entry_count=entry_count)


# ---------------------------------------------------------------------------
# Per-operation breakdown helpers
# ---------------------------------------------------------------------------

def _build_per_operation(ops: list[dict]) -> dict[str, int]:
    """Build per-operation token map from a list of op dicts."""
    result: dict[str, int] = {}
    for op in ops:
        key = f"{op.get('domain', '')}.{op.get('operation', '')}"
        avg = OP_TOKEN_AVERAGES.get(key, OP_TOKEN_AVERAGES["default"])
        result[key] = result.get(key, 0) + avg
    return result


def _build_by_domain(ops: list[dict]) -> dict[str, dict]:
    """Aggregate estimated tokens and op count by domain."""
    by_domain: dict[str, dict] = {}
    for op in ops:
        domain = op.get("domain", "unknown")
        key = f"{domain}.{op.get('operation', '')}"
        avg = OP_TOKEN_AVERAGES.get(key, OP_TOKEN_AVERAGES["default"])
        if domain not in by_domain:
            by_domain[domain] = {"estimated_tokens": 0, "ops_count": 0}
        by_domain[domain]["estimated_tokens"] += avg
        by_domain[domain]["ops_count"] += 1
    return by_domain


def _build_mcp_vs_cli(ops: list[dict]) -> dict[str, dict]:
    """Split token totals between mcp and cli gateways."""
    result: dict[str, dict] = {
        "mcp": {"estimated_tokens": 0, "ops_count": 0},
        "cli": {"estimated_tokens": 0, "ops_count": 0},
    }
    for op in ops:
        gw = op.get("gateway", "mcp")
        if gw not in result:
            result[gw] = {"estimated_tokens": 0, "ops_count": 0}
        key = f"{op.get('domain', '')}.{op.get('operation', '')}"
        avg = OP_TOKEN_AVERAGES.get(key, OP_TOKEN_AVERAGES["default"])
        result[gw]["estimated_tokens"] += avg
        result[gw]["ops_count"] += 1
    return result


# ---------------------------------------------------------------------------
# token-summary.json builder
# ---------------------------------------------------------------------------

def build_summary(
    run_dir: str | None,
    project_dir: str | None,
    session_id: str | None = None,
) -> dict:
    """Build the full token-summary.json structure."""
    ops = _parse_audit_ops(project_dir)
    resolution = resolve_tokens(
        run_dir=run_dir,
        project_dir=project_dir,
        session_id=session_id,
        entry_count=len(ops),
    )

    method = resolution["method"]
    confidence = resolution["confidence"]
    total_tokens = resolution["total_tokens"]

    by_domain = _build_by_domain(ops) if ops else {}
    mcp_vs_cli = _build_mcp_vs_cli(ops) if ops else {
        "mcp": {"estimated_tokens": 0, "ops_count": 0},
        "cli": {"estimated_tokens": 0, "ops_count": 0},
    }

    note = f"Confidence: {confidence} ({method}"
    if method == "otel":
        note += "). Real token counts from OpenTelemetry."
    elif method == "chars":
        note += "/4). Enable OTel for REAL token counts."
    else:
        note += " average). Enable OTel for REAL token counts."

    return {
        "run_dir": str(Path(run_dir).resolve()) if run_dir else None,
        "confidence": confidence,
        "method": method,
        "total_tokens": total_tokens,
        "by_domain": by_domain,
        "mcp_vs_cli": mcp_vs_cli,
        "score_per_1k_tokens": None,
        "note": note,
    }


# ---------------------------------------------------------------------------
# _tokenMeta enrichment for GRADES.jsonl
# ---------------------------------------------------------------------------

def _build_token_meta(
    grade_entry: dict,
    run_dir: str | None,
    project_dir: str | None,
) -> dict:
    """
    Build _tokenMeta for a single GRADES.jsonl entry.

    Tries all three layers; adds per-operation breakdown from audit ops when
    available, otherwise infers from grade entry fields.
    """
    session_id = grade_entry.get("session_id")

    # Gather any ops referenced in the entry itself (heuristic)
    entry_ops: list[dict] = []
    if "operations" in grade_entry and isinstance(grade_entry["operations"], list):
        entry_ops = grade_entry["operations"]
    elif "audit" in grade_entry and isinstance(grade_entry["audit"], list):
        entry_ops = grade_entry["audit"]

    # Try project-level audit log first; fall back to entry-level ops
    project_ops = _parse_audit_ops(project_dir)
    ops_to_use = project_ops if project_ops else entry_ops

    resolution = resolve_tokens(
        run_dir=run_dir,
        project_dir=project_dir,
        session_id=session_id,
        entry_count=len(ops_to_use) or 1,
    )

    per_op = _build_per_operation(ops_to_use) if ops_to_use else {}

    return {
        "method": resolution["method"],
        "confidence": resolution["confidence"],
        "total_tokens": resolution["total_tokens"],
        "mcp_token_overhead": MCP_OVERHEAD_PER_OP * max(len(ops_to_use), 1),
        "per_operation": per_op,
    }


def enrich_grades_file(grades_path: str, run_dir: str | None, project_dir: str | None) -> int:
    """
    Read GRADES.jsonl, add _tokenMeta to entries that lack it, rewrite file.

    Returns count of entries enriched.
    """
    path = Path(grades_path)
    if not path.is_file():
        print(f"ERROR: Grades file not found: {grades_path}", file=sys.stderr)
        sys.exit(1)

    entries = []
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                entries.append(json.loads(raw))
            except json.JSONDecodeError as exc:
                print(f"  WARN: Skipping malformed line: {exc}", file=sys.stderr)

    enriched_count = 0
    updated = []
    for entry in entries:
        if "_tokenMeta" not in entry:
            entry["_tokenMeta"] = _build_token_meta(entry, run_dir, project_dir)
            enriched_count += 1
        updated.append(entry)

    # Rewrite file atomically (write to temp, then rename)
    tmp_path = path.with_suffix(".jsonl.tmp")
    with open(tmp_path, "w", encoding="utf-8") as fh:
        for entry in updated:
            fh.write(json.dumps(entry, separators=(",", ":")) + "\n")
    tmp_path.replace(path)

    return enriched_count


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------

def _fmt_tokens(value: int, confidence: str) -> str:
    return f"{value:,} tokens ({confidence})"


def print_summary(summary: dict) -> None:
    confidence = summary["confidence"]
    total = summary["total_tokens"]
    method = summary["method"]

    print(f"\nToken Summary")
    print("=" * 52)
    print(f"  Total:      {_fmt_tokens(total, confidence)}")
    print(f"  Method:     {method}")

    by_domain = summary.get("by_domain", {})
    if by_domain:
        print(f"\n  By Domain:")
        for domain, info in sorted(by_domain.items()):
            t = info["estimated_tokens"]
            n = info["ops_count"]
            print(f"    {domain:<20} {_fmt_tokens(t, confidence)}  ({n} op{'s' if n != 1 else ''})")

    mcp_cli = summary.get("mcp_vs_cli", {})
    if any(v["ops_count"] for v in mcp_cli.values()):
        print(f"\n  MCP vs CLI:")
        for gw in ("mcp", "cli"):
            if gw in mcp_cli:
                t = mcp_cli[gw]["estimated_tokens"]
                n = mcp_cli[gw]["ops_count"]
                print(f"    {gw.upper():<6} {_fmt_tokens(t, confidence)}  ({n} op{'s' if n != 1 else ''})")

    print(f"\n  Note: {summary['note']}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Three-layer token estimation for ct-grade v3",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--run-dir",
        default=None,
        help="A/B run directory (enables Layer 2 chars/4 estimation)",
    )
    parser.add_argument(
        "--project-dir",
        default=None,
        help="Project root for audit log / tasks.db (enables Layer 3 coarse estimation)",
    )
    parser.add_argument(
        "--grades-file",
        default=None,
        help="GRADES.jsonl path — enrich each entry with _tokenMeta in-place",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output path for token-summary.json (default: <run-dir>/token-summary.json or ./token-summary.json)",
    )
    parser.add_argument(
        "--session-id",
        default=None,
        help="Filter OTel data to a specific session ID",
    )
    args = parser.parse_args()

    # Enrich GRADES.jsonl if requested
    if args.grades_file:
        count = enrich_grades_file(args.grades_file, args.run_dir, args.project_dir)
        print(f"Enriched {count} GRADES.jsonl entr{'ies' if count != 1 else 'y'} with _tokenMeta")

    # Always build and write the token-summary.json
    summary = build_summary(
        run_dir=args.run_dir,
        project_dir=args.project_dir,
        session_id=args.session_id,
    )

    if args.output:
        output_path = args.output
    elif args.run_dir and os.path.isdir(args.run_dir):
        output_path = os.path.join(args.run_dir, "token-summary.json")
    else:
        output_path = "token-summary.json"

    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)

    print_summary(summary)
    print(f"\nWritten: {output_path}")


if __name__ == "__main__":
    main()
