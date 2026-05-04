"""Tests for telemetry.py and analyze_runs.py."""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
FIXTURES = SCRIPTS_DIR / "fixtures"

sys.path.insert(0, str(SCRIPTS_DIR))
import telemetry  # noqa: E402
import analyze_runs  # noqa: E402


def load_fixture(name: str) -> str:
    return (FIXTURES / name).read_text()


class TestTelemetryExtractValidFixture(unittest.TestCase):
    """Telemetry on the canonical valid.md fixture."""

    @classmethod
    def setUpClass(cls):
        cls.md = load_fixture("valid.md")
        cls.record = telemetry.extract_record(cls.md)
        cls.payload = json.loads(json.dumps(telemetry.asdict(cls.record), default=str))

    def test_schema_version(self):
        self.assertEqual(self.payload["schema_version"], telemetry.SCHEMA_VERSION)

    def test_validation_passes(self):
        self.assertTrue(self.payload["validation"]["valid"])
        self.assertEqual(self.payload["validation"]["structural_violations"], 0)

    def test_question_extracted(self):
        self.assertIn("retry-on-timeout", self.payload["question"])

    def test_evidence_pack_count(self):
        self.assertEqual(self.payload["evidence_pack"]["count"], 3)
        self.assertFalse(self.payload["evidence_pack"]["has_llmtxt"])

    def test_all_five_advisors_present(self):
        for advisor in telemetry.ADVISORS:
            self.assertIn(advisor, self.payload["advisors"])

    def test_each_advisor_has_four_gate_results(self):
        for advisor, body in self.payload["advisors"].items():
            with self.subTest(advisor=advisor):
                self.assertEqual(set(body["gates"].keys()), {"G1", "G2", "G3", "G4"})
                for gate, verdict in body["gates"].items():
                    self.assertIn(verdict, ("PASS", "FAIL", "MISSING"))

    def test_advisors_get_full_weight_when_4_of_4(self):
        for advisor, body in self.payload["advisors"].items():
            self.assertEqual(body["gate_pass_count"], 4)
            self.assertEqual(body["weight"], "full")

    def test_each_advisor_has_a_reviewer(self):
        # Per the fixed rotation, every advisor is the reviewee of exactly one peer.
        for advisor, body in self.payload["advisors"].items():
            self.assertIsNotNone(body["reviewer"])

    def test_sharpest_points_extracted(self):
        for advisor, body in self.payload["advisors"].items():
            self.assertIsNotNone(body["sharpest"])
            self.assertGreater(len(body["sharpest"]), 0)

    def test_peer_reviews_match_rotation(self):
        prs = self.payload["peer_reviews"]
        pairs = [(p["reviewer"], p["reviewee"]) for p in prs]
        self.assertEqual(pairs, list(telemetry.PEER_REVIEW_ROTATION))

    def test_all_peer_reviews_have_disposition(self):
        for pr in self.payload["peer_reviews"]:
            self.assertIn(pr["disposition"], ("Accept", "Modify", "Reject"))

    def test_convergence_flag_cleared(self):
        # The fixture explicitly says "no convergence flag".
        self.assertEqual(self.payload["convergence"]["flag"], False)

    def test_chairman_confidence_high(self):
        self.assertEqual(self.payload["chairman"]["confidence"], "high")

    def test_chairman_recommendation_and_action_present(self):
        self.assertTrue(self.payload["chairman"]["recommendation_present"])
        self.assertTrue(self.payload["chairman"]["next_action_present"])


class TestTelemetryExtractWithLlmtxt(unittest.TestCase):
    def test_llmtxt_flag_set_when_evidence_pack_uses_it(self):
        md = load_fixture("valid_with_llmtxt.md")
        rec = telemetry.extract_record(md)
        payload = json.loads(json.dumps(telemetry.asdict(rec), default=str))
        self.assertTrue(payload["evidence_pack"]["has_llmtxt"])


class TestTelemetryHandlesInvalid(unittest.TestCase):
    def test_invalid_record_marks_validation_false(self):
        md = load_fixture("missing_advisor.md")
        rec = telemetry.extract_record(md)
        self.assertFalse(rec.validation["valid"])
        self.assertGreater(rec.validation["structural_violations"], 0)

    def test_thin_evidence_pack_flagged(self):
        md = load_fixture("thin_evidence.md")
        rec = telemetry.extract_record(md)
        self.assertFalse(rec.validation["valid"])
        self.assertLess(rec.evidence_pack["count"], 3)


class TestSyntheticGateFails(unittest.TestCase):
    """Synthesize an output with a deliberate gate FAIL on a target peer review."""

    def _replace_gate_in_review(self, md: str, reviewer: str, reviewee: str, gate: str, new_verdict: str) -> str:
        """Replace `- <gate>: PASS|FAIL` inside the section `### <reviewer> reviewing <reviewee>`."""
        marker = f"### {reviewer} reviewing {reviewee}"
        idx = md.index(marker)
        # Find the next gate line within this section's body.
        line_marker = f"- {gate}: PASS"
        # Search from `idx`.
        rel = md.find(line_marker, idx)
        assert rel != -1, f"Did not find {line_marker!r} after {marker!r}"
        return md[:rel] + f"- {gate}: {new_verdict}" + md[rel + len(line_marker):]

    def test_synthetic_fail_propagates_to_advisor_record(self):
        md = self._replace_gate_in_review(
            load_fixture("valid.md"),
            reviewer="Outsider",
            reviewee="Executor",
            gate="G1 Rigor",
            new_verdict="FAIL",
        )
        rec = telemetry.extract_record(md)
        # Outsider reviews Executor → Executor's G1 should now read FAIL.
        executor = rec.advisors["Executor"]
        self.assertEqual(executor["gates"]["G1"], "FAIL")
        self.assertEqual(executor["gate_pass_count"], 3)
        self.assertEqual(executor["weight"], "high")


class TestAnalyzeRuns(unittest.TestCase):
    def setUp(self):
        # Build a small synthetic JSONL with 3 runs: 1 clean, 1 gate-fail, 1 convergence-flagged.
        valid_md = load_fixture("valid.md")
        clean = telemetry.extract_record(valid_md)

        # Run 2: synthesize a FAIL on Executor's G1 by editing `Outsider reviewing Executor`.
        marker = "### Outsider reviewing Executor"
        idx = valid_md.index(marker)
        rel = valid_md.find("- G1 Rigor: PASS", idx)
        fail_md = valid_md[:rel] + "- G1 Rigor: FAIL" + valid_md[rel + len("- G1 Rigor: PASS"):]
        gate_fail = telemetry.extract_record(fail_md, tokens=42000, wall_clock=70.0)

        # Run 3: synthesize convergence flag raised.
        conv_md = valid_md.replace(
            "Distinct subjects: retry storms, idempotency, breaker wiring, ADR-precondition gap, test-first action. No convergence flag raised. Proceeding to Phase 3.",
            "All five sharpest points reduce to retry-storm risk. Convergence flag raised. Reran Contrarian.",
        )
        conv = telemetry.extract_record(conv_md, tokens=58000, wall_clock=110.0)

        self.records = [clean, gate_fail, conv]
        self.runs = [json.loads(json.dumps(telemetry.asdict(r), default=str)) for r in self.records]

    def test_gate_hotspots_finds_the_fail(self):
        rows = analyze_runs.gate_hotspots(self.runs)
        # The Executor G1 fail in run 2 should sit on top of the hotspot list.
        executor_g1 = [r for r in rows if r["advisor"] == "Executor" and r["gate"] == "G1"]
        self.assertEqual(len(executor_g1), 1)
        self.assertEqual(executor_g1[0]["fail"], 1)
        self.assertGreater(executor_g1[0]["fail_rate"], 0)

    def test_disposition_distribution_counts_correctly(self):
        disp = analyze_runs.disposition_distribution(self.runs)
        # 3 runs × 5 peer reviews = 15 total. All Accept in the source fixture.
        self.assertEqual(disp["overall"].get("Accept"), 15)

    def test_convergence_flag_detected(self):
        cv = analyze_runs.convergence_rate(self.runs)
        self.assertEqual(cv["raised"], 1)
        self.assertEqual(cv["cleared"], 2)

    def test_confidence_distribution(self):
        conf = analyze_runs.confidence_distribution(self.runs)
        self.assertEqual(conf["counts"].get("high"), 3)

    def test_cost_distribution_handles_partial_metrics(self):
        cost = analyze_runs.cost_distribution(self.runs)
        # Only runs 2 and 3 have tokens stamped.
        self.assertEqual(cost["tokens"]["n"], 2)

    def test_exit_criteria_token_spread_outside_20pct(self):
        report = analyze_runs.build_report(self.runs)
        ec = report["exit_criteria"]
        # 42000 vs 58000 → spread > 20%.
        self.assertFalse(ec["token_spread_within_20pct"])

    def test_exit_criteria_advisor_min_average(self):
        report = analyze_runs.build_report(self.runs)
        ec = report["exit_criteria"]
        # Executor avg = (4 + 3 + 4) / 3 = 3.67.
        self.assertGreaterEqual(ec["advisor_gate_avg"]["Executor"], 3.0)


class TestPhase25Extractor(unittest.TestCase):
    """Tests for the Phase 2.5 structured extractor (T-shakedown-1 verdict)."""

    def setUp(self):
        import tempfile, shutil
        self.tmpdir = Path(tempfile.mkdtemp(prefix="council-25-"))
        self.addCleanup(shutil.rmtree, self.tmpdir, ignore_errors=True)
        # Minimal run.json so run_id is preserved.
        (self.tmpdir / "run.json").write_text(json.dumps({"run_id": "abcd1234"}))

    def _write_phase1(self, slug: str, sharpest: str) -> None:
        body = (
            f"### Advisor: {slug.replace('-', ' ').title()}\n\n"
            "**Frame:** ...\n\n"
            "**Evidence anchored:**\n"
            "- foo — bar\n"
            "- baz — qux\n\n"
            "**Verdict from this lens:** ...\n\n"
            f"**Single sharpest point:** {sharpest}\n"
        )
        (self.tmpdir / f"phase1-{slug}.md").write_text(body)

    def test_extract_5_distinct_points_no_clique(self):
        # 5 distinct topics → no pairwise overlap, no clique.
        self._write_phase1("contrarian", "Retry storms cascade under upstream latency spikes.")
        self._write_phase1("first-principles", "Idempotency classification is the missing atomic truth.")
        self._write_phase1("expansionist", "Wire the dormant circuit breaker for system-wide resilience.")
        self._write_phase1("outsider", "ADR-021 says the precondition has been met for years.")
        self._write_phase1("executor", "Write a failing test that pins the GET-vs-POST retry contract.")
        verdict = telemetry.extract_phase_2_5(self.tmpdir)
        self.assertEqual(verdict["flag_mechanical"], False)
        self.assertEqual(verdict["pairwise_same"], [])
        self.assertEqual(verdict["missing_advisors"], [])
        self.assertEqual(verdict["run_id"], "abcd1234")

    def test_extract_3_clique_raises_flag(self):
        # 3 of 5 sentences are near-identical; all pairwise Jaccard ≥ 0.6 → clique → flag=True.
        self._write_phase1("contrarian", "Wire the dormant circuit breaker before retries land.")
        self._write_phase1("first-principles", "Wire the dormant circuit breaker before retries land in production.")
        self._write_phase1("expansionist", "Wire the dormant circuit breaker before retries land for safety.")
        self._write_phase1("outsider", "Completely unrelated observation about ADR drift over time.")
        self._write_phase1("executor", "Run a failing test next inside packages core.")
        verdict = telemetry.extract_phase_2_5(self.tmpdir)
        self.assertTrue(verdict["flag_mechanical"], f"Expected flag=True, got verdict: {verdict}")
        self.assertGreaterEqual(len(verdict["pairwise_same"]), 3)

    def test_anchor_distinguishes_inline_marker_from_structural_marker(self):
        """Regression test: the marker text inside a paragraph must NOT match.

        Specifically guards against the bug surfaced in shakedown #1, where the
        Executor's action body referenced `**Single sharpest point:**` as a
        parse target and the un-anchored regex matched the inline mention.
        """
        body = (
            "### Advisor: Executor\n\n"
            "**Frame:** ...\n\n"
            "**Evidence anchored:**\n"
            "- foo — bar\n"
            "- baz — qux\n\n"
            "**The action (one):** Add a parser that reads each `**Single sharpest point:**` line "
            "from per-advisor files and emits structured JSON for this run.\n\n"
            "**Expected outcome:** ...\n\n"
            "**Single sharpest point:** Ship the structured-output extractor.\n"
        )
        (self.tmpdir / "phase1-executor.md").write_text(body)
        # Other advisors absent — only Executor's sharpest is being tested.
        sharpest = telemetry._read_sharpest(self.tmpdir, "Executor")
        self.assertIsNotNone(sharpest)
        self.assertIn("Ship the structured-output extractor", sharpest)
        self.assertNotIn("Add a parser", sharpest)

    def test_missing_advisor_file_recorded(self):
        self._write_phase1("contrarian", "X.")
        self._write_phase1("first-principles", "Y.")
        # Three other phase1 files absent.
        verdict = telemetry.extract_phase_2_5(self.tmpdir)
        self.assertEqual(set(verdict["missing_advisors"]), {"Expansionist", "Outsider", "Executor"})

    def test_jaccard_threshold_respected(self):
        a = telemetry._tokenize("retry storms cascade under upstream latency spikes")
        b = telemetry._tokenize("retry storms cascade when upstream latency spikes happen")
        self.assertGreater(telemetry._jaccard(a, b), 0.6)
        c = telemetry._tokenize("idempotency classification atomic truth")
        d = telemetry._tokenize("circuit breaker resilience platform")
        self.assertLess(telemetry._jaccard(c, d), 0.6)

    def test_3_clique_detection_logic(self):
        # Pairs covering all 3 edges of vertices {0,1,2} → clique.
        self.assertTrue(telemetry._has_3_clique([[0, 1], [1, 2], [0, 2]], n=5))
        # Star pattern around vertex 0 → no triangle.
        self.assertFalse(telemetry._has_3_clique([[0, 1], [0, 2], [0, 3]], n=5))
        # Empty.
        self.assertFalse(telemetry._has_3_clique([], n=5))

    def test_extracts_real_shakedown_1_correctly(self):
        """Live regression: extract from the actual shakedown #1 run dir."""
        run_dir = SCRIPTS_DIR.parent / ".runs" / "20260425T023423Z-0f82cea9"
        if not run_dir.exists():
            self.skipTest("shakedown #1 run dir not present")
        verdict = telemetry.extract_phase_2_5(run_dir)
        self.assertEqual(verdict["flag_mechanical"], False)
        self.assertEqual(verdict["missing_advisors"], [])
        # Each sharpest point should be the full final sentence, not a truncated
        # fragment from the action body.
        executor_sentence = next(
            sp["sentence"] for sp in verdict["sharpest_points"] if sp["advisor"] == "Executor"
        )
        self.assertIn("--phase 2.5-extract", executor_sentence)
        self.assertTrue(executor_sentence.startswith("Within the hour"))


class TestVerdictAndTldrRendering(unittest.TestCase):
    """The Council emits THREE artifacts: verdict.md (the deliverable),
    tldr.md (for PR comments), output.md (audit trail). Tests that the lean
    deliverables extract correctly from a validated full output."""

    def setUp(self):
        self.md = load_fixture("valid.md")

    def test_verdict_has_question_header(self):
        v = telemetry.render_verdict(self.md)
        self.assertTrue(v.startswith("# Council Verdict — "))
        self.assertIn("retry-on-timeout", v)

    def test_verdict_contains_chairman_section(self):
        v = telemetry.render_verdict(self.md)
        self.assertIn("## Phase 3 — Chairman's verdict", v)
        self.assertIn("### Gate summary", v)
        self.assertIn("### Recommendation", v)
        self.assertIn("### Next 60-minute action", v)
        self.assertIn("### Confidence", v)

    def test_verdict_omits_upstream_phases(self):
        v = telemetry.render_verdict(self.md)
        # Should NOT contain the per-advisor sections or peer reviews.
        self.assertNotIn("### Advisor: Contrarian", v)
        self.assertNotIn("Contrarian reviewing First Principles", v)
        self.assertNotIn("## Phase 1 — Advisor analyses", v)
        self.assertNotIn("## Phase 2 — Shuffled peer reviews", v)

    def test_verdict_is_significantly_shorter_than_output(self):
        v_lines = telemetry.render_verdict(self.md).count("\n")
        full_lines = self.md.count("\n")
        # Verdict should be <40% of full output's line count.
        self.assertLess(v_lines, full_lines * 0.4,
                        f"Verdict {v_lines} lines vs full {full_lines} — should be much leaner")

    def test_tldr_has_question_header(self):
        t = telemetry.render_tldr(self.md)
        self.assertTrue(t.startswith("# Council TL;DR — "))

    def test_tldr_contains_load_bearing_fields(self):
        t = telemetry.render_tldr(self.md)
        self.assertIn("**Recommendation**", t)
        self.assertIn("**Next 60-minute action**", t)
        self.assertIn("**Confidence**", t)
        self.assertIn("Conditions:", t)

    def test_tldr_confidence_is_just_the_level(self):
        t = telemetry.render_tldr(self.md)
        # Should NOT contain the full confidence justification (e.g., "four independent frames converged").
        # Accept em-dash, en-dash, or hyphen as separator.
        m = re.search(r"\*\*Confidence\*\*\s*[—–\-]\s*(.+?)\n", t)
        self.assertIsNotNone(m, f"TLDR did not match Confidence pattern. Got:\n{t}")
        confidence_field = m.group(1).strip()
        # Must be short — just the level.
        self.assertLess(len(confidence_field), 30,
                        f"Confidence field too long: {confidence_field!r}")
        self.assertIn(confidence_field.lower(), ("low", "medium", "high", "medium-high", "medium-low"))

    def test_tldr_is_under_15_lines(self):
        t = telemetry.render_tldr(self.md)
        # Strictly bounded — TL;DR must fit in a chat message / PR comment.
        self.assertLess(t.count("\n"), 16, f"TL;DR too long:\n{t}")

    def test_tldr_points_to_full_artifacts(self):
        t = telemetry.render_tldr(self.md)
        self.assertIn("verdict.md", t)
        self.assertIn("output.md", t)

    def test_render_verdict_raises_on_missing_phase3(self):
        bad_md = load_fixture("missing_advisor.md")  # Has no Phase 3 properly.
        # missing_advisor.md may still have Phase 3 — use a synthetic md without it.
        no_phase3 = "# The Council — test\n\n## Evidence pack\n\n1. `foo` — bar\n"
        with self.assertRaises(ValueError):
            telemetry.render_verdict(no_phase3)


class TestAnalyzeRunsEdgeCases(unittest.TestCase):
    def test_empty_log_produces_empty_report(self):
        report = analyze_runs.build_report([])
        self.assertEqual(report["n_runs"], 0)
        self.assertEqual(report["gate_hotspots"], [])

    def test_render_report_is_non_empty(self):
        valid_md = load_fixture("valid.md")
        rec = telemetry.extract_record(valid_md)
        runs = [json.loads(json.dumps(telemetry.asdict(rec), default=str))]
        out = analyze_runs.render_report(analyze_runs.build_report(runs))
        self.assertIn("Council telemetry", out)
        self.assertIn("Exit-criteria scorecard", out)


class TestRunIndex(unittest.TestCase):
    """Tests for INDEX.jsonl auto-generation in run_council.py."""

    def setUp(self):
        # Import run_council fresh — it lives next to telemetry.py.
        sys.path.insert(0, str(SCRIPTS_DIR))
        import run_council  # noqa: E402
        self.run_council = run_council

        import tempfile, shutil
        self.tmp_root = Path(tempfile.mkdtemp(prefix="council-index-"))
        self.runs_dir = self.tmp_root / ".cleo" / "council-runs"
        self.runs_dir.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, self.tmp_root, ignore_errors=True)

    def test_auto_title_strips_should_prefix(self):
        t = self.run_council._auto_title("Should we adopt X for the new schema?")
        self.assertNotIn("Should we", t)
        self.assertTrue(t.startswith("Adopt") or t.startswith("adopt"),
                        f"Title should start with derived verb, got: {t!r}")

    def test_auto_title_truncates_with_ellipsis(self):
        long_q = "Should we " + "adopt the new architectural pattern that requires significant rework " * 3
        t = self.run_council._auto_title(long_q, max_len=60)
        self.assertLessEqual(len(t), 60)
        self.assertTrue(t.endswith("…"))

    def test_auto_title_handles_short_question(self):
        t = self.run_council._auto_title("Should we ship X?")
        self.assertEqual(t, "Ship X")

    def test_auto_title_normalizes_whitespace(self):
        t = self.run_council._auto_title("Should   we\n\tadopt   X?")
        self.assertNotIn("  ", t)
        self.assertNotIn("\n", t)
        self.assertNotIn("\t", t)

    def test_upsert_index_creates_new_entry(self):
        result = self.run_council._upsert_index(self.runs_dir, "abc123", {
            "title": "Test", "status": "initialized",
        })
        self.assertEqual(result["run_id"], "abc123")
        self.assertEqual(result["status"], "initialized")
        # File must exist now.
        self.assertTrue((self.runs_dir / "INDEX.jsonl").exists())

    def test_upsert_index_updates_existing_entry_no_duplicates(self):
        self.run_council._upsert_index(self.runs_dir, "abc123", {
            "title": "Test", "status": "initialized",
        })
        self.run_council._upsert_index(self.runs_dir, "abc123", {
            "status": "ingested", "verdict_recommendation": "Ship it.",
        })
        entries = self.run_council._read_index(self.runs_dir)
        # Single entry, with merged fields.
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["status"], "ingested")
        self.assertEqual(entries[0]["title"], "Test")
        self.assertEqual(entries[0]["verdict_recommendation"], "Ship it.")

    def test_upsert_index_preserves_other_entries(self):
        self.run_council._upsert_index(self.runs_dir, "aaa", {"title": "A"})
        self.run_council._upsert_index(self.runs_dir, "bbb", {"title": "B"})
        self.run_council._upsert_index(self.runs_dir, "aaa", {"status": "ingested"})
        entries = self.run_council._read_index(self.runs_dir)
        self.assertEqual(len(entries), 2)
        ids = {e["run_id"] for e in entries}
        self.assertEqual(ids, {"aaa", "bbb"})

    def test_extract_recommendation_snippet_pulls_first_sentence(self):
        verdict_md = (
            "# Council Verdict — Should we ship X?\n\n"
            "## Phase 3 — Chairman's verdict\n\n"
            "### Gate summary\n\n| ... | ... |\n\n"
            "### Recommendation\n\n"
            "**Reject the binary.** This is a longer second sentence with more detail. "
            "And a third sentence even longer than the second.\n\n"
            "### Why this, not the alternatives\n\n..."
        )
        snippet = self.run_council._extract_recommendation_snippet(verdict_md)
        self.assertIsNotNone(snippet)
        self.assertIn("Reject the binary", snippet)
        # Should be just the first sentence — not the longer follow-ups.
        self.assertNotIn("And a third sentence", snippet)

    def test_extract_recommendation_snippet_returns_none_when_missing(self):
        verdict_md = "# Council Verdict — empty test\n\n## Phase 3 — Chairman's verdict\n\nNo recommendation here.\n"
        self.assertIsNone(self.run_council._extract_recommendation_snippet(verdict_md))

    def test_extract_recommendation_snippet_truncates_long_first_sentence(self):
        body = "x" * 500 + "."
        verdict_md = f"### Recommendation\n\n{body}\n\n### Next 60-minute action\n"
        snippet = self.run_council._extract_recommendation_snippet(verdict_md, max_len=200)
        self.assertLessEqual(len(snippet), 200)
        self.assertTrue(snippet.endswith("…"))


if __name__ == "__main__":
    unittest.main()
