#!/usr/bin/env python3
"""Generate a full 3-phase HTML validation report for a CLEO skill.

Phase 1: Structural compliance (validate.py tiers 1-5)
Phase 2: CLEO Ecosystem compliance (ecosystem-check.json, if provided)
Phase 3: Quality eval results (grading.json, comparison.json, if provided)

Opens the report in the user's browser automatically.

Usage:
    python generate_validation_report.py <skill-dir>
    python generate_validation_report.py <skill-dir> --manifest path/to/manifest.json
    python generate_validation_report.py <skill-dir> --ecosystem-check ecosystem-check.json
    python generate_validation_report.py <skill-dir> --grading grading.json --comparison comparison.json
    python generate_validation_report.py <skill-dir> --output report.html
    python generate_validation_report.py <skill-dir> --no-open
"""

import argparse
import html
import json
import subprocess
import sys
import tempfile
import time
import webbrowser
from pathlib import Path


TIER_NAMES = {
    1: "Tier 1 — Structure",
    2: "Tier 2 — Frontmatter Quality",
    3: "Tier 3 — Body Quality",
    4: "Tier 4 — CLEO Integration",
    5: "Tier 5 — Provider Compatibility",
}


def run_validate(skill_path: Path, manifest: str | None, dispatch_config: str | None, provider_map: str | None) -> dict:
    """Run validate.py --json and return parsed output."""
    script = Path(__file__).parent / "validate.py"
    cmd = [sys.executable, str(script), str(skill_path), "--json"]
    if manifest:
        cmd.extend(["--manifest", manifest])
    if dispatch_config:
        cmd.extend(["--dispatch-config", dispatch_config])
    if provider_map:
        cmd.extend(["--provider-map", provider_map])
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {
            "skill_name": skill_path.name,
            "results": [{"tier": 1, "severity": "ERROR", "message": f"validate.py failed: {result.stderr.strip()}"}],
            "errors": 1, "warnings": 0, "passed": False,
        }


def run_audit_body(skill_path: Path) -> list[dict] | None:
    """Run audit_body.py --json and return parsed findings."""
    script = Path(__file__).parent / "audit_body.py"
    if not script.exists():
        return None
    result = subprocess.run([sys.executable, str(script), str(skill_path), "--json"], capture_output=True, text=True)
    if result.stdout.strip():
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            pass
    return None


def _phase_header(phase_num: int, title: str, status: str) -> str:
    color = {"PASS": "#788c5d", "PASS_WITH_WARNINGS": "#d97706", "FAIL": "#c44", "PENDING": "#b0aea5"}.get(status, "#b0aea5")
    label = {"PASS": "PASS", "PASS_WITH_WARNINGS": "PASS ⚠", "FAIL": "FAIL", "PENDING": "—"}.get(status, status)
    return f"""
    <div class="phase-header">
        <span class="phase-num">Phase {phase_num}</span>
        <span class="phase-title">{html.escape(title)}</span>
        <span class="phase-badge" style="color:{color}">{label}</span>
    </div>
"""


def _tier_section(tier_num: int, tier_results: list[dict]) -> str:
    tier_name = html.escape(TIER_NAMES.get(tier_num, f"Tier {tier_num}"))
    t_errors = sum(1 for r in tier_results if r["severity"] == "ERROR")
    t_warns = sum(1 for r in tier_results if r["severity"] == "WARN")
    if t_errors:
        indicator = f" — {t_errors} error(s)"
    elif t_warns:
        indicator = f" — {t_warns} warning(s)"
    else:
        indicator = " — OK"

    rows = ""
    for r in tier_results:
        sev = r["severity"]
        msg = html.escape(r["message"])
        if sev == "OK":
            rows += f'        <div class="finding finding-ok"><span class="icon">✅</span><span>{msg}</span></div>\n'
        elif sev == "WARN":
            rows += f'        <div class="finding finding-warn"><span class="icon">⚠️</span><span>{msg}</span></div>\n'
        elif sev == "ERROR":
            rows += f'        <div class="finding finding-error"><span class="icon">❌</span><span>{msg}</span></div>\n'

    return f"""
    <div class="tier-section">
        <div class="tier-header">{tier_name}{indicator}</div>
{rows}    </div>
"""


def _ecosystem_section(eco: dict) -> str:
    verdict = eco.get("verdict", "UNKNOWN")
    verdict_color = {"PASS": "#788c5d", "PASS_WITH_WARNINGS": "#d97706", "FAIL": "#c44"}.get(verdict, "#b0aea5")
    summary = eco.get("summary", {})
    primary_domain = eco.get("primary_domain", "—")
    lifecycle = eco.get("lifecycle_stages_served", [])
    recommendations = eco.get("recommendations", [])
    rules = eco.get("rules", [])

    rule_rows = ""
    for rule in rules:
        status = rule.get("status", "")
        icon = {"OK": "✅", "WARN": "⚠️", "ERROR": "❌", "SKIP": "⏭"}.get(status, "•")
        css = {"OK": "finding-ok", "WARN": "finding-warn", "ERROR": "finding-error", "SKIP": "finding-skip"}.get(status, "")
        rule_name = html.escape(f"Rule {rule.get('rule_id', '?')} — {rule.get('rule_name', '')}")
        finding = html.escape(rule.get("finding", ""))
        evidence = html.escape(rule.get("evidence", ""))
        ev_block = f'<div class="evidence">Evidence: {evidence}</div>' if evidence else ""
        rule_rows += f"""        <div class="finding {css}">
            <span class="icon">{icon}</span>
            <span><strong>{rule_name}</strong><br>{finding}{ev_block}</span>
        </div>\n"""

    rec_items = "".join(f"<li>{html.escape(r)}</li>" for r in recommendations) if recommendations else ""
    rec_block = f'<div class="recommendations"><strong>Recommendations:</strong><ol>{rec_items}</ol></div>' if rec_items else ""

    return f"""
    <div class="tier-section" style="border-color:#3a5a8c">
        <div class="tier-header" style="background:#2c3e5a">
            CLEO Ecosystem Compliance — Primary domain: {html.escape(primary_domain)} | Lifecycle: {html.escape(", ".join(lifecycle) or "—")}
            <span style="float:right;color:{verdict_color}">{html.escape(verdict)}</span>
        </div>
        <div style="padding:10px 16px;font-size:0.8rem;color:#6b6b6b;background:#f7f9fc;border-bottom:1px solid #dde6f0">
            Errors: {summary.get("errors", 0)} &nbsp;|&nbsp; Warnings: {summary.get("warnings", 0)} &nbsp;|&nbsp; Skipped: {summary.get("skipped", 0)} &nbsp;|&nbsp; Passed: {summary.get("passed", 0)}
        </div>
{rule_rows}        {rec_block}
    </div>
"""


def _grading_section(grading: dict) -> str:
    summary = grading.get("summary", {})
    expectations = grading.get("expectations", [])
    pass_rate = summary.get("pass_rate", 0)
    color = "#788c5d" if pass_rate >= 0.8 else ("#d97706" if pass_rate >= 0.5 else "#c44")

    rows = ""
    for exp in expectations:
        passed = exp.get("passed", False)
        icon = "✅" if passed else "❌"
        css = "finding-ok" if passed else "finding-error"
        text = html.escape(exp.get("text", ""))
        evidence = html.escape(exp.get("evidence", ""))
        rows += f'        <div class="finding {css}"><span class="icon">{icon}</span><span><strong>{text}</strong><br><span class="evidence">{evidence}</span></span></div>\n'

    return f"""
    <div class="tier-section" style="border-color:#5a3a8c">
        <div class="tier-header" style="background:#3a2a5a">
            Quality Eval — Grading Results
            <span style="float:right;color:{color}">{summary.get("passed", 0)}/{summary.get("total", 0)} passed ({pass_rate:.0%})</span>
        </div>
{rows}    </div>
"""


def _comparison_section(comparison: dict) -> str:
    winner = comparison.get("winner", "?")
    reasoning = html.escape(comparison.get("reasoning", ""))
    q_a = comparison.get("output_quality", {}).get("A", {})
    q_b = comparison.get("output_quality", {}).get("B", {})

    def quality_block(label: str, q: dict) -> str:
        score = q.get("score", "?")
        strengths = "".join(f"<li>{html.escape(s)}</li>" for s in q.get("strengths", []))
        weaknesses = "".join(f"<li>{html.escape(w)}</li>" for w in q.get("weaknesses", []))
        return f"""<div class="ab-block"><strong>Output {label} (score: {score}/10)</strong>
            <div style="margin-top:6px"><em>Strengths:</em><ul>{strengths}</ul></div>
            <div><em>Weaknesses:</em><ul>{weaknesses}</ul></div></div>"""

    winner_color = "#788c5d" if winner == "A" else ("#c44" if winner == "B" else "#d97706")
    return f"""
    <div class="tier-section" style="border-color:#5a3a8c">
        <div class="tier-header" style="background:#3a2a5a">
            Quality Eval — A/B Comparison
            <span style="float:right;color:{winner_color}">Winner: {html.escape(winner)}</span>
        </div>
        <div style="padding:12px 16px;font-size:0.875rem">
            <p><strong>Reasoning:</strong> {reasoning}</p>
            <div class="ab-grid">
                {quality_block("A", q_a)}
                {quality_block("B", q_b)}
            </div>
        </div>
    </div>
"""


def generate_html(
    validation: dict,
    audit: list[dict] | None,
    ecosystem: dict | None,
    grading: dict | None,
    comparison: dict | None,
    skill_path: Path,
) -> str:
    """Generate a self-contained 3-phase HTML validation report."""
    skill_name = html.escape(validation.get("skill_name", skill_path.name))
    s_errors = validation.get("errors", 0)
    s_warnings = validation.get("warnings", 0)
    s_passed = validation.get("passed", s_errors == 0)

    eco_verdict = ecosystem.get("verdict", "PENDING") if ecosystem else "PENDING"
    eco_passed = eco_verdict in ("PASS", "PASS_WITH_WARNINGS") if ecosystem else None

    # Compute overall
    phase1_status = "PASS" if s_passed and s_warnings == 0 else ("PASS_WITH_WARNINGS" if s_passed else "FAIL")
    phase2_status = eco_verdict if ecosystem else "PENDING"
    phase3_status = "PASS" if grading and grading.get("summary", {}).get("pass_rate", 0) >= 0.8 else ("FAIL" if grading else "PENDING")

    all_passed = s_passed and (eco_passed is not False) and (grading is None or phase3_status == "PASS")
    overall_label = "ALL PHASES PASS" if all_passed else "ISSUES FOUND"
    overall_color = "#788c5d" if all_passed else "#c44"

    # Build tier sections
    results = validation.get("results", [])
    tiers: dict[int, list[dict]] = {}
    for r in results:
        t = r.get("tier", 0)
        tiers.setdefault(t, []).append(r)

    tier_html = "".join(_tier_section(t, tiers[t]) for t in sorted(tiers))

    audit_html = ""
    if audit is not None:
        if not audit:
            audit_html = '<div class="tier-section"><div class="tier-header">Body Quality Audit (audit_body)</div><div class="no-issues">No issues found.</div></div>'
        else:
            items = "".join(f'<div class="finding finding-warn"><span class="icon">⚠️</span><span>{html.escape(str(i))}</span></div>' for i in audit)
            audit_html = f'<div class="tier-section"><div class="tier-header">Body Quality Audit (audit_body)</div>{items}</div>'

    eco_html = _ecosystem_section(ecosystem) if ecosystem else '<div class="tier-section pending"><div class="tier-header">CLEO Ecosystem Compliance — Not yet run</div><div class="no-issues">Run: python check_ecosystem.py &lt;skill-dir&gt; | ecosystem-checker agent | save to ecosystem-check.json</div></div>'

    grading_html = _grading_section(grading) if grading else '<div class="tier-section pending"><div class="tier-header" style="background:#3a2a5a">Quality Eval — Grading not yet run</div><div class="no-issues">Run A/B eval using ct-skill-creator agents/grader.md then pass --grading grading.json</div></div>'

    comparison_html = _comparison_section(comparison) if comparison else ""

    return f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>{skill_name} — CLEO Full Validation Report</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Lora:wght@400;500&display=swap" rel="stylesheet">
    <style>
        body {{ font-family: 'Lora', Georgia, serif; max-width: 900px; margin: 0 auto; padding: 32px 24px; background: #faf9f5; color: #141413; }}
        h1 {{ font-family: 'Poppins', sans-serif; color: #141413; margin-bottom: 4px; }}
        h2 {{ font-family: 'Poppins', sans-serif; font-size: 0.95rem; color: #141413; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: 0.06em; }}
        .subtitle {{ color: #b0aea5; font-size: 0.875rem; margin-bottom: 24px; }}
        .overall-box {{ background: white; border: 2px solid {overall_color}; border-radius: 8px; padding: 18px 24px; margin-bottom: 24px; display: flex; align-items: center; gap: 20px; }}
        .overall-badge {{ font-family: 'Poppins', sans-serif; font-size: 1.3rem; font-weight: 600; color: {overall_color}; flex-shrink: 0; }}
        .phase-grid {{ display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 28px; }}
        .phase-card {{ background: white; border: 1px solid #e8e6dc; border-radius: 8px; padding: 14px 16px; }}
        .phase-card .label {{ font-family: 'Poppins', sans-serif; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #b0aea5; }}
        .phase-card .name {{ font-size: 0.875rem; margin: 4px 0; font-weight: 500; }}
        .phase-card .status {{ font-family: 'Poppins', sans-serif; font-size: 0.9rem; font-weight: 600; }}
        .phase-header {{ display: flex; align-items: center; gap: 10px; margin: 24px 0 8px; font-family: 'Poppins', sans-serif; }}
        .phase-num {{ background: #141413; color: white; border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 600; flex-shrink: 0; }}
        .phase-title {{ font-size: 0.9rem; font-weight: 600; flex: 1; }}
        .phase-badge {{ font-size: 0.85rem; font-weight: 600; }}
        .tier-section {{ background: white; border: 1px solid #e8e6dc; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }}
        .tier-section.pending {{ opacity: 0.6; }}
        .tier-header {{ font-family: 'Poppins', sans-serif; font-size: 0.8rem; font-weight: 600; padding: 10px 16px; background: #141413; color: #faf9f5; }}
        .finding {{ display: flex; align-items: flex-start; gap: 10px; padding: 9px 16px; border-bottom: 1px solid #f0ede3; font-size: 0.85rem; line-height: 1.5; }}
        .finding:last-child {{ border-bottom: none; }}
        .icon {{ flex-shrink: 0; }}
        .finding-ok {{ color: #3b3b3b; }}
        .finding-warn {{ color: #92400e; background: #fffbeb; }}
        .finding-error {{ color: #7f1d1d; background: #fef2f2; }}
        .finding-skip {{ color: #6b6b6b; background: #f5f5f5; }}
        .evidence {{ font-size: 0.78rem; color: #888; font-style: italic; margin-top: 3px; display: block; }}
        .no-issues {{ padding: 12px 16px; color: #788c5d; font-size: 0.875rem; }}
        .recommendations {{ padding: 10px 16px; font-size: 0.85rem; background: #fffbeb; }}
        .recommendations ol {{ margin: 4px 0 0 16px; padding: 0; }}
        .ab-grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 10px; }}
        .ab-block {{ background: #f7f7f5; border-radius: 6px; padding: 10px 14px; font-size: 0.8rem; }}
        .ab-block ul {{ margin: 4px 0 0 16px; padding: 0; }}
        .footer {{ margin-top: 32px; font-size: 0.75rem; color: #b0aea5; text-align: center; }}
    </style>
</head>
<body>
    <h1>{skill_name}</h1>
    <div class="subtitle">CLEO Full Validation Report &mdash; {time.strftime("%Y-%m-%d %H:%M")}</div>

    <div class="overall-box">
        <div class="overall-badge">{html.escape(overall_label)}</div>
        <div style="font-size:0.875rem;color:#6b6b6b">
            Structural: {s_errors} errors, {s_warnings} warnings &nbsp;|&nbsp;
            Ecosystem: {html.escape(eco_verdict)} &nbsp;|&nbsp;
            Quality: {html.escape(phase3_status)}
        </div>
    </div>

    <div class="phase-grid">
        <div class="phase-card">
            <div class="label">Phase 1</div>
            <div class="name">Structural Compliance</div>
            <div class="status" style="color:{'#788c5d' if phase1_status == 'PASS' else ('#d97706' if 'WARN' in phase1_status else '#c44')}">{html.escape(phase1_status)}</div>
        </div>
        <div class="phase-card">
            <div class="label">Phase 2</div>
            <div class="name">CLEO Ecosystem Fit</div>
            <div class="status" style="color:{'#788c5d' if phase2_status == 'PASS' else ('#d97706' if 'WARN' in phase2_status else ('#b0aea5' if phase2_status == 'PENDING' else '#c44'))}">{html.escape(phase2_status)}</div>
        </div>
        <div class="phase-card">
            <div class="label">Phase 3</div>
            <div class="name">Quality A/B Eval</div>
            <div class="status" style="color:{'#788c5d' if phase3_status == 'PASS' else ('#b0aea5' if phase3_status == 'PENDING' else '#c44')}">{html.escape(phase3_status)}</div>
        </div>
    </div>

    <h2>Phase 1 — Structural Compliance</h2>
    {tier_html}
    {audit_html}

    <h2>Phase 2 — CLEO Ecosystem Fit</h2>
    {eco_html}

    <h2>Phase 3 — Quality A/B Eval</h2>
    {grading_html}
    {comparison_html}

    <div class="footer">Generated by ct-skill-validator &mdash; CLEO Full Validation Report</div>
</body>
</html>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate full 3-phase validation report for a CLEO skill")
    parser.add_argument("skill_dir", help="Path to the skill directory")
    parser.add_argument("--manifest", default=None, help="Path to manifest.json (Tier 4 check)")
    parser.add_argument("--dispatch-config", default=None, help="Path to dispatch-config.json")
    parser.add_argument("--provider-map", default=None, help="Path to provider-skills-map.json")
    parser.add_argument("--ecosystem-check", default=None, help="Path to ecosystem-check.json (Phase 2 results)")
    parser.add_argument("--grading", default=None, help="Path to grading.json (Phase 3 quality eval)")
    parser.add_argument("--comparison", default=None, help="Path to comparison.json (Phase 3 A/B results)")
    parser.add_argument("--audit", action="store_true", help="Run audit_body.py for deep body analysis")
    parser.add_argument("--output", "-o", default=None, help="Write HTML to this path (default: temp file)")
    parser.add_argument("--no-open", action="store_true", help="Do not open the report in a browser")
    args = parser.parse_args()

    skill_path = Path(args.skill_dir).resolve()
    if not skill_path.is_dir():
        print(f"Error: '{args.skill_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    print(f"Phase 1: Running structural validation ...", file=sys.stderr)
    validation = run_validate(skill_path, args.manifest, args.dispatch_config, args.provider_map)

    audit = None
    if args.audit:
        print(f"Phase 1: Running body audit ...", file=sys.stderr)
        audit = run_audit_body(skill_path)

    ecosystem = None
    if args.ecosystem_check:
        eco_path = Path(args.ecosystem_check)
        if eco_path.exists():
            try:
                ecosystem = json.loads(eco_path.read_text())
                print(f"Phase 2: Loaded ecosystem check from {eco_path}", file=sys.stderr)
            except json.JSONDecodeError as e:
                print(f"Warning: Could not parse {eco_path}: {e}", file=sys.stderr)
        else:
            print(f"Warning: ecosystem-check.json not found at {eco_path}", file=sys.stderr)

    grading = None
    if args.grading:
        grading_path = Path(args.grading)
        if grading_path.exists():
            try:
                grading = json.loads(grading_path.read_text())
                print(f"Phase 3: Loaded grading from {grading_path}", file=sys.stderr)
            except json.JSONDecodeError:
                pass

    comparison = None
    if args.comparison:
        comp_path = Path(args.comparison)
        if comp_path.exists():
            try:
                comparison = json.loads(comp_path.read_text())
                print(f"Phase 3: Loaded comparison from {comp_path}", file=sys.stderr)
            except json.JSONDecodeError:
                pass

    report_html = generate_html(validation, audit, ecosystem, grading, comparison, skill_path)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report_html)
        report_path = out_path.resolve()
    else:
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        tmp = Path(tempfile.gettempdir()) / f"cleo_validation_{skill_path.name}_{timestamp}.html"
        tmp.write_text(report_html)
        report_path = tmp

    s_errors = validation.get("errors", 0)
    s_warnings = validation.get("warnings", 0)
    s_passed = validation.get("passed", False)
    eco_verdict = ecosystem.get("verdict", "—") if ecosystem else "not run"

    print(f"\n  Validation Report: {report_path}", file=sys.stderr)
    print(f"  Phase 1 (Structural): {'PASS' if s_passed else 'FAIL'} ({s_errors} errors, {s_warnings} warnings)", file=sys.stderr)
    print(f"  Phase 2 (Ecosystem):  {eco_verdict}", file=sys.stderr)
    print(f"  Phase 3 (Quality):    {'PASS' if grading else 'not run'}", file=sys.stderr)

    if not args.no_open:
        webbrowser.open(str(report_path))

    sys.exit(0 if s_passed else 1)


if __name__ == "__main__":
    main()
