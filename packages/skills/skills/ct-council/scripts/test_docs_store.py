"""Tests for the CleoDocs store write in run_council.py (T13363 AC2).

The store push is additive and non-fatal: these tests mock subprocess.run
(no real `cleo` binary or store is touched) and prove the invocation shape,
the idempotent add→update fallback, and that failures never raise into
ingest.
"""

from __future__ import annotations

import subprocess
import sys
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
        with mock.patch.dict("os.environ", {}, clear=True):
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


if __name__ == "__main__":
    unittest.main()
