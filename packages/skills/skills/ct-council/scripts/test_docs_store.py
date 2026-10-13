"""Tests for the CleoDocs store write in run_council.py (T13363 AC2).

The store push is additive and non-fatal: these tests mock subprocess.run
(no real `cleo` binary or store is touched) and prove the invocation shape,
the idempotent add→update fallback, and that failures never raise into
ingest.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
import run_council  # noqa: E402

CONTENT = "# The Council — retry?\n\n## Phase 1 — advisors\n\n...\n"
META = {
    "run_id": "abcdef12",
    "title": "Retry on timeout",
    "question": "Should we retry on timeout?",
}
RUN_DIR = Path(".cleo/council-runs/20261013T000000-abcdef12")


def _completed(cmd, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(cmd, returncode, stdout=stdout, stderr=stderr)


class TestDocsSlug(unittest.TestCase):
    def test_slug_scheme(self):
        self.assertEqual(run_council.docs_slug_for_run("abcdef12"), "council-run-abcdef12")


class TestResolveOwner(unittest.TestCase):
    def test_flag_wins(self):
        args = mock.Mock(owner="T1234", spec=["owner"])
        self.assertEqual(run_council.resolve_docs_owner(args), "T1234")

    def test_env_fallback(self):
        args = mock.Mock(owner=None, spec=["owner"])
        with mock.patch.dict("os.environ", {"CLEO_SESSION_ID": "ses_x"}, clear=True):
            self.assertEqual(run_council.resolve_docs_owner(args), "ses_x")

    def test_none_when_unset(self):
        args = mock.Mock(owner=None, spec=["owner"])
        with mock.patch.dict("os.environ", {}, clear=True), \
                mock.patch.object(run_council.subprocess, "run", side_effect=OSError("no cleo")):
            self.assertIsNone(run_council.resolve_docs_owner(args))

    def test_claude_code_session_only_resolves_through_the_cli(self):
        # T13658: under Claude Code only CLAUDE_CODE_SESSION_ID is set; the CLI
        # binds it to a cleo session, which becomes the owner.
        args = mock.Mock(owner=None, spec=["owner"])
        with mock.patch.dict("os.environ", {"CLAUDE_CODE_SESSION_ID": "cc-123"}, clear=True), \
                mock.patch.object(run_council.subprocess, "run") as m:
            m.return_value = _completed([], returncode=0, stdout="ses_bound\n")
            self.assertEqual(run_council.resolve_docs_owner(args), "ses_bound")
        (cmd,), kwargs = m.call_args
        self.assertEqual(cmd[:3], ["cleo", "session", "status"])
        self.assertIn("timeout", kwargs)

    def test_hung_session_status_is_none(self):
        args = mock.Mock(owner=None, spec=["owner"])
        with mock.patch.dict("os.environ", {}, clear=True), \
                mock.patch.object(run_council.subprocess, "run",
                                  side_effect=subprocess.TimeoutExpired(["cleo"], 60)):
            self.assertIsNone(run_council.resolve_docs_owner(args))


class TestPushRunToDocsStore(unittest.TestCase):
    def _push(self, mock_run, **kwargs):
        defaults = dict(run_dir=RUN_DIR, meta=dict(META), content=CONTENT, owner="ses_x")
        defaults.update(kwargs)
        return run_council.push_run_to_docs_store(**defaults)

    def test_add_invocation_shape(self):
        with mock.patch.object(run_council.subprocess, "run") as m:
            m.return_value = _completed([], returncode=0, stdout='{"success":true}')
            ok = self._push(m)
        self.assertTrue(ok)
        (cmd,), kwargs = m.call_args
        self.assertEqual(cmd[:4], ["cleo", "docs", "add", "ses_x"])
        self.assertIn("--content", cmd)
        self.assertEqual(cmd[cmd.index("--content") + 1], "-")  # stdin, never argv
        self.assertEqual(cmd[cmd.index("--type") + 1], "note")
        self.assertEqual(cmd[cmd.index("--slug") + 1], "council-run-abcdef12")
        self.assertEqual(kwargs["input"], CONTENT)  # markdown flows via stdin
        self.assertEqual(kwargs["env"]["CLEO_SESSION_ID"], "ses_x")
        self.assertEqual(kwargs["timeout"], run_council.CLEO_TIMEOUT_SEC)
        self.assertIn("--title=Retry on timeout", cmd)

    def test_dash_title_stays_one_token(self):
        with mock.patch.object(run_council.subprocess, "run") as m:
            m.return_value = _completed([], returncode=0)
            self._push(m, meta={**META, "title": "--force everything"})
        (cmd,), _ = m.call_args
        self.assertIn("--title=--force everything", cmd)
        self.assertNotIn("--force everything", cmd)

    def test_hung_cleo_is_non_fatal(self):
        with mock.patch.object(run_council.subprocess, "run",
                               side_effect=subprocess.TimeoutExpired(["cleo"], 60)):
            self.assertFalse(self._push(mock.Mock()))

    def test_session_env_only_for_session_owner(self):
        with mock.patch.object(run_council.subprocess, "run") as m:
            m.return_value = _completed([], returncode=0)
            with mock.patch.dict("os.environ", {"CLEO_SESSION_ID": "ses_other"}, clear=True):
                ok = self._push(m, owner="T1234")
        self.assertTrue(ok)
        (_,), kwargs = m.call_args
        self.assertEqual(kwargs["env"]["CLEO_SESSION_ID"], "ses_other")

    def test_slug_reserved_falls_back_to_update(self):
        reserved = _completed([], returncode=1, stdout='{"success":false,"error":{"codeName":"E_SLUG_RESERVED"}}')
        updated = _completed([], returncode=0, stdout='{"success":true}')
        with mock.patch.object(run_council.subprocess, "run") as m:
            m.side_effect = [reserved, updated]
            ok = self._push(m)
        self.assertTrue(ok)
        self.assertEqual(m.call_count, 2)
        (cmd,), _ = m.call_args
        self.assertEqual(cmd[:3], ["cleo", "docs", "update"])
        self.assertEqual(cmd[3], "council-run-abcdef12")
        self.assertIn("abcdef12", cmd[cmd.index("--message") + 1])

    def test_add_failure_is_non_fatal(self):
        with mock.patch.object(run_council.subprocess, "run") as m:
            m.return_value = _completed([], returncode=1, stdout='{"success":false,"error":{"codeName":"E_BOOM"}}')
            ok = self._push(m)
        self.assertFalse(ok)
        self.assertEqual(m.call_count, 1)  # no update fallback on other errors

    def test_missing_binary_is_non_fatal(self):
        with mock.patch.object(run_council.subprocess, "run") as m:
            m.side_effect = OSError("No such file or directory: 'cleo'")
            ok = self._push(m)
        self.assertFalse(ok)

    def test_update_failure_is_non_fatal(self):
        reserved = _completed([], returncode=1, stdout="E_SLUG_RESERVED")
        failed = _completed([], returncode=1, stderr="boom")
        with mock.patch.object(run_council.subprocess, "run") as m:
            m.side_effect = [reserved, failed]
            ok = self._push(m)
        self.assertFalse(ok)

    def test_fallback_requires_slug_reserved_marker(self):
        # A non-reserved add failure must NOT attempt an update.
        with mock.patch.object(run_council.subprocess, "run") as m:
            m.return_value = _completed([], returncode=1, stderr="E_VALIDATION")
            ok = self._push(m)
        self.assertFalse(ok)
        self.assertEqual(m.call_count, 1)


class TestIngestOrdering(unittest.TestCase):
    """T13659: telemetry + INDEX are written first; docs_slug only on success."""

    REAL_RUN = staticmethod(subprocess.run)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="council-ingest-"))
        self.run_dir = self.tmp / "runs" / "20261013T000000-abcdef12"
        self.run_dir.mkdir(parents=True)
        shutil.copy(SCRIPTS_DIR / "fixtures" / "valid.md", self.run_dir / "output.md")
        (self.run_dir / "run.json").write_text(json.dumps(META))
        self.log = self.tmp / "council-runs.jsonl"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _ingest(self, cleo_behaviour):
        def fake_run(cmd, *a, **kw):
            if cmd and cmd[0] == "cleo":
                return cleo_behaviour(cmd)
            return self.REAL_RUN(cmd, *a, **kw)  # real validate.py / telemetry.py

        args = argparse.Namespace(run_dir=str(self.run_dir), log=str(self.log), tokens=None,
                                  wall_clock=None, owner="ses_x", no_store=False)
        with mock.patch.object(run_council.subprocess, "run", side_effect=fake_run) as m:
            code = run_council.cmd_ingest(args)
        index = [json.loads(line) for line in (self.tmp / "runs" / "INDEX.jsonl").read_text().splitlines()]
        return code, m, index[0]

    def _assert_records_written(self, code, entry):
        self.assertEqual(code, 0)
        self.assertTrue(self.log.read_text().strip(), "telemetry JSONL record missing")
        self.assertEqual(entry["status"], "ingested")

    def test_hung_cleo_does_not_block_and_records_still_land(self):
        def hung(cmd):
            raise subprocess.TimeoutExpired(cmd, run_council.CLEO_TIMEOUT_SEC)
        code, _, entry = self._ingest(hung)
        self._assert_records_written(code, entry)
        self.assertNotIn("docs_slug", entry)

    def test_failed_write_stamps_no_docs_slug(self):
        code, _, entry = self._ingest(lambda cmd: _completed(cmd, returncode=1, stderr="E_BOOM"))
        self._assert_records_written(code, entry)
        self.assertNotIn("docs_slug", entry)

    def test_skipped_write_stamps_no_docs_slug(self):
        args_owner = mock.patch.object(run_council, "resolve_docs_owner", return_value=None)
        with args_owner:
            code, m, entry = self._ingest(lambda cmd: _completed(cmd, returncode=0))
        self._assert_records_written(code, entry)
        self.assertNotIn("docs_slug", entry)
        self.assertFalse(any(c.args[0][0] == "cleo" for c in m.call_args_list))

    def test_successful_write_runs_last_and_stamps_docs_slug(self):
        order = []

        def ok(cmd):
            order.append("cleo")
            self.assertTrue(self.log.read_text().strip(), "store write ran before telemetry")
            self.assertTrue((self.tmp / "runs" / "INDEX.jsonl").exists(), "store write ran before INDEX")
            return _completed(cmd, returncode=0)
        code, _, entry = self._ingest(ok)
        self._assert_records_written(code, entry)
        self.assertEqual(order, ["cleo"])
        self.assertEqual(entry["docs_slug"], "council-run-abcdef12")


if __name__ == "__main__":
    unittest.main()
