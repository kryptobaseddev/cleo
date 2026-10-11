---
id: t13421-reply-lean
tasks: [T13421]
kind: feat
summary: answer-first reply rule on every agent surface; owner questions carry 2-4 populated options
---

CLEO-INJECTION.md gains universal protocol step 8, **Reply lean**: the first line
is the result, answer or decision; then only the evidence the reader needs and
what was skipped or unverified; no preamble, recap or status chatter. Owner
questions go only through the ask tool with 2-4 options, each describing what
happens and its trade-offs.

The same rule lands in `ct-cleo` and `ct-orchestrator` (which now fills in a
relayed subagent question with thin options before asking), and the spawn
prompt's HITL line requires populated options from subagents. Gate 27
(`lint-hitl-rule-delivery`) guards the new markers on all four surfaces.

The always-loaded core cap rises from 14,000 to 14,600 characters, sized for
this rule and the `ct-lean` pointer (T13422): both govern every reply, so
neither can be an on-demand section. Protocol 2.24.8.
