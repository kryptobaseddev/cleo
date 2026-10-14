---
id: t13678-research-link-merge
tasks: [T13678]
kind: fix
summary: cleo research link and update no longer replace a manifest entry's title, topics, findings and links
---

`cleo research link <id> <task>` sent a whole new manifest entry through
`manifest.append` under the same id: a "Link: <id> -> <task>" title, empty
topics and findings, and `linked_tasks` set to the one task. The append
upserts, so the original research (title, topics, every key finding, earlier
links) was replaced. `cleo research update` did the same, clearing links and
topics and resetting the status to `partial` whenever a flag was left out.

Both now call a new `pipeline.manifest.update` operation
(`pipelineManifestUpdate` in core). In one transaction it changes only the
fields given: `linkTask` is added to `linked_tasks` (no duplicates, never
removing one), and title, topics, key findings and status change only when
passed. An unknown id fails `E_NOT_FOUND` and writes nothing, and a link to a
malformed or missing task is refused before any write.
