---
id: drop-startup-legacy-cleanup
tasks: [T14315]
kind: refactor
summary: "the CLI no longer runs the legacy cleanup sweep on start or writes .cleanup-* markers; doctor legacy-backups --prune removes the old markers"
---

Every CLI start imported `store/cleanup-legacy` and, once per (version,
project), swept for files from before v2026.4.11 and wrote a zero-byte
`<cleoHome>/.cleanup-<version>-<hash>` marker that nothing ever pruned:
4,053 of them on one machine.

- The startup sweep and its marker helpers (`getCleanupMarkerPath`,
  `isCleanupMarkerSet`, `setCleanupMarker`) are gone. The cleanup itself stays
  reachable through `cleo doctor --scan-stray-nexus-dbs`.
- `cleo doctor legacy-backups` lists each existing marker (origin
  `cleanup-marker`) and `--prune` removes them; it stays a dry run unless
  `--no-dry-run` is passed.
- The portable-bundle scan no longer carries a `.cleanup-*` exclusion.

Ledger: adds nothing; deletes the startup sweep, its markers and its
bundle-scan exclusion.
