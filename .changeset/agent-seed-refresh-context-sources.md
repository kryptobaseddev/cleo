---
id: agent-seed-refresh-context-sources
tasks: [T14654]
kind: fix
summary: "cleo agent doctor refreshes an unedited seed that no longer parses, and context_sources and on_overflow reach the compiled CANT bundle"
---

- `cleo agent doctor` parses every installed `.cant` file with the CANT parser.
  A file that does not parse is reported as D-007. When it is an unedited seed
  (its digest equals the installed one) and a packaged template of the same
  name ships, `cleo agent doctor --repair` refreshes it from that template;
  otherwise the finding names the file and the reinstall command and the file
  is left alone.
- `compileBundle` rebuilds the keyed `context_sources:` block from the parser's
  flat property list, so `contextSources` and `onOverflow` carry the template's
  values instead of the defaults.
- The refresh proves a file is unedited with a new local-only
  `agent_registry_agents.seed_sha256` column, written only when a packaged
  template is installed. A D-003 hash refresh never touches it, and a file
  that D-003 flags in the same run is never refreshed. Rows installed before
  the column have no proof and are reported instead.
- `installAgentFromCant` writes through a temp file and a rename. It keeps the
  bytes it replaces as `<file>.bak-<instant>`, and restores them when the row
  write fails.
- When the parser cannot load, `cleo agent doctor` reports D-012 instead of
  skipping the parse check silently.
