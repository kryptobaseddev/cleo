---
id: t12247-safe-index-evidence
tasks: [T12247]
kind: fix
summary: Publish validated graph generations atomically and expose incomplete extraction
---

Index rebuilds stage a replacement graph before atomic publication. Failure or concurrent source edits retain the previous usable generation. Content hashes detect edits that preserve size and timestamps, while freshness checks include tracked and newly staged files.

Explicit nested repository inclusion preserves project identity and source ownership. Walking honors Git ignore, info/exclude, and configured global excludes. Index results report analyzed, excluded, unsupported, oversized, and failed files with revision and content provenance.

Module import resolution supports qualified workspace source paths without inventing declarations absent from the parsed graph. Unresolved supported import scopes produce explicit partial-coverage diagnostics, with detailed references available through Nexus status.

Code placed in packages/nexus/ for index extraction and publication primitives, packages/core/ for project orchestration and coverage, and packages/contracts/ for shared graph metadata per Package-Boundary Check — verified against AGENTS.md.
