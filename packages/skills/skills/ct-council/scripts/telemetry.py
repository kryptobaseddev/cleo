#!/usr/bin/env python3
"""
telemetry.py — extract one JSONL record from a Council run output.

Reads a council-output.md, validates it (using validate.py), and emits a
single JSON record describing the run: question, per-advisor gate-pass
rates, peer-review disposition distribution, convergence flag, Chairman
confidence, evidence-pack size, and (optional) externally-supplied
tokens / wall-clock metrics.

Usage:
  # Emit JSON to stdout (do not append to log).
  python3 telemetry.py <output.md>

  # Append one JSON line to .cleo/council-runs.jsonl (default log path).
  python3 telemetry.py --append <output.md>

  # Append to a specific log path.
  python3 telemetry.py --log path/to/runs.jsonl <output.md>

  # Stamp tokens / wall-clock from the orchestrator.
  python3 telemetry.py --tokens 41250 --wall-clock 73.4 --append <output.md>

Exit codes:
  0 — record emitted successfully
  1 — validation failed (no record emitted)
  2 — file not found / unreadable
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

# Re-use the validator's helpers — single source of truth for parsing.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate import (  # noqa: E402
    ADVISORS,
    PEER_REVIEW_ROTATION,
    PEER_REVIEW_GATES,
    Validator,
)


SCHEMA_VERSION = "1.0.0"
DEFAULT_LOG_PATH = Path(".cleo/council-runs.jsonl")

GATE_KEYS = ["G1", "G2", "G3", "G4"]


@dataclass
class AdvisorRecord:
    gates: dict[str, str] = field(default_factory=dict)  # G1..G4 → PASS|FAIL
    gate_pass_count: int = 0
    weight: str = "low"  # full | high | moderate | low
    sharpest: str | None = None
    reviewer: str | None = None  # who graded this advisor


@dataclass
class PeerReviewRecord:
    reviewer: str
    reviewee: str
    disposition: str | None = None  # Accept | Modify | Reject
    gates_passed: int = 0


@dataclass
class TelemetryRecord:
    schema_version: str
    run_id: str
    timestamp: str
    question: str
    validation: dict
    evidence_pack: dict
    advisors: dict[str, dict]
    peer_reviews: list[dict]
    convergence: dict
    chairman: dict
    metrics: dict


# ─── helpers (mirror validate.py's line-based, fence-aware section scan) ────

_HEADER_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


def _section_body(md: str, header_regex: str) -> str | None:
    """Body under the first header matching header_regex; ignores ``` fences."""
    lines = md.split("\n")
    in_fence = False
    start_line: int | None = None
    start_level: int | None = None
    end_line = len(lines)

    for i, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _HEADER_RE.match(line)
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


def _weight_from_pass_count(n: int) -> str:
    if n == 4:
        return "full"
    if n == 3:
        return "high"
    if n == 2:
        return "moderate"
    return "low"


def _extract_question(md: str) -> str:
    m = re.search(r"^#\s+The Council\s+—\s+(.+)$", md, re.MULTILINE)
    return m.group(1).strip() if m else ""


def _extract_evidence_pack(md: str) -> dict:
    body = _section_body(md, r"^Evidence pack$")
    if body is None:
        return {"count": 0, "has_llmtxt": False}
    items = re.findall(
        r"^\s*\d+\.\s+(.+?)(?=^\s*\d+\.\s+|\Z)", body, re.MULTILINE | re.DOTALL
    )
    has_llmtxt = any("llmtxt:" in item for item in items)
    return {"count": len(items), "has_llmtxt": has_llmtxt}


def _extract_sharpest(advisor_body: str) -> str | None:
    m = re.search(
        r"\*\*Single sharpest point:\*\*\s*(.+?)(?=\n\*\*|\Z)",
        advisor_body,
        re.DOTALL,
    )
    if not m:
        return None
    return m.group(1).strip().splitlines()[0].strip() if m.group(1).strip() else None


def _extract_peer_review(md: str, reviewer: str, reviewee: str) -> PeerReviewRecord:
    pr = PeerReviewRecord(reviewer=reviewer, reviewee=reviewee)
    body = _section_body(md, rf"^{re.escape(reviewer)} reviewing {re.escape(reviewee)}$")
    if body is None:
        return pr

    # Gate parsing: tolerate both "G1 Rigor" and the full label.
    for key, full in zip(GATE_KEYS, PEER_REVIEW_GATES):
        gate_re = rf"-\s+{re.escape(full)}:\s+(PASS|FAIL)\s+—"
        m = re.search(gate_re, body)
        if m:
            pr.__dict__.setdefault("gates", {})[key] = m.group(1)
            if m.group(1) == "PASS":
                pr.gates_passed += 1

    disp_match = re.search(r"\*\*Disposition:\*\*\s+(Accept|Modify|Reject)\b", body)
    if disp_match:
        pr.disposition = disp_match.group(1)

    return pr


def _extract_advisor(md: str, advisor: str) -> AdvisorRecord:
    rec = AdvisorRecord()
    body = _section_body(md, rf"^Advisor:\s+{re.escape(advisor)}$")
    if body is None:
        return rec
    rec.sharpest = _extract_sharpest(body)
    return rec


def _annotate_advisor_with_gates(rec: AdvisorRecord, pr: PeerReviewRecord) -> None:
    """Attach the peer-review gate verdicts (the reviewee's gates) onto the advisor."""
    rec.reviewer = pr.reviewer
    gates_map: dict[str, str] = pr.__dict__.get("gates", {})
    for gate_key in GATE_KEYS:
        rec.gates[gate_key] = gates_map.get(gate_key, "MISSING")
    rec.gate_pass_count = sum(1 for v in rec.gates.values() if v == "PASS")
    rec.weight = _weight_from_pass_count(rec.gate_pass_count)


def _extract_convergence(md: str) -> dict:
    body = _section_body(md, r"^Phase 2\.5\s*[—-]\s*Convergence check$")
    if body is None:
        return {"flag": None, "rerun_advisors": []}
    text = body.lower()
    # Heuristic: "convergence flag" + a positive verb. Authors typically write
    # "convergence flag raised" or "no convergence flag".
    raised = bool(re.search(r"\bconvergence\b.*\b(raised|fired|triggered)\b", text))
    cleared = bool(re.search(r"\bno convergence\b|\bproceeding to phase 3\b|\bdistinct subjects\b", text))
    flag = True if (raised and not cleared) else (False if cleared else None)
    rerun = re.findall(r"reran\s+(\w[\w \-]*?)\b", text)
    return {"flag": flag, "rerun_advisors": [r.strip() for r in rerun]}


def _extract_chairman(md: str) -> dict:
    body = _section_body(md, r"^Phase 3\s*[—-]\s*Chairman['’]s verdict$")
    if body is None:
        return {
            "confidence": None,
            "recommendation_present": False,
            "next_action_present": False,
            "open_questions_count": 0,
        }
    rec_match = re.search(r"###\s+Recommendation\s*\n(.+?)(?=\n###|\Z)", body, re.DOTALL)
    rec_present = bool(rec_match and rec_match.group(1).strip())

    action_match = re.search(r"###\s+Next 60-minute action\s*\n(.+?)(?=\n###|\Z)", body, re.DOTALL)
    action_present = bool(action_match and len(action_match.group(1).strip()) >= 15)

    conf = None
    conf_match = re.search(r"###\s+Confidence\s*\n(.+?)(?=\n###|\Z)", body, re.DOTALL)
    if conf_match:
        conf_text = conf_match.group(1).strip().lower()
        # Order matters: medium-high before high.
        for level in ("medium-high", "medium-low", "high", "medium", "low"):
            if level in conf_text:
                conf = level
                break

    open_q_match = re.search(r"###\s+Open questions for the owner\s*\n(.+?)(?=\n###|\Z)", body, re.DOTALL)
    open_q_count = 0
    if open_q_match:
        open_q_count = len(re.findall(r"^\s*[-*]\s+", open_q_match.group(1), re.MULTILINE))

    return {
        "confidence": conf,
        "recommendation_present": rec_present,
        "next_action_present": action_present,
        "open_questions_count": open_q_count,
    }


# ─── public API ─────────────────────────────────────────────────────────────


def extract_record(
    md: str,
    *,
    source_path: str | None = None,
    tokens: int | None = None,
    wall_clock: float | None = None,
    extra: dict | None = None,
) -> TelemetryRecord:
    v = Validator(md)
    violations = v.validate()
    structural = sum(1 for x in violations if x.kind == "structural")
    warnings = sum(1 for x in violations if x.kind == "warning")

    question = _extract_question(md)
    ep = _extract_evidence_pack(md)

    advisors: dict[str, AdvisorRecord] = {a: _extract_advisor(md, a) for a in ADVISORS}

    peer_reviews: list[PeerReviewRecord] = []
    for reviewer, reviewee in PEER_REVIEW_ROTATION:
        pr = _extract_peer_review(md, reviewer, reviewee)
        peer_reviews.append(pr)
        _annotate_advisor_with_gates(advisors[reviewee], pr)

    convergence = _extract_convergence(md)
    chairman = _extract_chairman(md)

    payload = md.encode("utf-8")
    run_id = hashlib.sha256(payload).hexdigest()[:16]

    record = TelemetryRecord(
        schema_version=SCHEMA_VERSION,
        run_id=run_id,
        timestamp=_dt.datetime.now(tz=_dt.timezone.utc).isoformat(timespec="seconds"),
        question=question,
        validation={
            "valid": structural == 0,
            "structural_violations": structural,
            "warnings": warnings,
        },
        evidence_pack=ep,
        advisors={
            name: {
                "gates": rec.gates,
                "gate_pass_count": rec.gate_pass_count,
                "weight": rec.weight,
                "sharpest": rec.sharpest,
                "reviewer": rec.reviewer,
            }
            for name, rec in advisors.items()
        },
        peer_reviews=[
            {
                "reviewer": pr.reviewer,
                "reviewee": pr.reviewee,
                "disposition": pr.disposition,
                "gates_passed": pr.gates_passed,
            }
            for pr in peer_reviews
        ],
        convergence=convergence,
        chairman=chairman,
        metrics={
            "tokens": tokens,
            "wall_clock_seconds": wall_clock,
            "evidence_pack_count": ep["count"],
            "source_path": source_path,
            "size_bytes": len(payload),
            **(extra or {}),
        },
    )
    return record


def append_jsonl(record: TelemetryRecord, log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(asdict(record), ensure_ascii=False) + "\n")


# ─── Verdict + TL;DR generation (post-shakedown UX fix) ─────────────────────
#
# The full output.md (Phase 0 + 5 advisors + 5 peer reviews + 2.5 + 3) is the
# audit trail — ~300-400 lines. The owner consumes the *Chairman verdict*,
# which is the last ~60 lines. Forcing the reader to scroll through the full
# transcript to reach the recommendation is a UX failure, not a content
# problem.
#
# These functions extract two leaner deliverables from a validated output.md:
#   - verdict.md — the Chairman section with the question prepended (~60-80 lines)
#   - tldr.md    — recommendation + action + confidence (~10-15 lines)
# The full output.md is preserved as-is for the audit trail.


def _extract_chairman_section(md: str) -> str | None:
    """Return the literal Phase 3 markdown body (everything under '## Phase 3 — ...')."""
    body = _section_body(md, r"^Phase 3\s*[—-]\s*Chairman['’]s verdict$")
    return body


def _extract_phase3_subsection(body: str, header: str) -> str | None:
    """Pull a specific `### <header>` subsection's body from a Phase 3 body."""
    m = re.search(
        rf"###\s+{re.escape(header)}\s*\n(.+?)(?=\n###|\Z)",
        body,
        re.DOTALL,
    )
    if not m:
        return None
    return m.group(1).strip()


def render_verdict(md: str) -> str:
    """Render verdict.md from a full output.md — Chairman section + question header.

    Output is structurally a standalone decision document: H1 question, gate
    summary, recommendation, conditions, action, confidence. Suitable for
    direct hand-off to the owner without scrolling past upstream artifacts.
    """
    question = _extract_question(md) or "<question missing>"
    chairman = _extract_chairman_section(md)
    if chairman is None:
        raise ValueError("output.md missing Phase 3 — Chairman's verdict section")
    return f"# Council Verdict — {question}\n\n## Phase 3 — Chairman's verdict\n{chairman.rstrip()}\n"


def render_tldr(md: str) -> str:
    """Render tldr.md — 10-15 line summary suitable for PR comments / chat.

    Pulls only the load-bearing fields: recommendation, next action, confidence,
    and a count of open questions / conditions. Not a substitute for the full
    verdict — a *pointer* to it.
    """
    question = _extract_question(md) or "<question missing>"
    chairman_body = _extract_chairman_section(md) or ""

    rec = _extract_phase3_subsection(chairman_body, "Recommendation") or "<missing>"
    action = _extract_phase3_subsection(chairman_body, "Next 60-minute action") or "<missing>"
    conf = _extract_phase3_subsection(chairman_body, "Confidence") or "<missing>"
    conditions = _extract_phase3_subsection(chairman_body, "Conditions on the recommendation") or ""
    open_q = _extract_phase3_subsection(chairman_body, "Open questions for the owner") or ""

    # Trim each to a single first paragraph / line for concision.
    rec_first = _first_paragraph(rec)
    action_first = _first_paragraph(action)
    # Confidence: just the level (first word) + first clause, not the full justification.
    conf_level_match = re.match(r"\s*(medium-high|medium-low|high|medium|low)\b", conf, re.IGNORECASE)
    if conf_level_match:
        conf_first = conf_level_match.group(1).lower()
    else:
        conf_first = _first_paragraph(conf)[:80]

    cond_count = len(re.findall(r"^\s*\d+\.\s+", conditions, re.MULTILINE))
    open_q_count = len(re.findall(r"^\s*\d+\.\s+|^\s*[-*]\s+", open_q, re.MULTILINE))
    open_q_marker = "none" if (not open_q.strip() or "none" in open_q.lower()[:80]) else f"{open_q_count}"

    lines = [
        f"# Council TL;DR — {question}",
        "",
        f"**Recommendation** — {rec_first}",
        "",
        f"**Next 60-minute action** — {action_first}",
        "",
        f"**Confidence** — {conf_first}",
        "",
        f"**Conditions:** {cond_count}  ·  **Open questions:** {open_q_marker}",
        "",
        "_Full verdict: `verdict.md` · Full transcript: `output.md`_",
        "",
    ]
    return "\n".join(lines)


# ─── Phase 2.5 structured extractor (T-shakedown-1 verdict) ─────────────────
#
# The Phase 2.5 convergence detector currently emits free prose; downstream
# telemetry has to grep regex (`_extract_convergence` above). This extractor
# replaces that with a structured artifact built directly from the per-advisor
# `phase1-<advisor>.md` files in a run directory, before output.md is even
# assembled. Output schema:
#
#   {
#     "schema_version": "...",
#     "run_id": "<8-char from run.json>",
#     "sharpest_points": [{"advisor": str, "sentence": str}, ...],
#     "pairwise_same":   [[i, j], ...],
#     "flag_mechanical": bool,
#     "method": "exact-normalized | jaccard>=0.6 | 3-clique"
#   }
#
# `flag_mechanical=True` iff a 3-clique exists in the pairwise-same graph —
# matching the protocol's "≥3 semantically the same finding" rule.

PHASE_2_5_SCHEMA_VERSION = "1.0.0"
JACCARD_THRESHOLD = 0.6

ADVISOR_FILE_SLUGS = {
    "Contrarian": "contrarian",
    "First Principles": "first-principles",
    "Expansionist": "expansionist",
    "Outsider": "outsider",
    "Executor": "executor",
}


def _normalize_sentence(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def _tokenize(s: str) -> set[str]:
    """Token bag for Jaccard — lowercase, alphanum, words ≥3 chars to drop noise."""
    return {t.lower() for t in re.findall(r"\w+", s) if len(t) >= 3}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _has_3_clique(pairs: list[list[int]], n: int) -> bool:
    """Detect a 3-clique in the undirected same-finding graph."""
    edges = {(min(i, j), max(i, j)) for i, j in pairs}
    for i in range(n):
        for j in range(i + 1, n):
            if (i, j) not in edges:
                continue
            for k in range(j + 1, n):
                if (i, k) in edges and (j, k) in edges:
                    return True
    return False


def _read_sharpest(run_dir: Path, advisor: str) -> str | None:
    """Locate the advisor's `**Single sharpest point:**` marker at the start of a line.

    Anchoring on `^` is load-bearing — the marker text can appear inline inside
    other sections (e.g. the Executor's action body referencing the marker as a
    parse target). The persona's output template always places the marker at
    the start of its own line, so a multiline-mode start-of-line anchor
    distinguishes the structural marker from inline mentions.
    """
    slug = ADVISOR_FILE_SLUGS[advisor]
    p = run_dir / f"phase1-{slug}.md"
    if not p.exists():
        return None
    body = p.read_text()
    m = re.search(
        r"^\*\*Single sharpest point:\*\*\s*(.+?)(?=\n\*\*|\n##|\Z)",
        body,
        re.DOTALL | re.MULTILINE,
    )
    if not m:
        return None
    return _first_paragraph(m.group(1))


def _first_paragraph(s: str) -> str:
    parts = [p.strip() for p in s.strip().split("\n\n") if p.strip()]
    if not parts:
        return s.strip()
    return re.sub(r"\s+", " ", parts[0])


def extract_phase_2_5(run_dir: Path) -> dict:
    """Read phase1-*.md files in run_dir, compute structured Phase-2.5 verdict."""
    run_meta_path = run_dir / "run.json"
    run_id = None
    if run_meta_path.exists():
        try:
            run_id = json.loads(run_meta_path.read_text()).get("run_id")
        except json.JSONDecodeError:
            run_id = None

    sharpest_points: list[dict] = []
    for advisor in ADVISORS:
        sentence = _read_sharpest(run_dir, advisor)
        sharpest_points.append({"advisor": advisor, "sentence": sentence or ""})

    n = len(sharpest_points)
    norm_strings = [_normalize_sentence(p["sentence"]) for p in sharpest_points]
    token_sets = [_tokenize(p["sentence"]) for p in sharpest_points]

    pairwise: list[list[int]] = []
    pair_methods: dict[tuple[int, int], str] = {}
    for i in range(n):
        for j in range(i + 1, n):
            if not norm_strings[i] or not norm_strings[j]:
                continue
            if norm_strings[i] == norm_strings[j]:
                pairwise.append([i, j])
                pair_methods[(i, j)] = "exact-normalized"
                continue
            score = _jaccard(token_sets[i], token_sets[j])
            if score >= JACCARD_THRESHOLD:
                pairwise.append([i, j])
                pair_methods[(i, j)] = f"jaccard={score:.2f}"

    flag_mechanical = _has_3_clique(pairwise, n)

    return {
        "schema_version": PHASE_2_5_SCHEMA_VERSION,
        "run_id": run_id,
        "run_dir": str(run_dir),
        "sharpest_points": sharpest_points,
        "pairwise_same": pairwise,
        "pair_methods": {f"{i},{j}": m for (i, j), m in pair_methods.items()},
        "flag_mechanical": flag_mechanical,
        "jaccard_threshold": JACCARD_THRESHOLD,
        "missing_advisors": [
            sp["advisor"] for sp in sharpest_points if not sp["sentence"]
        ],
    }


def main():
    parser = argparse.ArgumentParser(description="Emit telemetry from a Council run output.")
    parser.add_argument("path", help="Path to the Council run markdown OR — with --phase-2-5 — a run directory.")
    parser.add_argument("--append", action="store_true", help="Append to the JSONL log (default off — stdout only).")
    parser.add_argument("--log", default=str(DEFAULT_LOG_PATH), help=f"JSONL log path (default: {DEFAULT_LOG_PATH}).")
    parser.add_argument("--tokens", type=int, default=None, help="Total tokens consumed (orchestrator-supplied).")
    parser.add_argument("--wall-clock", type=float, default=None, help="Wall-clock seconds (orchestrator-supplied).")
    parser.add_argument("--allow-invalid", action="store_true", help="Emit a record even if validation fails.")
    parser.add_argument("--phase-2-5", action="store_true", help="Treat <path> as a run directory; emit structured Phase 2.5 verdict (sharpest points + pairwise-same + clique flag) to stdout. No JSONL append in this mode.")
    args = parser.parse_args()

    path = Path(args.path)
    if not path.exists():
        print(f"❌ Path not found: {path}", file=sys.stderr)
        sys.exit(2)

    if args.phase_2_5:
        if not path.is_dir():
            print(f"❌ --phase-2-5 expects a run directory, got: {path}", file=sys.stderr)
            sys.exit(2)
        verdict = extract_phase_2_5(path)
        print(json.dumps(verdict, ensure_ascii=False, indent=2))
        return

    md = path.read_text()
    record = extract_record(
        md,
        source_path=str(path),
        tokens=args.tokens,
        wall_clock=args.wall_clock,
    )

    if not record.validation["valid"] and not args.allow_invalid:
        print(
            f"❌ Validation failed ({record.validation['structural_violations']} violations). "
            f"Run validate.py for details, or pass --allow-invalid to log anyway.",
            file=sys.stderr,
        )
        sys.exit(1)

    json_str = json.dumps(asdict(record), ensure_ascii=False, indent=2)
    print(json_str)

    if args.append:
        append_jsonl(record, Path(args.log))
        print(f"📊 Appended one record to {args.log}", file=sys.stderr)


if __name__ == "__main__":
    main()
