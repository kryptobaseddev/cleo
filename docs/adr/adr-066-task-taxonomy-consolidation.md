# ADR-066: Task Taxonomy Consolidation — `--kind` Canonical, AC-Everywhere, System-Wide Severity Attestation

- **Status**: Accepted
- **Date**: 2026-05-08
- **Tasks**: T9067 (epic), T9068 (R1 role consumer audit), T9069 (R2 scope analysis), T9071 (W3 severity attestation), T9072 (W1 help/validator drift), T9073 (W2 role→kind rename), T9074 (W4 scope deletion), T9075 (W5 cleo bug deletion), T9076 (W6 docs + ADR)
- **Cross-references**: T1910 (paths SSoT epic), T1882 (paths package), ADR-064 (CAAMP↔adapters boundary), T9077 (hygiene follow-up)

## Context

Prior to the T9067 consolidation, CLEO's task taxonomy carried several forms of accumulated drift:

### `cleo bug` shim (242 LOC)

`packages/cleo/src/cli/commands/bug.ts` was a dedicated command for creating bug-report tasks.
It had three interconnected problems:

1. **Silent `--acceptance` drop**: the shim forwarded its arguments to the task-creation
   dispatch but omitted the `--acceptance` flag. This meant any `cleo bug --acceptance "..."` call
   silently discarded the acceptance criteria, breaking block-mode enforcement for P0+ bugs.
2. **Severity attestation coupling**: Ed25519-signed severity attestation
   (`appendSignedSeverityAttestation`, `canonicalAttestationJson`, `loadOwnerPubkeys`) lived
   exclusively in `bug.ts`. This made it impossible to require attestation on any task created
   through `cleo add --kind bug` or on severity-flagged non-bug tasks.
3. **Redundant surface**: everything `cleo bug` provided was achievable with
   `cleo add --kind bug --severity Px --acceptance "..."`. The shim offered no unique capability.

### `--role` vs `--kind` flag confusion

The CLI exposed both `--role` and `--kind` as synonyms where `--kind` was documented as "an
alias for `--role` (T944 fractal-ontology compat)". The internal type was named `TaskRole` with
6 declaration sites across `packages/contracts/` and `packages/core/`. This was a naming inversion:
`--kind` was the descriptively correct term (task intent kind: work, research, experiment, bug,
spike, release), while `--role` was the legacy holdover. CLI help, the TypeScript type, the DB
column, and the validator all used `role`, causing confusion about which term was canonical.

### `TaskScope` vestigial field

`TaskScope` (`project | feature | unit`) was introduced in T944 alongside `TaskRole`. R2 research
(T9069) found it load-bearing in zero consumers: no filter, no facet, no BRAIN typed-promotion, no
sentient logic used scope distinctly from `--type` (epic/task/subtask). The field existed in 16+
files, the schema migration, and the DB column, but carried no semantic weight downstream.

### Acceptance-criteria exemption for bug tasks

The `cleo bug` shim created tasks without requiring `--acceptance`. Owner directive (2026-05-06):
acceptance criteria are required for ALL tasks regardless of `--kind`. No bug exemption exists.

### Precedent

ADR-064 (CAAMP↔Adapters Boundary, 2026-05-06) established the pattern for SSoT cleanup:
identify the correct owner of each concern, write an ownership matrix, and remove all duplicate
implementations. The T9067 epic applies the same pattern to the task taxonomy layer.

## Decision

Three concerns in the task taxonomy are given a canonical owner. All other representations
are removed.

### Ownership Matrix

| Concern | Owner | Notes |
|---------|-------|-------|
| Task structural type (parent/leaf hierarchy) | `TaskType` (`epic \| task \| subtask`) | Locked. Not overloaded with intent. CLI flag: `--type`. |
| Task intent / kind | `TaskKind` (`work \| research \| experiment \| bug \| spike \| release`) | Renamed from `TaskRole`. CLI flag: `--kind` (canonical). `--role` does not exist. |
| Task severity (defect impact) | `TaskSeverity` (`P0 \| P1 \| P2 \| P3`) | Orthogonal to priority. System-wide: fires for any task with `--severity`, not only `--kind bug`. Stored in `.cleo/audit/severity-attestation.jsonl`. |
| Task scope (project/feature/unit) | **DELETED** | Vestigial per R2 verdict (T9069). Zero load-bearing consumers. Removed from contracts, schema, CLI, and 16+ call sites. |
| Acceptance criteria | Required for ALL tasks regardless of `--kind` | No exemption for `bug` or any other kind. |

### Canonical CLI Patterns (post-consolidation)

```bash
# Create a bug with severity and acceptance criteria
cleo add "Fix null-deref in task loader" --kind bug --severity P1 \
  --acceptance "Null input returns E_VALIDATION, not uncaught exception"

# Create a P0 bug (triggers severity attestation)
cleo add "Auth bypass on anonymous requests" --kind bug --severity P0 \
  --acceptance "Anonymous POST to /api/tasks returns 401"

# Create a spike (no severity needed)
cleo add "Investigate SQLite WAL tuning options" --kind spike \
  --acceptance "Options table with pros/cons and recommended setting documented"

# Severity attestation fires for any --severity flag, regardless of --kind
cleo add "Performance regression in find" --kind work --severity P2 \
  --acceptance "p99 latency under 50ms on 10k-task DB"
```

### Invariants

1. **`--kind` is the canonical flag.** `--role` does not appear in CLI help, validators,
   or documentation. No tombstone. No deprecated re-export of `TaskRole`.
2. **`cleo bug` does not exist.** No command, no alias, no shim. Attempting to call it returns
   a "command not found" error. Bug tasks are created exclusively with
   `cleo add --kind bug --severity Px --acceptance "..."`.
3. **Severity attestation is a system-wide primitive.** The
   `appendSignedSeverityAttestation` function lives in
   `packages/core/src/tasks/severity-attestation.ts` and is called by the task-creation
   path for any task that carries a `--severity` value, regardless of `--kind`.
4. **`--scope` does not exist.** The `TaskScope` type, the `scope` DB column, and all
   CLI/dispatch/filter/schema references have been removed.
5. **Acceptance criteria are required for all tasks.** The AC gate is enforced at
   task-creation time with no exemption path for any `--kind` value.
6. **`cleo issue` is preserved.** The issue command (GitHub issue filing for the CLEO
   project repository) is orthogonal to this taxonomy and was not part of T9067 scope.

## Consequences

### Positive

- **-242 LOC**: `cleo bug` command removed entirely (T9075).
- **+1 shared primitive**: severity attestation now callable by any task-creation path.
- **Closed help/validator drift**: 4 stale `--type` references in CLI help and the validator
  cleaned up in W1 (T9072).
- **Simpler mental model**: task intent lives exclusively in `--kind`; hierarchy in `--type`;
  severity impact in `--severity`. Three orthogonal axes, no overlapping field names.
- **AC-everywhere enforced**: no silent criteria drops. Block-mode enforcement is reliable.
- **ADR-064 boundary preserved**: adapters, CAAMP, and paths packages are not touched.

### Negative / Trade-offs

- **DB migration required**: the `role` column is not renamed to `kind` in this epic (the DB
  column rename is deferred; the CLI/type rename is complete). The Drizzle schema uses `kind`
  as the TypeScript property name mapped to the `role` column via `.mapWith()`. A future
  migration task should rename the column for full consistency.
- **No backward-compat shim for `--role`**: owner directive was explicit — no tombstone, no
  deprecated re-export. Any script or agent prompt that used `--role` must be updated.

## Drift Detection

Future taxonomy drift can be caught by:

1. `grep -rn 'cleo bug\b' docs/ packages/ ~/.cleo/templates/` — must return zero hits.
2. `grep -rn 'TaskRole\b' packages/` — must return zero hits after full rename.
3. `grep -rn -- '--role\b' packages/cleo/src/cli/commands/` — must return zero hits
   in help/description strings.
4. `grep -rn 'TaskScope\b' packages/` — must return zero hits.
5. `cleo doctor` reports no unknown CLI surface for `bug` subcommand.

## Cross-References

- **T1910**: paths SSoT epic (filed independently; T9067 relates to T1910 because both address
  accumulated drift via the same SSoT pattern — different code domains).
- **T1882**: `@cleocode/paths` package (ADR-064 context).
- **ADR-064**: CAAMP↔Adapters Ownership Boundary — precedent for ownership-matrix approach.
- **T9067**: parent epic (9 children, waves 0–2 + docs).
- **T9068**: R1 — TaskRole consumer audit (confirmed 6 declaration sites, 30+ consumers).
- **T9069**: R2 — TaskScope load-bearing analysis (verdict: DELETE, 16 files + 1 test + 1 migration).
- **T9071**: W3 — severity attestation extracted to system-wide primitive in `packages/core/`.
- **T9072**: W1 — help/validator drift closed (4 stale `--type` sites).
- **T9073**: W2 — `TaskRole` → `TaskKind`, `--role` → `--kind` rename across contracts + core + CLI.
- **T9074**: W4 — `TaskScope` deleted from 16+ files, schema migration, and DB column.
- **T9075**: W5 — `cleo bug` command deleted (no shim, no tombstone, no alias).
- **T9077**: hygiene follow-up epic (post-T9067 cleanup items).
