#!/usr/bin/env python3
"""
CLEO Skill Depth Check — progressive-disclosure-depth rule (T9684).

Fails when a skill's SKILL.md is below the depth threshold AND it has
no references/ subdir with at least the manifest-declared reference
files. The gold standard is ct-orchestrator (9 references) and
ct-skill-creator (7 references); the rule is calibrated to flag
stubs without forcing every skill to that depth.

Rule logic:
  PASS when ANY of:
    - SKILL.md body has >= MIN_BODY_LINES content lines
    - references/ subdir exists with >= MIN_REF_FILES files
    - manifest.json references[] array populated with file paths that
      all exist on disk

  FAIL when:
    - SKILL.md body < MIN_BODY_LINES lines AND
    - references/ missing or has < MIN_REF_FILES files AND
    - manifest.json references[] empty or files missing

Error message points at the gold standard and lists expected files
from the manifest entry (when present) so the fix is obvious.

Usage:
    check_depth.py <skill-directory>
    check_depth.py <skill-directory> --manifest path/to/manifest.json
    check_depth.py <skill-directory> --all                  # walk all skills under a root
    check_depth.py <skill-directory> --json
"""
import sys
import re
import json
import argparse
import datetime
from pathlib import Path


# Calibration knobs — set against the post-T9567 state.
# Adjust here, then re-run the audit to verify all 19 active skills pass.
MIN_BODY_LINES = 100
MIN_REF_FILES = 3
GOLD_STANDARDS = ("ct-orchestrator", "ct-skill-creator")

# Cadence for the allowlist audit — entries older than this are flagged stale.
ALLOWLIST_STALE_DAYS = 30
LAST_REVIEWED_RE = re.compile(r"last_reviewed:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")

# Allowlist — pre-existing stub skills exempted at T9567 (E-SKILLS-DEPTH-BACKFILL).
# Each entry MUST have a follow-up task ID. Remove the entry once that task
# lands a depth backfill. New entries require owner approval — do not add
# silently.
#
# AUDIT CADENCE: review every release cycle (or every 30 days, whichever
# comes first). Each entry below carries `last_reviewed` — if that timestamp
# is older than the cadence, run `python check_depth.py <skill-dir>` for each
# allowlisted skill, decide keep / remove, and bump `last_reviewed` to a
# fresh `date '+%Y-%m-%d %H:%M:%S'` value. See ALLOWLIST_STALE_DAYS above
# for the actual threshold the audit enforces.
#
# Format: skill-name -> "task-id: rationale | last_reviewed: YYYY-MM-DD HH:MM:SS"
ALLOWLIST: dict[str, str] = {
    "ct-codebase-mapper": "T9567-followup: pre-existing; depth-backfill deferred | last_reviewed: 2026-05-21 14:00:18",
    "ct-master-tac":      "T9567-followup: pre-existing; depth-backfill deferred | last_reviewed: 2026-05-21 14:00:18",
    "ct-memory":          "T9567-followup: pre-existing; depth-backfill deferred | last_reviewed: 2026-05-21 14:00:18",
    "ct-stickynote":      "T9567-followup: ephemeral note skill; minimal-by-design | last_reviewed: 2026-05-21 14:00:18",
}


def count_body_lines(skill_md_path: Path) -> int:
    """Count content lines in the SKILL.md body (excluding frontmatter)."""
    if not skill_md_path.exists():
        return 0
    raw = skill_md_path.read_text(encoding="utf-8")
    if not raw.startswith("---"):
        # No frontmatter — count whole file
        return len(raw.split("\n"))
    parts = raw.split("---", 2)
    if len(parts) < 3:
        return 0
    body = parts[2].strip()
    if not body:
        return 0
    return len(body.split("\n"))


def manifest_references_for(skill_name: str, manifest_path: Path) -> list[str]:
    """Return the references array from manifest.json for the given skill,
    or empty list if not present."""
    if not manifest_path.exists():
        return []
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    for entry in data.get("skills", []):
        if entry.get("name") == skill_name:
            return entry.get("references", []) or []
    return []


def repo_root_of(skill_dir: Path) -> Path:
    """Walk up from skill_dir to the repo root (heuristic: contains
    `packages/skills/skills/manifest.json`)."""
    cur = skill_dir.resolve()
    for _ in range(10):
        if (cur / "packages" / "skills" / "skills" / "manifest.json").exists():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return skill_dir  # fallback


def check_depth(skill_path: Path, manifest_path: Path | None = None) -> tuple[bool, dict]:
    """Run the depth check on a single skill directory.

    Returns (passed, report_dict).
    """
    skill_dir = Path(skill_path).resolve()
    skill_name = skill_dir.name
    skill_md = skill_dir / "SKILL.md"
    refs_dir = skill_dir / "references"

    report: dict = {
        "skill_name": skill_name,
        "path": str(skill_dir),
        "body_lines": 0,
        "ref_files_on_disk": 0,
        "manifest_references": [],
        "manifest_references_missing": [],
        "thresholds": {
            "min_body_lines": MIN_BODY_LINES,
            "min_ref_files": MIN_REF_FILES,
        },
        "passed": False,
        "reasons": [],
        "remediation": [],
    }

    # Threshold A: body length
    body_lines = count_body_lines(skill_md)
    report["body_lines"] = body_lines
    body_passes = body_lines >= MIN_BODY_LINES

    # Threshold B: references/ subdir
    ref_files_on_disk = 0
    if refs_dir.is_dir():
        ref_files_on_disk = len([p for p in refs_dir.iterdir() if p.is_file() and p.suffix == ".md"])
    report["ref_files_on_disk"] = ref_files_on_disk
    refs_dir_passes = ref_files_on_disk >= MIN_REF_FILES

    # Threshold C: manifest.json references populated and on disk
    manifest_passes = False
    if manifest_path is None:
        # Auto-locate from repo root
        root = repo_root_of(skill_dir)
        manifest_path = root / "packages" / "skills" / "skills" / "manifest.json"

    if manifest_path.exists():
        manifest_refs = manifest_references_for(skill_name, manifest_path)
        report["manifest_references"] = manifest_refs
        if manifest_refs:
            root = repo_root_of(skill_dir)
            base = root / "packages" / "skills"
            missing = []
            for rel in manifest_refs:
                ref_abs = base / rel
                if not ref_abs.exists():
                    # Try relative to skill_dir as fallback
                    fallback = skill_dir / Path(rel).relative_to(Path(rel).parts[0]) \
                        if Path(rel).parts else None
                    if fallback is None or not fallback.exists():
                        missing.append(rel)
            report["manifest_references_missing"] = missing
            manifest_passes = (len(manifest_refs) >= MIN_REF_FILES and not missing)

    # Decide pass/fail — ANY threshold passes ⇒ depth check passes.
    passed = body_passes or refs_dir_passes or manifest_passes
    report["passed"] = passed

    if body_passes:
        report["reasons"].append(f"body_lines={body_lines} >= {MIN_BODY_LINES}")
    if refs_dir_passes:
        report["reasons"].append(f"references/ has {ref_files_on_disk} files >= {MIN_REF_FILES}")
    if manifest_passes:
        report["reasons"].append(
            f"manifest references[] populated with {len(report['manifest_references'])} files (all on disk)"
        )

    # Allowlist override — exempted skills pass with a reason captured.
    if not passed and skill_name in ALLOWLIST:
        passed = True
        report["passed"] = True
        report["allowlisted"] = True
        report["allowlist_reason"] = ALLOWLIST[skill_name]
        report["reasons"].append(f"allowlisted: {ALLOWLIST[skill_name]}")

    if not passed:
        report["reasons"].append("none of the three thresholds met")
        report["remediation"] = [
            f"Expand SKILL.md body to >= {MIN_BODY_LINES} content lines (currently {body_lines}), OR",
            f"Add references/ subdir with >= {MIN_REF_FILES} markdown files (currently {ref_files_on_disk}), OR",
            "Populate manifest.json references[] array for this skill with file paths.",
            f"Gold-standard examples: {', '.join(GOLD_STANDARDS)}.",
        ]
        if report["manifest_references_missing"]:
            report["remediation"].append(
                "Manifest references[] lists files that do not exist on disk: "
                + ", ".join(report["manifest_references_missing"])
            )

    return passed, report


def _print_report(report: dict) -> None:
    """Print a single skill's depth report."""
    name = report["skill_name"]
    status = "PASS" if report["passed"] else "FAIL"
    icon = "✅" if report["passed"] else "❌"
    print(f"\n{icon} {status}  {name}")
    print(f"     body_lines={report['body_lines']} (min {MIN_BODY_LINES})")
    print(f"     ref_files_on_disk={report['ref_files_on_disk']} (min {MIN_REF_FILES})")
    print(f"     manifest_references={len(report['manifest_references'])} files")
    if report["manifest_references_missing"]:
        print(f"     manifest_references_missing={report['manifest_references_missing']}")
    for r in report["reasons"]:
        print(f"     - {r}")
    if not report["passed"]:
        print("     remediation:")
        for r in report["remediation"]:
            print(f"       * {r}")


def audit_allowlist(
    *,
    now: datetime.datetime | None = None,
    stale_days: int = ALLOWLIST_STALE_DAYS,
) -> list[dict]:
    """Audit the ALLOWLIST for malformed or stale `last_reviewed` stamps.

    Returns a list of finding dicts: each has `skill`, `severity` (WARN),
    `message`, and (when parseable) `age_days`. An empty list means every
    allowlist entry has a well-formed, fresh stamp.

    `last_reviewed:` must match `YYYY-MM-DD HH:MM:SS`. Stamps older than
    `stale_days` are flagged for re-audit.
    """
    now = now or datetime.datetime.now()
    findings: list[dict] = []
    for skill, rationale in ALLOWLIST.items():
        m = LAST_REVIEWED_RE.search(rationale)
        if not m:
            findings.append({
                "skill": skill, "severity": "WARN",
                "message": "missing or malformed 'last_reviewed: YYYY-MM-DD HH:MM:SS' stamp",
            })
            continue
        stamp = m.group(1)
        try:
            ts = datetime.datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S")
        except ValueError as e:
            findings.append({
                "skill": skill, "severity": "WARN",
                "message": f"invalid timestamp '{stamp}': {e}",
            })
            continue
        age_days = (now - ts).days
        if age_days > stale_days:
            findings.append({
                "skill": skill, "severity": "WARN", "age_days": age_days,
                "message": (
                    f"stale: last_reviewed was {age_days}d ago "
                    f"(cadence: {stale_days}d). Audit and bump the stamp."
                ),
            })
    return findings


def _print_allowlist_audit(findings: list[dict], *, stream=sys.stderr) -> None:
    if not findings:
        return
    print("=== allowlist audit ===", file=stream)
    for f in findings:
        print(f"  ⚠️  {f['skill']}: {f['message']}", file=stream)
    print(file=stream)


def walk_all_skills(root: Path) -> list[Path]:
    """Find all skill directories under packages/skills/skills/.
    Skips manifest.json, _shared/, and any dir without SKILL.md."""
    base = root if (root / "SKILL.md").exists() else (root / "packages" / "skills" / "skills")
    if not base.is_dir():
        return []
    skills = []
    for entry in sorted(base.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith("_") or entry.name.startswith("."):
            continue
        if (entry / "SKILL.md").exists():
            skills.append(entry)
    return skills


def main() -> int:
    parser = argparse.ArgumentParser(
        description="CLEO Skill Depth Check (T9684) — progressive-disclosure-depth"
    )
    parser.add_argument("skill_dir", help="Path to the skill directory (or repo root if --all)")
    parser.add_argument("--manifest", help="Path to manifest.json (auto-located if omitted)")
    parser.add_argument(
        "--all", action="store_true",
        help="Walk every skill under packages/skills/skills/",
    )
    parser.add_argument("--json", action="store_true", help="Output JSON instead of text")
    parser.add_argument(
        "--audit-allowlist", action="store_true",
        help=(
            "Audit ALLOWLIST entries for malformed or stale `last_reviewed` "
            "stamps and exit. Exits 1 if any finding is reported."
        ),
    )
    args = parser.parse_args()

    # Standalone audit mode — for CI / cron use.
    if args.audit_allowlist:
        findings = audit_allowlist()
        if args.json:
            print(json.dumps({
                "stale_days_cadence": ALLOWLIST_STALE_DAYS,
                "findings": findings,
                "passed": len(findings) == 0,
            }, indent=2))
        else:
            if findings:
                _print_allowlist_audit(findings, stream=sys.stdout)
                print(f"=== SUMMARY ===\nFindings: {len(findings)}\nResult: FAIL",
                      file=sys.stdout)
            else:
                print("=== allowlist audit ===", file=sys.stdout)
                print(f"  ✅ all {len(ALLOWLIST)} entries have fresh stamps "
                      f"(cadence: {ALLOWLIST_STALE_DAYS}d)", file=sys.stdout)
                print(f"\n=== SUMMARY ===\nFindings: 0\nResult: PASS",
                      file=sys.stdout)
        return 1 if findings else 0

    # Background audit — runs on every invocation, silent when clean, emits
    # to stderr so --json output on stdout stays parseable.
    if not args.json:
        _print_allowlist_audit(audit_allowlist())

    arg_path = Path(args.skill_dir).resolve()
    manifest = Path(args.manifest).resolve() if args.manifest else None

    if args.all:
        skills = walk_all_skills(arg_path)
        if not skills:
            print(f"Error: no skill directories found under {arg_path}", file=sys.stderr)
            return 1
        all_reports = []
        total_fail = 0
        for s in skills:
            passed, report = check_depth(s, manifest)
            all_reports.append(report)
            if not passed:
                total_fail += 1
        if args.json:
            print(json.dumps({
                "summary": {
                    "total": len(all_reports),
                    "passed": len(all_reports) - total_fail,
                    "failed": total_fail,
                    "thresholds": {
                        "min_body_lines": MIN_BODY_LINES,
                        "min_ref_files": MIN_REF_FILES,
                    },
                },
                "skills": all_reports,
            }, indent=2))
        else:
            print(f"=== CLEO Skill Depth Check (all skills under {arg_path}) ===")
            for r in all_reports:
                _print_report(r)
            print(f"\n=== SUMMARY ===")
            print(f"Total skills: {len(all_reports)}")
            print(f"Passed: {len(all_reports) - total_fail}")
            print(f"Failed: {total_fail}")
        return 1 if total_fail > 0 else 0

    # Single-skill mode
    if not arg_path.is_dir():
        print(f"Error: '{args.skill_dir}' is not a directory", file=sys.stderr)
        return 1
    if not (arg_path / "SKILL.md").exists():
        print(f"Error: '{args.skill_dir}' has no SKILL.md", file=sys.stderr)
        return 1

    passed, report = check_depth(arg_path, manifest)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print_report(report)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
