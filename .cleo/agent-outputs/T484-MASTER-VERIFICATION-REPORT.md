# T484: Master CLI Runtime Verification Report

**Date**: 2026-04-10
**Agents deployed**: 11 (10 domain + 1 cross-domain)
**Commands tested**: ~200+ executed against live project data

---

## Critical Bugs (MUST FIX)

### BUG-CRIT-1: Commander-shim multi-word subcommand collision
- **Severity**: CRITICAL — 5+ commands non-functional
- **Domain**: memory (affects graph.*, reason.*)
- **Root cause**: `commander-shim.ts` `parseCommandName()` only takes first whitespace token. `graph show/neighbors/add/remove` all register as `graph`, last one wins. `reason why` dispatches `reason.similar`.
- **Impact**: `memory graph show`, `memory graph neighbors`, `memory graph add`, `memory reason why` are all broken
- **Fix**: Use hyphenated names (`graph-show`, `reason-why`) or restructure as nested command groups

### BUG-CRIT-2: `cleo claim` / `cleo unclaim` parameter mismatch
- **Severity**: CRITICAL — both commands fail 100%
- **Domain**: tasks
- **Root cause**: Handler passes `{ taskId }`, registry expects `{ id }`
- **File**: `packages/cleo/src/cli/commands/claim.ts`
- **Fix**: Change param name to match registry expectation

### BUG-CRIT-3: `cleo chain *` commands not registered
- **Severity**: HIGH — 5 commands missing from installed binary
- **Domain**: pipeline
- **Root cause**: chain.ts was created but may not be in the installed build
- **Fix**: Verify registration in index.ts, rebuild

### BUG-CRIT-4: 11 orchestrate commands missing from installed binary
- **Severity**: HIGH — T483 commands not in release
- **Domain**: orchestrate
- **Commands**: bootstrap, classify, fanout, fanout-status, handoff, spawn-execute, conduit-status/peek/start/stop/send
- **Root cause**: Added to source after v2026.4.25 binary was built
- **Fix**: New release needed

---

## Bugs (Should Fix)

### BUG-1: `admin version` reports stale version (2026.4.23 vs 2026.4.25)
- **File**: Reads from wrong version source
- **Fix**: Align version source with binary version

### BUG-2: `testing validate` misroutes to `check.manifest`
- **Domain**: check
- **Expected**: Should route to `check.protocol {protocolType: 'testing'}`
- **File**: `packages/cleo/src/cli/commands/testing.ts`

### BUG-3: `skills validate` silent failure (exits 0, returns E_INTERNAL)
- **Domain**: tools
- **Root cause**: CAAMP_SKILL_LIBRARY not set

### BUG-4: `skills search` reports wrong operation in meta
- **Domain**: tools
- **Reports**: `tools.skill.list` instead of `tools.skill.find`

### BUG-5: `labels show <label>` filter param ignored
- **Domain**: tasks
- **Root cause**: Dispatches to `label.list {label}` but the label filter is not applied

### BUG-6: `sync reconcile` not registered as subcommand
- **Domain**: tasks
- **Root cause**: Subcommand registration issue in sync.ts

### BUG-7: Unknown subcommand exits 0 instead of 1
- **Domain**: orchestrate, pipeline
- **Impact**: Scripted error detection unreliable

### BUG-8: `detect-drift` false positives (6/7)
- **Domain**: admin
- **Root cause**: Checks flat `src/` paths instead of monorepo `packages/*/src/`

### BUG-9: `admin context-inject` exits 0 with no args
- **Domain**: admin
- **Expected**: Should fail (missing required protocolType)

### BUG-10: `admin install-global` broken injection template
- **Domain**: admin
- **Error**: "Bundled injection template not found"

### BUG-11: `migrate-claude-mem` ghost command
- **Domain**: admin
- **Issue**: Exits 0 but no handler — silent false success

---

## Duplicates — Consolidation Recommendations

### REMOVE (dead/deprecated)
| Command | Reason |
|---------|--------|
| `cleo agents` (plural) | Dead — exits 1, `cleo agent` is the real command |
| `cleo commands` | Self-deprecated — prints warning, delegates to `admin.help` |
| `cleo roadmap` | Exact duplicate of `cleo dash` — misleading name |
| `cleo env status` | Exact duplicate of `cleo admin runtime` |
| `cleo migrate-claude-mem` | Ghost — no handler, silent false success |

### MERGE (diverged duplicates — pick one surface, combine features)
| Pair | Issue | Recommendation |
|------|-------|---------------|
| `cleo observe` vs `cleo memory observe` | Different options (`--type` vs `--agent`) | Merge into `cleo memory observe` with ALL options, keep `cleo observe` as alias |
| `cleo stats` vs `cleo admin stats` | Different param formats | Standardize on `cleo stats`, keep `cleo admin stats` as pass-through |
| `cleo doctor` vs `cleo admin health` | 6 flags vs 1 flag | Merge flags into `cleo admin health`, keep `cleo doctor` as alias |
| `cleo skills discover` vs `cleo skills list` | Identical output | Remove `discover`, it's a no-op alias |

### KEEP (intentional aliases — document in help)
| Alias | Target | Reason |
|-------|--------|--------|
| `cleo done` | `cleo complete` | Convenience |
| `cleo ls` | `cleo list` | Unix convention |
| `cleo rm` | `cleo delete` | Unix convention |
| `cleo tags` | `cleo labels list` | Synonym |
| `cleo jot` | `cleo sticky add` | Convenience |
| `cleo pipeline` | `cleo phase` | Domain clarity |
| `cleo promote` | `cleo reparent {null}` | Convenience |
| `cleo skills enable/disable` | `cleo skills install/uninstall` | Backward compat |

### CLARIFY (confusing but distinct)
| Group | Issue | Recommendation |
|-------|-------|---------------|
| `export` / `export-tasks` / `snapshot export` | 3 export commands, different purposes | Add `--help` text explaining difference |
| `import` / `import-tasks` / `snapshot import` | Same issue | Document clearly |
| `cleo next` vs `cleo orchestrate next` | Different ops (tasks.next vs orchestrate.next) | Already distinct — just needs doc |
| `cleo phase` vs `cleo phases` | CRUD vs read-only views | Document the split |

---

## Per-Domain Summary

| Domain | Tested | Pass | Fail/Broken | Duplicates | Key Issue |
|--------|--------|------|-------------|------------|-----------|
| tasks | 31 | 26 | 3 | 2 | claim/unclaim param mismatch |
| session | 13 | 13 | 0 | 0 | Clean |
| memory | 20 | 13 | 5 | 1 | **CRITICAL** shim collision |
| check | 21 | 21 | 0 | 0 | testing validate misroute |
| pipeline | 27 | 19 | 8 | 1 | chain unregistered |
| orchestrate | 24 | 13 | 11 | 1 | T483 commands not in binary |
| tools | 28 | 23 | 3 | 1 | CAAMP deps |
| admin | 39 | 33 | 1 | 6 | version stale, dead commands |
| nexus | 22 | ~20 | ~2 | 0 | Partial (rate limited) |
| sticky | 6 | 6 | 0 | 1 | jot alias (intentional) |
| **TOTAL** | **~231** | **~187** | **~33** | **~12** | |

---

## Priority Fix Order

1. **BUG-CRIT-1**: Shim subcommand collision — affects memory graph/reason (architectural)
2. **BUG-CRIT-2**: claim/unclaim param mismatch — 2-line fix
3. **BUG-CRIT-3+4**: chain + orchestrate commands not in binary — rebuild/release
4. **REMOVE**: 5 dead/deprecated commands
5. **MERGE**: 4 diverged duplicate pairs
6. **BUG-1 through BUG-11**: Individual fixes
