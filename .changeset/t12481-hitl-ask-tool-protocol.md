---
id: t12481-hitl-ask-tool-protocol
tasks: [T12481]
kind: docs
summary: owner questions go through the ask tool with selectable options (CLEO-INJECTION.md 2.20.8 + ct-cleo 2.20.8 + ct-orchestrator 2.9.0)
---

Adds rule 7 "Ask the owner" to the Universal protocol in CLEO-INJECTION.md: every
owner answer, decision, approval or choice goes through the ask tool
(`AskUserQuestion` or the provider equivalent) with concrete selectable options,
recommended first; never ask in prose; no routine status chatter. Subagents return
the question and options to their orchestrator, which asks. Without an ask tool,
emit one LAFS `hitl.request` envelope and stop. ct-cleo and ct-orchestrator carry
the same rule, the subagent relay and the fallback. The template was compressed
elsewhere (duplicated prose) so the tier-1 spawn prompt stays under 43,000 chars.
