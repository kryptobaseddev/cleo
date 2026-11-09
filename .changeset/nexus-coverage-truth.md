---
id: nexus-coverage-truth
tasks: [T12350, T14377]
kind: fix
summary: "NEXUS stops re-parsing unchanged files that fail with E_PARSE_SYNTAX and stops requesting SQL capabilities no extractor provides, so coverage reports only real gaps"
---

- **Cached syntax failures (T12350).** A file whose parse fails with
  `E_PARSE_SYNTAX` is a pure function of its bytes and the fingerprinted
  grammar, so the failure is now stored in the parse cache under its content
  hash. An incremental run reports the unchanged file as a failed gap again
  without re-parsing it; a changed file, or a new extractor build, parses it
  afresh. Timeouts and read errors are never cached.
- **SQL coverage (T14377).** SQL files requested `sql-*` capabilities that no
  extractor implements, so every SQL file stayed incomplete forever. A SQL file
  now requests only file evidence, which it gets; the unassessed schema and
  reference semantics stay stated as limitations. A real SQL extractor is
  tracked as a follow-up task.
