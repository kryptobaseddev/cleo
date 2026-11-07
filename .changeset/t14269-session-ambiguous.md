---
id: t14269-session-ambiguous
tasks: [T14269]
kind: fix
summary: "an unnamed mutation that cannot tell which agent of a shared harness session is calling is refused with E_SESSION_AMBIGUOUS"
---

The silent shared-session fallback for mutations is gone (decision D11234).
When a caller carries a harness's provider key with no `CLEO_AGENT_ID` and no
`CLEO_SESSION_ID`, that key has no live session of its own, and two or more
named agents of the harness hold live sessions, the mutation is refused with
`E_SESSION_AMBIGUOUS` (exit 27). The error names the live agents, and its fix
is `export CLEO_AGENT_ID=<your agent name>` (or `CLEO_SESSION_ID`). A lead
whose session is bound to the plain provider key is never ambiguous. The
protocol text (CLEO-INJECTION 2.25.7, ct-cleo) now tells Agent-tool subagents
to set `CLEO_AGENT_ID`.
