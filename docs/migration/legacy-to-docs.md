# Migrating Legacy `.cleo/` Markdown to the Docs SSoT

CLEO projects accumulate hundreds (sometimes thousands) of free-floating
markdown files under `.cleo/research/`, `.cleo/adrs/`, and
`.cleo/agent-outputs/` over their lifetime. Until Saga T9625 these files
were only addressable by filesystem path — they could not be fetched by
slug, searched semantically, or linked to tasks.

`cleo docs import` (Epic T9628) walks one of these legacy trees and
streams every `.md` it finds into the docs SSoT (`.cleo/blobs/`). The
import is content-addressed and idempotent: re-running on the same
corpus rewrites the manifest entries but never duplicates blob bytes.

> **TL;DR**: `cleo docs import .cleo --json --audit-manifest .cleo/docs-import.json`

## What gets migrated

The scanner walks the directory you point it at and classifies each
markdown file by its source-dir prefix:

| Source-dir prefix                       | CLI import type | `DocKind` written              |
|-----------------------------------------|-----------------|--------------------------------|
| `.cleo/adrs/*.md`                       | `adr`           | `adr` (manifest.db)            |
| `.cleo/research/*.md`                   | `research`      | `agent-output` (manifest.db)   |
| `.cleo/agent-outputs/*.md`              | `note`          | `agent-output` (manifest.db)   |
| `docs/specs/*.md` and `docs/**/*.md`    | `spec`          | `agent-output` (manifest.db)   |
| anything else                           | `note`          | `agent-output` (manifest.db)   |

The CLI-level `importType` is preserved on `meta.importType` so future
queries can recover the original classification without rescanning.

Each imported blob is keyed by SHA-256 of its UTF-8 bytes. The original
file at its legacy path is **not modified** — the migration is purely
additive. See the deprecation policy below.

## Running a migration

```bash
# Dry-run first to preview what would be imported. Writes no blobs and
# no audit manifest. Counters still report scan/import/noop/error split.
cleo docs import .cleo --dry-run --json

# Real import. Writes blobs to .cleo/blobs/blobs/<sha> and an audit
# manifest to <project-root>/docs-import-<ts>.json by default. Override
# the manifest path with --audit-manifest.
cleo docs import .cleo --json --audit-manifest .cleo/docs-import.json
```

For a fresh clone with no existing docs SSoT, this is the only command
you need — `cleo` provisions `.cleo/blobs/manifest.db` on first write.

### Useful flags

- `--dry-run` — preview only, never write
- `--force` — bypass SHA-dedup. Logged to
  `.cleo/audit/import-force-bypass.jsonl` for traceability
- `--audit-manifest <path>` — override the audit-manifest output path
- `--json` — emit the LAFS JSON envelope (default for agent callers)

## Counter-integrity invariant (T9709)

Every import enforces:

```
scanCount === importCount + noopCount + errorCount
```

If the sum diverges from the scan count the CLI exits non-zero with
`E_COUNTER_MISMATCH` and the audit manifest is not written. This catches
silent skips (e.g. a `continue` that forgets to bump a counter) before
they corrupt downstream provenance work.

## Validation against the cleocode repo

The migration was validated end-to-end against this repo on 2026-05-19:

| Metric                          | Value      |
|---------------------------------|------------|
| `find ... -name '*.md'` count   | 1272       |
| `scanCount`                     | 1272       |
| `importCount`                   | 1268       |
| `noopCount`                     | 2          |
| `errorCount`                    | 2          |
| Counter-integrity sum           | 1272 (✓)   |
| 10-file round-trip byte-equality| 10/10 PASS |

The four non-imports break down as:

- **Two `noop` rows** — both files happened to have the same SHA-256 as
  an earlier file in the same scan (the in-run dedup set catches this).
- **Two `error` rows** — both files are named `import.md` and the slug
  generator refuses to emit reserved slugs (`import`, `export`, etc.) to
  avoid colliding with reserved subcommands once the SSoT is exposed
  over CLI.

All four cases are legitimate; rerunning with `--force` is not
recommended because it would mint blob duplicates without resolving the
underlying slug conflict.

## Deprecation policy for legacy files

The import is **additive**. After running it the pre-existing markdown
files remain in place under `.cleo/research/`, `.cleo/adrs/`, and
`.cleo/agent-outputs/`. We deliberately do not rewrite, move, or delete
them because:

1. Many of those files are referenced by hard-coded paths in older agent
   outputs and ADR cross-links. Renaming them would break the
   historical record.
2. The docs SSoT can serve them by slug or SHA-256 once imported, so
   nothing is *gained* by deleting the originals.
3. Audit and forensics workflows benefit from the original filesystem
   layout staying intact.

If you want to encourage callers to migrate to slug-based fetch, add a
short frontmatter banner to the legacy files:

```markdown
> **Deprecated path** — fetch via `cleo docs fetch <slug-or-sha>` instead.
```

The banner is **not** rewritten automatically by `cleo docs import`;
adding it is a one-time editorial choice per project. The CLI's
deprecation policy is "leave bytes alone, audit the import".

## CI smoke test

A minimal smoke script lives at `scripts/docs-import-smoke.mjs`. It
copies a tiny corpus into a tmp project root, runs the import, and
asserts the counter-integrity invariant. Run it ad-hoc with:

```bash
node scripts/docs-import-smoke.mjs
```

## Troubleshooting

- **`E_COUNTER_MISMATCH`** — the scanner found more files than the
  counters add up to. Re-run with `--dry-run` and inspect
  `entries[].action` to find the missing classifications. File an issue
  with the audit manifest attached.
- **`slug "<x>" is reserved`** — the file's name collides with the
  slug-generator's reserved list (e.g. `import`, `export`). Rename the
  source file or accept the `error` row.
- **High `noopCount` on first run** — multiple source files genuinely
  contain identical bytes. Confirm with `sha256sum` on the source paths;
  the dedup is by content, not by name.
- **`docs fetch` returns `E_NOT_FOUND`** — the `cleo docs fetch`
  subcommand currently reads from the legacy attachment store, not the
  new docs SSoT. Round-trip verification today goes through the
  content-addressed blob at `.cleo/blobs/blobs/<sha>`. Full read-side
  parity is tracked under the T9064 follow-up.

## See also

- `packages/core/src/docs/import/` — implementation (scanner, slug,
  dedup, audit, orchestrator).
- ADR-068 — DB Charter (manifest.db write-ownership table).
- Saga T9625 — full migration roll-up.
