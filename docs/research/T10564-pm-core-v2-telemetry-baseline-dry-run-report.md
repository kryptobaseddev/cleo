# T10564 PM-Core V2 telemetry baseline and dry-run report

Task: T10564
Saga: T10538 PM-Core V2
Slug: `t10564-pm-core-v2-telemetry-baseline-dry-run-report`
Type: research
Captured: 2026-05-25T21:45:10.212Z

This research note is the docs SSoT payload for the PM-Core V2 Wave 0 telemetry baseline plus the copied-DB dry-run report. It is intended to be attached with `cleo docs add T10564 ... --type research --slug t10564-pm-core-v2-telemetry-baseline-dry-run-report` and fetched by that slug.

## Question

What baseline telemetry and copied-database dry-run evidence should be visible in the docs SSoT before PM-Core V2 proceeds beyond Wave 0, and what conflicts must downstream owners see before any real migration apply?

## Findings

### Telemetry baseline

Source database: `/mnt/projects/cleocode/.cleo/tasks.db` (read-only queries).

| Metric | Value |
| --- | ---: |
| Total tasks | 3570 |
| Active tasks | 3 |
| Pending tasks | 613 |
| Done tasks | 1063 |
| Archived tasks | 1828 |
| Cancelled tasks | 61 |
| Proposed tasks | 2 |
| Task rows with blank/null status | 0 |
| Relation rows with missing endpoint | 2 |
| Duplicate docs slugs | 0 |
| Existing rows for this report slug before attach | 0 |

Task type baseline:

| Type | Count |
| --- | ---: |
| null | 174 |
| epic | 528 |
| saga | 1 |
| subtask | 543 |
| task | 2324 |

Task priority baseline:

| Priority | Count |
| --- | ---: |
| critical | 437 |
| high | 1480 |
| medium | 1554 |
| low | 99 |

Workgraph relation baseline:

| Relation type | Count |
| --- | ---: |
| absorbs | 10 |
| blocks | 63 |
| duplicates | 2 |
| extends | 9 |
| fixes | 4 |
| grouped-by | 4 |
| groups | 171 |
| related | 92 |
| supersedes | 23 |

Docs SSoT attachment baseline:

| Doc type | Count |
| --- | ---: |
| null | 11 |
| adr | 103 |
| changeset | 122 |
| handoff | 9 |
| llm-readme | 1 |
| note | 1217 |
| plan | 7 |
| research | 1039 |
| spec | 143 |

### Copied-DB dry-run report

Dry-run command:

```bash
node scripts/t10562-copied-db-migration-dry-run.mjs \
  --live-db /mnt/projects/cleocode/.cleo/tasks.db \
  --copy-db tmp/t10564/tasks-dry-run-copy.db
```

Dry-run status: `pass`.

| Would-change counter | Count |
| --- | ---: |
| wouldCreate | 1 |
| wouldUpdate | 1 |
| wouldDelete | 1 |

Live DB integrity observed by the dry-run:

| Field | Value |
| --- | --- |
| liveBefore sha256 | `eab4e4a8e7cd6611328ddc99fb1df6e1ff5a8b356cab35978206be12c7df01b8` |
| liveAfter sha256 | `eab4e4a8e7cd6611328ddc99fb1df6e1ff5a8b356cab35978206be12c7df01b8` |
| liveBefore/liveAfter size | `119189504` bytes |
| copy path under worktree tmp | `true` |

Rollback plan emitted by the dry-run:

1. Do not replace or promote `/mnt/projects/cleocode/.cleo/tasks.db`; it was not modified by this dry-run.
2. Delete dry-run copy `tmp/t10564/tasks-dry-run-copy.db` to discard simulated changes.
3. If a future real migration fails after promotion, restore the pre-migration backup and verify sha256/inode metadata before reopening CLEO.

### Conflict summary

Visible conflict summary for Wave 0 owners:

- Docs slug conflict: none detected before attach (`duplicateSlugs = 0`, target slug rows = 0).
- Telemetry data conflict: relation endpoint drift detected (`relationsDangling = 2`); PM-Core V2 migration planning must either reconcile these two dangling relation rows or explicitly waive them before real apply.
- Dry-run mutation conflict: none detected against the live DB; the live DB hash and size matched before and after the copied-DB dry-run.
- Apply sequencing conflict: real migration apply remains blocked until the T10563 backup/restore rehearsal evidence is present and passing for the same target database.

## Sources

- `scripts/t10562-copied-db-migration-dry-run.mjs`
- `scripts/t10563-pm-core-v2-backup-restore-rehearsal.mjs`
- `docs/research/T10563-pm-core-v2-backup-restore-rehearsal.md`
- Read-only SQLite telemetry queries against `/mnt/projects/cleocode/.cleo/tasks.db` on 2026-05-25T21:45:10.212Z.
