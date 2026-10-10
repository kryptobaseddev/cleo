---
id: t13338-manifest-needs-followup
tasks: [T13338]
kind: fix
summary: manifest list tolerates a legacy boolean needs_followup, reports a bad entry on its own, and append rejects wrongly typed fields
---

`cleo manifest list` failed with `E_MANIFEST_METADATA_INVALID` when one entry stored `needs_followup` as a boolean: `pipelineManifestAppend` checked required fields but not their types, so an agent's `--entry` JSON with `"needs_followup": true` was stored as is. Append now checks every metadata field against the reader's contract and rejects a wrong type with `E_VALIDATION_FAILED` naming the field. The reader accepts the legacy boolean (`false` → `[]`, `true` → one "follow-up needed (no task named)" item). `manifest list`, `find`, `pending` and `stats` set aside any entry whose metadata still violates the contract and report it per entry (`malformed`, with `malformedRemedy: cleo doctor manifest-rows --repair`) instead of failing the whole command.
