---
id: t13420-ask-enforce-hook
tasks: [T13420]
kind: feat
summary: "`cleo hook ask-enforce`: a Stop hook that blocks a turn ending in a prose owner question and tells the agent to re-ask with its ask tool"
---

The owner rule (CLEO-INJECTION.md step 7) sends every owner question through
the harness ask tool, but nothing enforced it. `cleo hook ask-enforce
--provider <harness>` reads the Stop payload, finds the final reply and the
tool calls since the last user prompt (from the payload or the tail of the
transcript it names, at most 256 KB), and asks the new core classifier
(`@cleocode/core/harness/ask-enforce`) whether the reply asks the owner
something in prose without an ask-tool call. If so it blocks the stop in the
harness's own protocol with a re-ask instruction naming the provider's ask
tool from CAAMP (or the `hitl.request` fallback): Claude Code, Codex and
Copilot CLI (`decision: block`), Gemini CLI (`decision: deny`), Cursor
(`followup_message`), opencode (`block`, for the CLEO plugin) and Kimi (exit
2).

The classifier is regex-only and tuned against false positives: code, quotes,
headings, tables, URLs and open-questions sections are stripped, only the
reply's tail is read, and attributed or self-answered questions do not count.
A 50-case corpus pins 0 false positives and at least 90% recall. Every error
fails open, the second stop of a turn always passes, and `CLEO_ASK_ENFORCE`
selects `block` (default), `warn` or `off`. Installation into each harness
follows in a separate change.
