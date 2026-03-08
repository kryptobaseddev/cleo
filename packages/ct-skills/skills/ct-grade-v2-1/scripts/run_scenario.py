#!/usr/bin/env python3
"""
Run a CLEO grade scenario and capture metrics.

Executes a predefined grade scenario against a live CLEO project,
capturing timing and output metrics for later analysis.

Usage:
    python run_scenario.py --scenario S1 [options]
    python run_scenario.py --scenario full [options]

Options:
    --scenario      S1-S5, full, or P1-P3 (default: S1)
    --cleo          CLEO binary (default: cleo-dev)
    --output-dir    Results directory (default: ./grade-results/<timestamp>)
    --scope         Session scope (default: global)
    --parent-task   Task ID for subtask scenarios (S2, S5)
    --seed-task     Existing task ID for lifecycle scenarios (S3, S4)
    --runs          Number of times to repeat (default: 1)
    --json          Output results as JSON to stdout
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Scenario definitions
# ---------------------------------------------------------------------------

def _build_scenario(name, ops_fn):
    return {"name": name, "build_ops": ops_fn}


def scenario_s1(args):
    """S1: Session Discipline — tests session.list before task ops and session.end."""
    seed = args.seed_task or "T100"
    return [
        (["session", "list"], "Check existing sessions"),
        (["admin", "dash"], "Project overview"),
        (["tasks", "find", "--status", "active"], "Discover active tasks"),
        (["tasks", "show", seed], "Inspect specific task"),
        # session.end is handled by run_graded_session wrapper
    ]


def scenario_s2(args):
    """S2: Task Hygiene — tests task creation with descriptions and parent verification."""
    parent = args.parent_task or args.seed_task
    if not parent:
        print("WARNING: --parent-task not set for S2; using T100 as placeholder", file=sys.stderr)
        parent = "T100"
    return [
        (["session", "list"], "Check existing sessions"),
        (["tasks", "exists", parent], "Verify parent exists"),
        (["tasks", "add",
          "--title", "Impl auth",
          "--description", "Add JWT authentication to API endpoints",
          "--parent", parent], "Create subtask with description"),
        (["tasks", "add",
          "--title", "Write auth tests",
          "--description", "Unit tests for auth module"], "Create standalone task with description"),
    ]


def scenario_s3(args):
    """S3: Error Recovery — tests E_NOT_FOUND recovery and no duplicate creates."""
    return [
        (["session", "list"], "Check existing sessions"),
        (["tasks", "show", "T99999"], "Trigger E_NOT_FOUND intentionally"),
        (["tasks", "find", "--query", "T99999"], "Recovery lookup after E_NOT_FOUND"),
        (["tasks", "add",
          "--title", "New feature discovered",
          "--description", "Feature that was not found — creating fresh"], "Create once"),
    ]


def scenario_s4(args):
    """S4: Full Lifecycle — all 5 dimensions at 20/20."""
    seed = args.seed_task or "T200"
    return [
        (["session", "list"], "Check existing sessions"),
        (["admin", "help"], "Progressive disclosure — tier 0"),
        (["admin", "dash"], "Project overview"),
        (["tasks", "find", "--status", "pending"], "Discover pending tasks"),
        (["tasks", "show", seed], "Inspect chosen task"),
        (["tasks", "update", "--task-id", seed, "--status", "active"], "Begin work"),
        (["tasks", "complete", seed], "Mark done"),
        (["tasks", "find", "--status", "pending"], "Check for next task"),
    ]


def scenario_s5(args):
    """S5: Multi-Domain Analysis — cross-domain with session decisions."""
    parent = args.parent_task or "T500"
    seed = args.seed_task or "T501"
    return [
        (["session", "list"], "Check existing sessions"),
        (["admin", "help"], "Progressive disclosure"),
        (["tasks", "find", "--parent", parent], "Discover epic subtasks"),
        (["tasks", "show", seed], "Inspect specific subtask"),
        (["session", "context-drift"], "Check context drift"),
        (["session", "decision-log", "--task-id", seed], "Review past decisions"),
        (["session", "record-decision",
          "--task-id", seed,
          "--decision", "Use adapter pattern",
          "--rationale", "Decouples provider logic"], "Record decision"),
        (["tasks", "update", "--task-id", seed, "--status", "active"], "Begin work"),
        (["tasks", "complete", seed], "Mark done"),
        (["tasks", "find", "--parent", parent, "--status", "pending"], "Find next subtask"),
    ]


SCENARIOS = {
    "S1": scenario_s1,
    "S2": scenario_s2,
    "S3": scenario_s3,
    "S4": scenario_s4,
    "S5": scenario_s5,
}


# ---------------------------------------------------------------------------
# CLEO runner
# ---------------------------------------------------------------------------

def run_cleo(cleo_bin, args_list, cwd=None, capture=True):
    """Run a cleo command and return (returncode, stdout, stderr, duration_ms)."""
    cmd = [cleo_bin] + args_list + ["--json"]
    start = time.time()
    try:
        result = subprocess.run(
            cmd,
            capture_output=capture,
            text=True,
            cwd=cwd,
            timeout=30,
        )
        duration_ms = int((time.time() - start) * 1000)
        return result.returncode, result.stdout or "", result.stderr or "", duration_ms
    except subprocess.TimeoutExpired:
        return -1, "", "TIMEOUT", 30000
    except FileNotFoundError:
        return -1, "", f"Command not found: {cleo_bin}", 0


def start_graded_session(cleo_bin, scope, name, cwd=None):
    """Start a grade-enabled session. Returns session ID or None."""
    rc, stdout, stderr, _ = run_cleo(
        cleo_bin,
        ["session", "start", "--scope", scope, "--name", name, "--grade"],
        cwd=cwd,
    )
    if rc != 0:
        print(f"ERROR: session start failed: {stderr}", file=sys.stderr)
        return None
    try:
        data = json.loads(stdout)
        # Try common paths for session ID
        return (
            data.get("data", {}).get("sessionId")
            or data.get("sessionId")
            or data.get("id")
        )
    except Exception:
        # Try to extract session ID from plain output
        for line in stdout.splitlines():
            if "session-" in line:
                parts = line.split()
                for p in parts:
                    if p.startswith("session-"):
                        return p.strip('",')
        return None


def end_session(cleo_bin, cwd=None):
    """End the current session."""
    rc, stdout, stderr, _ = run_cleo(cleo_bin, ["session", "end"], cwd=cwd)
    return rc == 0


def grade_session(cleo_bin, session_id, cwd=None):
    """Grade a session. Returns dict or None."""
    rc, stdout, stderr, _ = run_cleo(cleo_bin, ["grade", session_id], cwd=cwd)
    if rc != 0:
        print(f"WARNING: grade failed (rc={rc}): {stderr}", file=sys.stderr)
        return None
    try:
        data = json.loads(stdout)
        return data.get("data") or data
    except Exception:
        return {"raw": stdout}


# ---------------------------------------------------------------------------
# Single scenario run
# ---------------------------------------------------------------------------

def run_single_scenario(scenario_name, args, output_dir):
    """Run one scenario. Returns metrics dict."""
    cleo = args.cleo
    scope = args.scope or "global"
    session_name = f"grade-{scenario_name.lower()}-{int(time.time())}"

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n=== Scenario {scenario_name} ===")
    print(f"  Binary : {cleo}")
    print(f"  Scope  : {scope}")
    print(f"  Output : {output_dir}")

    # Start graded session
    t_start = time.time()
    session_id = start_graded_session(cleo, scope, session_name, cwd=args.cleo_cwd)
    if not session_id:
        print("ERROR: Could not start graded session", file=sys.stderr)
        metrics = {
            "scenario": scenario_name,
            "session_id": None,
            "error": "DB_UNAVAILABLE",
            "hint": "Use agent-based /ct-grade scenario instead — agents use live MCP tools",
            "grade": None,
            "token_meta": {"estimation_method": "unavailable", "total_estimated_tokens": None},
        }
        metrics_path = output_dir / "metrics.json"
        metrics_path.write_text(json.dumps(metrics, indent=2))
        return metrics

    print(f"  Session: {session_id}")

    # Build operations for this scenario
    scenario_fn = SCENARIOS[scenario_name]
    operations = scenario_fn(args)

    # Execute each operation
    op_results = []
    for op_args, description in operations:
        print(f"  -> {' '.join(op_args)}")
        rc, stdout, stderr, dur_ms = run_cleo(cleo, op_args, cwd=args.cleo_cwd)
        output_chars = len(stdout)
        estimated_tokens = int(output_chars / 4)
        op_results.append({
            "operation": " ".join(op_args),
            "description": description,
            "returncode": rc,
            "success": rc == 0,
            "output_chars": output_chars,
            "estimated_tokens": estimated_tokens,
            "duration_ms": dur_ms,
            "error": stderr[:200] if rc != 0 else None,
        })
        if rc not in (0, 4):  # 4 = E_NOT_FOUND (expected for S3)
            print(f"    WARNING: rc={rc} stderr={stderr[:100]}")

    # End session
    ended = end_session(cleo, cwd=args.cleo_cwd)
    print(f"  Session end: {'ok' if ended else 'FAILED'}")

    # Grade session
    grade = grade_session(cleo, session_id, cwd=args.cleo_cwd)
    t_total = time.time() - t_start

    # Compute token metadata
    total_output_chars = sum(r["output_chars"] for r in op_results)
    total_estimated_tokens = sum(r["estimated_tokens"] for r in op_results)

    metrics = {
        "scenario": scenario_name,
        "session_id": session_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "duration_seconds": round(t_total, 2),
        "operations": op_results,
        "grade": grade,
        "token_meta": {
            "estimation_method": "output_chars",
            "total_output_chars": total_output_chars,
            "total_estimated_tokens": total_estimated_tokens,
            "avg_tokens_per_op": int(total_estimated_tokens / max(len(op_results), 1)),
        },
    }

    # Save
    metrics_path = output_dir / "metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2))
    print(f"  Saved  : {metrics_path}")

    if grade:
        score = grade.get("totalScore", "?")
        letter = _score_to_letter(grade.get("totalScore", 0))
        flags = grade.get("flags", [])
        print(f"  Grade  : {score}/100 ({letter}) — {len(flags)} flag(s)")
        if flags:
            for f in flags:
                print(f"    FLAG: {f}")

    return metrics


def _score_to_letter(score):
    if score >= 90: return "A"
    if score >= 75: return "B"
    if score >= 60: return "C"
    if score >= 45: return "D"
    return "F"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Run CLEO grade scenarios")
    parser.add_argument("--scenario", default="S1",
                        help="S1-S5, full, or comma-separated e.g. S1,S3")
    parser.add_argument("--cleo", default="cleo-dev",
                        help="CLEO binary (default: cleo-dev)")
    parser.add_argument("--cleo-cwd", default=None,
                        help="Working directory for CLEO commands")
    parser.add_argument("--output-dir", default=None,
                        help="Output directory (default: ./grade-results/<timestamp>)")
    parser.add_argument("--scope", default="global",
                        help="Session scope (default: global)")
    parser.add_argument("--parent-task", default=None,
                        help="Parent task ID for S2/S5 subtask scenarios")
    parser.add_argument("--seed-task", default=None,
                        help="Existing task ID for S3/S4/S5 lifecycle scenarios")
    parser.add_argument("--runs", type=int, default=1,
                        help="Number of runs per scenario (default: 1)")
    parser.add_argument("--json", action="store_true",
                        help="Output summary as JSON to stdout")
    args = parser.parse_args()

    # Determine which scenarios to run
    if args.scenario.lower() == "full":
        targets = list(SCENARIOS.keys())
    else:
        targets = [s.strip().upper() for s in args.scenario.split(",")]
        unknown = [s for s in targets if s not in SCENARIOS]
        if unknown:
            print(f"ERROR: Unknown scenarios: {unknown}. Valid: {list(SCENARIOS.keys())}", file=sys.stderr)
            sys.exit(1)

    # Build output directory
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    base_output = Path(args.output_dir) if args.output_dir else Path(f"./grade-results/{ts}")

    all_results = []

    for scenario_name in targets:
        for run_num in range(1, args.runs + 1):
            run_dir = base_output / scenario_name / f"run-{run_num:03d}"
            metrics = run_single_scenario(scenario_name, args, run_dir)
            all_results.append(metrics)

    # Summary
    summary = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "scenarios_run": targets,
        "total_runs": len(all_results),
        "results": all_results,
        "grade_summary": [
            {
                "scenario": r["scenario"],
                "score": r.get("grade", {}).get("totalScore") if r.get("grade") else None,
                "letter": _score_to_letter(r.get("grade", {}).get("totalScore", 0) if r.get("grade") else 0),
                "flags": len(r.get("grade", {}).get("flags", [])) if r.get("grade") else None,
                "estimated_tokens": r.get("token_meta", {}).get("total_estimated_tokens"),
            }
            for r in all_results
        ],
    }

    summary_path = base_output / "summary.json"
    base_output.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2))

    print(f"\n=== Summary ===")
    for gs in summary["grade_summary"]:
        score_str = f"{gs['score']}/100 ({gs['letter']})" if gs['score'] is not None else "N/A"
        tok_str = f"~{gs['estimated_tokens']}t" if gs['estimated_tokens'] else ""
        print(f"  {gs['scenario']}: {score_str}  flags={gs['flags']}  {tok_str}")
    print(f"\nSaved: {base_output}")

    if args.json:
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
