#!/usr/bin/env python3
"""
analyze_runs.py — read council-runs.jsonl, surface where to harden next.

Reports:
  * gate-failure hotspots (which advisor fails which gate most),
  * peer-review reject frequency (per reviewer + per reviewee),
  * convergence-flag rate,
  * Chairman confidence distribution + low-confidence question shapes,
  * token / wall-clock distribution per scope tier (if metrics present),
  * exit-criteria scorecard from the plan.

Usage:
  python3 analyze_runs.py                              # default log
  python3 analyze_runs.py --log path/to/runs.jsonl
  python3 analyze_runs.py --json
  python3 analyze_runs.py --since 2026-04-24           # filter by timestamp prefix
  python3 analyze_runs.py --tail 8                     # last N runs only
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

DEFAULT_LOG_PATH = Path(".cleo/council-runs.jsonl")
ADVISORS = ["Contrarian", "First Principles", "Expansionist", "Outsider", "Executor"]
GATES = ["G1", "G2", "G3", "G4"]


def load_runs(path: Path, since: str | None = None, tail: int | None = None) -> list[dict]:
    if not path.exists():
        return []
    runs: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if since and rec.get("timestamp", "") < since:
                continue
            runs.append(rec)
    if tail:
        runs = runs[-tail:]
    return runs


def gate_hotspots(runs: list[dict]) -> dict:
    """Per (advisor, gate) FAIL count + rate."""
    fail = Counter()
    seen = Counter()
    for r in runs:
        for advisor, body in (r.get("advisors") or {}).items():
            for gate in GATES:
                verdict = (body.get("gates") or {}).get(gate)
                if verdict in ("PASS", "FAIL"):
                    seen[(advisor, gate)] += 1
                    if verdict == "FAIL":
                        fail[(advisor, gate)] += 1
    rows = []
    for key, total in seen.items():
        f = fail[key]
        rows.append({
            "advisor": key[0],
            "gate": key[1],
            "fail": f,
            "n": total,
            "fail_rate": round(f / total, 3) if total else 0.0,
        })
    rows.sort(key=lambda x: (-x["fail_rate"], -x["fail"], x["advisor"], x["gate"]))
    return rows


def disposition_distribution(runs: list[dict]) -> dict:
    by_reviewer = defaultdict(Counter)
    by_reviewee = defaultdict(Counter)
    overall = Counter()
    for r in runs:
        for pr in r.get("peer_reviews", []):
            disp = pr.get("disposition") or "Unknown"
            overall[disp] += 1
            by_reviewer[pr["reviewer"]][disp] += 1
            by_reviewee[pr["reviewee"]][disp] += 1
    return {
        "overall": dict(overall),
        "by_reviewer": {k: dict(v) for k, v in by_reviewer.items()},
        "by_reviewee": {k: dict(v) for k, v in by_reviewee.items()},
    }


def convergence_rate(runs: list[dict]) -> dict:
    raised = sum(1 for r in runs if (r.get("convergence") or {}).get("flag") is True)
    cleared = sum(1 for r in runs if (r.get("convergence") or {}).get("flag") is False)
    unknown = sum(1 for r in runs if (r.get("convergence") or {}).get("flag") is None)
    return {
        "raised": raised,
        "cleared": cleared,
        "unknown": unknown,
        "rate": round(raised / len(runs), 3) if runs else 0.0,
    }


def confidence_distribution(runs: list[dict]) -> dict:
    counts = Counter()
    low_conf_questions: list[str] = []
    for r in runs:
        conf = (r.get("chairman") or {}).get("confidence")
        counts[conf or "missing"] += 1
        if conf in ("low", "medium-low"):
            low_conf_questions.append(r.get("question", ""))
    return {
        "counts": dict(counts),
        "low_confidence_questions": low_conf_questions,
    }


def cost_distribution(runs: list[dict]) -> dict:
    tokens = [r.get("metrics", {}).get("tokens") for r in runs if (r.get("metrics") or {}).get("tokens")]
    walls = [r.get("metrics", {}).get("wall_clock_seconds") for r in runs if (r.get("metrics") or {}).get("wall_clock_seconds")]

    def _summary(xs):
        if not xs:
            return None
        return {
            "n": len(xs),
            "min": min(xs),
            "max": max(xs),
            "mean": round(statistics.mean(xs), 1),
            "stdev": round(statistics.stdev(xs), 1) if len(xs) > 1 else 0.0,
            "spread_pct": round(((max(xs) - min(xs)) / statistics.mean(xs)) * 100, 1) if statistics.mean(xs) else 0.0,
        }

    return {"tokens": _summary(tokens), "wall_clock_seconds": _summary(walls)}


def exit_criteria(runs: list[dict]) -> dict:
    """Scorecard against the plan's exit criteria."""
    n = len(runs)

    # 1. All shakedowns validate (here we don't know which run = which scenario,
    #    but we report the structural-validity rate as a proxy).
    valid_runs = sum(1 for r in runs if (r.get("validation") or {}).get("valid"))

    # 2. Every advisor ≥3/4 average gate pass.
    sums = defaultdict(list)
    for r in runs:
        for advisor, body in (r.get("advisors") or {}).items():
            sums[advisor].append(body.get("gate_pass_count", 0))
    advisor_avg = {a: round(statistics.mean(v), 2) for a, v in sums.items() if v}

    # 3. Convergence flag fires at most once across the campaign.
    convergence_raised = convergence_rate(runs)["raised"]

    # 4. Chairman confidence ≥ medium-high on ≥6/8 runs.
    high_or_above = sum(
        1 for r in runs
        if (r.get("chairman") or {}).get("confidence") in ("high", "medium-high")
    )

    # 5. Token cost stable within 20% per scope tier — proxy on overall spread.
    tokens = [r.get("metrics", {}).get("tokens") for r in runs if (r.get("metrics") or {}).get("tokens")]
    token_spread_ok = None
    if tokens and len(tokens) > 1 and statistics.mean(tokens):
        spread_pct = ((max(tokens) - min(tokens)) / statistics.mean(tokens)) * 100
        token_spread_ok = spread_pct <= 20.0

    return {
        "n_runs": n,
        "validate_pass_rate": round(valid_runs / n, 3) if n else 0.0,
        "advisor_gate_avg": advisor_avg,
        "advisor_gate_avg_min": min(advisor_avg.values()) if advisor_avg else None,
        "convergence_raised": convergence_raised,
        "high_or_above_confidence_runs": high_or_above,
        "token_spread_within_20pct": token_spread_ok,
        "checklist": {
            "all_validate": valid_runs == n if n else False,
            "every_advisor_avg_ge_3": all(v >= 3.0 for v in advisor_avg.values()) if advisor_avg else False,
            "convergence_at_most_once": convergence_raised <= 1,
            "high_or_above_ge_6_of_8": high_or_above >= 6 if n >= 8 else None,
            "token_spread_ok": token_spread_ok,
        },
    }


def render_report(report: dict) -> str:
    lines = []
    lines.append(f"# Council telemetry — {report['n_runs']} run(s)")
    lines.append("")

    lines.append("## Exit-criteria scorecard")
    cl = report["exit_criteria"]
    lines.append(f"- Validate pass rate: {cl['validate_pass_rate']*100:.0f}%")
    lines.append(f"- Advisor avg gate-pass (≥3.0 target): {cl['advisor_gate_avg']}")
    lines.append(f"- Convergence flags raised: {cl['convergence_raised']} (target ≤1)")
    lines.append(f"- High/medium-high confidence: {cl['high_or_above_confidence_runs']}/{report['n_runs']} (target ≥6/8)")
    spread = cl["token_spread_within_20pct"]
    lines.append(f"- Token spread within 20%: {'yes' if spread else 'no' if spread is False else 'n/a (insufficient runs with token metrics)'}")
    lines.append("")

    lines.append("## Gate-failure hotspots (top 5)")
    if not report["gate_hotspots"]:
        lines.append("- No gate-fail data yet.")
    else:
        for row in report["gate_hotspots"][:5]:
            if row["fail"] == 0:
                continue
            lines.append(
                f"- {row['advisor']:<16} {row['gate']}  "
                f"fail {row['fail']}/{row['n']}  ({row['fail_rate']*100:.0f}%)"
            )
        if all(r["fail"] == 0 for r in report["gate_hotspots"]):
            lines.append("- 0 gate failures across all runs (suspicious — check whether reviewers are too lenient).")
    lines.append("")

    lines.append("## Peer-review disposition distribution")
    disp = report["dispositions"]
    lines.append(f"- Overall: {disp['overall']}")
    lines.append("")

    lines.append("## Convergence")
    cv = report["convergence"]
    lines.append(f"- Raised: {cv['raised']} | Cleared: {cv['cleared']} | Unknown: {cv['unknown']} (rate {cv['rate']*100:.0f}%)")
    lines.append("")

    lines.append("## Chairman confidence")
    conf = report["confidence"]
    lines.append(f"- Distribution: {conf['counts']}")
    if conf["low_confidence_questions"]:
        lines.append("- Low-confidence questions (candidates for documenting as 'not a good council fit'):")
        for q in conf["low_confidence_questions"]:
            lines.append(f"  - {q}")
    lines.append("")

    lines.append("## Cost (token + wall-clock summary)")
    cost = report["cost"]
    if cost["tokens"]:
        t = cost["tokens"]
        lines.append(f"- Tokens: n={t['n']} mean={t['mean']:.0f} stdev={t['stdev']:.0f} spread={t['spread_pct']}%")
    else:
        lines.append("- Tokens: no metrics recorded (pass --tokens to telemetry.py).")
    if cost["wall_clock_seconds"]:
        w = cost["wall_clock_seconds"]
        lines.append(f"- Wall-clock: n={w['n']} mean={w['mean']}s stdev={w['stdev']}s")
    else:
        lines.append("- Wall-clock: no metrics recorded.")
    lines.append("")

    return "\n".join(lines)


def build_report(runs: list[dict]) -> dict:
    return {
        "n_runs": len(runs),
        "gate_hotspots": gate_hotspots(runs),
        "dispositions": disposition_distribution(runs),
        "convergence": convergence_rate(runs),
        "confidence": confidence_distribution(runs),
        "cost": cost_distribution(runs),
        "exit_criteria": exit_criteria(runs),
    }


def main():
    parser = argparse.ArgumentParser(description="Analyze council-runs.jsonl telemetry.")
    parser.add_argument("--log", default=str(DEFAULT_LOG_PATH), help=f"JSONL log path (default: {DEFAULT_LOG_PATH}).")
    parser.add_argument("--json", action="store_true", help="Emit JSON report.")
    parser.add_argument("--since", default=None, help="Only include runs with ISO timestamps ≥ this prefix.")
    parser.add_argument("--tail", type=int, default=None, help="Only the last N runs.")
    args = parser.parse_args()

    runs = load_runs(Path(args.log), since=args.since, tail=args.tail)
    report = build_report(runs)

    if not runs:
        print(f"⚠️  No runs found at {args.log}.", file=sys.stderr)
        sys.exit(0)

    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        print(render_report(report))


if __name__ == "__main__":
    main()
