#!/usr/bin/env python3
"""
CLEO Skill Validator — Full compliance gauntlet.
Validates a skill directory against the complete CLEO skill standard.

Usage:
    validate.py <skill-directory>
    validate.py <skill-directory> --manifest path/to/manifest.json
    validate.py <skill-directory> --manifest path/to/manifest.json --dispatch-config path/to/dispatch-config.json
    validate.py <skill-directory> --provider-map path/to/provider-skills-map.json
    validate.py <skill-directory> --json
"""
import sys
import re
import json
import yaml
import argparse
from pathlib import Path

V2_STANDARD = {
    "name", "description", "argument-hint", "disable-model-invocation",
    "user-invocable", "allowed-tools", "model", "context", "agent", "hooks",
    "license",
}
CLEO_ONLY = {
    "version", "tier", "core", "category", "protocol",
    "dependencies", "sharedResources", "compatibility",
    "token_budget", "capabilities", "constraints",
    "metadata", "tags", "triggers", "mvi_scope", "requires_tiers",
}

MANIFEST_REQUIRED_FIELDS = [
    "name", "version", "description", "path", "status",
    "tier", "token_budget", "capabilities", "constraints",
]


def validate_skill(skill_path, manifest_path=None, dispatch_config_path=None, provider_map_path=None):
    """Run the full v2 validation gauntlet on a skill directory.

    Returns (results, errors, warnings) where results is a list of
    (tier, severity, message) tuples.
    """
    skill_dir = Path(skill_path).resolve()
    skill_name = skill_dir.name
    errors = 0
    warnings = 0
    results = []

    def error(tier, msg):
        nonlocal errors
        errors += 1
        results.append((tier, "ERROR", msg))

    def warn(tier, msg):
        nonlocal warnings
        warnings += 1
        results.append((tier, "WARN", msg))

    def ok(tier, msg):
        results.append((tier, "OK", msg))

    # ── Tier 1 — Structure ──────────────────────────────────────────────
    tier = 1
    skill_md = skill_dir / "SKILL.md"

    if not skill_md.exists():
        error(tier, "SKILL.md does not exist")
        return results, errors, warnings

    ok(tier, "SKILL.md exists")

    raw_content = skill_md.read_text(encoding="utf-8")

    if not raw_content.startswith("---"):
        error(tier, "SKILL.md does not start with '---' (no frontmatter block)")
        return results, errors, warnings

    ok(tier, "Content starts with '---'")

    fm_match = re.match(r"^---\n(.*?)\n---", raw_content, re.DOTALL)
    if not fm_match:
        error(tier, "Could not extract frontmatter (missing closing '---')")
        return results, errors, warnings

    ok(tier, "Frontmatter block extracted")

    raw_frontmatter = fm_match.group(1)
    try:
        frontmatter = yaml.safe_load(raw_frontmatter)
    except yaml.YAMLError as e:
        error(tier, f"Frontmatter is not valid YAML: {e}")
        return results, errors, warnings

    ok(tier, "Frontmatter is valid YAML")

    if not isinstance(frontmatter, dict):
        error(tier, "Frontmatter is not a dictionary (key: value pairs expected)")
        return results, errors, warnings

    ok(tier, "Frontmatter is a dict")

    for key in frontmatter:
        if key in CLEO_ONLY:
            error(tier, f"Move '{key}' to manifest.json (CLEO-only field)")
        else:
            pass  # valid or unknown keys checked in tier 2

    if not any(r[1] == "ERROR" and "CLEO-only" in r[2] for r in results):
        ok(tier, "No CLEO-only fields in frontmatter")

    # ── Tier 2 — Frontmatter Quality ────────────────────────────────────
    tier = 2

    # name checks
    name_val = frontmatter.get("name")
    if name_val is None:
        error(tier, "'name' field is missing")
    else:
        if not isinstance(name_val, str):
            error(tier, "'name' must be a string")
        else:
            if not re.match(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", name_val):
                error(tier, f"'name' must be hyphen-case (got: '{name_val}')")
            if "--" in name_val:
                error(tier, "'name' must not contain consecutive hyphens")
            if name_val.startswith("-") or name_val.endswith("-"):
                error(tier, "'name' must not start or end with a hyphen")
            if len(name_val) > 64:
                error(tier, f"'name' exceeds 64 characters (got: {len(name_val)})")
            if name_val != skill_name:
                warn(tier, f"'name' field ('{name_val}') does not match directory name ('{skill_name}')")
            if not any(r[1] == "ERROR" and "'name'" in r[2] for r in results if r[0] == 2):
                ok(tier, "'name' is valid")

    # description checks
    desc_val = frontmatter.get("description")
    if desc_val is None:
        error(tier, "'description' field is missing")
    else:
        if not isinstance(desc_val, str):
            error(tier, "'description' must be a string")
        else:
            if "<" in desc_val or ">" in desc_val:
                error(tier, "'description' must not contain '<' or '>' characters")
            if len(desc_val) > 1024:
                error(tier, f"'description' exceeds 1024 characters (got: {len(desc_val)})")
            if len(desc_val) < 50:
                warn(tier, f"'description' is shorter than 50 characters (got: {len(desc_val)})")
            trigger_indicators = ["when", "use when", "use for"]
            has_trigger = any(ind in desc_val.lower() for ind in trigger_indicators)
            if not has_trigger:
                warn(tier, "'description' should contain a trigger indicator ('when', 'use when', 'use for')")
            if desc_val.startswith("I "):
                warn(tier, "'description' should not start with 'I ' (use third person)")
            if not any(r[1] == "ERROR" and "'description'" in r[2] for r in results if r[0] == 2):
                ok(tier, "'description' is valid")

    # YAML multiline pitfall check
    if "description: >" in raw_frontmatter or "description: |" in raw_frontmatter:
        warn(tier, "'description' uses YAML multiline syntax (> or |) which can cause unexpected whitespace")

    # context checks
    context_val = frontmatter.get("context")
    if context_val is not None:
        if context_val != "fork":
            error(tier, f"'context' must be 'fork' if present (got: '{context_val}')")
        else:
            if "agent" not in frontmatter:
                warn(tier, "'context' is 'fork' but no 'agent' field specified")
            ok(tier, "'context' is valid")

    # boolean field checks
    dmi_val = frontmatter.get("disable-model-invocation")
    if dmi_val is not None and not isinstance(dmi_val, bool):
        error(tier, "'disable-model-invocation' must be a boolean")

    ui_val = frontmatter.get("user-invocable")
    if ui_val is not None and not isinstance(ui_val, bool):
        error(tier, "'user-invocable' must be a boolean")

    # contradictory flags
    if (isinstance(dmi_val, bool) and dmi_val is True and
            isinstance(ui_val, bool) and ui_val is False):
        error(tier, "Contradictory: 'disable-model-invocation' is true AND 'user-invocable' is false (skill cannot be invoked at all)")

    # argument-hint checks
    ah_val = frontmatter.get("argument-hint")
    if ah_val is not None:
        if not isinstance(ah_val, str):
            error(tier, "'argument-hint' must be a string")
        elif len(ah_val) > 100:
            error(tier, f"'argument-hint' exceeds 100 characters (got: {len(ah_val)})")

    # allowed-tools checks
    at_val = frontmatter.get("allowed-tools")
    if at_val is not None:
        if not isinstance(at_val, (str, list)):
            error(tier, "'allowed-tools' must be a string or list")

    # model checks
    model_val = frontmatter.get("model")
    if model_val is not None and not isinstance(model_val, str):
        error(tier, "'model' must be a string")

    # agent checks
    agent_val = frontmatter.get("agent")
    if agent_val is not None and not isinstance(agent_val, str):
        error(tier, "'agent' must be a string")

    # hooks checks
    hooks_val = frontmatter.get("hooks")
    if hooks_val is not None and not isinstance(hooks_val, dict):
        error(tier, "'hooks' must be a dict")

    # ── Tier 3 — Body Quality ───────────────────────────────────────────
    tier = 3

    # Extract body (content after second ---)
    parts = raw_content.split("---", 2)
    body = parts[2].strip() if len(parts) >= 3 else ""

    if not body:
        warn(tier, "Body is empty (no content after frontmatter)")
    else:
        ok(tier, "Body is present")

        body_lines = body.split("\n")
        line_count = len(body_lines)

        if line_count >= 600:
            error(tier, f"Body is too long: {line_count} lines (max 600)")
        elif line_count >= 400:
            warn(tier, f"Body is getting long: {line_count} lines (warn threshold: 400)")
        else:
            ok(tier, f"Body length OK ({line_count} lines)")

        # Placeholder scan — case-sensitive to avoid matching "todo app", "replace with X", etc.
        placeholders = [r"\[Required:", r"\bTODO\b", r"\bREPLACE\b", r"\[Add content", r"\bFIXME\b", r"\bTBD\b"]
        for pattern in placeholders:
            matches = re.findall(pattern, body)
            if matches:
                clean_pattern = re.sub(r"[\\(?\[\])]", "", pattern).strip("\\b")
                warn(tier, f"Placeholder text found: '{clean_pattern}' ({len(matches)} occurrence(s))")

        # Section headers check for long bodies
        if line_count > 200:
            section_headers = re.findall(r"^## ", body, re.MULTILINE)
            if not section_headers:
                warn(tier, "Body exceeds 200 lines but has no '## ' section headers")
            else:
                ok(tier, f"Body has {len(section_headers)} section header(s)")

        # File reference existence checks
        # Strip fenced code blocks first — paths inside ``` are examples, not live references
        body_no_fences = re.sub(r"```[\s\S]*?```", "", body)
        refs = re.findall(r"(?:references|scripts)/[\w./-]+", body_no_fences)
        for ref in refs:
            # Skip cross-skill paths (preceded by / or ${ anywhere in the body)
            escaped = re.escape(ref)
            if re.search(r"[/$]" + escaped, body_no_fences):
                continue
            # Skip example prose: line contains illustrative markers
            ref_line = next((l for l in body_no_fences.split("\n") if ref in l), "")
            if re.search(r"\b(examples?|e\.g\.|such as|like `|would be|illustrat)\b", ref_line, re.IGNORECASE):
                continue
            ref_path = skill_dir / ref
            if not ref_path.exists():
                warn(tier, f"Referenced file does not exist: {ref}")

    # ── Tier 4 — CLEO Integration ──────────────────────────────────────
    tier = 4

    if manifest_path:
        manifest_file = Path(manifest_path).resolve()
        if not manifest_file.exists():
            error(tier, f"Manifest file not found: {manifest_path}")
        else:
            try:
                manifest_data = json.loads(manifest_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                error(tier, f"Manifest is not valid JSON: {e}")
                manifest_data = None

            if manifest_data is not None:
                skills_list = manifest_data.get("skills", [])
                matching = [s for s in skills_list if s.get("name") == skill_name]

                if not matching:
                    warn(tier, f"Skill '{skill_name}' not found in manifest.json skills[]")
                else:
                    ok(tier, f"Skill '{skill_name}' found in manifest.json")
                    entry = matching[0]
                    for field in MANIFEST_REQUIRED_FIELDS:
                        if field not in entry:
                            warn(tier, f"Manifest entry missing required field: '{field}'")

        if dispatch_config_path:
            dc_file = Path(dispatch_config_path).resolve()
            if not dc_file.exists():
                error(tier, f"Dispatch config file not found: {dispatch_config_path}")
            else:
                try:
                    dc_data = json.loads(dc_file.read_text(encoding="utf-8"))
                except json.JSONDecodeError as e:
                    error(tier, f"Dispatch config is not valid JSON: {e}")
                    dc_data = None

                if dc_data is not None:
                    overrides = dc_data.get("skill_overrides", {})
                    if skill_name not in overrides:
                        warn(tier, f"Skill '{skill_name}' not found in dispatch-config.json skill_overrides")
                    else:
                        ok(tier, f"Skill '{skill_name}' found in dispatch-config.json")

    # ── Tier 5 — Provider Compatibility ─────────────────────────────────
    tier = 5

    if provider_map_path:
        pm_file = Path(provider_map_path).resolve()
        if not pm_file.exists():
            error(tier, f"Provider map file not found: {provider_map_path}")
        else:
            try:
                pm_data = json.loads(pm_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                error(tier, f"Provider map is not valid JSON: {e}")
                pm_data = None

            if pm_data is not None:
                # Check if skill is referenced anywhere in the provider map
                pm_text = json.dumps(pm_data)
                if skill_name not in pm_text:
                    warn(tier, f"Skill '{skill_name}' not referenced in provider-skills-map.json")
                else:
                    ok(tier, f"Skill '{skill_name}' found in provider-skills-map.json")

    return results, errors, warnings


def _print_report(skill_name, results, errors, warnings):
    """Print the structured validation report."""
    print(f"\n=== CLEO Skill Validator: {skill_name} ===\n")

    tier_names = {
        1: "Tier 1 — Structure",
        2: "Tier 2 — Frontmatter Quality",
        3: "Tier 3 — Body Quality",
        4: "Tier 4 — CLEO Integration",
        5: "Tier 5 — Provider Compatibility",
    }

    current_tier = None
    for tier_num, severity, msg in results:
        if tier_num != current_tier:
            current_tier = tier_num
            print(f"{tier_names.get(tier_num, f'Tier {tier_num}')}")

        if severity == "OK":
            print(f"  \u2705 {msg}")
        elif severity == "ERROR":
            print(f"  \u274c ERROR: {msg}")
        elif severity == "WARN":
            print(f"  \u26a0\ufe0f  WARN: {msg}")

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
        description="CLEO Skill Validator — Full compliance gauntlet"
    )
    parser.add_argument("skill_dir", help="Path to the skill directory to validate")
    parser.add_argument("--manifest", help="Path to manifest.json for CLEO integration check")
    parser.add_argument("--dispatch-config", help="Path to dispatch-config.json for dispatch override check")
    parser.add_argument("--provider-map", help="Path to provider-skills-map.json for provider compatibility check")
    parser.add_argument("--json", action="store_true", help="Output results as JSON instead of human-readable text")

    args = parser.parse_args()

    skill_path = Path(args.skill_dir).resolve()
    if not skill_path.is_dir():
        print(f"Error: '{args.skill_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    skill_name = skill_path.name
    results, errors, warnings = validate_skill(
        skill_path,
        manifest_path=args.manifest,
        dispatch_config_path=args.dispatch_config,
        provider_map_path=args.provider_map,
    )

    if getattr(args, "json"):
        output = {
            "skill_name": skill_name,
            "results": [
                {"tier": t, "severity": s, "message": m}
                for t, s, m in results
            ],
            "errors": errors,
            "warnings": warnings,
            "passed": errors == 0,
        }
        print(json.dumps(output, indent=2))
    else:
        _print_report(skill_name, results, errors, warnings)

    sys.exit(1 if errors > 0 else 0)


if __name__ == "__main__":
    main()
