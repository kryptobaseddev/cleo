#!/usr/bin/env python3
"""
test_validate.py — unit tests for the Council output validator.

Run from the skill's scripts/ directory:
    python3 -m unittest test_validate.py -v

Or from anywhere:
    python3 <path-to-council>/scripts/test_validate.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
FIXTURES_DIR = SCRIPTS_DIR / "fixtures"

# Make validate.py importable regardless of how tests are invoked.
sys.path.insert(0, str(SCRIPTS_DIR))
from validate import Validator, detect_phase  # noqa: E402


def load_fixture(name: str) -> str:
    return (FIXTURES_DIR / name).read_text()


class TestValidCouncilOutput(unittest.TestCase):
    def test_valid_fixture_has_no_structural_violations(self):
        v = Validator(load_fixture("valid.md"))
        violations = v.validate()
        structural = [x for x in violations if x.kind == "structural"]
        self.assertEqual(
            structural, [],
            f"Valid fixture produced structural violations: {[(x.section, x.message) for x in structural]}"
        )

    def test_valid_fixture_passes_all_advisors(self):
        v = Validator(load_fixture("valid.md"))
        violations = v.validate()
        advisor_errors = [x for x in violations if "Advisor:" in x.section and x.kind == "structural"]
        self.assertEqual(advisor_errors, [], f"Advisor-section errors: {advisor_errors}")

    def test_valid_fixture_passes_all_peer_reviews(self):
        v = Validator(load_fixture("valid.md"))
        violations = v.validate()
        review_errors = [x for x in violations if "reviewing" in x.section and x.kind == "structural"]
        self.assertEqual(review_errors, [], f"Peer-review errors: {review_errors}")


class TestMissingAdvisor(unittest.TestCase):
    """missing_advisor.md omits the Outsider section."""

    def test_flags_missing_outsider(self):
        v = Validator(load_fixture("missing_advisor.md"))
        violations = v.validate()
        sections = [x.section for x in violations]
        self.assertIn("Advisor: Outsider", sections,
                      f"Expected missing-advisor violation for Outsider; got sections: {sections}")

    def test_flags_missing_peer_reviews_that_depend_on_outsider(self):
        v = Validator(load_fixture("missing_advisor.md"))
        violations = v.validate()
        # Without Outsider, several peer-review pairs are missing — those are flagged under
        # section "Peer review" with the specific pair named in the message.
        review_violations = [
            x for x in violations
            if x.section == "Peer review" and "reviewing" in x.message
        ]
        self.assertGreaterEqual(
            len(review_violations), 1,
            f"Expected ≥1 missing peer-review violation; got: {[v.message for v in violations]}"
        )


class TestExecutorMultipleActions(unittest.TestCase):
    """executor_multi.md has a numbered list under 'The action (one)'."""

    def test_flags_multiple_actions(self):
        v = Validator(load_fixture("executor_multi.md"))
        violations = v.validate()
        executor_errors = [x for x in violations if x.section == "Advisor: Executor"]
        self.assertTrue(
            any("numbered" in x.message or "bulleted" in x.message for x in executor_errors),
            f"Expected multi-action violation; got: {[x.message for x in executor_errors]}"
        )


class TestThinEvidencePack(unittest.TestCase):
    """thin_evidence.md has only 2 evidence items."""

    def test_flags_evidence_pack_minimum(self):
        v = Validator(load_fixture("thin_evidence.md"))
        violations = v.validate()
        ep_errors = [x for x in violations if x.section == "Evidence pack" and x.kind == "structural"]
        self.assertTrue(
            any("minimum is 3" in x.message for x in ep_errors),
            f"Expected evidence-pack minimum violation; got: {[x.message for x in ep_errors]}"
        )


class TestMissingConvergenceSection(unittest.TestCase):
    """missing_convergence.md skips Phase 2.5."""

    def test_flags_missing_phase_2_5(self):
        v = Validator(load_fixture("missing_convergence.md"))
        violations = v.validate()
        phase25_errors = [x for x in violations if x.section == "Phase 2.5"]
        self.assertTrue(
            any("Missing" in x.message for x in phase25_errors),
            f"Expected Phase 2.5 missing violation; got: {[x.message for x in phase25_errors]}"
        )


class TestHeaderValidation(unittest.TestCase):
    def test_missing_h1_flagged(self):
        md = "## Evidence pack\n\n1. `foo.py:1` — something.\n"
        v = Validator(md)
        violations = v.validate()
        self.assertTrue(any(x.section == "H1" for x in violations))

    def test_short_restated_question_flagged(self):
        md = "# The Council — X\n\n## Evidence pack\n"
        v = Validator(md)
        violations = v.validate()
        h1_errors = [x for x in violations if x.section == "H1"]
        self.assertTrue(any("too short" in x.message for x in h1_errors))


class TestChairmanVerdict(unittest.TestCase):
    def test_valid_fixture_has_all_chairman_subsections(self):
        v = Validator(load_fixture("valid.md"))
        violations = v.validate()
        phase3_errors = [x for x in violations if x.section == "Phase 3" and x.kind == "structural"]
        self.assertEqual(
            phase3_errors, [],
            f"Chairman verdict has issues: {[x.message for x in phase3_errors]}"
        )


class TestGateFormat(unittest.TestCase):
    def test_valid_fixture_gate_lines_accepted(self):
        """Valid fixture has properly formatted 'G1 Rigor: PASS — <evidence>' lines."""
        v = Validator(load_fixture("valid.md"))
        violations = v.validate()
        gate_errors = [x for x in violations if "Gate" in x.message]
        self.assertEqual(gate_errors, [], f"Valid fixture has gate-format errors: {gate_errors}")

    def test_partial_pass_is_rejected(self):
        """Regression test: 'PARTIAL PASS' is not a valid gate state per peer-review.md."""
        # Start from the valid fixture and corrupt exactly one gate to PARTIAL PASS.
        md = load_fixture("valid.md").replace(
            "- G3 Frame integrity: PASS — stayed in atomic-truth lane.",
            "- G3 Frame integrity: PARTIAL PASS — stayed in lane mostly.",
            1,
        )
        v = Validator(md)
        violations = v.validate()
        g3_errors = [
            x for x in violations
            if "G3 Frame integrity" in x.message and "missing or malformed" in x.message
        ]
        self.assertTrue(
            g3_errors,
            f"Expected validator to reject 'PARTIAL PASS' as malformed; got: {[v.message for v in violations]}"
        )

    def test_code_fence_shell_comments_do_not_fake_headers(self):
        """Regression: `# 0.` shell comments inside ```bash fences must not be parsed as H1 headers,
        which would truncate the containing section and hide required subsections."""
        md = load_fixture("valid.md")
        # Inject a bash code block with a `# comment` that looks like an H1 into Phase 3's action.
        injected = md.replace(
            "### Next 60-minute action\n",
            "### Next 60-minute action\n\n```bash\n# 0. This is a shell comment, not a header.\ncleo verify T1234\n```\n\n",
            1,
        )
        v = Validator(injected)
        violations = v.validate()
        missing_conf = [
            x for x in violations
            if x.section == "Phase 3" and "Confidence" in x.message
        ]
        self.assertEqual(
            missing_conf, [],
            "Shell comments inside code fences should not truncate the Phase 3 body; "
            f"unexpected violations: {[v.message for v in violations]}"
        )

    def test_mixed_is_rejected(self):
        """Regression test: 'MIXED' is not a valid gate state."""
        md = load_fixture("valid.md").replace(
            "- G1 Rigor: PASS — \"Non-idempotent requests cannot be blindly retried\" is specific.",
            "- G1 Rigor: MIXED — partially specific.",
            1,
        )
        v = Validator(md)
        violations = v.validate()
        g1_errors = [
            x for x in violations
            if "G1 Rigor" in x.message and "missing or malformed" in x.message
        ]
        self.assertTrue(
            g1_errors,
            f"Expected validator to reject 'MIXED' as malformed; got: {[v.message for v in violations]}"
        )


class TestValidatorReportFormat(unittest.TestCase):
    def test_report_mentions_violation_count(self):
        from validate import report
        v = Validator(load_fixture("missing_advisor.md"))
        violations = v.validate()
        text = report(violations, as_json=False)
        self.assertIn("violation", text.lower())

    def test_json_report_parseable(self):
        import json as _json
        from validate import report
        v = Validator(load_fixture("valid.md"))
        violations = v.validate()
        text = report(violations, as_json=True)
        data = _json.loads(text)
        self.assertIn("valid", data)
        self.assertIn("violations", data)


class TestLlmtxtRefParsing(unittest.TestCase):
    """llmtxt_ref.py parsing + cache-path logic — no network."""

    def test_parse_ref_slug_only(self):
        from llmtxt_ref import parse_ref
        slug, version = parse_ref("my-doc")
        self.assertEqual(slug, "my-doc")
        self.assertIsNone(version)

    def test_parse_ref_with_version(self):
        from llmtxt_ref import parse_ref
        slug, version = parse_ref("my-doc@v2")
        self.assertEqual(slug, "my-doc")
        self.assertEqual(version, "v2")

    def test_parse_ref_single_char_slug(self):
        from llmtxt_ref import parse_ref
        slug, version = parse_ref("a")
        self.assertEqual(slug, "a")
        self.assertIsNone(version)

    def test_parse_ref_rejects_uppercase(self):
        from llmtxt_ref import parse_ref
        with self.assertRaises(ValueError):
            parse_ref("Invalid")

    def test_parse_ref_rejects_leading_dash(self):
        from llmtxt_ref import parse_ref
        with self.assertRaises(ValueError):
            parse_ref("-leading")

    def test_parse_ref_rejects_trailing_dash(self):
        from llmtxt_ref import parse_ref
        with self.assertRaises(ValueError):
            parse_ref("trailing-")

    def test_parse_ref_rejects_empty_version(self):
        from llmtxt_ref import parse_ref
        with self.assertRaises(ValueError):
            parse_ref("slug@")

    def test_cache_path_no_version(self):
        from llmtxt_ref import cache_path
        p = cache_path("my-doc", None)
        self.assertTrue(str(p).endswith("my-doc/_latest.md"))

    def test_cache_path_with_version(self):
        from llmtxt_ref import cache_path
        p = cache_path("my-doc", "v2")
        self.assertTrue(str(p).endswith("my-doc/v2.md"))

    def test_cache_path_sanitizes_version(self):
        """Version string is sanitized for filename safety but slug is preserved."""
        from llmtxt_ref import cache_path
        p = cache_path("my-doc", "v2/weird")
        self.assertTrue("my-doc" in str(p))
        self.assertTrue("v2_weird.md" in str(p))


class TestLlmtxtCacheFreshness(unittest.TestCase):
    """cache_is_fresh logic — immutable vs mutable behavior."""

    def test_missing_file_is_not_fresh(self):
        from llmtxt_ref import cache_is_fresh
        self.assertFalse(cache_is_fresh(Path("/tmp/nonexistent-xyz-abc.md"), immutable=True))

    def test_immutable_file_is_always_fresh(self):
        import tempfile
        from llmtxt_ref import cache_is_fresh
        with tempfile.NamedTemporaryFile(delete=False, suffix=".md") as f:
            f.write(b"cached")
            tmp = Path(f.name)
        try:
            self.assertTrue(cache_is_fresh(tmp, immutable=True))
        finally:
            tmp.unlink()

    def test_mutable_file_respects_ttl(self):
        import os
        import tempfile
        import time
        from llmtxt_ref import cache_is_fresh, LATEST_TTL_SECONDS
        with tempfile.NamedTemporaryFile(delete=False, suffix=".md") as f:
            f.write(b"cached")
            tmp = Path(f.name)
        try:
            # Set mtime to (TTL + 5) seconds ago — should read as stale.
            stale_time = time.time() - (LATEST_TTL_SECONDS + 5)
            os.utime(tmp, (stale_time, stale_time))
            self.assertFalse(cache_is_fresh(tmp, immutable=False))
        finally:
            tmp.unlink()


class TestLlmtxtFormatting(unittest.TestCase):
    def test_format_includes_evidence_pack_header(self):
        from llmtxt_ref import format_for_evidence_pack
        formatted = format_for_evidence_pack("my-doc", "v2", "# Overview\n\nBody")
        self.assertIn("<!-- evidence-pack item: `llmtxt:my-doc@v2` -->", formatted)
        self.assertIn("# Overview", formatted)

    def test_format_without_version(self):
        from llmtxt_ref import format_for_evidence_pack
        formatted = format_for_evidence_pack("my-doc", None, "body")
        self.assertIn("`llmtxt:my-doc`", formatted)
        self.assertNotIn("@", formatted.split("-->")[0])


class TestLlmtxtEvidencePackItem(unittest.TestCase):
    """The validator accepts evidence-pack items using the llmtxt:<slug>[@version] citation format."""

    def test_valid_fixture_with_llmtxt_item_passes(self):
        v = Validator(load_fixture("valid_with_llmtxt.md"))
        violations = v.validate()
        structural = [x for x in violations if x.kind == "structural"]
        self.assertEqual(
            structural, [],
            f"valid_with_llmtxt.md should validate cleanly; got: {[(x.section, x.message) for x in structural]}"
        )

    def test_llmtxt_citation_satisfies_has_citation_check(self):
        """A minimal evidence item with only an llmtxt: citation still counts as a citation."""
        md = (
            "# The Council — Is the llmtxt citation format accepted by the validator?\n\n"
            "## Evidence pack\n\n"
            "1. `llmtxt:some-external-doc` — external SDK reference.\n"
            "2. `llmtxt:other-doc@v3` — pinned version.\n"
            "3. `src/foo.py:L1-L5` — local anchor.\n"
        )
        v = Validator(md)
        v.check_evidence_pack()
        ep_errors = [x for x in v.violations if x.section == "Evidence pack" and x.kind == "structural"]
        self.assertEqual(ep_errors, [], f"llmtxt citations should pass; got: {ep_errors}")


class TestPhaseAwareValidation(unittest.TestCase):
    """Tests for --phase N partial-validation mode + auto-detect.

    Regression test for the bug where running `validate.py` against a
    phase0.md-only file produced 12 noise errors about missing downstream
    sections. After fix, partial files validate cleanly when phase is
    explicitly specified or auto-detected."""

    PHASE_0_ONLY = (
        "# The Council — Should we ship X?\n\n"
        "## Evidence pack\n\n"
        "1. `packages/foo.ts:L10-L20` — does the thing.\n"
        "2. `packages/bar.ts:L5-L8` — relevant baseline.\n"
        "3. `commit a1b2c3d` — last touched.\n"
    )

    def test_phase_0_only_file_validates_cleanly_with_phase_arg(self):
        v = Validator(self.PHASE_0_ONLY)
        violations = v.validate(phase=0)
        structural = [x for x in violations if x.kind == "structural"]
        self.assertEqual(structural, [],
                         f"phase=0 should not flag missing downstream sections; got: {structural}")

    def test_phase_0_file_default_validation_FAILS_without_phase(self):
        # Old behavior at the API level: if validate() is called with phase=None
        # and the file is missing downstream sections, those ARE flagged.
        v = Validator(self.PHASE_0_ONLY)
        violations = v.validate()  # phase=None defaults to 3 inside the validator
        structural = [x for x in violations if x.kind == "structural"]
        self.assertGreater(len(structural), 0,
                           "Without phase arg, missing downstream sections should still be flagged")

    def test_detect_phase_returns_0_for_phase0_only(self):
        self.assertEqual(detect_phase(self.PHASE_0_ONLY), 0)

    def test_detect_phase_returns_1_when_advisor_present(self):
        md = self.PHASE_0_ONLY + "\n## Phase 1\n\n### Advisor: Contrarian\n\nSome content.\n"
        self.assertEqual(detect_phase(md), 1)

    def test_detect_phase_returns_2_when_peer_review_present(self):
        md = self.PHASE_0_ONLY + (
            "\n## Phase 1\n\n### Advisor: Contrarian\nbody\n\n"
            "## Phase 2\n\n### Contrarian reviewing First Principles\n\nbody\n"
        )
        self.assertEqual(detect_phase(md), 2)

    def test_detect_phase_returns_3_when_phase_3_present(self):
        md = self.PHASE_0_ONLY + "\n## Phase 3 — Chairman's verdict\n\nbody\n"
        self.assertEqual(detect_phase(md), 3)

    def test_detect_phase_ignores_headers_inside_code_fences(self):
        # Section markers inside ``` blocks shouldn't count.
        md = (
            "# The Council — fenced test\n\n"
            "## Evidence pack\n\n"
            "1. `foo.ts` — bar\n"
            "2. `baz.ts` — qux\n"
            "3. `quux.ts` — flob\n\n"
            "Here is some example output:\n"
            "```\n"
            "## Phase 3 — Chairman's verdict\n"
            "### Advisor: Contrarian\n"
            "```\n"
        )
        # Inside the fence, those headers should NOT be detected.
        self.assertEqual(detect_phase(md), 0)

    def test_phase_1_validation_checks_advisors_but_not_peer_reviews(self):
        md = self.PHASE_0_ONLY + (
            "\n## Phase 1 — Advisor analyses\n\n"
            "### Advisor: Contrarian\n\n"
            "**Frame:** ...\n\n"
            "**Evidence anchored:**\n- foo — bar\n- baz — qux\n\n"
            "**Verdict from this lens:** ...\n\n"
            "**Single sharpest point:** ...\n"
        )
        v = Validator(md)
        violations = v.validate(phase=1)
        # Should flag missing advisors (4 missing) but NOT peer reviews / convergence / chairman.
        msgs = [(x.section, x.message) for x in violations if x.kind == "structural"]
        # No peer-review or Phase 2.5 or Phase 3 errors expected.
        self.assertFalse(any("Peer review" in s for s, _ in msgs))
        self.assertFalse(any("Phase 2.5" in s for s, _ in msgs))
        self.assertFalse(any("Phase 3" in s for s, _ in msgs))


if __name__ == "__main__":
    unittest.main(verbosity=2)
