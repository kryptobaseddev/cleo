---
id: core-skills-work-loop
tasks: [T13958]
kind: docs
summary: "core skills teach plan, execute, verify instead of RCASD stages and the IVTR loop"
---
ct-orchestrator 4.1.0 replaces its LOOM section (RCASD planning stages, the
IVTR loop and spawn-time stage gates) with the loop agents actually run: one
plan document per epic in `cleo docs`, decisions in BRAIN, tasks with
acceptance criteria, waves and spawns from `cleo orchestrate`, AgentMBX for
coordination, evidence gates and an independent review per PR head. Its
`cleo pipeline stage.*` quick-reference rows and `references/lifecycle-gates.md`
are removed. ct-cleo 2.24.18 swaps `references/loom-lifecycle.md` for
`references/planning-loop.md`. ct-lead 1.1.2 qualifies the `agentmbx inbox`
fallback: it works only inside the provider session that holds the MCP lease.
