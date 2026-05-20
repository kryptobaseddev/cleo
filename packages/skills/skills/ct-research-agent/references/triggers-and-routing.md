# Triggers and Routing

When to load `ct-research-agent`, what tasks it owns, and how it hands off
to neighboring skills in the RCASD-IVTR+C pipeline. The skill operates as the
`research` protocol within the orchestrator's stage taxonomy and is the first
skill invoked when an Epic enters its research lifecycle stage.

## Primary Triggers

Load this skill when the orchestrator (or the user) requests any of the
following — the dispatch matrix in `manifest.json` enumerates the canonical
keyword set.

| Trigger phrase | Routing decision |
|----------------|------------------|
| "research <topic>" | Direct invocation — proceed with multi-source pull |
| "investigate <area>" | Same as research; emphasize codebase + web blend |
| "explore options for <decision>" | Treat as research → ct-consensus-voter |
| "what does the literature say about X" | Web + Context7 lookup, no codebase |
| "audit current <subsystem> implementation" | Codebase-only research; skip web |
| "compare libraries for <use-case>" | Web + Context7 with `--research` flag |
| "due-diligence on <vendor/tool>" | Web + reputation + license scan |

The orchestrator's `cleo orchestrate spawn` prompt always carries a
`stage: research` hint when the task's `pipelineStage` field equals
`research`. The skill SHOULD honor that hint and SHOULD NOT advance the
pipeline stage on its own — that is the orchestrator's responsibility once
the research manifest entry is appended.

## Anti-Triggers (Do NOT Load)

The skill MUST NOT be loaded for the following requests because they belong
to sibling skills that have narrower context budgets and stricter contracts.

| Request | Correct skill |
|---------|---------------|
| "fix this failing test" | `ct-task-executor` |
| "write the spec for X" | `ct-spec-writer` |
| "validate this implementation against the spec" | `ct-validator` |
| "decompose this epic into tasks" | `ct-epic-architect` |
| "look up Next.js 15 middleware API" | `ct-docs-lookup` (single-library fetch) |
| "decide between A and B" (no investigation needed) | `ct-consensus-voter` |
| "explain this function" | (no skill — direct read suffices) |

A useful heuristic: if the user already knows the answer and just wants it
written down, route to `ct-spec-writer` or `ct-docs-write`. Research is for
when the answer is not yet known.

## Routing to Downstream Skills

Research outputs typically feed one of these next stages. The manifest
`chains_to` array enumerates the legal handoffs.

1. **`ct-spec-writer`** — when findings produce testable requirements.
   Pass the research file path and the synthesized recommendations as
   spec input. Use this when the task description contains "spec",
   "contract", "RFC", or "protocol".
2. **`ct-epic-architect`** — when findings change the scope estimate of
   an Epic. The architect re-decomposes based on the new evidence.
3. **`ct-consensus-voter`** — when research surfaces two-or-more viable
   options with comparable trade-offs. The voter resolves the choice
   under HITL when confidence < 0.5.
4. **`ct-task-executor`** — only when the research itself contains an
   actionable next step that does not require a spec (e.g. "bump the
   library version" or "delete deprecated path"). Rare.

## Decision Tree

```
Is the answer already known and just needs documentation?
├── YES → ct-docs-write
└── NO → continue
    │
    Is this a single-library API question?
    ├── YES → ct-docs-lookup
    └── NO → ct-research-agent (this skill)
        │
        After research, do findings produce requirements?
        ├── YES → ct-spec-writer next
        └── NO → continue
            │
            Do findings produce a decision between options?
            ├── YES → ct-consensus-voter next
            └── NO → return manifest only, no chain
```

## Stage Hint Compliance

The orchestrator's `pipeline_manifest` table tracks per-task stage
progression. The research skill MUST append exactly one entry with
`agent_type: "research"` and MUST NOT mutate stage fields directly. If
findings indicate a stage advance is warranted, the skill SHOULD include
that suggestion in `needs_followup` so the orchestrator can act on it.
