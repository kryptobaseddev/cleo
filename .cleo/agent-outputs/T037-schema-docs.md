# T037 — Consolidate Schema Documentation

**Epic:** T029 (Schema Architecture Review)
**Date:** 2026-03-21
**Status:** Complete

---

## Summary

Consolidated and updated all CLEO schema documentation to reflect the current state of all three databases (tasks.db, brain.db, nexus.db) including T033 composite indexes, T060 pipeline_stage column, full column descriptions, relationship mapping, and status registry values.

---

## Files Updated

### 1. `docs/architecture/DATABASE-ERDS.md` (primary update)

**Version**: 1.0.0 → 1.1.0

Changes made:
- Added column descriptions to ALL columns across all 37 tables
- Added `tasks.pipeline_stage` column (T060)
- Added `tasks.session_id` hard FK notation (T033 migration)
- Split FK legend into "Hard FKs" and "Intentional Soft FKs" sections
- Added T030 SFK audit references to each soft FK entry
- Added warning that `PRAGMA foreign_keys` is currently OFF (T030 finding)
- Added `idx_tasks_pipeline_stage` index (T060)
- Added all T033 composite indexes:
  - `idx_tasks_parent_status` (parent_id, status)
  - `idx_tasks_status_priority` (status, priority)
  - `idx_tasks_type_phase` (type, phase)
  - `idx_tasks_status_archive_reason` (status, archive_reason)
  - `idx_sessions_status_started_at` (status, started_at)
  - `idx_audit_log_session_timestamp` (session_id, timestamp)
  - `idx_audit_log_domain_operation` (domain, operation)
  - `idx_brain_observations_content_hash_created_at` (content_hash, created_at)
  - `idx_brain_observations_type_project` (type, project)
- Updated aggregate statistics table
- Added "Cross-Database Reference Map" section documenting all cross-DB soft FK relationships
- Added comprehensive "Status Registry Values" section with all enum values for all fields
- Added "Related Documents" section with cross-references

### 2. `docs/specs/SCHEMA-AUTHORITY.md` (correction)

Changes made:
- Fixed stale reference to `schema.ts` (file no longer exists) — replaced with correct file list:
  - `tasks-schema.ts`
  - `brain-schema.ts`
  - `chain-schema.ts`
  - `agent-schema.ts`
  - `nexus-schema.ts`
  - `packages/contracts/src/status-registry.ts` (ADR-018 SSoT)
- Updated migration paths from `drizzle/` to `packages/core/migrations/drizzle-tasks/` and `drizzle-brain/`
- Updated CLI commands from `npx` to `pnpm`
- Added step 6 (biome check) and step 7 (update DATABASE-ERDS.md) to contributor checklist

### 3. `docs/specs/CLEO-BRAIN-SPECIFICATION.md` (corrections)

Changes made:
- Section 2.1.3: Updated storage note to list all 9 shipped brain.db tables (was missing `brain_sticky_notes`, `brain_page_nodes`, `brain_page_edges`)
- Section 2.1.3: Added cross-reference to DATABASE-ERDS.md
- Appendix B: Fixed `~/.cleo/nexus.db` path to correct XDG path `~/.local/share/cleo/nexus.db`

---

## What Was NOT Changed

- `docs/specs/CLEO-NEXUS-ARCHITECTURE.md` — already comprehensive and accurate; section 3.1 documents all nexus.db tables with column descriptions matching the current schema
- `docs/specs/CLEO-DATA-INTEGRITY-SPEC.md` — not a schema doc; not changed
- No new files created (all updates were to existing files)

---

## Key Findings from Audit Sources (T030, T031)

### From T030 (Soft FK Audit)
- 23 soft FKs identified across tasks.db and brain.db
- 1 intentionally soft (audit_log.task_id — survives task deletion with 'system' sentinel)
- 5 cross-database (brain.db → tasks.db) — cannot use SQLite native FKs
- 17 intra-database candidates for hardening (T032 remediation task)
- PRAGMA foreign_keys = OFF on both databases (compounding risk — hard FKs not enforced)

### From T031 (Index Analysis)
- 11 composite indexes recommended; all added by T033 migration
- Most impactful: idx_tasks_parent_status (every hierarchy render), idx_sessions_status_started_at (getActiveSession hot path)
- idx_brain_observations_content_hash now superseded by composite (both retained per schema)
