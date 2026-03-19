#!/usr/bin/env python3
"""
Deep body quality audit for CLEO skills.
Usage:
    audit_body.py <skill-directory>
    audit_body.py <skill-directory> --json
"""
import sys
import re
import json
import argparse
from pathlib import Path


def audit_body(skill_path):
    """Run a deep body quality audit on a skill's SKILL.md.

    Returns (results, errors, warnings) where results is a list of
    {"severity": "OK"|"WARN"|"ERROR", "section": str, "message": str} dicts.
    """
    skill_dir = Path(skill_path).resolve()
    skill_md = skill_dir / "SKILL.md"
    warnings = 0
    errors = 0
    results = []

    def error(section, msg):
        nonlocal errors
        errors += 1
        results.append({"severity": "ERROR", "section": section, "message": msg})

    def warn(section, msg):
        nonlocal warnings
        warnings += 1
        results.append({"severity": "WARN", "section": section, "message": msg})

    def ok(section, msg):
        results.append({"severity": "OK", "section": section, "message": msg})

    if not skill_md.exists():
        error("structure", "SKILL.md does not exist")
        return results, errors, warnings

    raw_content = skill_md.read_text(encoding="utf-8")

    parts = raw_content.split("---", 2)
    if len(parts) < 3:
        error("structure", "No body found (missing frontmatter closing '---')")
        return results, errors, warnings

    body = parts[2].strip()

    if not body:
        error("structure", "Body is empty")
        return results, errors, warnings

    ok("structure", "Body is present")

    body_lines = body.split("\n")
    total_lines = len(body_lines)

    # ── Section analysis ────────────────────────────────────────────────
    h1_headers = re.findall(r"^# .+", body, re.MULTILINE)
    h2_headers = re.findall(r"^## .+", body, re.MULTILINE)
    h3_headers = re.findall(r"^### .+", body, re.MULTILINE)
    total_sections = len(h2_headers) + len(h3_headers)

    if len(h1_headers) > 1:
        warn("section-analysis", f"Multiple '# ' top-level headings found ({len(h1_headers)})")

    first_h2_line = None
    first_h3_line = None
    for i, line in enumerate(body_lines):
        if first_h2_line is None and line.startswith("## "):
            first_h2_line = i
        if first_h3_line is None and line.startswith("### "):
            first_h3_line = i

    if first_h3_line is not None and (first_h2_line is None or first_h3_line < first_h2_line):
        warn("section-analysis", "'### ' heading appears before any '## ' heading (broken hierarchy)")

    if total_sections > 0:
        ok("section-analysis", f"Found {total_sections} section(s) ({len(h2_headers)} h2, {len(h3_headers)} h3)")
    else:
        warn("section-analysis", "No section headings found")

    # ── Code blocks ─────────────────────────────────────────────────────
    code_blocks = re.findall(r"```[\s\S]*?```", body)
    if code_blocks:
        ok("code-blocks", f"Found {len(code_blocks)} code block(s)")
        for block in code_blocks:
            script_refs = re.findall(r"(?:scripts|references)/[\w./-]+", block)
            for ref in script_refs:
                # Skip cross-skill references (preceded by / or ${)
                escaped = re.escape(ref)
                if re.search(r"[/$]" + escaped, block):
                    continue
                ref_path = skill_dir / ref
                if not ref_path.exists():
                    warn("code-blocks", f"Code block references non-existent file: {ref}")
    else:
        ok("code-blocks", "No code blocks (not required)")

    # ── Link validation ─────────────────────────────────────────────────
    # Strip fenced code blocks first — links inside ``` are examples, not live refs
    body_no_fences = re.sub(r"```[\s\S]*?```", "", body)
    links = re.findall(r"\[([^\]]+)\]\(([^)]+)\)", body_no_fences)
    if links:
        broken = 0
        for text, href in links:
            if href.startswith("http://") or href.startswith("https://"):
                continue
            clean_href = href.split("#")[0]
            if not clean_href:
                continue
            link_path = skill_dir / clean_href
            if not link_path.exists():
                # Check if it's on an example line
                link_line = next((l for l in body_no_fences.split("\n") if f"[{text}]({href})" in l), "")
                if re.search(r"\b(examples?|e\.g\.|such as|would be|illustrat)\b", link_line, re.IGNORECASE):
                    continue
                warn("link-validation", f"Broken link: [{text}]({href}) — file not found")
                broken += 1
        if broken == 0:
            ok("link-validation", f"All {len(links)} link(s) valid")
    else:
        ok("link-validation", "No links to validate")

    # ── Placeholder scan — case-sensitive ───────────────────────────────
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
        matches = re.findall(pattern, body)  # no re.IGNORECASE
        if matches:
            warn("placeholder-scan", f"Placeholder text: '{label}' ({len(matches)} occurrence(s))")
            placeholder_found = True

    if not placeholder_found:
        ok("placeholder-scan", "No placeholder text found")

    # ── Duplicate headings ──────────────────────────────────────────────
    all_headings = re.findall(r"^(#{1,6} .+)", body, re.MULTILINE)
    seen: dict[str, bool] = {}
    dup_found = False
    for heading in all_headings:
        normalized = heading.strip()
        if normalized in seen:
            warn("duplicate-headings", f"Duplicate heading: '{normalized}'")
            dup_found = True
        seen[normalized] = True

    if not dup_found:
        ok("duplicate-headings", "No duplicate headings")

    # ── Statistics ──────────────────────────────────────────────────────
    avg_per_section = total_lines / total_sections if total_sections > 0 else total_lines
    results.append({
        "severity": "INFO",
        "section": "statistics",
        "message": f"Lines: {total_lines}, Sections: {total_sections}, Avg lines/section: {avg_per_section:.1f}, Code blocks: {len(code_blocks)}, Links: {len(links)}",
    })

    return results, errors, warnings


def _print_report(skill_name: str, results: list, errors: int, warnings: int) -> None:
    section_order = ["structure", "section-analysis", "code-blocks", "link-validation", "placeholder-scan", "duplicate-headings", "statistics"]
    section_labels = {
        "structure": "Structure",
        "section-analysis": "Section Analysis",
        "code-blocks": "Code Blocks",
        "link-validation": "Link Validation",
        "placeholder-scan": "Placeholder Scan",
        "duplicate-headings": "Duplicate Headings",
        "statistics": "Statistics",
    }
    print(f"\n=== CLEO Body Audit: {skill_name} ===\n")
    current_section = None
    for r in results:
        sec = r["section"]
        if sec != current_section:
            current_section = sec
            print(f"\n--- {section_labels.get(sec, sec)} ---")
        sev = r["severity"]
        msg = r["message"]
        if sev == "OK":
            print(f"  \u2705 {msg}")
        elif sev == "WARN":
            print(f"  \u26a0\ufe0f  WARN: {msg}")
        elif sev == "ERROR":
            print(f"  \u274c ERROR: {msg}")
        elif sev == "INFO":
            print(f"  {msg}")

    print(f"\n=== SUMMARY ===")
    print(f"Errors:   {errors}")
    print(f"Warnings: {warnings}")
    if errors > 0:
        print("Result:   FAIL")
    elif warnings > 0:
        print("Result:   PASS (with warnings)")
    else:
        print("Result:   PASS")


def main():
    parser = argparse.ArgumentParser(description="Deep body quality audit for CLEO skills")
    parser.add_argument("skill_dir", help="Path to the skill directory to audit")
    parser.add_argument("--json", action="store_true", help="Output results as JSON")
    args = parser.parse_args()

    skill_path = Path(args.skill_dir).resolve()
    if not skill_path.is_dir():
        print(f"Error: '{args.skill_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    skill_name = skill_path.name
    results, errors, warnings = audit_body(skill_path)

    if getattr(args, "json"):
        print(json.dumps({
            "skill_name": skill_name,
            "results": results,
            "errors": errors,
            "warnings": warnings,
            "passed": errors == 0,
        }, indent=2))
    else:
        _print_report(skill_name, results, errors, warnings)

    sys.exit(1 if errors > 0 else 0)


if __name__ == "__main__":
    main()
