-- T12500 (E-MULTI-SESSION · epic T12497) — who wrote a terminal binding.
--
-- `bound_by_provider` = 1 when the binding was written by an explicit session
-- start / resume / switch from a process that carried an agent-harness identity
-- (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, …). A tab- or ppid-level binding
-- written by a HUMAN (no provider key) stays 0, and only such a binding may be
-- adopted by an agent running in the same tab — so a tab-started session is
-- visible from Claude Code in that tab, while two Claude instances that each
-- started their own session stay isolated. A provider row written by that
-- adoption is also 0 (adopted, not owned).
--
-- @task T12500
-- @epic T12497

ALTER TABLE `session_terminal_bindings` ADD COLUMN `bound_by_provider` INTEGER NOT NULL DEFAULT 0;
