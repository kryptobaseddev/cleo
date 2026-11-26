---
id: agent-templates-parse-clean
tasks: [T14643]
kind: fix
summary: "@cleocode/agents: the five project-* agent templates now parse and validate with cant-core"
---
- `skills:` and `workers:` are inline arrays instead of YAML `- item` lists,
  which cant-core rejected with `expected key: value`.
- `context_sources:` is a keyed sub-block (`patterns:`, `decisions:`,
  `learnings:`) with `on_overflow:` inside it, as JIT-001 requires.
- The `template_project_*_parses_clean` tests in cant-core run again (no
  longer ignored), and the templates README names the real files.
