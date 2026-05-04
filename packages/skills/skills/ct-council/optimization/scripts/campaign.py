#!/usr/bin/env python3
"""
campaign.py — programmatic tracker for Council hardening campaigns.

A campaign is an instance of the playbook: a sequence of shakedown runs with
shared telemetry and a cumulative findings log. Campaigns persist locally
(gitignored under `optimization/campaigns/<name>/`); the playbook itself
(`optimization/HARDENING-PLAYBOOK.md`) stays committed.

Subcommands:

  new <name>                 Initialize a new campaign directory from the playbook.
  status [--name <n>]        Show campaign progress + exit-criteria scorecard.
  next [--name <n>]          Print the next scenario's full briefing.
  done <scenario> <run-id>   Mark a scenario complete (links the run dir).
  log <failure> <fix> <reg>  Append a hardening fix to findings.md.
  list                       List all known campaigns under campaigns/.
  active [--set <n>]         Show or set the active campaign (used as default).

Usage:

  python3 optimization/scripts/campaign.py new 2026-04-25-portability
  python3 optimization/scripts/campaign.py next
  python3 optimization/scripts/campaign.py done baseline 20260425T023423Z-0f82cea9
  python3 optimization/scripts/campaign.py log "Executor mis-cite" "Pre-action verify rule" "yes"
  python3 optimization/scripts/campaign.py status
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
from dataclasses import dataclass
from pathlib import Path

# Resolve skill root from this script's location.
SCRIPT_PATH = Path(__file__).resolve()
OPTIMIZATION_DIR = SCRIPT_PATH.parent.parent
SKILL_ROOT = OPTIMIZATION_DIR.parent
CAMPAIGNS_DIR = OPTIMIZATION_DIR / "campaigns"
PLAYBOOK_PATH = OPTIMIZATION_DIR / "HARDENING-PLAYBOOK.md"
ACTIVE_FILE = OPTIMIZATION_DIR / ".active-campaign"  # gitignored
TELEMETRY_LOG = SKILL_ROOT / ".cleo" / "council-runs.jsonl"
SKILL_RUNS_DIR = SKILL_ROOT / ".runs"


# ─── Scenario catalogue (loaded from optimization/scenarios.yaml) ────────────


@dataclass(frozen=True)
class Scenario:
    id: str          # e.g. "baseline", "external-doc-heavy"
    number: int      # campaign run-order key (lowest first)
    title: str
    dimension: str
    shape: str
    learn: str
    briefing: str    # multi-line guidance for the orchestrator


SCENARIOS_YAML_PATH = OPTIMIZATION_DIR / "scenarios.yaml"
SCENARIOS_JSON_PATH = OPTIMIZATION_DIR / "scenarios.json"  # alternate format

# Hardcoded fallback used only if both scenarios.yaml and scenarios.json are
# missing (or unparseable) AND the YAML library isn't available. Keeps
# campaign.py runnable in clean-checkout / minimal-deps environments.
_FALLBACK_SCENARIOS: list[dict] = [
    {
        "id": "baseline",
        "number": 1,
        "title": "Narrow binary, dense evidence",
        "dimension": "Control run",
        "shape": "Binary decision, 5-7 path:line / sha citations, no llmtxt:",
        "learn": "Baseline cost / wall-clock / gate-pass distribution all subsequent runs compare against.",
        "briefing": (
            "Pick a binary decision in the active project.\n"
            "Evidence: 5-7 path:line or sha citations from the live codebase. No llmtxt:.\n"
            "This run sets the campaign's baseline cost + gate-pass distribution.\n"
        ),
    },
]


def _load_scenarios() -> list[Scenario]:
    """Load scenarios from YAML (preferred), JSON (alternate), or fallback list.

    Order of precedence:
      1. optimization/scenarios.yaml (if pyyaml available + file present)
      2. optimization/scenarios.json (always-available fallback for editing)
      3. Hardcoded _FALLBACK_SCENARIOS (clean-checkout safety net)
    """
    raw_entries: list[dict] | None = None

    if SCENARIOS_YAML_PATH.exists():
        try:
            import yaml  # type: ignore
            data = yaml.safe_load(SCENARIOS_YAML_PATH.read_text())
            if isinstance(data, dict) and isinstance(data.get("scenarios"), list):
                raw_entries = data["scenarios"]
        except ImportError:
            print(
                "ℹ️  scenarios.yaml exists but PyYAML isn't installed; "
                "falling back to scenarios.json or hardcoded list. "
                "Run `pip install pyyaml` to use YAML.",
                file=sys.stderr,
            )
        except Exception as e:
            print(f"⚠️  Could not parse {SCENARIOS_YAML_PATH}: {e}", file=sys.stderr)

    if raw_entries is None and SCENARIOS_JSON_PATH.exists():
        try:
            data = json.loads(SCENARIOS_JSON_PATH.read_text())
            if isinstance(data, dict) and isinstance(data.get("scenarios"), list):
                raw_entries = data["scenarios"]
            elif isinstance(data, list):
                raw_entries = data
        except json.JSONDecodeError as e:
            print(f"⚠️  Could not parse {SCENARIOS_JSON_PATH}: {e}", file=sys.stderr)

    if raw_entries is None:
        raw_entries = _FALLBACK_SCENARIOS

    out: list[Scenario] = []
    required_fields = ["id", "number", "title", "dimension", "shape", "learn", "briefing"]
    for i, entry in enumerate(raw_entries, 1):
        if not isinstance(entry, dict):
            print(f"⚠️  Scenario #{i} is not a mapping; skipping.", file=sys.stderr)
            continue
        missing = [f for f in required_fields if f not in entry]
        if missing:
            print(f"⚠️  Scenario #{i} ({entry.get('id', '?')}) missing fields: {missing}; skipping.", file=sys.stderr)
            continue
        out.append(Scenario(
            id=entry["id"],
            number=int(entry["number"]),
            title=entry["title"],
            dimension=entry["dimension"],
            shape=entry["shape"],
            learn=entry["learn"],
            briefing=entry["briefing"],
        ))
    out.sort(key=lambda s: s.number)
    if not out:
        print("⚠️  No valid scenarios loaded; using hardcoded fallback.", file=sys.stderr)
        out = [Scenario(**e) for e in _FALLBACK_SCENARIOS]
    return out


SCENARIOS: list[Scenario] = _load_scenarios()
SCENARIO_BY_ID: dict[str, Scenario] = {s.id: s for s in SCENARIOS}


# ─── Campaign helpers ───────────────────────────────────────────────────────


def _campaigns_dir() -> Path:
    CAMPAIGNS_DIR.mkdir(parents=True, exist_ok=True)
    return CAMPAIGNS_DIR


def _read_active_campaign() -> str | None:
    if ACTIVE_FILE.exists():
        return ACTIVE_FILE.read_text().strip() or None
    # If exactly one campaign exists, use it as default.
    dirs = [p for p in _campaigns_dir().iterdir() if p.is_dir()]
    if len(dirs) == 1:
        return dirs[0].name
    return None


def _write_active_campaign(name: str) -> None:
    ACTIVE_FILE.write_text(name + "\n")


def _resolve_campaign(name: str | None) -> Path:
    name = name or _read_active_campaign()
    if not name:
        sys.exit(
            "❌ No campaign specified and no active campaign set.\n"
            "   Run: campaign.py new <name>  OR  campaign.py active --set <name>"
        )
    path = _campaigns_dir() / name
    if not path.exists():
        sys.exit(f"❌ Campaign not found: {path}\n   Existing: campaign.py list")
    return path


def _read_manifest(campaign_dir: Path) -> dict:
    p = campaign_dir / "manifest.json"
    if not p.exists():
        return {"name": campaign_dir.name, "completed": {}, "fixes": []}
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        return {"name": campaign_dir.name, "completed": {}, "fixes": []}


def _write_manifest(campaign_dir: Path, manifest: dict) -> None:
    (campaign_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )


def _next_scenario(manifest: dict) -> Scenario | None:
    completed_ids = set(manifest.get("completed", {}).keys())
    for s in SCENARIOS:
        if s.id not in completed_ids:
            return s
    return None


# ─── Subcommands ────────────────────────────────────────────────────────────


def cmd_new(args) -> int:
    name = args.name.strip()
    if "/" in name or name.startswith("."):
        sys.exit("❌ Campaign name must be a simple slug (no slashes, no leading dot).")

    path = _campaigns_dir() / name
    if path.exists():
        sys.exit(f"❌ Campaign already exists: {path}")

    path.mkdir(parents=True)
    (path / "runs").mkdir()

    manifest = {
        "name": name,
        "schema_version": "1.0.0",
        "created_at": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(timespec="seconds"),
        "playbook": str(PLAYBOOK_PATH.relative_to(SKILL_ROOT)),
        "telemetry_log": str(TELEMETRY_LOG.relative_to(SKILL_ROOT)),
        "completed": {},  # scenario_id → {run_id, completed_at}
        "fixes": [],      # list of {at, failure, fix, regression_test}
    }
    _write_manifest(path, manifest)

    findings_md = (
        f"# Findings — campaign `{name}`\n\n"
        "Failure-mode diff table — appended via `campaign.py log` between runs.\n"
        "Each row pairs a failure surfaced in run N with the fix shipped before run N+1.\n\n"
        "| Run | Scenario | Failure surfaced | Fix shipped | Regression test |\n"
        "|---|---|---|---|---|\n"
    )
    (path / "findings.md").write_text(findings_md)

    plan_md = (
        f"# Plan — campaign `{name}`\n\n"
        "Generated from `optimization/HARDENING-PLAYBOOK.md`. "
        "Edit this file to add campaign-specific notes (skipped scenarios, custom questions, etc.) — "
        "the manifest tracks scenario completion separately.\n\n"
        "## Scenarios (run in order)\n\n"
    )
    for s in SCENARIOS:
        plan_md += f"### {s.number}. {s.id} — {s.title}\n\n"
        plan_md += f"**Dimension:** {s.dimension}\n\n"
        plan_md += f"**Shape:** {s.shape}\n\n"
        plan_md += f"**Learn:** {s.learn}\n\n"
        plan_md += f"**Status:** _pending_\n\n"
    (path / "plan.md").write_text(plan_md)

    _write_active_campaign(name)

    print(f"📁 Campaign initialized: {path}")
    print(f"   Active campaign set to: {name}")
    print(f"   Next: campaign.py next")
    return 0


def cmd_next(args) -> int:
    campaign_dir = _resolve_campaign(args.name)
    manifest = _read_manifest(campaign_dir)
    s = _next_scenario(manifest)
    if s is None:
        print("✅ All 8 scenarios completed for this campaign.")
        print("   Run: campaign.py status   # for the exit-criteria scorecard")
        return 0

    print(f"# Next scenario — {s.number}/{len(SCENARIOS)} · {s.id}")
    print()
    print(f"**Title:** {s.title}")
    print(f"**Dimension:** {s.dimension}")
    print(f"**Shape:** {s.shape}")
    print(f"**Learn:** {s.learn}")
    print()
    print("## Briefing")
    print()
    print(s.briefing)
    print("## Suggested commands")
    print()
    print(f"  python3 scripts/run_council.py init '<your question>' --scenario {s.id} --subagent-mode")
    print(f"  # write evidence pack into <run-dir>/phase0.md")
    print(f"  # spawn 5 advisor agents → 5 peer review agents → write phase2_5.md + phase3.md → assemble output.md")
    print(f"  python3 scripts/run_council.py ingest <run-dir>")
    print(f"  python3 optimization/scripts/campaign.py done {s.id} <run-dir-id>")
    print()
    return 0


def cmd_done(args) -> int:
    if args.scenario not in SCENARIO_BY_ID:
        sys.exit(f"❌ Unknown scenario: {args.scenario}\n   Valid: {', '.join(s.id for s in SCENARIOS)}")
    campaign_dir = _resolve_campaign(args.name)
    manifest = _read_manifest(campaign_dir)

    if args.scenario in manifest.get("completed", {}):
        existing = manifest["completed"][args.scenario]
        print(f"⚠️  Scenario {args.scenario} already marked complete (run_id={existing['run_id']}). Overwriting.")

    manifest.setdefault("completed", {})[args.scenario] = {
        "run_id": args.run_id,
        "completed_at": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(timespec="seconds"),
    }
    _write_manifest(campaign_dir, manifest)

    # Best-effort symlink the run dir into campaign_dir/runs/.
    # The skill's run dirs live at <skill-root>/.runs/<run-id> by convention.
    src = SKILL_RUNS_DIR / args.run_id
    if not src.exists():
        # User may have passed a full run-dir name with timestamp prefix.
        candidates = list(SKILL_RUNS_DIR.glob(f"*{args.run_id}*"))
        if len(candidates) == 1:
            src = candidates[0]
    if src.exists():
        link = campaign_dir / "runs" / src.name
        if not link.exists():
            try:
                link.symlink_to(src.resolve())
                print(f"🔗 Linked {link.name} → {src}")
            except OSError as e:
                print(f"⚠️  Symlink failed ({e}); run accessible at {src}")

    s = SCENARIO_BY_ID[args.scenario]
    next_s = _next_scenario(manifest)
    print(f"✅ Marked done: scenario #{s.number} {s.id}")
    if next_s:
        print(f"   Next: campaign.py next   # → scenario {next_s.id}")
    else:
        print(f"   All 8 scenarios complete. Run: campaign.py status")
    return 0


def cmd_log(args) -> int:
    campaign_dir = _resolve_campaign(args.name)
    manifest = _read_manifest(campaign_dir)

    completed_count = len(manifest.get("completed", {}))
    last_scenario = None
    if completed_count > 0:
        last_scenario = sorted(
            manifest["completed"].items(),
            key=lambda kv: kv[1].get("completed_at", ""),
        )[-1][0]

    fix = {
        "at": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(timespec="seconds"),
        "after_run": completed_count,
        "after_scenario": last_scenario,
        "failure": args.failure,
        "fix": args.fix,
        "regression_test": args.regression,
    }
    manifest.setdefault("fixes", []).append(fix)
    _write_manifest(campaign_dir, manifest)

    findings_path = campaign_dir / "findings.md"
    findings = findings_path.read_text() if findings_path.exists() else "| Run | Scenario | Failure surfaced | Fix shipped | Regression test |\n|---|---|---|---|---|\n"
    row = f"| {completed_count} | {last_scenario or '—'} | {args.failure} | {args.fix} | {args.regression} |\n"
    if not findings.endswith("\n"):
        findings += "\n"
    findings_path.write_text(findings + row)

    print(f"📝 Logged fix #{len(manifest['fixes'])} to findings.md")
    return 0


def cmd_status(args) -> int:
    campaign_dir = _resolve_campaign(args.name)
    manifest = _read_manifest(campaign_dir)
    completed = manifest.get("completed", {})
    fixes = manifest.get("fixes", [])

    print(f"# Campaign — {manifest.get('name')}")
    print(f"_Created: {manifest.get('created_at', '?')} · Path: {campaign_dir.relative_to(SKILL_ROOT)}_")
    print()
    print(f"**Progress:** {len(completed)}/{len(SCENARIOS)} scenarios complete")
    print(f"**Fixes shipped:** {len(fixes)}")
    print()

    print("## Scenario status")
    print()
    print("| # | Scenario | Status | Run ID | Completed |")
    print("|---|---|---|---|---|")
    for s in SCENARIOS:
        c = completed.get(s.id)
        if c:
            print(f"| {s.number} | `{s.id}` | ✅ done | `{c['run_id']}` | {c['completed_at']} |")
        else:
            print(f"| {s.number} | `{s.id}` | ☐ pending | — | — |")
    print()

    if fixes:
        print("## Hardening fixes shipped")
        print()
        print("| # | After run | After scenario | Failure | Fix | Regression |")
        print("|---|---|---|---|---|---|")
        for i, f in enumerate(fixes, 1):
            print(f"| {i} | {f.get('after_run', '?')} | {f.get('after_scenario', '—')} | {f['failure']} | {f['fix']} | {f.get('regression_test', '?')} |")
        print()

    # Read telemetry from the skill-root jsonl. Filter to runs done in this campaign.
    if TELEMETRY_LOG.exists():
        run_ids = {c["run_id"] for c in completed.values()}
        records = []
        for line in TELEMETRY_LOG.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Match by source_path containing run_id.
            sp = (rec.get("metrics") or {}).get("source_path") or ""
            if any(rid in sp for rid in run_ids):
                records.append(rec)

        if records:
            print(f"## Exit-criteria scorecard ({len(records)} ingested runs)")
            print()
            target_n = len(SCENARIOS)
            valid = sum(1 for r in records if (r.get("validation") or {}).get("valid"))
            print(f"- Validate pass rate: {valid}/{len(records)} {'✅' if valid == len(records) else '❌'}")

            from collections import defaultdict
            advisor_passes = defaultdict(list)
            for r in records:
                for advisor, body in (r.get("advisors") or {}).items():
                    advisor_passes[advisor].append(body.get("gate_pass_count", 0))
            avg_str = ", ".join(f"{a}={sum(v)/len(v):.2f}" for a, v in sorted(advisor_passes.items()))
            min_avg = min((sum(v)/len(v) for v in advisor_passes.values()), default=0)
            print(f"- Advisor avg gate-pass (≥3.0 target): {avg_str} {'✅' if min_avg >= 3.0 else '❌'}")

            convergence_raised = sum(1 for r in records if (r.get("convergence") or {}).get("flag") is True)
            print(f"- Convergence flags raised: {convergence_raised} (target ≤1) {'✅' if convergence_raised <= 1 else '❌'}")

            high_or_above = sum(1 for r in records if (r.get("chairman") or {}).get("confidence") in ("high", "medium-high"))
            print(f"- High/medium-high confidence: {high_or_above}/{len(records)} (target ≥6/{target_n}) {'✅' if (high_or_above >= 6 or len(records) < target_n) else '❌'}")

            tokens = [(r.get("metrics") or {}).get("tokens") for r in records if (r.get("metrics") or {}).get("tokens")]
            if tokens and len(tokens) > 1:
                spread = ((max(tokens) - min(tokens)) / (sum(tokens) / len(tokens))) * 100
                print(f"- Token spread: {spread:.1f}% (target ≤20%) {'✅' if spread <= 20 else '❌'}")

            print()

    if len(completed) == len(SCENARIOS):
        print("🎉 Campaign complete. Consider promoting durable findings into `references/*.md` and archiving this campaign.")
    else:
        print(f"   Next: campaign.py next   # {len(SCENARIOS) - len(completed)} scenarios remaining")
    return 0


def cmd_list(args) -> int:
    dirs = sorted(p for p in _campaigns_dir().iterdir() if p.is_dir())
    if not dirs:
        print(f"(no campaigns under {CAMPAIGNS_DIR.relative_to(SKILL_ROOT)})")
        return 0
    active = _read_active_campaign()
    width = max(len(d.name) for d in dirs)
    for d in dirs:
        manifest = _read_manifest(d)
        completed = len(manifest.get("completed", {}))
        marker = "*" if d.name == active else " "
        print(f"{marker} {d.name:<{width}}  {completed}/{len(SCENARIOS)} done  · {manifest.get('created_at', '?')}")
    if active:
        print(f"\n_Active: {active}_")
    return 0


def cmd_active(args) -> int:
    if args.set_name:
        path = _campaigns_dir() / args.set_name
        if not path.exists():
            sys.exit(f"❌ Campaign not found: {args.set_name}")
        _write_active_campaign(args.set_name)
        print(f"✓ Active campaign set to: {args.set_name}")
        return 0
    active = _read_active_campaign()
    if active:
        print(active)
    else:
        print("(no active campaign)")
    return 0


# ─── Entry ──────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Council hardening campaign manager.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_new = sub.add_parser("new", help="Initialize a new campaign.")
    p_new.add_argument("name", help="Campaign slug, e.g. 2026-04-25-portability")
    p_new.set_defaults(func=cmd_new)

    p_status = sub.add_parser("status", help="Show campaign progress + scorecard.")
    p_status.add_argument("--name", default=None, help="Campaign name (defaults to active).")
    p_status.set_defaults(func=cmd_status)

    p_next = sub.add_parser("next", help="Print next scenario's briefing.")
    p_next.add_argument("--name", default=None)
    p_next.set_defaults(func=cmd_next)

    p_done = sub.add_parser("done", help="Mark a scenario complete.")
    p_done.add_argument("scenario", help=f"Scenario id ({', '.join(s.id for s in SCENARIOS)})")
    p_done.add_argument("run_id", help="Run dir id (e.g. 20260425T023423Z-0f82cea9)")
    p_done.add_argument("--name", default=None)
    p_done.set_defaults(func=cmd_done)

    p_log = sub.add_parser("log", help="Append a hardening fix to findings.md.")
    p_log.add_argument("failure", help="One-line failure description")
    p_log.add_argument("fix", help="One-line fix description")
    p_log.add_argument("regression", help="yes / no / n-a — was a regression test added?")
    p_log.add_argument("--name", default=None)
    p_log.set_defaults(func=cmd_log)

    p_list = sub.add_parser("list", help="List all campaigns.")
    p_list.set_defaults(func=cmd_list)

    p_active = sub.add_parser("active", help="Show or set the active campaign.")
    p_active.add_argument("--set", dest="set_name", default=None, help="Set the active campaign.")
    p_active.set_defaults(func=cmd_active)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
