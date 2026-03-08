#!/usr/bin/env python3
"""Extract structured context from a skill for ecosystem compliance checking.

Parses SKILL.md and scans for CLEO-specific patterns (operation references,
domain mentions, lifecycle stages, deprecated verbs). Outputs a JSON context
package that the ecosystem-checker agent evaluates.

Usage:
    python check_ecosystem.py <skill-dir>
    python check_ecosystem.py <skill-dir> --output context.json
"""

import argparse
import json
import re
import sys
from pathlib import Path

# Canonical CLEO domains
CANONICAL_DOMAINS = [
    "tasks", "session", "memory", "check", "pipeline",
    "orchestrate", "tools", "admin", "nexus", "sticky",
]

# RCASD-IVTR+C lifecycle stage names (and common abbreviations)
LIFECYCLE_STAGES = [
    "Research", "Consensus", "Architecture Decision", "Specification",
    "Decomposition", "Implementation", "Validation", "Testing", "Release",
    "Contribution", "RCASD", "IVTR", "RCSD",
]

# Deprecated verbs that should not be used when describing CLEO operations
DEPRECATED_VERBS = [
    r"\bcreate\b",   # → add
    r"\bsearch\b",   # → find
    r"(?<!\btool)\bget\b",   # → show or fetch (avoid matching "get" in "getter" etc.)
]

# Patterns indicating direct .cleo/ data manipulation (not via MCP)
DIRECT_DATA_PATTERNS = [
    r"edit\s+tasks\.db",
    r"modify\s+\.cleo/",
    r"open\s+brain\.db",
    r"directly\s+edit",
    r"\.cleo/config\.json\s+directly",
    r"vim\s+\.cleo/",
    r"nano\s+\.cleo/",
]

# Pattern for detecting CLEO operation references
# Matches: "query tasks.show", "mutate memory.observe", "query { domain: ...", etc.
OPERATION_PATTERN = re.compile(
    r"(?:query|mutate)\s+([a-z]+\.[a-z.]+)"
    r"|(?:query|mutate)\s*\{\s*domain:\s*[\"']([a-z]+)[\"']\s*,\s*operation:\s*[\"']([^\"']+)[\"']",
    re.IGNORECASE,
)

# Pattern for cleo CLI commands: "cleo <verb> ..."
CLEO_CLI_PATTERN = re.compile(r"`cleo\s+([a-z]+)", re.IGNORECASE)


def extract_skill_data(skill_path: Path) -> dict:
    """Extract structured data from a skill directory."""
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return {"error": f"SKILL.md not found at {skill_md}"}

    content = skill_md.read_text(encoding="utf-8")

    # Parse frontmatter
    frontmatter: dict = {}
    body = content
    fm_match = re.match(r"^---\n(.*?)\n---\n?(.*)", content, re.DOTALL)
    if fm_match:
        raw_fm = fm_match.group(1)
        body = fm_match.group(2).strip()
        # Simple YAML key extraction (not full YAML parse to avoid dependency)
        for line in raw_fm.split("\n"):
            if ":" in line:
                key, _, val = line.partition(":")
                frontmatter[key.strip()] = val.strip().strip('"').strip("'")

    name = frontmatter.get("name", skill_path.name)
    description = frontmatter.get("description", "")
    allowed_tools = frontmatter.get("allowed-tools", "")

    # Find CLEO operation references
    cleo_ops: list[str] = []
    for m in OPERATION_PATTERN.finditer(content):
        if m.group(1):
            cleo_ops.append(m.group(1))
        elif m.group(2) and m.group(3):
            cleo_ops.append(f"{m.group(2)}.{m.group(3)}")
    cleo_ops = sorted(set(cleo_ops))

    # Find domain mentions
    domains_mentioned: list[str] = []
    for domain in CANONICAL_DOMAINS:
        if re.search(r"\b" + domain + r"\b", content, re.IGNORECASE):
            domains_mentioned.append(domain)

    # Find lifecycle stage mentions
    lifecycle_found: list[str] = []
    for stage in LIFECYCLE_STAGES:
        if re.search(r"\b" + re.escape(stage) + r"\b", content, re.IGNORECASE):
            lifecycle_found.append(stage)

    # Find deprecated verb usage
    deprecated_found: list[str] = []
    for pattern in DEPRECATED_VERBS:
        matches = re.findall(pattern, body, re.IGNORECASE)
        if matches:
            verb = pattern.replace(r"\b", "").replace("(?<!\\btool)\\bget\\b", "get")
            deprecated_found.append(f"{matches[0]} ({len(matches)} occurrence(s))")

    # Check for direct data manipulation
    direct_data_issues: list[str] = []
    for pattern in DIRECT_DATA_PATTERNS:
        if re.search(pattern, body, re.IGNORECASE):
            direct_data_issues.append(pattern)

    # Find cleo CLI verb usage
    cli_verbs = list(set(m.group(1).lower() for m in CLEO_CLI_PATTERN.finditer(content)))

    body_lines = len([l for l in body.split("\n") if l.strip()])

    return {
        "skill_name": name,
        "skill_path": str(skill_path.resolve()),
        "frontmatter": frontmatter,
        "description": description,
        "allowed_tools": allowed_tools,
        "body_line_count": body_lines,
        "body": body,
        "cleo_operations_referenced": cleo_ops,
        "domains_mentioned": domains_mentioned,
        "lifecycle_stages_mentioned": lifecycle_found,
        "deprecated_verbs_found": deprecated_found,
        "direct_data_manipulation_detected": direct_data_issues,
        "cli_verbs_used": cli_verbs,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract CLEO ecosystem context from a skill for compliance checking"
    )
    parser.add_argument("skill_dir", help="Path to the skill directory")
    parser.add_argument("--output", "-o", default=None, help="Write JSON to file (default: stdout)")
    args = parser.parse_args()

    skill_path = Path(args.skill_dir).resolve()
    if not skill_path.is_dir():
        print(f"Error: '{args.skill_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    data = extract_skill_data(skill_path)

    output = json.dumps(data, indent=2)

    if args.output:
        Path(args.output).write_text(output)
        print(f"Context written to {args.output}", file=sys.stderr)
    else:
        print(output)


if __name__ == "__main__":
    main()
