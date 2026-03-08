#!/usr/bin/env python3
"""
Deep body quality audit for CLEO skills.
Usage: audit_body.py <skill-directory>
"""
import sys
import re
import argparse
from pathlib import Path


def audit_body(skill_path):
    """Run a deep body quality audit on a skill's SKILL.md."""
    skill_dir = Path(skill_path).resolve()
    skill_name = skill_dir.name
    skill_md = skill_dir / "SKILL.md"
    warnings = 0
    errors = 0

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

    print(f"\n=== CLEO Body Audit: {skill_name} ===\n")

    if not skill_md.exists():
        error("SKILL.md does not exist")
        _print_summary(errors, warnings)
        return errors

    raw_content = skill_md.read_text(encoding="utf-8")

    # Extract body (after second ---)
    parts = raw_content.split("---", 2)
    if len(parts) < 3:
        error("No body found (missing frontmatter closing '---')")
        _print_summary(errors, warnings)
        return errors

    body = parts[2].strip()

    if not body:
        error("Body is empty")
        _print_summary(errors, warnings)
        return errors

    ok("Body is present")

    body_lines = body.split("\n")
    total_lines = len(body_lines)

    # ── Section analysis ────────────────────────────────────────────────
    print("\n--- Section Analysis ---")

    h1_headers = re.findall(r"^# .+", body, re.MULTILINE)
    h2_headers = re.findall(r"^## .+", body, re.MULTILINE)
    h3_headers = re.findall(r"^### .+", body, re.MULTILINE)
    total_sections = len(h2_headers) + len(h3_headers)

    if len(h1_headers) > 1:
        warn(f"Multiple '# ' top-level headings found ({len(h1_headers)})")

    # Check heading hierarchy: ### before any ##
    first_h2_line = None
    first_h3_line = None
    for i, line in enumerate(body_lines):
        if first_h2_line is None and line.startswith("## "):
            first_h2_line = i
        if first_h3_line is None and line.startswith("### "):
            first_h3_line = i

    if first_h3_line is not None and (first_h2_line is None or first_h3_line < first_h2_line):
        warn("'### ' heading appears before any '## ' heading (broken hierarchy)")

    if total_sections > 0:
        ok(f"Found {total_sections} section(s) ({len(h2_headers)} h2, {len(h3_headers)} h3)")
    else:
        warn("No section headings found")

    # ── Code blocks ─────────────────────────────────────────────────────
    print("\n--- Code Blocks ---")

    code_blocks = re.findall(r"```[\s\S]*?```", body)
    if code_blocks:
        ok(f"Found {len(code_blocks)} code block(s)")
        # Check for scripts/ references in code blocks
        for block in code_blocks:
            script_refs = re.findall(r"(?:scripts|references)/[\w./-]+", block)
            for ref in script_refs:
                ref_path = skill_dir / ref
                if not ref_path.exists():
                    warn(f"Code block references non-existent file: {ref}")
    else:
        ok("No code blocks (not required)")

    # ── Link validation ─────────────────────────────────────────────────
    print("\n--- Link Validation ---")

    links = re.findall(r"\[([^\]]+)\]\(([^)]+)\)", body)
    if links:
        broken = 0
        for text, href in links:
            # Skip URLs
            if href.startswith("http://") or href.startswith("https://"):
                continue
            # Strip anchors
            clean_href = href.split("#")[0]
            if not clean_href:
                continue
            link_path = skill_dir / clean_href
            if not link_path.exists():
                warn(f"Broken link: [{text}]({href}) — file not found")
                broken += 1
        if broken == 0:
            ok(f"All {len(links)} link(s) valid")
    else:
        ok("No links to validate")

    # ── Placeholder scan ────────────────────────────────────────────────
    print("\n--- Placeholder Scan ---")

    placeholder_patterns = [
        (r"\[Required:", "[Required:"),
        (r"\bTODO\b", "TODO"),
        (r"\bREPLACE\b", "REPLACE"),
        (r"\bFIXME\b", "FIXME"),
        (r"\bTBD\b", "TBD"),
        (r"\[Add content", "[Add content"),
    ]
    placeholder_found = False
    for pattern, label in placeholder_patterns:
        matches = re.findall(pattern, body, re.IGNORECASE)
        if matches:
            warn(f"Placeholder text: '{label}' ({len(matches)} occurrence(s))")
            placeholder_found = True

    if not placeholder_found:
        ok("No placeholder text found")

    # ── Duplicate headings ──────────────────────────────────────────────
    print("\n--- Duplicate Headings ---")

    all_headings = re.findall(r"^(#{1,6} .+)", body, re.MULTILINE)
    seen = {}
    dup_found = False
    for heading in all_headings:
        normalized = heading.strip()
        if normalized in seen:
            warn(f"Duplicate heading: '{normalized}'")
            dup_found = True
        seen[normalized] = True

    if not dup_found:
        ok("No duplicate headings")

    # ── Statistics ──────────────────────────────────────────────────────
    print("\n--- Statistics ---")

    avg_per_section = total_lines / total_sections if total_sections > 0 else total_lines
    print(f"  Total lines:          {total_lines}")
    print(f"  Section count:        {total_sections}")
    print(f"  Avg lines/section:    {avg_per_section:.1f}")
    print(f"  Code blocks:          {len(code_blocks)}")
    print(f"  Links:                {len(links)}")

    _print_summary(errors, warnings)
    return errors


def _print_summary(errors, warnings):
    """Print the audit summary."""
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
        description="Deep body quality audit for CLEO skills"
    )
    parser.add_argument("skill_dir", help="Path to the skill directory to audit")

    args = parser.parse_args()

    skill_path = Path(args.skill_dir).resolve()
    if not skill_path.is_dir():
        print(f"Error: '{args.skill_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    error_count = audit_body(skill_path)
    sys.exit(1 if error_count > 0 else 0)


if __name__ == "__main__":
    main()
