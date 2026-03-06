# Doc Fix Complete: Mintlify Stale Registry References

**Date**: 2026-03-05
**Scope**: Documentation only — no src/, test, schema, or ADR files touched.

---

## File 1: docs/mintlify/guides/project-registry.mdx

### Changes made

1. **Migration notice added after the frontmatter heading** (before "Overview"):

   ```
   > **Note**: As of 2026.3, the global registry has migrated from
   > `~/.cleo/projects-registry.json` to `~/.cleo/nexus.db` (SQLite).
   > Legacy JSON files are automatically migrated on first use. See the
   > CLEO NEXUS Specification for current architecture.
   ```

2. **"File Locations > Global Registry" Location field updated**:
   - Before: `~/.cleo/projects-registry.json`
   - After: `~/.cleo/nexus.db` (SQLite), with an inline legacy callout noting the old path was used prior to 2026.3.

3. **Architecture diagram updated**:
   - Before: `~/.cleo/projects-registry.json` in the Two-Tier ASCII diagram
   - After: `~/.cleo/nexus.db (SQLite)` in the diagram

### Remaining references (contextually correct)

- Line 12: Migration notice itself cites the old path as "migrated from" — appropriate.
- Line 51: Explicit legacy callout block.
- Lines in historical "Upgrade Path" and "See Also" sections — all within properly contextualized legacy/migration content.

---

## File 2: docs/mintlify/developer/specifications/CLEO-NEXUS.mdx

### Changes made

The file was already corrected (by a prior session) before this pass ran. The Registry Layer
in the architecture diagram (line 74-75) already reads:

```
│   - ~/.cleo/nexus.db (SQLite, primary storage)          │
│   - Legacy: ~/.cleo/projects-registry.json (migrated)   │
```

No additional edits were required. The single remaining reference to `projects-registry.json`
is explicitly labeled "Legacy ... (migrated)" — correct.

---

## File 3: docs/mintlify/migration/hybrid-registry-migration.md

### Changes made

The file was already corrected (by a prior session) before this pass ran. The deprecation
notice is present at line 1:

```
> **SUPERSEDED**: This migration guide describes the pre-v0.69 transition from single to
> hybrid JSON registry. As of 2026.3, the registry backend is SQLite (`~/.cleo/nexus.db`).
> The JSON-to-SQLite migration is automatic. See [CLEO NEXUS Specification]
> (../../specs/CLEO-NEXUS-SPECIFICATION.md) for current architecture.
```

The two remaining body references to `projects-registry.json` (lines 19 and 36) are inside
historical "Before/After" sections that document the old architecture — appropriate because
the entire document is now marked SUPERSEDED at the top.

---

## Validation results

```
docs/mintlify/guides/project-registry.mdx
  line 12  — migration notice ("migrated from ...")      OK: deprecation context
  line 51  — legacy callout ("used prior to 2026.3")    OK: deprecation context

docs/mintlify/developer/specifications/CLEO-NEXUS.mdx
  line 75  — "Legacy: ... (migrated)"                   OK: deprecation context

docs/mintlify/migration/hybrid-registry-migration.md
  line 19  — historical "Before" diagram                OK: document is SUPERSEDED
  line 36  — historical "After" diagram                 OK: document is SUPERSEDED
```

No remaining reference presents `projects-registry.json` as the current live backend.

## Status: COMPLETE
