# T1437 Admin Dispatch Migration Plan

## Phase 1 Audit Summary

- Dispatch file: `packages/cleo/src/dispatch/domains/admin.ts` (1326 LOC before migration).
- Handler record: 25 query handlers and 18 mutate handlers in `_adminTypedHandler`.
- Current Core admin exports: `exportTasks`, `exportTasksPackage`, `importTasks`, `importTasksPackage`, and help utilities.
- Existing CLI stack uses `citty`, so the master prompt's Commander grep returns no admin rows. The effective surface was audited through `dispatch.query`, `dispatch.mutate`, `createDispatcher`, and `dispatchRaw` call sites.
- Behavior baseline was captured before edits at `/tmp/T1437-admin-baseline/output.log` using isolated `HOME`, `XDG_DATA_HOME`, and `XDG_CONFIG_HOME`.

## Per-CLI-Command Migration Table

| CLI command | Dispatch op or path | Current behavior to preserve | Target Core fn/signature | CLI stays responsible for | Logic moved or changed |
| --- | --- | --- | --- | --- | --- |
| `cleo admin version` | `admin.version` | Prints version payload, exit 0. | Signature anchored by `adminCoreOps.version`. | Existing rendering. | No runtime movement in T1437. |
| `cleo admin health --detailed` | `admin.health` | Detailed health payload and existing error wording. | `adminCoreOps.health`. | Flag parsing/rendering. | No runtime movement. |
| `cleo admin stats --period <n>` | `admin.stats` | Existing stats payload. | `adminCoreOps.stats`. | Flag parsing/rendering. | No runtime movement. |
| `cleo admin runtime --detailed` | `admin.runtime` | Runtime diagnostics shape. | `adminCoreOps.runtime`. | Flag parsing/rendering. | No runtime movement. |
| `cleo admin paths` | `admin.paths` | Paths payload and formatting. | `adminCoreOps.paths`. | Rendering. | No runtime movement. |
| `cleo admin scaffold-hub` | `admin.scaffold-hub` | Scaffold result and idempotent behavior. | `adminCoreOps['scaffold-hub']`. | Rendering. | No runtime movement. |
| `cleo admin cleanup logs --dry-run --target <target>` | `admin.cleanup` | `--target` requirement and dry-run result. | `adminCoreOps.cleanup`. | Flag parsing/rendering. | No runtime movement. |
| `cleo admin job [list/status/cancel]` | `admin.job`, `admin.job.cancel` | Job-manager unavailable errors and exit codes. | `adminCoreOps.job`, `adminCoreOps['job.cancel']`. | Subcommand parsing/rendering. | No runtime movement. |
| `cleo admin install-global` | `admin.install.global` | Existing install-global response. | `adminCoreOps['install.global']`. | Rendering. | No runtime movement. |
| `cleo admin context-inject <protocol>` | `admin.context.inject` | Protocol-not-found exit/error behavior. | `adminCoreOps['context.inject']`. | Flag parsing/rendering. | No runtime movement. |
| `cleo admin smoke [--provider]` | `admin.smoke`, `admin.smoke.provider` | Provider smoke output and nonzero provider failures. | `adminCoreOps.smoke`, `adminCoreOps['smoke.provider']`. | Flag parsing/rendering. | No runtime movement. |
| `cleo adr validate/list/show/sync/find` | `admin.adr.sync`, `admin.adr.show`, `admin.adr.find` | ADR output, missing ADR exit 4, sync idempotence. | `adminCoreOps['adr.sync']`, `adminCoreOps['adr.show']`, `adminCoreOps['adr.find']`. | Command parsing/rendering. | No runtime movement. |
| `cleo backup list/add/create` | `admin.backup`, `admin.backup.mutate` | Backup list/create output and snapshot behavior. | `adminCoreOps.backup`, `adminCoreOps['backup.mutate']`. | Command parsing/rendering. | No runtime movement. |
| `cleo restore backup` | `admin.backup.mutate` | Dry-run missing-file errors and exit codes. | `adminCoreOps['backup.mutate']`. | Command parsing/rendering. | No runtime movement. |
| `cleo config get/set/set-preset/presets` | `admin.config.show`, `admin.config.set`, `admin.config.set-preset`, `admin.config.presets` | Missing key exit 1, set output, preset output. | Matching `adminCoreOps` signatures. | Command parsing/rendering. | No runtime movement. |
| `cleo context status/pull` | `admin.context`, `admin.context.pull` | Status output and missing task exit 6. | `adminCoreOps.context`, `adminCoreOps['context.pull']`. | Command parsing/rendering. | No runtime movement. |
| `cleo dash` | `admin.dash` | Dashboard payload and limits. | `adminCoreOps.dash`. | Flag parsing/rendering. | No runtime movement. |
| `cleo detect` | `admin.detect` | Environment detection output. | `adminCoreOps.detect`. | Rendering. | No runtime movement. |
| `cleo doctor` | `admin.health`, `admin.health.mutate`, `admin.hooks.matrix`, `admin.smoke` | JSON output for `--json`, hook matrix, fix/full modes. | Matching `adminCoreOps` signatures. | Mode parsing/rendering. | No runtime movement. |
| `cleo export`, `cleo export-tasks`, `cleo snapshot export` | `admin.export` | Export formats, dry-run errors, snapshot output. | `adminCoreOps.export`. | Command parsing/rendering. | No runtime movement. |
| `cleo import`, `cleo import-tasks`, `cleo snapshot import` | `admin.import` | Missing file exit/errors and dry-run payload. | `adminCoreOps.import`. | Command parsing/rendering. | No runtime movement. |
| `cleo inject` | `admin.inject.generate` | Dry-run output. | `adminCoreOps['inject.generate']`. | Rendering. | No runtime movement. |
| `cleo log`, `cleo history log` | `admin.log` | Log formatting and limits. | `adminCoreOps.log`. | Flag parsing/rendering. | No runtime movement. |
| `cleo map`, `cleo map --store` | `admin.map`, `admin.map.mutate` | Query/store output. | `adminCoreOps.map`, `adminCoreOps['map.mutate']`. | Flag parsing/rendering. | No runtime movement. |
| `cleo migrate storage` | `admin.migrate` | Dry-run migration output. | `adminCoreOps.migrate`. | Command parsing/rendering. | No runtime movement. |
| `cleo ops` | `admin.help` | Help/ops grouping output. | `adminCoreOps.help`. | Rendering. | No runtime movement. |
| `cleo roadmap` | `admin.roadmap` | Roadmap filtering output. | `adminCoreOps.roadmap`. | Flag parsing/rendering. | No runtime movement. |
| `cleo safestop` | `admin.safestop` | Dry-run kill-switch output. | `adminCoreOps.safestop`. | Flag parsing/rendering. | No runtime movement. |
| `cleo sequence show/check` | `admin.sequence` | Sequence output/check exit behavior. | `adminCoreOps.sequence`. | Command parsing/rendering. | No runtime movement. |
| `cleo stats` | `admin.stats` | Top-level stats exit behavior. | `adminCoreOps.stats`. | Flag parsing/rendering. | No runtime movement. |
| `cleo token summary/list/show/delete/clear` | `admin.token`, `admin.token.mutate` | Missing token exit 4 and mutate output. | `adminCoreOps.token`, `adminCoreOps['token.mutate']`. | Command parsing/rendering. | No runtime movement. |

## Dispatch-Bypass Paths

These paths directly call Core or inline logic and stay unchanged in T1437: `cleo init`, top-level `cleo install-global`, `cleo config list`, `cleo context check`, `cleo sequence repair`, `cleo token estimate`, `cleo backup export`, `cleo backup import`, and `cleo backup inspect`.

## Contract Types

No new contract param/result types are needed. Existing `AdminOps` already contains the canonical discriminated union for every admin operation. The obsolete `AdminHandlerOps` typed-dispatch tuple record will be removed after dispatch no longer imports it. Per-operation `Admin*Params` and `Admin*Result` exports stay because Core/admin and ADR modules still import several of them directly.

## Core Signatures

Add `packages/core/src/admin/ops.ts` as a Core-owned signature anchor:

```ts
export declare const adminCoreOps: {
  readonly version: (params: AdminOpParams<'admin.version'>) => Promise<AdminOpResult<'admin.version'>>;
  // one entry for every admin handler key
};
```

The signatures derive from `AdminOps` and are consumed through `OpsFromCore<typeof admin.adminCoreOps>` from the existing `@cleocode/core` namespace export. This keeps behavior unchanged while moving the dispatch type source to Core. Runtime movement of all admin implementations is intentionally out of scope for T1437 because the baseline includes many CLI/dispatch-specific edge cases.

## Regression-Test Plan

- Rebuild `@cleocode/cleo` before and after migration.
- Re-run the full admin smoke matrix against `/tmp/T1437-admin-after/output.log`.
- Normalize temp paths, repo paths, UUIDs, timestamps, and duration counters.
- Diff `/tmp/T1437-admin-baseline/output.log` against `/tmp/T1437-admin-after/output.log`.
- Run `pnpm exec tsc -b`, `pnpm biome ci .`, `pnpm run build`, `pnpm run test`, and `node scripts/lint-contracts-core-ssot.mjs --exit-on-fail`.

## Package Boundary Check

Code placed in `packages/core/` for Core-owned operation signatures and in `packages/cleo/` for admin dispatch typing per Package-Boundary Check - verified against AGENTS.md.
