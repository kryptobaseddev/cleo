#!/usr/bin/env python3
"""
token_tracker.py — Aggregate token usage stats from a completed A/B run.

Usage:
    python token_tracker.py --run-dir ./ab_results/run-001

Reads all timing.json files in the run directory and produces token-summary.json
with per-arm statistics.

Output: <run-dir>/token-summary.json
"""

import argparse
import json
import os
import sys
import math
from pathlib import Path


def find_timing_files(run_dir):
    """Find all timing.json files under run_dir."""
    return list(Path(run_dir).rglob("timing.json"))


def load_timing(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        print(f"  WARN: Could not read {path}: {e}", file=sys.stderr)
        return None


def mean(values):
    return sum(values) / len(values) if values else 0


def stddev(values):
    if len(values) < 2:
        return 0
    m = mean(values)
    return math.sqrt(sum((x - m) ** 2 for x in values) / (len(values) - 1))


def stats(values):
    if not values:
        return {"mean": None, "stddev": None, "min": None, "max": None, "count": 0}
    return {
        "mean": round(mean(values), 1),
        "stddev": round(stddev(values), 1),
        "min": min(values),
        "max": max(values),
        "count": len(values),
    }


def main():
    parser = argparse.ArgumentParser(description="Aggregate token stats from ct-grade A/B run")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--output", default=None, help="Output path (default: <run-dir>/token-summary.json)")
    args = parser.parse_args()

    run_dir = args.run_dir
    if not os.path.isdir(run_dir):
        print(f"ERROR: Run dir not found: {run_dir}", file=sys.stderr)
        sys.exit(1)

    timing_files = find_timing_files(run_dir)
    if not timing_files:
        print(f"ERROR: No timing.json files found in {run_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(timing_files)} timing.json files")

    # Group by arm
    by_arm = {}
    by_interface = {}
    missing_tokens = []

    for tpath in timing_files:
        data = load_timing(tpath)
        if data is None:
            continue

        arm = data.get("arm", "unknown")
        iface = data.get("interface", "unknown")
        tokens = data.get("total_tokens")
        duration = data.get("duration_ms")

        if arm not in by_arm:
            by_arm[arm] = {"tokens": [], "duration_ms": [], "interface": iface, "files": []}
        if iface not in by_interface:
            by_interface[iface] = {"tokens": [], "duration_ms": [], "files": []}

        by_arm[arm]["files"].append(str(tpath))

        if tokens is not None:
            by_arm[arm]["tokens"].append(tokens)
            by_interface[iface]["tokens"].append(tokens)
        else:
            missing_tokens.append(str(tpath))

        if duration is not None:
            by_arm[arm]["duration_ms"].append(duration)
            by_interface[iface]["duration_ms"].append(duration)

    # Build summary
    arm_stats = {}
    for arm, data in sorted(by_arm.items()):
        arm_stats[arm] = {
            "interface": data["interface"],
            "file_count": len(data["files"]),
            "total_tokens": stats(data["tokens"]),
            "duration_ms": stats(data["duration_ms"]),
        }

    iface_stats = {}
    for iface, data in sorted(by_interface.items()):
        iface_stats[iface] = {
            "file_count": len(data["files"]),
            "total_tokens": stats(data["tokens"]),
            "duration_ms": stats(data["duration_ms"]),
        }

    # Compute delta between arms (A vs B)
    delta = {}
    if "arm-A" in arm_stats and "arm-B" in arm_stats:
        a_mean = arm_stats["arm-A"]["total_tokens"].get("mean") or 0
        b_mean = arm_stats["arm-B"]["total_tokens"].get("mean") or 0
        if b_mean > 0:
            delta = {
                "mean_tokens": round(a_mean - b_mean, 1),
                "percent": f"{((a_mean - b_mean) / b_mean * 100):+.1f}%",
                "note": f"Arm A uses {abs(a_mean - b_mean):.0f} {'more' if a_mean > b_mean else 'fewer'} tokens on average",
            }

    summary = {
        "run_dir": os.path.abspath(run_dir),
        "timing_files_found": len(timing_files),
        "timing_files_missing_tokens": len(missing_tokens),
        "by_arm": arm_stats,
        "by_interface": iface_stats,
        "delta_A_vs_B": delta,
        "warnings": (
            [f"MISSING total_tokens in {len(missing_tokens)} files — fill these from task notifications"]
            if missing_tokens else []
        ),
    }

    output_path = args.output or os.path.join(run_dir, "token-summary.json")
    with open(output_path, "w") as f:
        json.dump(summary, f, indent=2)

    # Print summary
    print(f"\nToken Summary")
    print(f"{'='*50}")
    for arm, s in arm_stats.items():
        t = s["total_tokens"]
        if t["mean"] is not None:
            print(f"  {arm} ({s['interface']}): {t['mean']:.0f} tokens (±{t['stddev']:.0f}, n={t['count']})")
        else:
            print(f"  {arm} ({s['interface']}): NO TOKEN DATA (fill timing.json from task notifications)")
    if delta:
        print(f"\n  Delta (A-B): {delta['percent']} ({delta['mean_tokens']:+.0f} tokens)")
        print(f"  {delta['note']}")
    if missing_tokens:
        print(f"\n  WARNING: {len(missing_tokens)} files missing total_tokens")
        print(f"  These must be filled from Claude Code task notification data.")
    print(f"\nWritten: {output_path}")


if __name__ == "__main__":
    main()
