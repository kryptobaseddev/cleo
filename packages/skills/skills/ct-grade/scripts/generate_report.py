#!/usr/bin/env python3
"""
generate_report.py — Generate a comparative analysis report from ct-grade A/B results.

Usage:
    python generate_report.py --run-dir ./ab_results/run-001 --mode ab [--html]

Reads: run-manifest.json, token-summary.json, */run-*/comparison.json, */run-*/arm-*/grade.json
Writes: <run-dir>/report.md (and optionally report.html)
"""

import argparse
import json
import os
import sys
from pathlib import Path
from datetime import datetime, timezone


DIMENSION_LABELS = {
    "sessionDiscipline": "S1 Session Discipline",
    "discoveryEfficiency": "S2 Discovery Efficiency",
    "taskHygiene": "S3 Task Hygiene",
    "errorProtocol": "S4 Error Protocol",
    "disclosureUse": "S5 Progressive Disclosure",
}

SCENARIO_LABELS = {
    "s1": "Fresh Discovery",
    "s2": "Task Creation Hygiene",
    "s3": "Error Recovery",
    "s4": "Full Lifecycle",
    "s5": "Multi-Domain Analysis",
}

GRADE_THRESHOLDS = [
    (90, "A"), (75, "B"), (60, "C"), (45, "D"), (0, "F")
]


def letter_grade(score):
    for threshold, letter in GRADE_THRESHOLDS:
        if score >= threshold:
            return letter
    return "F"


def find_json(path, filename):
    p = Path(path) / filename
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            return None
    return None


def find_all_comparison_files(run_dir):
    return list(Path(run_dir).rglob("comparison.json"))


def find_grade_files(run_dir):
    return list(Path(run_dir).rglob("grade.json"))


def load_grade(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return None


def mean(values):
    return sum(values) / len(values) if values else None


def collect_scores(run_dir):
    """Collect grade scores by arm from all grade.json files."""
    by_arm = {"arm-A": [], "arm-B": []}
    by_arm_dimensions = {
        "arm-A": {d: [] for d in DIMENSION_LABELS},
        "arm-B": {d: [] for d in DIMENSION_LABELS},
    }

    for gfile in find_grade_files(run_dir):
        parts = Path(gfile).parts
        arm = next((p for p in parts if p.startswith("arm-")), None)
        if arm not in by_arm:
            continue
        data = load_grade(gfile)
        if data and "totalScore" in data:
            by_arm[arm].append(data["totalScore"])
            dims = data.get("dimensions", {})
            for dim, label in DIMENSION_LABELS.items():
                if dim in dims:
                    by_arm_dimensions[arm][dim].append(dims[dim].get("score", 0))

    return by_arm, by_arm_dimensions


def collect_comparisons(run_dir):
    wins = {"arm-A": 0, "arm-B": 0, "tie": 0}
    comparisons = []
    for cfile in find_all_comparison_files(run_dir):
        data = find_json(os.path.dirname(cfile), "comparison.json")
        if data:
            winner = data.get("winner", "tie").lower()
            if winner in wins:
                wins[winner] += 1
            comparisons.append(data)
    return wins, comparisons


def build_report(run_dir, mode, manifest, token_summary, scores, dim_scores, wins, comparisons):
    arm_a_scores = scores.get("arm-A", [])
    arm_b_scores = scores.get("arm-B", [])
    arm_a_mean = mean(arm_a_scores)
    arm_b_mean = mean(arm_b_scores)

    arm_a_config = manifest.get("arms", {}).get("A", {}).get("label", "Arm A")
    arm_b_config = manifest.get("arms", {}).get("B", {}).get("label", "Arm B")

    token_a = (token_summary or {}).get("by_arm", {}).get("arm-A", {}).get("total_tokens", {})
    token_b = (token_summary or {}).get("by_arm", {}).get("arm-B", {}).get("total_tokens", {})
    token_delta = (token_summary or {}).get("delta_A_vs_B", {})

    total_runs = wins["arm-A"] + wins["arm-B"] + wins["tie"]
    a_win_rate = wins["arm-A"] / total_runs if total_runs else 0

    # Determine overall winner
    if wins["arm-A"] > wins["arm-B"]:
        overall_winner = f"Arm A ({arm_a_config})"
        winner_arm = "A"
    elif wins["arm-B"] > wins["arm-A"]:
        overall_winner = f"Arm B ({arm_b_config})"
        winner_arm = "B"
    else:
        overall_winner = "Tie"
        winner_arm = "tie"

    lines = []
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines.append(f"# CLEO Grade A/B Analysis Report")
    lines.append(f"**Generated**: {ts}  **Mode**: {mode}  **Run dir**: `{run_dir}`\n")

    # Executive Summary
    lines.append("## Executive Summary\n")
    a_mean_str = f"{arm_a_mean:.1f}" if arm_a_mean is not None else "N/A"
    b_mean_str = f"{arm_b_mean:.1f}" if arm_b_mean is not None else "N/A"
    delta_str = f"{arm_a_mean - arm_b_mean:+.1f}" if arm_a_mean and arm_b_mean else "N/A"
    a_grade = letter_grade(arm_a_mean) if arm_a_mean else "?"
    b_grade = letter_grade(arm_b_mean) if arm_b_mean else "?"

    tok_a_mean = token_a.get("mean") or "N/A"
    tok_b_mean = token_b.get("mean") or "N/A"
    tok_delta = token_delta.get("percent", "N/A")
    tok_note = token_delta.get("note", "")

    lines.append(f"| Metric | Arm A ({arm_a_config}) | Arm B ({arm_b_config}) | Delta |")
    lines.append(f"|---|---|---|---|")
    lines.append(f"| Mean Score | {a_mean_str}/100 | {b_mean_str}/100 | {delta_str} |")
    lines.append(f"| Grade | {a_grade} | {b_grade} | — |")
    lines.append(f"| Mean Tokens | {tok_a_mean} | {tok_b_mean} | {tok_delta} |")
    lines.append(f"| Win Rate | {wins['arm-A']}/{total_runs} | {wins['arm-B']}/{total_runs} | — |")
    lines.append(f"| Ties | — | — | {wins['tie']} |")
    lines.append("")
    lines.append(f"**Overall Winner: {overall_winner}**")
    if tok_note:
        lines.append(f"Token note: {tok_note}")
    lines.append("")

    # Per-dimension breakdown
    lines.append("## Per-Dimension Scores (Mean)\n")
    lines.append(f"| Dimension | Arm A | Arm B | Delta | Max |")
    lines.append(f"|---|---|---|---|---|")
    for dim, label in DIMENSION_LABELS.items():
        a_vals = dim_scores.get("arm-A", {}).get(dim, [])
        b_vals = dim_scores.get("arm-B", {}).get(dim, [])
        a_m = mean(a_vals)
        b_m = mean(b_vals)
        a_str = f"{a_m:.1f}" if a_m is not None else "N/A"
        b_str = f"{b_m:.1f}" if b_m is not None else "N/A"
        d_str = f"{a_m - b_m:+.1f}" if a_m is not None and b_m is not None else "N/A"
        lines.append(f"| {label} | {a_str} | {b_str} | {d_str} | 20 |")
    lines.append("")

    # Comparison results
    if comparisons:
        lines.append("## Comparison Results\n")
        lines.append(f"| Run | Slot | Winner | A Score | B Score | A Flags | B Flags |")
        lines.append(f"|---|---|---|---|---|---|---|")
        for i, c in enumerate(comparisons, 1):
            winner = c.get("winner", "?")
            gc = c.get("grade_comparison", {})
            a_total = gc.get("A", {}).get("total_score", "?")
            b_total = gc.get("B", {}).get("total_score", "?")
            a_flags = len(gc.get("A", {}).get("flags", []))
            b_flags = len(gc.get("B", {}).get("flags", []))
            lines.append(f"| {i} | — | {winner} | {a_total} | {b_total} | {a_flags} | {b_flags} |")
        lines.append("")

    # Token Economy
    lines.append("## Token Economy\n")
    if token_a.get("mean") and token_b.get("mean"):
        a_tok = token_a["mean"]
        b_tok = token_b["mean"]
        a_spt = (arm_a_mean / a_tok * 1000) if arm_a_mean and a_tok else None
        b_spt = (arm_b_mean / b_tok * 1000) if arm_b_mean and b_tok else None
        lines.append(f"| Metric | Arm A | Arm B |")
        lines.append(f"|---|---|---|")
        lines.append(f"| Mean tokens | {a_tok:.0f} | {b_tok:.0f} |")
        lines.append(f"| Stddev | {token_a.get('stddev', 0):.0f} | {token_b.get('stddev', 0):.0f} |")
        if a_spt and b_spt:
            lines.append(f"| Score per 1k tokens | {a_spt:.1f} | {b_spt:.1f} |")
        lines.append("")
        lines.append(f"**Token delta**: {tok_delta} — {tok_note}")
    else:
        lines.append("_Token data incomplete. Fill `total_tokens` in timing.json from task notifications._")
    lines.append("")

    # Recommendations placeholder
    lines.append("## Recommendations\n")
    lines.append("_Run `agents/analysis-reporter.md` for AI-generated recommendations based on full pattern analysis._\n")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate ct-grade A/B comparison report")
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--mode", default="ab", choices=["scenario", "ab", "blind"])
    parser.add_argument("--html", action="store_true", help="Also generate report.html")
    args = parser.parse_args()

    run_dir = args.run_dir
    if not os.path.isdir(run_dir):
        print(f"ERROR: Run dir not found: {run_dir}", file=sys.stderr)
        sys.exit(1)

    manifest = find_json(run_dir, "run-manifest.json") or {}
    token_summary = find_json(run_dir, "token-summary.json")

    if token_summary is None:
        print("WARN: token-summary.json not found. Run token_tracker.py first.", file=sys.stderr)

    scores, dim_scores = collect_scores(run_dir)
    wins, comparisons = collect_comparisons(run_dir)

    report = build_report(run_dir, args.mode, manifest, token_summary,
                          scores, dim_scores, wins, comparisons)

    report_path = os.path.join(run_dir, "report.md")
    with open(report_path, "w") as f:
        f.write(report)

    print(f"\nReport written: {report_path}")

    if args.html:
        # Basic HTML wrapper
        html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ct-grade Report</title>
<style>body{{font-family:sans-serif;max-width:900px;margin:40px auto;padding:0 20px}}
table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ddd;padding:8px;text-align:left}}
th{{background:#f5f5f5}}code{{background:#f5f5f5;padding:2px 4px;border-radius:3px}}</style>
</head><body>
<pre>{report}</pre>
</body></html>"""
        html_path = os.path.join(run_dir, "report.html")
        with open(html_path, "w") as f:
            f.write(html)
        print(f"HTML report written: {html_path}")

    # Summary
    total_a = scores.get("arm-A", [])
    total_b = scores.get("arm-B", [])
    print(f"\nScore summary:")
    print(f"  Arm A: mean={mean(total_a):.1f} n={len(total_a)}" if total_a else "  Arm A: no data")
    print(f"  Arm B: mean={mean(total_b):.1f} n={len(total_b)}" if total_b else "  Arm B: no data")
    print(f"  Wins: A={wins['arm-A']}, B={wins['arm-B']}, tie={wins['tie']}")


if __name__ == "__main__":
    main()
