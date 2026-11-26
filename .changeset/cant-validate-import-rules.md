---
id: cant-validate-import-rules
tasks: [T14603]
kind: fix
summary: "cleo cant validate now walks a file's imports and reports circular imports (S03), over-deep import chains (S11) and imported agents that escalate permissions (S12)"
---

The CANT validator never called S03 or S12, and S11 ran against an empty
import chain, so a document with cyclic imports validated cleanly.

- `cant_core::validate_document_file` (and the optional `filePath` argument of
  `cantValidateDocument`) resolves imports from the file and runs S03, S11 and
  S12 over the import graph. `cleo cant validate` passes the path.
- `cleo cant validate --help` states the true rule count: 41 of the 42
  numbered rules (S04 is not implemented) plus 8 hierarchy lints.
