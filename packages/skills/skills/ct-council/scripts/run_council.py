#!/usr/bin/env python3
"""
run_council.py — driver script that turns a Council run from a hand-driven
ritual into a reproducible artifact.

It does NOT spawn agents itself (the orchestrator does that — see SKILL.md
"Phase ownership" table). What it provides:

  1. A canonical layout for run artifacts under
     <out-dir>/<timestamp>-<short-id>/{phase0.md, phase1.md, peer.md,
     output.md, run.json}.
  2. Phase-gating: each phase validates before the next is allowed to start.
  3. Validator + telemetry hooks: a validated `output.md` is automatically
     appended to .cleo/council-runs.jsonl with optional --tokens / --wall-clock
     stamps.
  4. A `--scenario` flag that names the shakedown (1..8) for telemetry
     filtering and exit-criteria reporting.

Subcommands:

  init <question>          create a new run directory + skeleton phase0 prompt
  validate <run-dir>       run validate.py on the assembled output.md
  ingest <run-dir>         validate + emit telemetry to the JSONL log
  list                     show all runs under the configured runs dir

Convention: assemble phase outputs into <run-dir>/output.md by hand or by
your subagent harness; then run `ingest`. The script is the audit trail,
not the agent runtime.

Usage:
  python3 run_council.py init "Should we ship X?" --scenario baseline
  # ... orchestrator runs Phase 0..3 and writes <run-dir>/output.md ...
  python3 run_council.py ingest <run-dir> --tokens 41250 --wall-clock 73.4
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_RUNS_DIR = Path(".cleo/council-runs")
DEFAULT_LOG_PATH = Path(".cleo/council-runs.jsonl")
INDEX_FILENAME = "INDEX.jsonl"  # lives inside DEFAULT_RUNS_DIR
INDEX_SCHEMA_VERSION = "1.0.0"
DEFAULT_TITLE_MAX_LEN = 60

PHASE0_TEMPLATE = """# The Council — {question}

## Evidence pack

<!--
3–7 items. Each item: `path:line | symbol | sha | URL | llmtxt:slug` — one-line rationale.
The validator (scripts/validate.py) refuses to advance Phase 1 until this section
is well-formed.
-->

1. ``
2. ``
3. ``
"""


def _short_id(question: str) -> str:
    seed = (question + _dt.datetime.now(tz=_dt.timezone.utc).isoformat()).encode()
    return hashlib.sha256(seed).hexdigest()[:8]


# ─── INDEX.jsonl helpers (run roster across the project) ────────────────────
#
# INDEX.jsonl is a project-scoped human-readable roster of council runs. One
# entry per run, upsert-by-run_id (re-running ingest does NOT duplicate). Lives
# at <runs-dir>/INDEX.jsonl. Distinct from the deeper telemetry log
# (.cleo/council-runs.jsonl) which carries the full per-run gate/disposition
# structure for analyze_runs.py.

def _auto_title(question: str, max_len: int = DEFAULT_TITLE_MAX_LEN) -> str:
    """Derive a short human-readable title from the restated question.

    Strips common prefixes, normalizes whitespace, truncates with an ellipsis.
    """
    q = re.sub(r"\s+", " ", question or "").strip()
    # Drop common interrogative prefixes for terseness.
    q = re.sub(
        r"^(Should\s+(we|the|I)\s+|Is\s+the\s+|Is\s+|Does\s+|Can\s+(we|I)\s+|Which\s+(of\s+)?)",
        "",
        q,
        flags=re.IGNORECASE,
    )
    q = q[:1].upper() + q[1:] if q else q
    if len(q) <= max_len:
        return q.rstrip("?.") or question[:max_len]
    return q[: max_len - 1].rstrip(",.;: ") + "…"


def _index_path(runs_dir: Path) -> Path:
    return runs_dir / INDEX_FILENAME


def _read_index(runs_dir: Path) -> list[dict]:
    p = _index_path(runs_dir)
    if not p.exists():
        return []
    out = []
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            # Preserve unparseable lines as raw so we never silently drop data.
            out.append({"_raw": line})
    return out


def _upsert_index(runs_dir: Path, run_id: str, updates: dict) -> dict:
    """Upsert a run's INDEX entry by run_id; rewrite the file in place.

    Returns the final entry. Re-running ingest must not create duplicates.
    """
    entries = _read_index(runs_dir)
    found = None
    for e in entries:
        if not isinstance(e, dict):
            continue
        if e.get("run_id") == run_id:
            e.update(updates)
            found = e
            break
    if found is None:
        found = {"schema_version": INDEX_SCHEMA_VERSION, "run_id": run_id, **updates}
        entries.append(found)

    p = _index_path(runs_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as f:
        for e in entries:
            if isinstance(e, dict) and "_raw" in e:
                f.write(e["_raw"] + "\n")
            else:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
    return found


def _extract_recommendation_snippet(verdict_md: str, max_len: int = 200) -> str | None:
    """Pull the first sentence of the verdict's recommendation, for INDEX browsing."""
    m = re.search(
        r"###\s+Recommendation\s*\n(.+?)(?=\n###|\Z)",
        verdict_md,
        re.DOTALL,
    )
    if not m:
        return None
    body = re.sub(r"\s+", " ", m.group(1).strip())
    if not body:
        return None
    # First sentence (period followed by space-or-EOL).
    sent_match = re.match(r"(.+?[.!?])(\s|$)", body)
    sent = sent_match.group(1) if sent_match else body
    if len(sent) > max_len:
        sent = sent[: max_len - 1].rstrip() + "…"
    return sent


def cmd_init(args) -> int:
    runs_dir = Path(args.runs_dir)
    runs_dir.mkdir(parents=True, exist_ok=True)

    ts = _dt.datetime.now(tz=_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    rid = _short_id(args.question)
    run_dir = runs_dir / f"{ts}-{rid}"
    run_dir.mkdir(parents=True, exist_ok=False)

    (run_dir / "phase0.md").write_text(PHASE0_TEMPLATE.format(question=args.question))

    title = (args.title or _auto_title(args.question)).strip()
    now = _dt.datetime.now(tz=_dt.timezone.utc).isoformat(timespec="seconds")

    metadata = {
        "schema_version": "1.0.0",
        "run_id": rid,
        "ts": ts,
        "title": title,
        "description": args.description or args.question,
        "created_at": now,
        "question": args.question,
        "scenario": args.scenario,
        "subagent_mode": args.subagent_mode,
    }
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=2))

    # Auto-write the INDEX.jsonl entry — `status: initialized` until ingest.
    _upsert_index(runs_dir, rid, {
        "ts": ts,
        "title": title,
        "description": args.description or args.question,
        "scenario": args.scenario,
        "run_dir": str(run_dir),
        "created_at": now,
        "status": "initialized",
    })

    print(f"📝 Run initialized: {run_dir}")
    print(f"   Title: {title}")
    print(f"   Indexed at: {_index_path(runs_dir)}")
    print(f"   Next: write evidence pack into {run_dir / 'phase0.md'}")
    return 0


def _run_validate(output_path: Path, *, json_out: bool = False) -> tuple[int, str]:
    cmd = [sys.executable, str(SCRIPT_DIR / "validate.py")]
    if json_out:
        cmd.append("--json")
    cmd.append(str(output_path))
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode, (result.stdout if json_out else result.stdout + result.stderr)


def cmd_validate(args) -> int:
    run_dir = Path(args.run_dir)
    output_path = run_dir / "output.md"
    if not output_path.exists():
        print(f"❌ {output_path} not found. Assemble phases into output.md first.", file=sys.stderr)
        return 2
    code, out = _run_validate(output_path, json_out=args.json)
    print(out)
    return code


def cmd_ingest(args) -> int:
    run_dir = Path(args.run_dir)
    output_path = run_dir / "output.md"
    meta_path = run_dir / "run.json"

    if not output_path.exists():
        print(f"❌ {output_path} not found.", file=sys.stderr)
        return 2

    code, out = _run_validate(output_path)
    print(out)
    if code != 0:
        print("❌ Validation failed — aborting ingest. Fix structural violations and re-run.", file=sys.stderr)
        return 1

    # Generate the lean deliverables alongside the audit transcript.
    sys.path.insert(0, str(SCRIPT_DIR))
    import telemetry as _t  # noqa: E402

    md = output_path.read_text()
    try:
        verdict_md = _t.render_verdict(md)
        (run_dir / "verdict.md").write_text(verdict_md)
        tldr_md = _t.render_tldr(md)
        (run_dir / "tldr.md").write_text(tldr_md)
        print(f"📄 Verdict written to {run_dir / 'verdict.md'}", file=sys.stderr)
        print(f"📌 TL;DR written to {run_dir / 'tldr.md'}", file=sys.stderr)
    except Exception as e:
        print(f"⚠️  Could not generate lean deliverables: {e}", file=sys.stderr)

    meta = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
        except json.JSONDecodeError:
            meta = {}

    cmd = [sys.executable, str(SCRIPT_DIR / "telemetry.py"), "--append", "--log", str(args.log)]
    if args.tokens is not None:
        cmd += ["--tokens", str(args.tokens)]
    if args.wall_clock is not None:
        cmd += ["--wall-clock", str(args.wall_clock)]
    cmd.append(str(output_path))

    result = subprocess.run(cmd, capture_output=True, text=True)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode != 0:
        return result.returncode

    # Stamp scenario / metadata into a sidecar so analyze_runs can dimension by it.
    if meta.get("scenario"):
        sidecar_path = Path(args.log).with_suffix(".sidecar.jsonl")
        sidecar_path.parent.mkdir(parents=True, exist_ok=True)
        with sidecar_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "run_id": meta.get("run_id"),
                "scenario": meta.get("scenario"),
                "subagent_mode": meta.get("subagent_mode"),
                "question": meta.get("question"),
                "ingested_at": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(timespec="seconds"),
            }) + "\n")
        print(f"📎 Sidecar metadata appended to {sidecar_path}", file=sys.stderr)

    # Upsert the INDEX.jsonl entry: status → ingested + verdict snippet + validation.
    if meta.get("run_id"):
        # Re-read the validator output to pluck the validation summary.
        try:
            json_validation = subprocess.run(
                [sys.executable, str(SCRIPT_DIR / "validate.py"), "--json", str(output_path)],
                capture_output=True, text=True,
            )
            v_payload = json.loads(json_validation.stdout) if json_validation.stdout else {}
        except (json.JSONDecodeError, OSError):
            v_payload = {}
        v = v_payload.get("violations") or []
        validation_summary = {
            "valid": v_payload.get("valid", True),
            "warnings": sum(1 for x in v if x.get("kind") == "warning"),
            "structural_violations": sum(1 for x in v if x.get("kind") == "structural"),
        }

        rec_snippet = None
        verdict_path = run_dir / "verdict.md"
        if verdict_path.exists():
            rec_snippet = _extract_recommendation_snippet(verdict_path.read_text())

        runs_dir = run_dir.parent
        _upsert_index(runs_dir, meta["run_id"], {
            "status": "ingested",
            "ingested_at": _dt.datetime.now(tz=_dt.timezone.utc).isoformat(timespec="seconds"),
            "validation": validation_summary,
            "verdict_recommendation": rec_snippet,
            "tokens": args.tokens,
            "wall_clock_seconds": args.wall_clock,
        })
        print(f"📋 INDEX.jsonl updated at {_index_path(runs_dir)}", file=sys.stderr)
    return 0


_STATUS_GLYPH = {
    "ingested": "✅",
    "initialized": "▶ ",  # in progress
    "failed": "❌",
}


def _format_index_row(entry: dict) -> tuple[str, str, str, str, str, str]:
    """Render one INDEX entry as a row tuple for the list table."""
    rid = entry.get("run_id", "?")
    ts = entry.get("ts") or entry.get("created_at", "")
    # Display ts in a friendlier form: 2026-04-25 03:39
    if ts and "T" in ts:
        ts_display = ts.replace("T", " ").rstrip("Z")[:16]
    else:
        ts_display = ts[:16]
    status = entry.get("status", "?")
    glyph = _STATUS_GLYPH.get(status, "  ")
    title = entry.get("title", "(untitled)")
    scenario = entry.get("scenario") or "—"
    return (glyph, status, rid, ts_display, scenario, title)


def cmd_list(args) -> int:
    runs_dir = Path(args.runs_dir)
    entries = _read_index(runs_dir)

    if not entries:
        if not runs_dir.exists():
            print(f"(no runs yet — {runs_dir} does not exist)")
        else:
            print(f"(no runs indexed at {_index_path(runs_dir)})")
        return 0

    # Filter by status if requested.
    if args.status:
        entries = [e for e in entries if isinstance(e, dict) and e.get("status") == args.status]

    # Newest first by ts (lexicographic on ISO ts string works).
    entries = sorted(
        [e for e in entries if isinstance(e, dict) and "_raw" not in e],
        key=lambda e: e.get("ts", ""),
        reverse=True,
    )

    if args.json:
        print(json.dumps(entries, indent=2, ensure_ascii=False))
        return 0

    if args.limit:
        entries = entries[: args.limit]

    rows = [_format_index_row(e) for e in entries]
    if not rows:
        print(f"(no runs match filter)")
        return 0

    # Column widths.
    w_status = max(len(r[1]) for r in rows)
    w_id = max(len(r[2]) for r in rows)
    w_ts = max(len(r[3]) for r in rows)
    w_scen = max(len(r[4]) for r in rows)

    print(f"# Council runs ({len(rows)})")
    print()
    print(f"{'':2}  {'STATUS':<{w_status}}  {'ID':<{w_id}}  {'WHEN':<{w_ts}}  {'SCENARIO':<{w_scen}}  TITLE")
    print(f"{'':2}  {'-' * w_status}  {'-' * w_id}  {'-' * w_ts}  {'-' * w_scen}  {'-' * 40}")
    for glyph, status, rid, ts, scen, title in rows:
        print(f"{glyph}  {status:<{w_status}}  {rid:<{w_id}}  {ts:<{w_ts}}  {scen:<{w_scen}}  {title}")
    return 0


def cmd_find(args) -> int:
    """Search INDEX.jsonl for runs whose title/description/scenario match a query."""
    runs_dir = Path(args.runs_dir)
    entries = _read_index(runs_dir)
    if not entries:
        print(f"(no runs at {_index_path(runs_dir)})")
        return 0

    needle = args.query.lower()
    matches = []
    for e in entries:
        if not isinstance(e, dict) or "_raw" in e:
            continue
        haystack = " ".join(str(e.get(k, "")) for k in ("title", "description", "question", "scenario", "verdict_recommendation"))
        if needle in haystack.lower():
            matches.append(e)

    if not matches:
        print(f"(no runs match '{args.query}')")
        return 0

    matches = sorted(matches, key=lambda e: e.get("ts", ""), reverse=True)
    if args.json:
        print(json.dumps(matches, indent=2, ensure_ascii=False))
        return 0

    for e in matches:
        glyph, status, rid, ts, scen, title = _format_index_row(e)
        print(f"{glyph} {rid}  {ts}  [{scen}]  {title}")
        if e.get("verdict_recommendation"):
            print(f"     ↳ {e['verdict_recommendation']}")
        print(f"     ↳ {e.get('run_dir', '?')}")
    return 0


def cmd_show(args) -> int:
    """Show one INDEX entry in full (run_id can be a prefix)."""
    runs_dir = Path(args.runs_dir)
    entries = _read_index(runs_dir)
    candidates = [e for e in entries if isinstance(e, dict) and e.get("run_id", "").startswith(args.run_id)]
    if not candidates:
        print(f"❌ No run_id matching '{args.run_id}'", file=sys.stderr)
        return 1
    if len(candidates) > 1:
        print(f"❌ Ambiguous prefix '{args.run_id}' — matches {len(candidates)} runs:", file=sys.stderr)
        for c in candidates:
            print(f"   - {c.get('run_id')}: {c.get('title')}", file=sys.stderr)
        return 1
    print(json.dumps(candidates[0], indent=2, ensure_ascii=False))
    return 0


def cmd_reindex(args) -> int:
    """Rebuild INDEX.jsonl from on-disk run.json files (recovery / migration)."""
    runs_dir = Path(args.runs_dir)
    if not runs_dir.exists():
        print(f"❌ {runs_dir} does not exist", file=sys.stderr)
        return 1

    # Save existing index to recover ingest-time fields (verdict snippet, validation).
    existing = {e.get("run_id"): e for e in _read_index(runs_dir) if isinstance(e, dict)}

    rebuilt: list[dict] = []
    for d in sorted(runs_dir.iterdir()):
        if not d.is_dir():
            continue
        meta_path = d / "run.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text())
        except json.JSONDecodeError:
            continue

        rid = meta.get("run_id")
        ts = meta.get("ts") or d.name.split("-", 1)[0]
        question = meta.get("question", "")
        title = meta.get("title") or _auto_title(question)
        description = meta.get("description") or question

        has_output = (d / "output.md").exists()
        has_verdict = (d / "verdict.md").exists()

        entry = {
            "schema_version": INDEX_SCHEMA_VERSION,
            "run_id": rid,
            "ts": ts,
            "title": title,
            "description": description,
            "scenario": meta.get("scenario", "—"),
            "run_dir": str(d),
            "created_at": meta.get("created_at"),
            "status": "ingested" if has_verdict else ("initialized" if has_output else "initialized"),
        }
        # Preserve existing ingest-time fields if present.
        prior = existing.get(rid, {})
        for k in ("ingested_at", "validation", "verdict_recommendation", "tokens", "wall_clock_seconds"):
            if k in prior:
                entry[k] = prior[k]

        # If verdict.md exists but we have no recommendation snippet, derive it.
        if has_verdict and "verdict_recommendation" not in entry:
            try:
                entry["verdict_recommendation"] = _extract_recommendation_snippet(
                    (d / "verdict.md").read_text()
                )
                entry["status"] = "ingested"
            except OSError:
                pass

        rebuilt.append(entry)

    p = _index_path(runs_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8") as f:
        for e in rebuilt:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"📋 Rebuilt {p} from {len(rebuilt)} run dir(s).")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Council run driver.")
    parser.add_argument("--runs-dir", default=str(DEFAULT_RUNS_DIR))
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="Create a new run directory.")
    p_init.add_argument("question", help="Restated question (one sentence).")
    p_init.add_argument("--title", default=None, help="Short human-readable title (auto-derived from question if omitted).")
    p_init.add_argument("--description", default=None, help="Longer description (defaults to the full question).")
    p_init.add_argument("--scenario", default="baseline", help="Scenario tag for telemetry (e.g. baseline, external-doc-heavy, three-way, sparse-ops, contradictory, non-cleo, mini, contention).")
    p_init.add_argument("--subagent-mode", action="store_true", help="Mark this run as subagent-mode (default: orchestrator-driven).")
    p_init.set_defaults(func=cmd_init)

    p_val = sub.add_parser("validate", help="Validate <run-dir>/output.md.")
    p_val.add_argument("run_dir")
    p_val.add_argument("--json", action="store_true")
    p_val.set_defaults(func=cmd_validate)

    p_ing = sub.add_parser("ingest", help="Validate + telemetry-append a completed run.")
    p_ing.add_argument("run_dir")
    p_ing.add_argument("--log", default=str(DEFAULT_LOG_PATH))
    p_ing.add_argument("--tokens", type=int, default=None)
    p_ing.add_argument("--wall-clock", type=float, default=None)
    p_ing.set_defaults(func=cmd_ingest)

    p_list = sub.add_parser("list", help="List runs from INDEX.jsonl.")
    p_list.add_argument("--status", default=None, help="Filter by status (initialized | ingested | failed).")
    p_list.add_argument("--limit", type=int, default=None, help="Show only N most recent.")
    p_list.add_argument("--json", action="store_true", help="Emit JSON instead of table.")
    p_list.set_defaults(func=cmd_list)

    p_find = sub.add_parser("find", help="Search runs by title/description/scenario/verdict text.")
    p_find.add_argument("query", help="Substring to search (case-insensitive).")
    p_find.add_argument("--json", action="store_true")
    p_find.set_defaults(func=cmd_find)

    p_show = sub.add_parser("show", help="Show one INDEX entry in full.")
    p_show.add_argument("run_id", help="Run id (or prefix — must be unambiguous).")
    p_show.set_defaults(func=cmd_show)

    p_reidx = sub.add_parser("reindex", help="Rebuild INDEX.jsonl from on-disk run.json files.")
    p_reidx.set_defaults(func=cmd_reindex)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
