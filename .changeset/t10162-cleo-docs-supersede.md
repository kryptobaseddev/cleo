---
id: t10162-cleo-docs-supersede
tasks: [T10162]
kind: feat
summary: cleo docs supersede <oldSlug> <newSlug> — atomic SQLite transaction that flips lifecycle_status to 'superseded' on the old row and links both rows via the supersedes/superseded_by self-FK pointers (T10162 / Saga T9855 / E12)
---
