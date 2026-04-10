# CleoOS Starter Bundle

Default CANT agent and team definitions deployed on `cleoos init`. These
files give every new CleoOS project a working multi-agent team topology out
of the box, so the CANT bridge has something to compile on first run.

## Contents

| File | Kind | Purpose |
|------|------|---------|
| `team.cant` | `team` | Declares the **Starter Team** with one orchestrator, one lead, and two workers |
| `agents/cleo-orchestrator.cant` | `agent` | **Orchestrator** (tier: high) — coordinates the team, dispatches to dev-lead |
| `agents/dev-lead.cant` | `agent` | **Lead** (tier: mid) — decomposes tasks, dispatches to workers. No Edit/Write/Bash |
| `agents/code-worker.cant` | `agent` | **Worker** (tier: mid) — writes code, runs tests within declared file globs |
| `agents/docs-worker.cant` | `agent` | **Worker** (tier: mid) — writes documentation within declared doc globs |

## Team Topology

```
cleo-orchestrator (orchestrator, high)
  dev-lead (lead, mid)
    code-worker (worker, mid)
    docs-worker (worker, mid)
```

## Customization

These files are copied into your project at `.cleo/cant/` during
initialization. Edit them freely to match your project structure:

- Add new workers for specialized domains (e.g., `test-worker.cant`)
- Adjust `permissions.files.write` globs to match your source layout
- Add `context_sources` queries relevant to your codebase
- Modify `skills` lists to load project-specific skills

## CANT Syntax Reference

Every `.cant` file requires frontmatter:

```cant
---
kind: agent    # or team, tool, mental-model
version: "1"
---
```

See `docs/plans/CLEO-ULTRAPLAN.md` sections 8-10 for the full grammar
specification, tier caps, and hierarchy rules.
