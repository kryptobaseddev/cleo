#!/usr/bin/env python3
"""
validate.py — structural validator for Council run outputs.

Usage:
  python3 validate.py <path-to-output.md>
  python3 validate.py --json <path>       # emit JSON report on stdout
  python3 validate.py --strict <path>     # treat warnings as failures

Exit codes:
  0 — valid
  1 — structural violations (fatal)
  2 — semantic warnings (convergence, weak grounding) with --strict
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

ADVISORS = ["Contrarian", "First Principles", "Expansionist", "Outsider", "Executor"]

PEER_REVIEW_ROTATION = [
    ("Contrarian", "First Principles"),
    ("First Principles", "Expansionist"),
    ("Expansionist", "Outsider"),
    ("Outsider", "Executor"),
    ("Executor", "Contrarian"),
]

ADVISOR_REQUIRED_MARKERS = [
    "**Frame:**",
    "**Evidence anchored:**",
    "**Verdict from this lens:**",
    "**Single sharpest point:**",
]

EXECUTOR_EXTRA_MARKERS = [
    "**The action (one):**",
    "**Expected outcome",
    "**What this unblocks:**",
]

PEER_REVIEW_GATES = ["G1 Rigor", "G2 Evidence grounding", "G3 Frame integrity", "G4 Actionability"]

PEER_REVIEW_REQUIRED_MARKERS = [
    "**Gate results:**",
    "**Strongest finding",
    "**Gap from",
    "**What I would add:**",
    "**Disposition:**",
]

CHAIRMAN_REQUIRED_SUBSECTIONS = [
    "### Gate summary",
    "### Recommendation",
    "### Why this, not the alternatives",
    "### What each advisor got right",
    "### Conditions on the recommendation",
    "### Next 60-minute action",
    "### Confidence",
]


@dataclass
class Violation:
    kind: str            # "structural" | "semantic" | "warning"
    section: str
    message: str


class Validator:
    def __init__(self, md: str):
        self.md = md
        self.violations: list[Violation] = []

    # ─── helpers ────────────────────────────────────────────────────────────

    def _section_body(self, header_regex: str) -> str | None:
        """Return the body text under the first header matching header_regex, up to the next same-or-higher level header.

        Line-based scan that correctly ignores headers inside ``` code fences.
        """
        header_re = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
        lines = self.md.split("\n")
        in_fence = False
        start_line = None        # first line of body (after matching header)
        start_level = None
        end_line = len(lines)    # body end (exclusive)

        for i, line in enumerate(lines):
            if line.lstrip().startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            m = header_re.match(line)
            if not m:
                continue
            level = len(m.group(1))
            title = m.group(2).strip()
            if start_line is None:
                if re.match(header_regex, title):
                    start_line = i + 1
                    start_level = level
            else:
                if level <= start_level:
                    end_line = i
                    break

        if start_line is None:
            return None
        return "\n".join(lines[start_line:end_line])

    def _fail(self, section: str, message: str, kind: str = "structural"):
        self.violations.append(Violation(kind=kind, section=section, message=message))

    # ─── checks ─────────────────────────────────────────────────────────────

    def check_top_header(self):
        m = re.search(r"^#\s+The Council\s+—\s+(.+)$", self.md, re.MULTILINE)
        if not m:
            self._fail("H1", "Missing H1: expected '# The Council — <one-line question>'.")
            return
        question = m.group(1).strip()
        if len(question) < 10:
            self._fail("H1", f"Restated question too short: {question!r}. Expected a full one-sentence decision question.")

    def check_evidence_pack(self):
        body = self._section_body(r"^Evidence pack$")
        if body is None:
            self._fail("Evidence pack", "Missing '## Evidence pack' section.")
            return
        items = re.findall(r"^\s*\d+\.\s+(.+?)(?=^\s*\d+\.\s+|\Z)", body, re.MULTILINE | re.DOTALL)
        count = len(items)
        if count < 3:
            self._fail("Evidence pack", f"Evidence pack has {count} items; minimum is 3.")
        if count > 7:
            self._fail("Evidence pack", f"Evidence pack has {count} items; maximum is 7.", kind="warning")
        for i, item in enumerate(items, 1):
            item_text = item.strip()
            # Each item must contain a rationale separator (—, --, or ":").
            has_rationale = ("—" in item_text) or (" -- " in item_text) or (": " in item_text and "`" in item_text)
            if not has_rationale:
                self._fail("Evidence pack", f"Item {i} appears to lack a rationale (expected 'citation — why this matters').")
            # Each item should have a citation-like token: backticks, file:line, sha, or URL.
            has_citation = bool(re.search(r"`[^`]+`|\b[0-9a-f]{7,40}\b|https?://|\.(ts|py|md|rs|tsx|js|sql)\b", item_text))
            if not has_citation:
                self._fail("Evidence pack", f"Item {i} appears to lack a citation (expected `path:line` | `symbol` | sha | URL).", kind="warning")

    def check_advisor_sections(self):
        for advisor in ADVISORS:
            body = self._section_body(rf"^Advisor:\s+{re.escape(advisor)}$")
            if body is None:
                self._fail(f"Advisor: {advisor}", f"Missing '### Advisor: {advisor}' section.")
                continue
            for marker in ADVISOR_REQUIRED_MARKERS:
                if marker not in body:
                    self._fail(f"Advisor: {advisor}", f"Missing required marker: {marker}")
            # Evidence anchored must have ≥2 bullet items.
            ea_match = re.search(r"\*\*Evidence anchored:\*\*(.*?)(?=\n\*\*|\Z)", body, re.DOTALL)
            if ea_match:
                bullets = re.findall(r"^-\s+.+", ea_match.group(1), re.MULTILINE)
                if len(bullets) < 2:
                    self._fail(f"Advisor: {advisor}", f"Evidence anchored has {len(bullets)} items; minimum is 2.")
            # Executor-specific markers.
            if advisor == "Executor":
                for marker in EXECUTOR_EXTRA_MARKERS:
                    if marker not in body:
                        self._fail("Advisor: Executor", f"Missing required marker: {marker}")
                self.check_executor_single_action(body)

    def check_executor_single_action(self, body: str):
        """The action must be exactly one paragraph, not a numbered or bulleted list."""
        m = re.search(r"\*\*The action \(one\):\*\*(.+?)(?=\n\*\*|\Z)", body, re.DOTALL)
        if not m:
            return
        action_body = m.group(1).strip()
        numbered = re.findall(r"^\s*\d+\.\s+", action_body, re.MULTILINE)
        bulleted = re.findall(r"^\s*[-*]\s+", action_body, re.MULTILINE)
        if len(numbered) > 1:
            self._fail("Advisor: Executor",
                       f"'The action (one)' contains {len(numbered)} numbered items; exactly one action required.")
        if len(bulleted) > 1:
            self._fail("Advisor: Executor",
                       f"'The action (one)' contains {len(bulleted)} bulleted items; exactly one action required.")

    def check_peer_reviews(self):
        for reviewer, reviewee in PEER_REVIEW_ROTATION:
            header_re = rf"^{re.escape(reviewer)} reviewing {re.escape(reviewee)}$"
            body = self._section_body(header_re)
            if body is None:
                self._fail("Peer review",
                           f"Missing peer review section: '### {reviewer} reviewing {reviewee}'.")
                continue
            for marker in PEER_REVIEW_REQUIRED_MARKERS:
                if marker not in body:
                    self._fail(f"{reviewer} reviewing {reviewee}",
                               f"Missing required marker: {marker}")
            # Gate lines must each appear with PASS or FAIL.
            for gate in PEER_REVIEW_GATES:
                gate_re = rf"-\s+{re.escape(gate)}:\s+(PASS|FAIL)\s+—\s+.+"
                if not re.search(gate_re, body):
                    self._fail(f"{reviewer} reviewing {reviewee}",
                               f"Gate '{gate}' missing or malformed. Expected: '- {gate}: PASS|FAIL — <evidence>'.")
            # Disposition must be one of Accept / Modify / Reject.
            disp_match = re.search(r"\*\*Disposition:\*\*\s+(Accept|Modify|Reject)\b", body)
            if not disp_match:
                self._fail(f"{reviewer} reviewing {reviewee}",
                           "Disposition must be one of: Accept | Modify | Reject.")

    def check_convergence_section(self):
        body = self._section_body(r"^Phase 2\.5\s*[—-]\s*Convergence check$")
        if body is None:
            self._fail("Phase 2.5", "Missing '## Phase 2.5 — Convergence check' section.")

    def check_chairman_verdict(self):
        body = self._section_body(r"^Phase 3\s*[—-]\s*Chairman['’]s verdict$")
        if body is None:
            self._fail("Phase 3", "Missing '## Phase 3 — Chairman's verdict' section.")
            return
        for marker in CHAIRMAN_REQUIRED_SUBSECTIONS:
            if marker not in body:
                self._fail("Phase 3", f"Missing required subsection: {marker}")
        # Gate summary table must reference all five advisors.
        for advisor in ADVISORS:
            if advisor not in body:
                self._fail("Phase 3", f"Gate summary table missing row for: {advisor}")
        # Next 60-minute action must have non-empty body.
        action_match = re.search(r"###\s+Next 60-minute action\s*\n(.+?)(?=\n###|\Z)", body, re.DOTALL)
        if action_match and len(action_match.group(1).strip()) < 15:
            self._fail("Phase 3", "Next 60-minute action is empty or too short to be actionable.")
        # Confidence must be low/medium/high.
        conf_match = re.search(r"###\s+Confidence\s*\n(.+?)(?=\n###|\Z)", body, re.DOTALL)
        if conf_match:
            conf_text = conf_match.group(1).strip().lower()
            if not any(level in conf_text for level in ["low", "medium", "high"]):
                self._fail("Phase 3", "Confidence must be one of: low | medium | high.")

    # ─── entry ──────────────────────────────────────────────────────────────

    def validate(self, phase: int | None = None) -> list[Violation]:
        """Run structural checks. If `phase` is given, only check sections
        that should exist by the end of that phase:
          phase=0 → H1 + evidence pack only
          phase=1 → +5 advisor sections
          phase=2 → +5 peer reviews
          phase=3 (or None) → +convergence + chairman (full output)
        """
        if phase is None:
            phase = 3
        self.check_top_header()
        self.check_evidence_pack()
        if phase >= 1:
            self.check_advisor_sections()
        if phase >= 2:
            self.check_peer_reviews()
        if phase >= 3:
            self.check_convergence_section()
            self.check_chairman_verdict()
        return self.violations


def detect_phase(md: str) -> int:
    """Best-effort detection of which phase a partial file represents.

    Returns 0..3 based on which sections are present:
      - Phase 3 header → 3 (assume full output)
      - Any peer-review section header → 2
      - Any '### Advisor:' header → 1
      - Otherwise → 0 (just evidence pack)

    Authors typically build the file phase-by-phase; this lets the validator
    match the author's actual progress instead of failing on missing sections
    that legitimately don't exist yet.
    """
    # Use the same fence-aware scan logic as Validator._section_body would.
    header_re = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
    in_fence = False
    has_phase3 = False
    has_phase2 = False
    has_phase1 = False
    for line in md.split("\n"):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = header_re.match(line)
        if not m:
            continue
        title = m.group(2).strip()
        if re.match(r"^Phase 3\b", title):
            has_phase3 = True
        elif "reviewing" in title and any(a in title for a in ADVISORS):
            has_phase2 = True
        elif title.startswith("Advisor:"):
            has_phase1 = True
    if has_phase3:
        return 3
    if has_phase2:
        return 2
    if has_phase1:
        return 1
    return 0


def report(violations: list[Violation], as_json: bool = False) -> str:
    if as_json:
        return json.dumps({
            "valid": not any(v.kind == "structural" for v in violations),
            "violations": [asdict(v) for v in violations],
        }, indent=2)
    if not violations:
        return "✅ Council output is structurally valid."
    lines = [f"❌ {len(violations)} violation(s) found:"]
    for v in violations:
        prefix = {"structural": "FAIL", "semantic": "SEMA", "warning": "WARN"}.get(v.kind, "????")
        lines.append(f"  [{prefix}] {v.section}: {v.message}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Validate a Council run output (full or partial).",
        epilog=(
            "Use --phase N to validate a partial file that hasn't reached Phase 3 yet:\n"
            "  --phase 0  → only H1 + evidence pack (use after writing phase0.md)\n"
            "  --phase 1  → also 5 advisor sections\n"
            "  --phase 2  → also 5 peer reviews\n"
            "  (no flag)  → full output (default; auto-detects partial files and suggests --phase)"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("path", help="Path to the markdown to validate.")
    parser.add_argument("--json", action="store_true", help="Emit JSON report on stdout.")
    parser.add_argument("--strict", action="store_true", help="Fail on warnings, not just structural errors.")
    parser.add_argument(
        "--phase",
        type=int,
        choices=[0, 1, 2, 3],
        default=None,
        help="Partial-validation mode. Without this flag, validates the full output (Phase 3).",
    )
    parser.add_argument(
        "--auto-detect",
        action="store_true",
        help="Auto-detect phase from file contents and validate up to that phase. Useful for in-progress files.",
    )
    args = parser.parse_args()

    path = Path(args.path)
    if not path.exists():
        print(f"❌ File not found: {path}", file=sys.stderr)
        sys.exit(1)

    md = path.read_text()
    requested_phase = args.phase

    # If user passed nothing AND the file has no Phase 3 header, surface a
    # helpful message instead of dumping a wall of "missing section" errors.
    if requested_phase is None and not args.auto_detect:
        detected = detect_phase(md)
        if detected < 3:
            phase_names = {0: "evidence pack only", 1: "through Phase 1 (advisors)", 2: "through Phase 2 (peer reviews)"}
            print(
                f"⚠️  Detected partial file (highest section present: phase {detected} — "
                f"{phase_names.get(detected, 'unknown')}).\n"
                f"   Validating with --phase {detected} so missing downstream sections don't drown out real issues.\n"
                f"   Pass --phase 3 (or wait until output.md is fully assembled) to enforce full structure.\n",
                file=sys.stderr,
            )
            requested_phase = detected

    if args.auto_detect:
        requested_phase = detect_phase(md)

    v = Validator(md)
    violations = v.validate(phase=requested_phase)
    print(report(violations, as_json=args.json))

    structural = [x for x in violations if x.kind == "structural"]
    warnings = [x for x in violations if x.kind == "warning"]
    if structural:
        sys.exit(1)
    if args.strict and warnings:
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
