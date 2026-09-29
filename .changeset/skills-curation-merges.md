---
id: skills-curation-merges
tasks: [T12649]
kind: refactor
summary: Skills curated per D11157 — 29 skill directories become 21; docs, memory, sticky and skill-authoring skills merged, three retired, ct-codebase-mapper rebuilt around nexus
---

Part 2 of T12649 applies the curation that owner decision D11157 approved.

- **Merged into ct-documentor:** ct-docs-write and ct-docs-review, as
  `references/writing.md` and `references/reviewing.md`, with their
  references and tests.
- **Merged into ct-cleo:** ct-memory and ct-stickynote, as
  `references/memory.md` and `references/sticky-notes.md`. Sticky notes are a
  core feature. The memory guide no longer claims the file bridge is always
  loaded (`cleo memory digest` is the default).
- **Merged into ct-skill-author (internal, new):** ct-skill-creator and
  ct-skill-validator. The validator's scripts, agents, evals and references
  moved with it, and the depth-check workflow and test now point at
  `ct-skill-author/scripts/check_depth.py`. Tracked `__pycache__` files were
  dropped.
- **Retired:**
  - ct-docs-lookup: use the Context7 MCP directly.
  - ct-master-tac: a drifting copy of core's `.cant` protocols, with an
    install hook that did not exist.
  - signaldock-connect: copied to the SignalDock repository at
    `skills/signaldock-connect`. CLEO reaches SignalDock through `cleo conduit`.
- **Rewritten:** ct-codebase-mapper (2.0.0) now orients with
  `cleo nexus status/clusters/flows/impact/context` plus `cleo map`. The
  MCP-era `query admin map` syntax is gone.
- **Code references updated:**
  - `SKILL_NAME_MAP`: docs aliases now resolve to ct-documentor.
  - The docs-worker agent template and scaffold no longer list ct-docs-write,
    and the cleo-historian seed agent no longer lists ct-docs-review.
  - The `full` profile no longer names internal or retired skills.
  - The skills README tables are regenerated from the manifest.
- **Gate 31:** the baseline is now empty; every skill is clean under
  `--strict`.
