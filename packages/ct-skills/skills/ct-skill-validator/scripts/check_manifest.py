#!/usr/bin/env python3
"""
CLEO manifest alignment checker.
Usage: check_manifest.py <skill-directory> <manifest-json> [--dispatch-config dispatch-config.json]
"""
import sys
import json
import re
import yaml
import argparse
from pathlib import Path

MANIFEST_REQUIRED_FIELDS = [
    "name", "version", "description", "path", "status",
    "tier", "token_budget", "capabilities", "constraints",
]


def check_manifest(skill_path, manifest_path, dispatch_config_path=None):
    """Check manifest alignment for a skill."""
    skill_dir = Path(skill_path).resolve()
    skill_name = skill_dir.name
    manifest_file = Path(manifest_path).resolve()
    errors = 0
    warnings = 0

    def error(msg):
        nonlocal errors
        errors += 1
        print(f"  \u274c ERROR: {msg}")

    def warn(msg):
        nonlocal warnings
        warnings += 1
        print(f"  \u26a0\ufe0f  WARN: {msg}")

    def ok(msg):
        print(f"  \u2705 {msg}")

    print(f"\n=== CLEO Manifest Check: {skill_name} ===\n")

    # ── Read SKILL.md frontmatter ───────────────────────────────────────
    print("--- SKILL.md ---")
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        error("SKILL.md does not exist")
        _print_summary(errors, warnings)
        return errors

    raw_content = skill_md.read_text(encoding="utf-8")
    fm_match = re.match(r"^---\n(.*?)\n---", raw_content, re.DOTALL)
    if not fm_match:
        error("Could not extract frontmatter from SKILL.md")
        _print_summary(errors, warnings)
        return errors

    try:
        frontmatter = yaml.safe_load(fm_match.group(1))
    except yaml.YAMLError as e:
        error(f"Frontmatter YAML parse error: {e}")
        _print_summary(errors, warnings)
        return errors

    if not isinstance(frontmatter, dict):
        error("Frontmatter is not a dict")
        _print_summary(errors, warnings)
        return errors

    fm_name = frontmatter.get("name", skill_name)
    ok(f"SKILL.md frontmatter read (name: '{fm_name}')")

    # ── Read manifest.json ──────────────────────────────────────────────
    print("\n--- Manifest ---")
    if not manifest_file.exists():
        error(f"Manifest file not found: {manifest_path}")
        _print_summary(errors, warnings)
        return errors

    try:
        manifest_data = json.loads(manifest_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        error(f"Manifest is not valid JSON: {e}")
        _print_summary(errors, warnings)
        return errors

    ok("Manifest parsed successfully")

    skills_list = manifest_data.get("skills", [])
    matching = [s for s in skills_list if s.get("name") == fm_name]

    if not matching:
        error(f"Skill '{fm_name}' not found in manifest.json skills[] array")
        _print_summary(errors, warnings)
        return errors

    ok(f"Skill '{fm_name}' found in manifest.json")
    entry = matching[0]

    # Check required fields
    print("\n--- Required Fields ---")
    missing_fields = []
    for field in MANIFEST_REQUIRED_FIELDS:
        if field not in entry:
            warn(f"Missing required field: '{field}'")
            missing_fields.append(field)
        else:
            ok(f"'{field}' present")

    # ── Dispatch config check ───────────────────────────────────────────
    if dispatch_config_path:
        print("\n--- Dispatch Config ---")
        dc_file = Path(dispatch_config_path).resolve()
        if not dc_file.exists():
            error(f"Dispatch config not found: {dispatch_config_path}")
        else:
            try:
                dc_data = json.loads(dc_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                error(f"Dispatch config is not valid JSON: {e}")
                dc_data = None

            if dc_data is not None:
                overrides = dc_data.get("skill_overrides", {})
                if fm_name not in overrides:
                    warn(f"Skill '{fm_name}' not found in dispatch-config.json skill_overrides")
                else:
                    ok(f"Skill '{fm_name}' found in dispatch-config.json")

    _print_summary(errors, warnings)
    return errors


def _print_summary(errors, warnings):
    """Print the check summary."""
    print(f"\n=== SUMMARY ===")
    print(f"Errors:   {errors}")
    print(f"Warnings: {warnings}")

    if errors > 0:
        print(f"Result:   FAIL")
    elif warnings > 0:
        print(f"Result:   PASS (with warnings)")
    else:
        print(f"Result:   PASS")


def main():
    parser = argparse.ArgumentParser(
        description="CLEO manifest alignment checker"
    )
    parser.add_argument("skill_dir", help="Path to the skill directory")
    parser.add_argument("manifest", help="Path to manifest.json")
    parser.add_argument("--dispatch-config", help="Path to dispatch-config.json")

    args = parser.parse_args()

    skill_path = Path(args.skill_dir).resolve()
    if not skill_path.is_dir():
        print(f"Error: '{args.skill_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    error_count = check_manifest(
        skill_path,
        args.manifest,
        dispatch_config_path=args.dispatch_config,
    )

    sys.exit(1 if error_count > 0 else 0)


if __name__ == "__main__":
    main()
