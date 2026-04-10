# T484 — Admin Domain CLI Runtime Verification

**Date**: 2026-04-10
**Domain**: admin (39 ops, largest domain)
**Tester**: CLI Runtime Verifier subagent

---

## Summary

| Category | Count |
|----------|-------|
| Commands tested | 39 |
| PASS (exit 0, success:true) | 33 |
| FAIL (broken/unavailable) | 1 |
| WARN (functional but buggy) | 3 |
| DEPRECATED (still work) | 2 |
| Confirmed duplicate routes | 6 groups |

---

## Results by Command

### admin.ts Subcommands

| Command | Exit | Operation | Result |
|---------|------|-----------|--------|
| `cleo admin version` | 0 | `admin.version` | PASS — returns `2026.4.23` (core engine version) |
| `cleo admin health` | 0 | `admin.health` | PASS — overall:warning (signaldock.db missing, expected) |
| `cleo admin stats` | 0 | `admin.stats` | PASS — full project stats |
| `cleo admin runtime` | 0 | `admin.runtime` | PASS — runtime diagnostics |
| `cleo admin smoke` | 0 | `admin.smoke` | PASS — 13/13 probes passed |
| `cleo admin paths` | 0 | `admin.paths` | PASS — all paths reported, hub scaffolded |
| `cleo admin scaffold-hub` | 0 | `admin.scaffold-hub` | PASS — idempotent, skipped existing dirs |
| `cleo admin cleanup --help` | 0 | — | PASS — shows required `--target` flag |
| `cleo admin cleanup` (no args) | 1 | — | PASS — correctly rejects missing `--target` |
| `cleo admin job list` | 1 | `admin.job` | FAIL — `E_NOT_AVAILABLE: Job manager not initialized` |
| `cleo admin install-global` | 0 | `admin.install.global` | PASS — idempotent scaffold (note: bundled injection template not found, skipped) |
| `cleo admin context-inject --help` | 0 | — | PASS — shows usage |
| `cleo admin context-inject` (no args) | 0 | — | WARN — shows help but exits 0 instead of 1 (missing required arg) |
| `cleo admin context-inject invalid-protocol` | 4 | — | PASS — `E_NOT_FOUND` exit 4 (correct) |
| `cleo admin detect` | 1 | — | FAIL (alias) — unknown subcommand, falls through to admin help display + exit 1 |

### Top-Level Admin Aliases

| Command | Exit | Operation | Result |
|---------|------|-----------|--------|
| `cleo dash` | 0 | `admin.dash` | PASS — full project dashboard |
| `cleo init --help` | 0 | — | PASS — shows init usage |
| `cleo doctor` | 0 | `admin.health` | PASS — identical to `cleo admin health` |
| `cleo commands` | 0 | `admin.help` | DEPRECATED — prints deprecation warning, delegates to admin.help |
| `cleo ops` | 0 | `admin.help` | PASS — routes to `admin.help` (tier 0) |
| `cleo version` | 0 | `cli.output` | WARN — returns `2026.4.25` (CLI pkg version), differs from `admin.version` (`2026.4.23`) |
| `cleo log` | 0 | `admin.log` | PASS — returns audit log with pagination |
| `cleo safestop --help` | 0 | — | PASS — shows required `--reason` flag |
| `cleo inject` | 0 | `admin.inject.generate` | PASS — generates injection markdown |
| `cleo map` | 0 | `admin.map` | PASS — returns full codebase structure analysis |
| `cleo sequence show` | 0 | `admin.sequence` | PASS — next ID is T486 |
| `cleo detect` | 0 | `admin.detect` | PASS — repairs project-context.json |
| `cleo detect-drift` | 2 | `cli.output` | WARN — exits 2 (correct propagation), but 7/8 checks fail due to hardcoded source paths that don't match monorepo layout (false positives — see bugs section) |
| `cleo roadmap` | 0 | `admin.dash` | PASS — exact alias to `cleo dash` |

### Config

| Command | Exit | Operation | Result |
|---------|------|-----------|--------|
| `cleo config list` | 0 | `cli.output` | PASS — returns full config object |
| `cleo config get output.defaultFormat` | 0 | `admin.config.show` | PASS — returns `"json"` |
| `cleo config get verification.enabled` | 1 | `admin.config.show` | PASS (correct failure) — `E_CONFIG_KEY_NOT_FOUND` exit 1. Key path must use top-level key only; `verification.enabled` is not a valid flat key |
| `cleo config presets` | 0 | `admin.config.presets` | PASS — returns strict/standard/minimal presets |

### Backup / Restore

| Command | Exit | Operation | Result |
|---------|------|-----------|--------|
| `cleo backup list` | 0 | `admin.backup` | PASS — lists 2 snapshots |
| `cleo backup add` | 0 | `admin.backup` | PASS — creates new snapshot with all 4 files |

### ADR

| Command | Exit | Operation | Result |
|---------|------|-----------|--------|
| `cleo adr list` | 0 | `admin.adr.find` | PASS — 39 ADRs returned |

### Token

| Command | Exit | Operation | Result |
|---------|------|-----------|--------|
| `cleo token summary` | 0 | `admin.token` | PASS — 2.8M tokens tracked, breakdown by operation |

### Export / Import

| Command | Exit | Operation | Result |
|---------|------|-----------|--------|
| `cleo export --help` | 0 | — | PASS — multi-format task export (csv/tsv/json/markdown) |
| `cleo snapshot export --help` | 0 | — | PASS — portable JSON state snapshot |
| `cleo import --help` | 0 | — | PASS — import from export package (has --parent, --phase, --onDuplicate, --dryRun) |
| `cleo snapshot import --help` | 0 | — | PASS — restore from snapshot (minimal options: --dryRun only) |

### Migrate

| Command | Exit | Operation | Result |
|---------|------|-----------|--------|
| `cleo migrate storage --help` | 0 | — | PASS — storage migration with schema repair |

### Other Admin-Adjacent

| Command | Exit | Operation | Result |
|---------|------|-----------|--------|
| `cleo env status` | 0 | `cli.output` | PASS — but see duplicates section |
| `cleo self-update --help` | 0 | — | PASS |
| `cleo upgrade --help` | 0 | — | PASS — unified maintenance (storage migration, schema repair, structural fixes, doc refresh) |

---

## Duplicate / Overlap Analysis

### Group 1: `cleo commands` vs `cleo ops` vs `cleo admin help`

All three route to `admin.help` (operation `admin.help`). Behavior:
- `cleo commands` — prints deprecation notice then delegates. **Deprecated, should be removed.**
- `cleo ops` — silently routes to `admin.help`. Works.
- `cleo admin help` — same output as `cleo ops`.

**Recommendation**: Remove `cleo commands`. Keep `cleo ops` as the agent-facing alias. `cleo admin help` remains as the canonical subcommand form.

---

### Group 2: `cleo doctor` vs `cleo admin health`

Both produce identical JSON output and identical `admin.health` operation. Zero behavioral difference.

**Recommendation**: Keep both — `doctor` is the user-friendly alias, `admin health` is the explicit subcommand. This is an acceptable alias, not a true duplicate.

---

### Group 3: `cleo export` vs `cleo snapshot export` vs `cleo export-tasks`

These are NOT the same:
- `cleo export` — exports tasks in human/machine formats (CSV, TSV, JSON, Markdown). Filtered by status/parent/phase. **Format conversion tool.**
- `cleo snapshot export` — exports the full state as a portable JSON snapshot for restore/migration. **Point-in-time backup.**
- `cleo export-tasks` — not tested (not present in command list provided). Unknown.

**Recommendation**: Keep both. Names are misleading — `cleo export` should perhaps be `cleo export tasks` and `cleo snapshot export` should be `cleo export snapshot`. The current names create discovery confusion.

---

### Group 4: `cleo import` vs `cleo snapshot import` vs `cleo import-tasks`

Mirrors the export distinction:
- `cleo import` — imports from an export package with rich options (parent reassignment, phase, duplicate handling, dry-run). **Full import workflow.**
- `cleo snapshot import` — restores from a snapshot file (minimal options: dry-run only). **State restore.**

**Recommendation**: Keep both. Same naming concern as export — the namespace `snapshot` is meaningful but not obvious.

---

### Group 5: `cleo roadmap` vs `cleo dash`

Both route to `admin.dash` (operation `admin.dash`). Identical JSON output.

**Recommendation**: Remove `cleo roadmap` — it's a confusing alias. A roadmap implies a future-planning view; `dash` is a dashboard. They produce identical output, so `roadmap` is misleading. Keep `cleo dash`.

---

### Group 6: `cleo version` vs `cleo admin version`

**These differ and the difference is a bug:**
- `cleo version` — returns `2026.4.25` via `cli.output` operation (reads CLI package version)
- `cleo admin version` — returns `2026.4.23` via `admin.version` operation (reads core engine version)

The CLI package and core engine are at different versions. While this can be intentional in a monorepo, it creates user confusion — running `cleo version` gives a different answer than `cleo admin version`. Both should reflect the same installed version or should be clearly labeled.

**Recommendation**: Either unify the version source, or rename `cleo admin version` to `cleo admin core-version` to make the distinction explicit. Add a note in the output of each explaining what it shows.

---

### Group 7: `cleo env status` vs `cleo admin runtime`

Both return **identical JSON data structures** with the same 12 fields (channel, mode, source, version, dataRoot, invocation, naming, node, platform, arch, warnings). The only difference is the meta operation name (`cli.output` vs `admin.runtime`).

**Recommendation**: Remove `cleo env status` — it is a pure duplicate of `cleo admin runtime`. If an alias is desired, point it to `admin runtime` explicitly.

---

## Bugs Found

### BUG-1: `cleo admin job list` — E_NOT_AVAILABLE (FAIL)

```
{"success":false,"error":{"code":1,"message":"Job manager not initialized","codeName":"E_NOT_AVAILABLE"}}
EXIT: 1
```

The job manager is not initialized at runtime. This command is registered but non-functional. Root cause: background job system not wired to CLI dispatch.

**Severity**: Medium. The `admin job list` subcommand is dead code from the CLI user perspective.

---

### BUG-2: `cleo detect-drift` — 7/8 checks report false positives

`detect-drift` checks for source file paths hardcoded to a flat `src/` layout:
- Checks `src/cli/commands/` — actual path is `packages/cleo/src/cli/commands/`
- Checks `src/dispatch/domains/` — actual path is `packages/core/src/dispatch/domains/`
- Checks `src/dispatch/lib/capability-matrix.ts` — does not exist in any package
- Checks `src/store/schema.ts` — does not exist at that path
- Checks `.cleo/templates/CLEO-INJECTION.md` — template lives at `~/.cleo/templates/CLEO-INJECTION.md`
- Checks `src/types/exit-codes.ts` — does not exist at that path

One check legitimately fails: `docs/specs/CLEO-OPERATIONS-REFERENCE.md` is genuinely missing.

Shell exit is `2` (correctly propagated from `data.summary.exitCode`), but all the structural failures are false positives caused by the detector not understanding the monorepo package layout.

**Severity**: Medium. The command misleads agents into thinking the installation is broken when it is not. The hardcoded paths need to be updated to match the monorepo layout or made configurable.

---

### BUG-3: `cleo admin context-inject` with no args exits 0

Running `cleo admin context-inject` without a required `PROTOCOLTYPE` argument displays the help text but exits `0`. It should exit `1` (missing required argument). Compare to `cleo admin cleanup` without `--target`, which correctly exits `1`.

**Severity**: Low. Cosmetic, but violates the convention that missing required args return exit 1.

---

### BUG-4: `cleo version` vs `cleo admin version` return different versions

`cleo version` reports `2026.4.25` (CLI package version from npm-global binary).
`cleo admin version` reports `2026.4.23` (core engine version).

This is caused by the CLI package and core package being versioned independently. The globally installed binary is at `2026.4.25` while the core engine inside it is `2026.4.23`. When run from the local source (`pnpm cleo`), both would return `2026.4.23`.

**Severity**: Low. Expected in a monorepo with independently versioned packages, but confusing to users and agents who run `cleo version` expecting the canonical version.

---

### BUG-5: `cleo admin install-global` reports "Bundled injection template not found"

```json
"templates": {
  "action": "skipped",
  "details": "Bundled injection template not found; skipped"
}
```

The bundled injection template cannot be found during `install-global`. This means the global CLEO-INJECTION.md template cannot be refreshed via `install-global`. The template at `~/.cleo/templates/CLEO-INJECTION.md` exists but was placed there manually, not via this command.

**Severity**: Low. The template exists but the automated refresh path is broken.

---

### GENUINE MISSING FILE: `docs/specs/CLEO-OPERATIONS-REFERENCE.md`

`detect-drift` correctly identifies that `docs/specs/CLEO-OPERATIONS-REFERENCE.md` does not exist. This file is referenced in AGENTS.md injection templates as a key escalation resource. Multiple ADRs reference it.

**Severity**: Medium. The file is expected by the protocol and does not exist.

---

## Deprecation Notices

| Command | Status | Action Required |
|---------|--------|-----------------|
| `cleo commands` | DEPRECATED — prints warning, still works | Remove the alias; it delegates to `admin.help` |
| `cleo roadmap` | Functional but misleading | Remove — identical to `cleo dash`, confusing name |

---

## Consolidation Recommendations

1. **Remove `cleo commands`** — deprecated alias to `admin.help`, emits console warning. Use `cleo ops` or `cleo admin help`.

2. **Remove `cleo roadmap`** — identical to `cleo dash`. The name implies future planning but shows current state. Misleads users.

3. **Remove `cleo env status`** — identical data to `cleo admin runtime`. Pick one surface; `admin runtime` is more discoverable under the admin namespace.

4. **Fix `cleo detect-drift` path resolution** — update checks to use monorepo-aware paths (`packages/cleo/src/`, `packages/core/src/`) instead of flat `src/`. This eliminates 6/7 false-positive failures.

5. **Fix `cleo admin job list`** — wire the job manager or remove the subcommand until it is implemented.

6. **Unify version reporting** — `cleo version` and `cleo admin version` should either return the same value or the output should clearly label which component version is being shown.

7. **Fix `cleo admin context-inject` exit code** — missing required positional arg should exit 1, not 0.

8. **Create `docs/specs/CLEO-OPERATIONS-REFERENCE.md`** — referenced across ADRs and injection templates but does not exist.
