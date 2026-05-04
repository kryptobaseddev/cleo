"""Tests for the YAML-driven scenario loader in campaign.py."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

# Import after path injection.
import campaign  # noqa: E402


class TestScenarioLoader(unittest.TestCase):
    """Verify scenarios.yaml drives campaign.py without code edits."""

    def test_default_load_returns_scenarios(self):
        # The committed scenarios.yaml should produce ≥1 scenario.
        scenarios = campaign._load_scenarios()
        self.assertGreater(len(scenarios), 0)
        for s in scenarios:
            self.assertIsInstance(s, campaign.Scenario)
            self.assertTrue(s.id)
            self.assertTrue(s.title)

    def test_default_scenarios_are_sorted_by_number(self):
        scenarios = campaign._load_scenarios()
        numbers = [s.number for s in scenarios]
        self.assertEqual(numbers, sorted(numbers))

    def test_default_scenarios_have_unique_ids(self):
        scenarios = campaign._load_scenarios()
        ids = [s.id for s in scenarios]
        self.assertEqual(len(ids), len(set(ids)), f"Duplicate scenario IDs: {ids}")

    def test_yaml_load_picks_up_appended_scenario(self):
        # Write a custom scenarios.yaml in a temp dir and point loader at it.
        with tempfile.TemporaryDirectory() as tmp:
            yaml_path = Path(tmp) / "scenarios.yaml"
            yaml_path.write_text(
                "schema_version: \"1.0.0\"\n"
                "scenarios:\n"
                "  - id: alpha\n"
                "    number: 1\n"
                "    title: Alpha\n"
                "    dimension: dim\n"
                "    shape: shape\n"
                "    learn: learn\n"
                "    briefing: |\n"
                "      Alpha briefing.\n"
                "  - id: beta\n"
                "    number: 99\n"
                "    title: Beta\n"
                "    dimension: dim\n"
                "    shape: shape\n"
                "    learn: learn\n"
                "    briefing: |\n"
                "      Beta briefing.\n"
            )
            with mock.patch.object(campaign, "SCENARIOS_YAML_PATH", yaml_path), \
                 mock.patch.object(campaign, "SCENARIOS_JSON_PATH", Path(tmp) / "nope.json"):
                scenarios = campaign._load_scenarios()
        self.assertEqual([s.id for s in scenarios], ["alpha", "beta"])
        self.assertEqual(scenarios[1].number, 99)

    def test_json_fallback_when_yaml_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            json_path = Path(tmp) / "scenarios.json"
            json_path.write_text(json.dumps({
                "schema_version": "1.0.0",
                "scenarios": [
                    {"id": "json-only", "number": 1, "title": "T", "dimension": "d",
                     "shape": "s", "learn": "l", "briefing": "b"},
                ],
            }))
            with mock.patch.object(campaign, "SCENARIOS_YAML_PATH", Path(tmp) / "missing.yaml"), \
                 mock.patch.object(campaign, "SCENARIOS_JSON_PATH", json_path):
                scenarios = campaign._load_scenarios()
        self.assertEqual([s.id for s in scenarios], ["json-only"])

    def test_skips_scenarios_with_missing_required_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            yaml_path = Path(tmp) / "scenarios.yaml"
            yaml_path.write_text(
                "scenarios:\n"
                "  - id: good\n"
                "    number: 1\n"
                "    title: Good\n"
                "    dimension: d\n"
                "    shape: s\n"
                "    learn: l\n"
                "    briefing: b\n"
                "  - id: bad-missing-briefing\n"
                "    number: 2\n"
                "    title: Bad\n"
                "    dimension: d\n"
                "    shape: s\n"
                "    learn: l\n"
            )
            with mock.patch.object(campaign, "SCENARIOS_YAML_PATH", yaml_path), \
                 mock.patch.object(campaign, "SCENARIOS_JSON_PATH", Path(tmp) / "nope.json"):
                scenarios = campaign._load_scenarios()
        self.assertEqual([s.id for s in scenarios], ["good"])

    def test_fallback_when_no_yaml_or_json_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(campaign, "SCENARIOS_YAML_PATH", Path(tmp) / "x.yaml"), \
                 mock.patch.object(campaign, "SCENARIOS_JSON_PATH", Path(tmp) / "x.json"):
                scenarios = campaign._load_scenarios()
        # _FALLBACK_SCENARIOS provides exactly one entry.
        self.assertEqual(len(scenarios), 1)
        self.assertEqual(scenarios[0].id, "baseline")

    def test_yaml_briefing_preserves_multiline_format(self):
        scenarios = campaign._load_scenarios()
        # The committed scenarios.yaml has multi-line briefings — confirm preserved.
        baseline = next((s for s in scenarios if s.id == "baseline"), None)
        if baseline:
            self.assertIn("\n", baseline.briefing,
                          "Multi-line briefings should preserve newlines from YAML literal block.")


class TestNoSkippedScenarioNumbers(unittest.TestCase):
    """Soft policy: numbers should be 1..N without gaps for human readability,
    but the loader allows gaps. This test documents the convention without enforcing it."""

    def test_committed_scenarios_have_contiguous_numbers(self):
        scenarios = campaign._load_scenarios()
        if len(scenarios) <= 1:
            self.skipTest("Only fallback scenario loaded")
        numbers = [s.number for s in scenarios]
        expected = list(range(numbers[0], numbers[0] + len(numbers)))
        self.assertEqual(numbers, expected,
                         f"Committed scenarios.yaml has gaps in numbering: {numbers}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
