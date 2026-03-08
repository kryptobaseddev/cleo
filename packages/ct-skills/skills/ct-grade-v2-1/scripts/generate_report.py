#!/usr/bin/env python3
"""
Generate a comparative analysis report from grade scenario and/or A/B test results.

Reads output directories from run_scenario.py and/or run_ab_test.py and produces:
  - Markdown report (human-readable)
  - analysis.json (machine-readable)

Usage:
    python generate_report.py --input-dir ./grade-results --format markdown
    python generate_report.py --input-dir ./ab-results --format markdown --focus token-delta
    python generate_report.py --input-dir ./results --format both --output ./report.md
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, stdev


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------

def load_json_safe(path):
    """Load JSON file, return None on failure."""
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return None


def find_summary_files(input_dir):
    """Find all summary.json files under input_dir."""
    return list(Path(input_dir).rglob("summary.json"))


def find_metrics_files(input_dir):
    """Find all metrics.json files (scenario runs)."""
    return list(Path(input_dir).rglob("metrics.json"))


def find_ab_summaries(input_dir):
    """Find summary.json files that look like A/B test summaries."""
    results = []
    for f in Path(input_dir).rglob("summary.json"):
        data = load_json_safe(f)
        if data and "global_wins" in data:
            results.append((f, data))
    return results


def find_grade_summaries(input_dir):
    """Find summary.json files that look like grade scenario summaries."""
    results = []
    for f in Path(input_dir).rglob("summary.json"):
        data = load_json_safe(f)
        if data and "grade_summary" in data:
            results.append((f, data))
    return results


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def analyze_grade_results(grade_summaries):
    """Aggregate grade scenario results."""
    if not grade_summaries:
        return None

    all_scores = []
    by_scenario = {}
    total_flags = 0
    total_tokens = 0

    for _, summary in grade_summaries:
        for gs in summary.get("grade_summary", []):
            scenario = gs.get("scenario", "?")
            score = gs.get("score")
            flags = gs.get("flags") or 0
            tokens = gs.get("estimated_tokens") or 0

            if score is not None:
                all_scores.append(score)
            total_flags += flags
            total_tokens += tokens

            if scenario not in by_scenario:
                by_scenario[scenario] = {"scores": [], "flags": [], "tokens": []}
            if score is not None:
                by_scenario[scenario]["scores"].append(score)
            by_scenario[scenario]["flags"].append(flags)
            by_scenario[scenario]["tokens"].append(tokens)

    analysis = {
        "total_runs": len(all_scores),
        "overall": {
            "mean_score": round(mean(all_scores), 1) if all_scores else None,
            "min_score": min(all_scores) if all_scores else None,
            "max_score": max(all_scores) if all_scores else None,
            "stddev_score": round(stdev(all_scores), 2) if len(all_scores) > 1 else 0,
            "total_flags": total_flags,
            "total_estimated_tokens": total_tokens,
        },
        "by_scenario": {},
    }

    for scenario, data in by_scenario.items():
        scores = data["scores"]
        flags = data["flags"]
        tokens = [t for t in data["tokens"] if t > 0]
        analysis["by_scenario"][scenario] = {
            "runs": len(scores),
            "mean_score": round(mean(scores), 1) if scores else None,
            "min_score": min(scores) if scores else None,
            "max_score": max(scores) if scores else None,
            "total_flags": sum(flags),
            "avg_flags_per_run": round(mean(flags), 2) if flags else 0,
            "avg_estimated_tokens": round(mean(tokens), 0) if tokens else 0,
        }

    return analysis


def analyze_ab_results(ab_summaries):
    """Aggregate A/B test results."""
    if not ab_summaries:
        return None

    total_mcp_wins = 0
    total_cli_wins = 0
    total_ties = 0
    total_runs = 0
    token_deltas = []
    per_op = {}

    for _, summary in ab_summaries:
        total_mcp_wins += summary.get("global_wins", {}).get("mcp", 0)
        total_cli_wins += summary.get("global_wins", {}).get("cli", 0)
        total_ties += summary.get("global_wins", {}).get("tie", 0)
        total_runs += summary.get("total_runs", 0)
        delta = summary.get("avg_token_delta_mcp_minus_cli")
        if delta is not None:
            token_deltas.append(delta)

        for op_summary in summary.get("per_operation", []):
            op_key = op_summary.get("operation", "?")
            if op_key not in per_op:
                per_op[op_key] = {
                    "mcp_wins": 0, "cli_wins": 0, "ties": 0,
                    "token_deltas": [],
                    "mcp_chars": [], "cli_chars": [],
                    "mcp_ms": [], "cli_ms": [],
                }
            per_op[op_key]["mcp_wins"] += op_summary.get("wins", {}).get("mcp", 0)
            per_op[op_key]["cli_wins"] += op_summary.get("wins", {}).get("cli", 0)
            per_op[op_key]["ties"] += op_summary.get("wins", {}).get("tie", 0)
            if op_summary.get("avg_token_delta_mcp_minus_cli") is not None:
                per_op[op_key]["token_deltas"].append(op_summary["avg_token_delta_mcp_minus_cli"])
            if op_summary.get("avg_mcp_chars"):
                per_op[op_key]["mcp_chars"].append(op_summary["avg_mcp_chars"])
            if op_summary.get("avg_cli_chars"):
                per_op[op_key]["cli_chars"].append(op_summary["avg_cli_chars"])
            if op_summary.get("avg_mcp_ms"):
                per_op[op_key]["mcp_ms"].append(op_summary["avg_mcp_ms"])
            if op_summary.get("avg_cli_ms"):
                per_op[op_key]["cli_ms"].append(op_summary["avg_cli_ms"])

    overall_winner = "mcp" if total_mcp_wins > total_cli_wins else \
                     "cli" if total_cli_wins > total_mcp_wins else "tie"
    avg_delta = mean(token_deltas) if token_deltas else 0

    analysis = {
        "total_runs": total_runs,
        "overall_winner": overall_winner,
        "global_wins": {
            "mcp": total_mcp_wins,
            "cli": total_cli_wins,
            "tie": total_ties,
        },
        "global_win_rate": {
            "mcp": round(total_mcp_wins / max(total_runs, 1), 3),
            "cli": round(total_cli_wins / max(total_runs, 1), 3),
        },
        "avg_token_delta_mcp_minus_cli": round(avg_delta, 1),
        "interpretation": (
            "MCP uses more tokens on average" if avg_delta > 0 else
            "CLI uses more tokens on average" if avg_delta < 0 else
            "MCP and CLI have equivalent token costs"
        ),
        "per_operation": {},
    }

    for op_key, data in per_op.items():
        total_op = data["mcp_wins"] + data["cli_wins"] + data["ties"]
        analysis["per_operation"][op_key] = {
            "total_runs": total_op,
            "mcp_wins": data["mcp_wins"],
            "cli_wins": data["cli_wins"],
            "ties": data["ties"],
            "winner": "mcp" if data["mcp_wins"] > data["cli_wins"] else
                      "cli" if data["cli_wins"] > data["mcp_wins"] else "tie",
            "avg_token_delta": round(mean(data["token_deltas"]), 1) if data["token_deltas"] else 0,
            "avg_mcp_chars": round(mean(data["mcp_chars"]), 0) if data["mcp_chars"] else 0,
            "avg_cli_chars": round(mean(data["cli_chars"]), 0) if data["cli_chars"] else 0,
            "avg_mcp_ms": round(mean(data["mcp_ms"]), 0) if data["mcp_ms"] else 0,
            "avg_cli_ms": round(mean(data["cli_ms"]), 0) if data["cli_ms"] else 0,
        }

    return analysis


# ---------------------------------------------------------------------------
# Markdown report generator
# ---------------------------------------------------------------------------

def generate_markdown(grade_analysis, ab_analysis, input_dir, focus=None):
    """Produce a markdown comparative analysis report."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# CLEO Grade v2.1 — Comparative Analysis Report",
        f"",
        f"**Generated:** {ts}  ",
        f"**Source:** `{input_dir}`",
        f"",
    ]

    # --- Grade scenario section ---
    if grade_analysis and focus != "token-delta":
        lines += [
            "---",
            "",
            "## Grade Scenario Results",
            "",
        ]
        ov = grade_analysis["overall"]
        lines += [
            f"| Metric | Value |",
            f"|--------|-------|",
            f"| Total runs | {ov['total_runs']} |",
            f"| Mean score | {ov['mean_score']}/100 |",
            f"| Score range | {ov['min_score']}–{ov['max_score']} |",
            f"| Score stddev | {ov['stddev_score']} |",
            f"| Total flags | {ov['total_flags']} |",
            f"| Total est. tokens | {ov['total_estimated_tokens']:,} |",
            "",
        ]

        lines += ["### Per-Scenario Breakdown", ""]
        lines += [
            "| Scenario | Runs | Mean Score | Min | Max | Flags/Run | Avg Tokens |",
            "|----------|------|-----------|-----|-----|-----------|------------|",
        ]
        for scenario, data in sorted(grade_analysis["by_scenario"].items()):
            score_str = f"{data['mean_score']}/100" if data["mean_score"] is not None else "N/A"
            lines.append(
                f"| {scenario} | {data['runs']} | {score_str} | "
                f"{data['min_score']} | {data['max_score']} | "
                f"{data['avg_flags_per_run']:.1f} | "
                f"~{int(data['avg_estimated_tokens'])}t |"
            )
        lines.append("")

    # --- A/B test section ---
    if ab_analysis:
        lines += [
            "---",
            "",
            "## MCP vs CLI Blind A/B Results",
            "",
        ]
        ow = ab_analysis["overall_winner"].upper()
        wr = ab_analysis["global_win_rate"]
        gw = ab_analysis["global_wins"]
        delta = ab_analysis["avg_token_delta_mcp_minus_cli"]
        interp = ab_analysis["interpretation"]

        lines += [
            f"**Overall winner: {ow}**  ",
            f"",
            f"| Metric | Value |",
            f"|--------|-------|",
            f"| Total runs | {ab_analysis['total_runs']} |",
            f"| MCP wins | {gw['mcp']} ({wr['mcp']*100:.1f}%) |",
            f"| CLI wins | {gw['cli']} ({wr['cli']*100:.1f}%) |",
            f"| Ties | {gw['tie']} |",
            f"| Avg token delta (MCP–CLI) | {delta:+.1f} tokens |",
            f"| Interpretation | {interp} |",
            "",
        ]

        lines += ["### Per-Operation Results", ""]
        lines += [
            "| Operation | MCP wins | CLI wins | Ties | Token delta | MCP chars | CLI chars | MCP ms | CLI ms |",
            "|-----------|----------|----------|------|-------------|-----------|-----------|--------|--------|",
        ]
        for op_key, data in sorted(ab_analysis["per_operation"].items()):
            winner_marker = " **MCP**" if data["winner"] == "mcp" else \
                            " **CLI**" if data["winner"] == "cli" else ""
            lines.append(
                f"| `{op_key}`{winner_marker} | {data['mcp_wins']} | {data['cli_wins']} | "
                f"{data['ties']} | {data['avg_token_delta']:+.0f}t | "
                f"{int(data['avg_mcp_chars'])} | {int(data['avg_cli_chars'])} | "
                f"{int(data['avg_mcp_ms'])}ms | {int(data['avg_cli_ms'])}ms |"
            )
        lines.append("")

        # Recommendations
        lines += ["### Recommendations", ""]
        if delta > 50:
            lines.append("- **MCP adds significant token overhead.** Consider whether MCP envelope verbosity can be reduced for high-frequency operations.")
        elif delta < -50:
            lines.append("- **CLI is more verbose than MCP.** CLI output may include formatting/ANSI tokens not useful to agents.")
        else:
            lines.append("- **MCP and CLI have similar token costs.** Interface choice should be based on other factors (protocol compliance, auditability).")

        if wr.get("mcp", 0) > 0.6:
            lines.append("- **MCP output quality is consistently higher.** Reinforces MCP-first agent protocol recommendation.")
        elif wr.get("cli", 0) > 0.6:
            lines.append("- **CLI output quality is consistently higher.** Investigate MCP envelope structure for potential improvements.")

        lines.append("")

    # --- Token efficiency section ---
    if focus == "token-delta" or (grade_analysis and ab_analysis):
        lines += [
            "---",
            "",
            "## Token Efficiency Summary",
            "",
        ]
        if grade_analysis:
            avg_tok = grade_analysis["overall"].get("total_estimated_tokens", 0)
            runs = grade_analysis["overall"].get("total_runs", 1)
            lines.append(f"- Average scenario cost: ~{int(avg_tok/max(runs,1))} estimated tokens/run")
        if ab_analysis:
            delta = ab_analysis["avg_token_delta_mcp_minus_cli"]
            sign = "+" if delta > 0 else ""
            lines.append(f"- MCP interface overhead vs CLI: {sign}{delta:.1f} tokens/operation")
            lines.append(f"- High-cost operations (MCP > CLI by >100t): " +
                         ", ".join(f"`{op}`" for op, d in ab_analysis["per_operation"].items()
                                   if d.get("avg_token_delta", 0) > 100) or "none detected")
        lines.append("")

    lines += [
        "---",
        "",
        f"*Report generated by ct-grade v2.1 `generate_report.py`*",
        "",
    ]

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Generate CLEO grade comparative analysis report")
    parser.add_argument("--input-dir", required=True, help="Directory with grade/AB test results")
    parser.add_argument("--format", default="both", choices=["markdown", "json", "both"])
    parser.add_argument("--output", default=None, help="Output file (default: <input-dir>/report.md)")
    parser.add_argument("--focus", default=None,
                        choices=["token-delta", "grade-scores", "ab-wins"],
                        help="Focus the report on a specific aspect")
    parser.add_argument("--json", action="store_true", help="Print analysis JSON to stdout")
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    if not input_dir.exists():
        print(f"ERROR: --input-dir does not exist: {input_dir}", file=sys.stderr)
        sys.exit(1)

    # Load results
    grade_summaries = find_grade_summaries(input_dir)
    ab_summaries = find_ab_summaries(input_dir)

    if not grade_summaries and not ab_summaries:
        print(f"ERROR: No summary.json files found under {input_dir}", file=sys.stderr)
        print("Run run_scenario.py or run_ab_test.py first.", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(grade_summaries)} grade summary file(s) and {len(ab_summaries)} A/B summary file(s)")

    # Analyze
    grade_analysis = analyze_grade_results(grade_summaries) if grade_summaries else None
    ab_analysis = analyze_ab_results(ab_summaries) if ab_summaries else None

    # Build analysis.json
    analysis = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "input_dir": str(input_dir),
        "grade_analysis": grade_analysis,
        "ab_analysis": ab_analysis,
    }

    output_base = args.output.rsplit(".", 1)[0] if args.output else str(input_dir / "report")

    if args.format in ("json", "both"):
        json_path = output_base + ".json" if not (args.output and args.output.endswith(".json")) else args.output
        Path(json_path).write_text(json.dumps(analysis, indent=2))
        print(f"Saved JSON: {json_path}")

    if args.format in ("markdown", "both"):
        md_content = generate_markdown(grade_analysis, ab_analysis, input_dir, focus=args.focus)
        md_path = output_base + ".md" if not (args.output and args.output.endswith(".md")) else args.output
        Path(md_path).write_text(md_content)
        print(f"Saved Markdown: {md_path}")

    if args.json:
        print(json.dumps(analysis, indent=2))


if __name__ == "__main__":
    main()
