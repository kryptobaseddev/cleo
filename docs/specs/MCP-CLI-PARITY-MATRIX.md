# MCP-CLI Parity Matrix

**Version**: 1.0.0  
**Status**: stable  
**Date**: 2026-02-10  
**Scope**: Deployed MCP implementation parity against canonical MCP contract and CLI surface

---

## 1. Data Sources

- MCP query operation registry: `mcp-server/src/gateways/query.ts`
- MCP mutate operation registry: `mcp-server/src/gateways/mutate.ts`
- MCP schema registry baseline: `mcp-server/schemas/index.json`
- CLI command index: `docs/commands/COMMANDS-INDEX.json`
- MCP domain handler CLI mappings: `mcp-server/src/domains/*.ts`

---

## 2. Machine-Diff Summary

### 2.1 Operation Count Comparison

| Source | Query | Mutate | Total |
|--------|------:|-------:|------:|
| Gateway registries (deployed) | 56 | 51 | 107 |
| Schema registry baseline | 46 | 47 | 93 |
| Delta (deployed - baseline) | +10 | +4 | +14 |

### 2.2 Schema Coverage

| Check | Result |
|------|--------|
| Schema operations missing in gateways | 0 |
| Gateway operations beyond schema baseline | 14 |

Interpretation:
- Baseline contract operations are fully implemented.
- Deployment includes 14 parity extensions beyond baseline schema registry.

---

## 3. Extension Operations (Gateway-Only)

### 3.1 Query Extensions (10)

- `query:tasks.relates`
- `query:system.job.status`
- `query:system.job.list`
- `query:system.dash`
- `query:system.roadmap`
- `query:system.labels`
- `query:system.compliance`
- `query:system.log`
- `query:system.archive-stats`
- `query:system.sequence`

### 3.2 Mutate Extensions (4)

- `mutate:tasks.relates.add`
- `mutate:system.job.cancel`
- `mutate:system.safestop`
- `mutate:system.uncancel`

Classification: **intentional parity extensions** (documented implementation growth, including T4269 additions).

---

## 4. CLI Mapping Risk Scan

A static scan of MCP domain handler inline CLI mapping comments identified command tokens that are not canonical CLI command IDs in `docs/commands/COMMANDS-INDEX.json`:

- `depends`
- `import`
- `lint`
- `skill`
- `version`

Interpretation:
- These are not automatically failures; some may be aliases, built-ins, or stale comments.
- They are **parity risk indicators** and MUST be validated against actual command routing behavior.

---

## 5. Parity Classification

| Area | Classification | Notes |
|------|----------------|-------|
| Baseline MCP contract operations (93) | Exact | Present in deployed gateways |
| Extended MCP operations (14) | Intentional | Deployed parity extensions beyond baseline schema |
| Known validation behavior mismatches | Gap | Tracked canonically in `docs/specs/MCP-SERVER-SPECIFICATION.md` section 10.7 |
| Domain comment token mismatches (5) | Gap candidate | Requires runtime verification and/or comment cleanup |

---

## 6. Required Follow-Ups

1. Add automated parity test to CI that diffs:
   - gateway registries vs schema registry
   - gateway registries vs canonical spec operation tables
2. Add runtime command-resolution tests for the five risk tokens.
3. Keep extension operations documented in canonical spec changelog when introduced.

---

## 7. Canonical Policy

This matrix is a canonical parity artifact. Working notes are not authoritative.

- Canonical contract: `docs/specs/MCP-SERVER-SPECIFICATION.md`
- Canonical product identity: `docs/concepts/vision.mdx`
- Canonical product contract: `docs/specs/PORTABLE-BRAIN-SPEC.md`
