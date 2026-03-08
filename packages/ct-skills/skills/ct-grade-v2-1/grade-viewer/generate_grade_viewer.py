#!/usr/bin/env python3
"""
generate_grade_viewer.py — Generate and serve a visual HTML report for ct-grade A/B runs.

Reads all artifacts from a run directory (grade.json, comparison.json, timing.json,
token-summary.json, analysis.json, report.md) and produces a self-contained HTML
page with visual score bars, A/B comparison tables, token charts, and recommendations.

Usage:
    # Serve live at localhost:3119 (refreshes on browser reload):
    python grade-viewer/generate_grade_viewer.py --run-dir ./ab_results/run-001

    # Write static HTML file:
    python grade-viewer/generate_grade_viewer.py --run-dir ./ab_results/run-001 --static grade-results.html

    # Different port:
    python grade-viewer/generate_grade_viewer.py --run-dir ./ab_results/run-001 --port 3120
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
from functools import partial
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path


DIMENSION_LABELS = {
    "sessionDiscipline":   "S1 Session Discipline",
    "discoveryEfficiency": "S2 Discovery Efficiency",
    "taskHygiene":         "S3 Task Hygiene",
    "errorProtocol":       "S4 Error Protocol",
    "disclosureUse":       "S5 Progressive Disclosure",
}

GRADE_COLORS = {"A": "#22c55e", "B": "#10b981", "C": "#eab308", "D": "#f97316", "F": "#ef4444"}
DIM_COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981"]


def letter_grade(score):
    if score is None:
        return "?"
    if score >= 90: return "A"
    if score >= 75: return "B"
    if score >= 60: return "C"
    if score >= 45: return "D"
    return "F"


def load_json_file(path):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return None


def find_grade_files(run_dir):
    return sorted(Path(run_dir).rglob("grade.json"))


def find_comparison_files(run_dir):
    return sorted(Path(run_dir).rglob("comparison.json"))


def collect_run_data(run_dir):
    """Collect all artifacts from the run directory."""
    data = {
        "manifest": load_json_file(Path(run_dir) / "run-manifest.json") or {},
        "token_summary": load_json_file(Path(run_dir) / "token-summary.json") or {},
        "analysis": load_json_file(Path(run_dir) / "analysis.json"),
        "report_md": None,
        "slots": {},
    }
    report_path = Path(run_dir) / "report.md"
    if report_path.exists():
        data["report_md"] = report_path.read_text()

    # Walk slot/run/arm structure
    for slot_dir in sorted(Path(run_dir).iterdir()):
        if not slot_dir.is_dir() or slot_dir.name.startswith("."):
            continue
        if slot_dir.name in ("run-manifest.json", "token-summary.json", "analysis.json", "report.md"):
            continue
        slot_name = slot_dir.name
        data["slots"][slot_name] = {"runs": {}}

        for run_subdir in sorted(slot_dir.iterdir()):
            if not run_subdir.is_dir():
                continue
            run_num = run_subdir.name
            run_data = {"arms": {}, "comparison": None}

            for arm_dir in sorted(run_subdir.iterdir()):
                if not arm_dir.is_dir():
                    continue
                arm_name = arm_dir.name
                arm_data = {
                    "grade": load_json_file(arm_dir / "grade.json"),
                    "timing": load_json_file(arm_dir / "timing.json"),
                    "operations": [],
                }
                ops_path = arm_dir / "operations.jsonl"
                if ops_path.exists():
                    for line in ops_path.read_text().splitlines():
                        line = line.strip()
                        if line:
                            try:
                                arm_data["operations"].append(json.loads(line))
                            except Exception:
                                pass
                run_data["arms"][arm_name] = arm_data

            comp = load_json_file(run_subdir / "comparison.json")
            run_data["comparison"] = comp
            data["slots"][slot_name]["runs"][run_num] = run_data

    return data


def pct(n, total=20):
    if n is None or total == 0:
        return 0
    return min(100, max(0, round(n / total * 100)))


def dim_bar(label, score, max_score=20, color="#6366f1"):
    fill = pct(score, max_score)
    score_str = f"{score}/{max_score}" if score is not None else "—"
    return f"""
    <div class="dim-row">
      <div class="dim-label"><span>{esc(label)}</span><span class="dim-score">{esc(score_str)}</span></div>
      <div class="dim-track"><div class="dim-fill" style="width:{fill}%;background:{color}"></div></div>
    </div>"""


def grade_badge(letter):
    color = GRADE_COLORS.get(letter, "#6b7280")
    return f'<span class="grade-badge" style="background:{color}22;color:{color};border:1px solid {color}44">{esc(letter)}</span>'


def esc(s):
    if s is None:
        return ""
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def render_grade_card(arm_label, grade_data, timing_data, color):
    if not grade_data:
        return f'<div class="no-data">No grade data for {esc(arm_label)}</div>'
    total = grade_data.get("totalScore", 0)
    letter = letter_grade(total)
    dims = grade_data.get("dimensions", {})
    flags = grade_data.get("flags", [])
    entry_count = grade_data.get("entryCount", 0)

    tokens = timing_data.get("total_tokens") if timing_data else None
    token_str = f"{tokens:,}" if tokens else "—"

    flags_html = ""
    if flags:
        flag_items = "".join(f"<li>{esc(f)}</li>" for f in flags)
        flags_html = f'<div class="flags-section"><div class="flags-label">Flags ({len(flags)})</div><ul class="flags-list">{flag_items}</ul></div>'
    else:
        flags_html = '<div class="flags-section no-flags">No flags — clean session</div>'

    dim_bars = ""
    for i, (dim_key, dim_label) in enumerate(DIMENSION_LABELS.items()):
        dim_data = dims.get(dim_key, {})
        score = dim_data.get("score")
        dim_bars += dim_bar(dim_label, score, 20, DIM_COLORS[i % len(DIM_COLORS)])

    evidence_html = ""
    for dim_key, dim_label in DIMENSION_LABELS.items():
        evs = dims.get(dim_key, {}).get("evidence", [])
        if evs:
            items = "".join(f"<li>{esc(e)}</li>" for e in evs)
            evidence_html += f'<div class="ev-dim">{esc(dim_label)}</div><ul class="ev-list">{items}</ul>'

    return f"""
    <div class="grade-card" style="border-top:3px solid {color}">
      <div class="grade-card-header">
        <div class="arm-label" style="color:{color}">{esc(arm_label)}</div>
        <div class="grade-score-block">
          {grade_badge(letter)}
          <span class="score-text">{esc(str(total))}<span class="score-max">/100</span></span>
        </div>
        <div class="grade-meta">
          <span>{esc(str(entry_count))} audit entries</span>
          <span>Tokens: {esc(token_str)}</span>
        </div>
      </div>
      <div class="dim-bars">{dim_bars}</div>
      {flags_html}
      {f'<div class="evidence-section"><div class="ev-title">Evidence</div>{evidence_html}</div>' if evidence_html else ''}
    </div>"""


def render_comparison_card(comp_data):
    if not comp_data:
        return ""
    winner = comp_data.get("winner", "?")
    reasoning = comp_data.get("reasoning", "")
    rubric = comp_data.get("rubric", {})
    winner_color = "#22c55e" if winner == "A" else "#f97316" if winner == "B" else "#6b7280"
    winner_label = f"Arm {winner}" if winner in ("A", "B") else "Tie"

    rows = ""
    for arm_key in ("A", "B"):
        r = rubric.get(arm_key, {})
        overall = r.get("overall_score", "—")
        content = r.get("content_score", "—")
        struct = r.get("structure_score", "—")
        rows += f"<tr><td>Arm {esc(arm_key)}</td><td>{esc(str(overall))}/10</td><td>{esc(str(content))}</td><td>{esc(str(struct))}</td></tr>"

    exp_rows = ""
    exp_res = comp_data.get("expectation_results", {})
    for arm_key in ("A", "B"):
        er = exp_res.get(arm_key, {})
        pr = er.get("pass_rate", None)
        pr_str = f"{round(pr*100)}%" if pr is not None else "—"
        passed = er.get("passed", "—")
        total = er.get("total", "—")
        exp_rows += f"<tr><td>Arm {esc(arm_key)}</td><td>{esc(str(passed))}/{esc(str(total))}</td><td>{esc(pr_str)}</td></tr>"

    return f"""
    <div class="comp-card">
      <div class="comp-header">
        <span class="comp-title">Blind Comparison</span>
        <span class="winner-badge" style="background:{winner_color}22;color:{winner_color};border:1px solid {winner_color}44">Winner: {esc(winner_label)}</span>
      </div>
      <div class="reasoning-text">{esc(reasoning)}</div>
      <div class="comp-tables">
        <table class="comp-table">
          <thead><tr><th>Arm</th><th>Overall</th><th>Content</th><th>Structure</th></tr></thead>
          <tbody>{rows}</tbody>
        </table>
        <table class="comp-table">
          <thead><tr><th>Arm</th><th>Expectations</th><th>Pass Rate</th></tr></thead>
          <tbody>{exp_rows}</tbody>
        </table>
      </div>
    </div>"""


def render_token_summary(token_summary):
    if not token_summary:
        return ""
    by_arm = token_summary.get("by_arm", {})
    delta = token_summary.get("delta_A_vs_B", {})
    warnings = token_summary.get("warnings", [])

    rows = ""
    for arm, stats in sorted(by_arm.items()):
        iface = stats.get("interface", "?")
        t = stats.get("total_tokens", {})
        mean = t.get("mean")
        sd = t.get("stddev")
        n = t.get("count", 0)
        mean_str = f"{mean:,.0f}" if mean else "—"
        sd_str = f"±{sd:,.0f}" if sd else ""
        rows += f"<tr><td>{esc(arm)}</td><td>{esc(iface)}</td><td>{esc(mean_str)} {esc(sd_str)}</td><td>{esc(str(n))}</td></tr>"

    delta_html = ""
    if delta and delta.get("mean_tokens"):
        pct_str = delta.get("percent", "")
        note = delta.get("note", "")
        delta_html = f'<div class="delta-row">Delta (A−B): <strong>{esc(pct_str)}</strong> — {esc(note)}</div>'

    warn_html = ""
    if warnings:
        warn_html = "".join(f'<div class="warn-row">{esc(w)}</div>' for w in warnings)

    return f"""
    <div class="token-section">
      <div class="section-title">Token Economy</div>
      <table class="comp-table">
        <thead><tr><th>Arm</th><th>Interface</th><th>Mean Tokens</th><th>Runs</th></tr></thead>
        <tbody>{rows}</tbody>
      </table>
      {delta_html}
      {warn_html}
    </div>"""


def render_slot(slot_name, slot_data):
    runs_html = ""
    for run_num, run_data in sorted(slot_data.get("runs", {}).items()):
        arms_html = ""
        for arm_name, arm_data in sorted(run_data.get("arms", {}).items()):
            arm_color = "#6366f1" if arm_name == "arm-A" else "#f59e0b"
            iface = (arm_data.get("timing") or {}).get("interface", arm_name)
            label = f"{arm_name} ({iface.upper()})"
            arms_html += render_grade_card(label, arm_data.get("grade"), arm_data.get("timing"), arm_color)

        comp_html = render_comparison_card(run_data.get("comparison"))
        runs_html += f"""
        <div class="run-block">
          <div class="run-label">{esc(run_num)}</div>
          <div class="arms-row">{arms_html}</div>
          {comp_html}
        </div>"""

    return f"""
    <div class="slot-block">
      <div class="slot-title">{esc(slot_name)}</div>
      {runs_html}
    </div>"""


def generate_html(run_dir: Path) -> str:
    data = collect_run_data(run_dir)
    manifest = data["manifest"]
    token_summary = data["token_summary"]
    analysis = data["analysis"]
    report_md = data["report_md"]

    mode = manifest.get("mode", "—")
    created_at = manifest.get("created_at", "—")
    arms_info = manifest.get("arms", {})
    arm_a_label = arms_info.get("A", {}).get("label", "Arm A")
    arm_b_label = arms_info.get("B", {}).get("label", "Arm B")

    slots_html = ""
    for slot_name, slot_data in sorted(data["slots"].items()):
        slots_html += render_slot(slot_name, slot_data)

    token_html = render_token_summary(token_summary)

    analysis_html = ""
    if analysis:
        recs = analysis.get("improvement_suggestions", [])
        rec_items = "".join(
            f'<div class="rec-item" style="border-left:3px solid {"#ef4444" if r.get("priority")=="high" else "#eab308" if r.get("priority")=="medium" else "#6366f1"}">'
            f'<div class="rec-priority">{esc(r.get("priority","").upper())}</div>'
            f'<div class="rec-dim">{esc(r.get("dimension",""))}</div>'
            f'<div class="rec-text">{esc(r.get("suggestion",""))}</div>'
            f'<div class="rec-impact">{esc(r.get("expected_impact",""))}</div>'
            f'</div>'
            for r in recs
        )
        analysis_html = f'<div class="section-title">Recommendations</div>{rec_items}' if rec_items else ""

    report_html = ""
    if report_md:
        pre_lines = report_md.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        report_html = f'<pre class="report-pre">{pre_lines}</pre>'

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ct-grade Results Viewer</title>
<style>
:root {{
  --bg:#0f1117;--surface:#1a1d27;--surface2:#21263a;--border:#2a2f45;
  --text:#e8eaf0;--muted:#6b7280;--accent:#6366f1;--radius:8px;
  --green:#22c55e;--red:#ef4444;--yellow:#eab308;
}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;font-size:14px}}
.topbar{{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;justify-content:space-between}}
.topbar h1{{font-size:1rem;font-weight:700;letter-spacing:-.01em}}
.topbar .meta{{font-size:11px;color:var(--muted)}}
.badge{{background:#3730a322;color:var(--accent);font-size:11px;padding:2px 8px;border-radius:20px;font-weight:600;margin-left:8px}}
.tabs{{display:flex;gap:0;border-bottom:1px solid var(--border);background:var(--surface);padding:0 24px}}
.tab{{padding:10px 16px;cursor:pointer;font-size:13px;font-weight:500;color:var(--muted);border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;color:var(--muted)}}
.tab:hover{{color:var(--text)}}
.tab.active{{color:var(--accent);border-bottom-color:var(--accent)}}
.pane{{display:none;padding:24px;max-width:1200px;margin:0 auto}}
.pane.active{{display:block}}
.slot-block{{margin-bottom:32px}}
.slot-title{{font-size:16px;font-weight:700;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--border)}}
.run-block{{margin-bottom:24px}}
.run-label{{font-size:12px;color:var(--muted);font-family:monospace;margin-bottom:10px}}
.arms-row{{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px}}
.grade-card{{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}}
.grade-card-header{{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}}
.arm-label{{font-size:13px;font-weight:700}}
.grade-score-block{{display:flex;align-items:center;gap:8px}}
.grade-badge{{font-size:20px;font-weight:700;padding:2px 10px;border-radius:6px}}
.score-text{{font-size:22px;font-weight:700}}
.score-max{{font-size:13px;color:var(--muted);font-weight:400}}
.grade-meta{{font-size:11px;color:var(--muted);display:flex;gap:12px;margin-left:auto}}
.dim-row{{margin-bottom:8px}}
.dim-label{{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:3px}}
.dim-score{{font-weight:600;color:var(--text)}}
.dim-track{{height:6px;background:var(--surface2);border-radius:3px;overflow:hidden}}
.dim-fill{{height:100%;border-radius:3px;transition:width .4s}}
.flags-section{{margin-top:12px;padding:8px 10px;border-radius:4px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2)}}
.no-flags{{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);color:var(--green);font-size:12px}}
.flags-label{{font-size:11px;font-weight:700;color:var(--red);margin-bottom:6px}}
.flags-list{{padding-left:16px;font-size:12px;color:var(--red);line-height:1.8}}
.evidence-section{{margin-top:10px}}
.ev-title{{font-size:11px;font-weight:700;color:var(--muted);margin-bottom:6px}}
.ev-dim{{font-size:11px;font-weight:600;color:var(--accent);margin-top:6px}}
.ev-list{{padding-left:16px;font-size:11px;color:var(--muted);line-height:1.8}}
.comp-card{{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-top:12px}}
.comp-header{{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}}
.comp-title{{font-size:13px;font-weight:700}}
.winner-badge{{font-size:13px;font-weight:700;padding:4px 12px;border-radius:20px}}
.reasoning-text{{font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:12px}}
.comp-tables{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}
.comp-table{{width:100%;border-collapse:collapse;font-size:12px}}
.comp-table th,.comp-table td{{padding:6px 10px;border:1px solid var(--border);text-align:left}}
.comp-table th{{background:var(--surface2);font-weight:600}}
.token-section{{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:24px}}
.section-title{{font-size:15px;font-weight:700;margin-bottom:14px}}
.delta-row{{margin-top:10px;font-size:13px;color:var(--muted);padding:8px;background:var(--surface2);border-radius:4px}}
.warn-row{{margin-top:6px;font-size:12px;color:var(--yellow);padding:6px 8px;background:rgba(234,179,8,.08);border-radius:4px}}
.rec-item{{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:10px}}
.rec-priority{{font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.08em;margin-bottom:3px}}
.rec-dim{{font-size:12px;font-weight:600;color:var(--accent);margin-bottom:4px}}
.rec-text{{font-size:13px;line-height:1.5;margin-bottom:4px}}
.rec-impact{{font-size:11px;color:var(--muted);font-style:italic}}
.report-pre{{font-family:monospace;font-size:12px;line-height:1.8;white-space:pre-wrap;word-break:break-all;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}}
.no-data{{color:var(--muted);font-size:12px;padding:12px}}
@media(max-width:700px){{.arms-row,.comp-tables{{grid-template-columns:1fr}}}}
</style>
</head>
<body>
<div class="topbar">
  <h1>ct-grade <span class="badge">Results Viewer</span></h1>
  <div class="meta">Mode: {esc(mode)} · Run: {esc(str(run_dir))} · Generated: {esc(ts)}</div>
</div>
<div class="tabs">
  <button class="tab active" onclick="showTab(event,'pane-results')">Results</button>
  <button class="tab" onclick="showTab(event,'pane-tokens')">Token Economy</button>
  <button class="tab" onclick="showTab(event,'pane-analysis')">Analysis</button>
  <button class="tab" onclick="showTab(event,'pane-report')">Report</button>
</div>
<div class="pane active" id="pane-results">
  {slots_html if slots_html else '<div style="color:var(--muted);padding:40px;text-align:center">No run data found. Run setup_run.py and execute the agents first.</div>'}
</div>
<div class="pane" id="pane-tokens">
  {token_html if token_html else '<div style="color:var(--muted);padding:40px;text-align:center">No token data. Run: python scripts/token_tracker.py --run-dir &lt;dir&gt;</div>'}
</div>
<div class="pane" id="pane-analysis">
  {analysis_html if analysis_html else '<div style="color:var(--muted);padding:40px;text-align:center">No analysis.json found. Spawn the analysis-reporter agent first.</div>'}
</div>
<div class="pane" id="pane-report">
  {report_html if report_html else '<div style="color:var(--muted);padding:40px;text-align:center">No report.md found. Run: python scripts/generate_report.py --run-dir &lt;dir&gt;</div>'}
</div>
<script>
function showTab(evt, paneId) {{
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  evt.target.classList.add('active');
  document.getElementById(paneId).classList.add('active');
}}
</script>
</body>
</html>"""


def _kill_port(port: int) -> None:
    try:
        result = subprocess.run(["lsof", "-ti", f":{port}"], capture_output=True, text=True, timeout=5)
        for pid_str in result.stdout.strip().split("\n"):
            if pid_str.strip():
                try:
                    os.kill(int(pid_str.strip()), signal.SIGTERM)
                except (ProcessLookupError, ValueError):
                    pass
        if result.stdout.strip():
            time.sleep(0.5)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass


class GradeViewerHandler(BaseHTTPRequestHandler):
    def __init__(self, run_dir, *args, **kwargs):
        self.run_dir = run_dir
        super().__init__(*args, **kwargs)

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            # Regenerate on every request — picks up new run data without restart
            html = generate_html(self.run_dir)
            content = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_error(404)

    def log_message(self, fmt, *args):
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="ct-grade A/B Results Viewer")
    parser.add_argument("--run-dir", required=True, type=Path, help="Path to A/B run directory")
    parser.add_argument("--port", "-p", type=int, default=3119)
    parser.add_argument("--static", "-s", type=Path, default=None, help="Write static HTML, don't serve")
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open browser")
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    if not run_dir.is_dir():
        print(f"ERROR: run-dir not found: {run_dir}", file=sys.stderr)
        sys.exit(1)

    if args.static:
        html = generate_html(run_dir)
        args.static.parent.mkdir(parents=True, exist_ok=True)
        args.static.write_text(html)
        print(f"\n  Grade viewer written: {args.static}\n")
        sys.exit(0)

    port = args.port
    _kill_port(port)
    handler = partial(GradeViewerHandler, run_dir)
    try:
        server = HTTPServer(("127.0.0.1", port), handler)
    except OSError:
        server = HTTPServer(("127.0.0.1", 0), handler)
        port = server.server_address[1]

    url = f"http://localhost:{port}"
    print(f"\n  ct-grade Results Viewer")
    print(f"  {'─' * 37}")
    print(f"  URL:     {url}")
    print(f"  Run dir: {run_dir}")
    print(f"\n  Refreshes on browser reload (live data).")
    print(f"  Press Ctrl+C to stop.\n")

    if not args.no_browser:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
