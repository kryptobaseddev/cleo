---
id: scaffolded-personas-parse-clean
tasks: [T14652]
kind: fix
summary: "@cleocode/core: personas scaffolded by cleo agent create now parse and validate with cant-core"
---
- `skills:` is an inline array instead of a YAML `- item` list, which
  cant-core rejected with `expected key: value`.
- `context_sources:` is a keyed sub-block (`patterns:`, `decisions:`,
  `learnings:`) with `on_overflow:` inside it, as JIT-001 requires.
- `mental_model.max_tokens` is lowered to the tier's TIER-002 cap, so
  `--tier low` and an orchestrator at `--tier mid` validate too.
