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
