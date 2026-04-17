# ADR-052 — caamp Retains commander: Monorepo CLI Framework Divergence Accepted

**Status**: ACCEPTED
**Date**: 2026-04-17
**Task**: T867
**Parent**: T861 (CLEO CLI Perfection)
**Relates to**: ADR-043 (native citty migration for cleo binary)

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
RFC 2119.

---

## Context

The `cleo` binary (`packages/cleo`) completed its migration from commander to citty in ADR-043
(T487). The question T861 raises is whether `caamp` (`packages/caamp`) SHOULD follow suit and
also migrate to citty, creating a unified CLI framework across the monorepo.

At the time of this ADR, `packages/caamp` uses `commander@^14.0.0` throughout:

- The root `cli.ts` creates a `Command` instance and uses `program.hook('preAction', ...)` with
  `thisCommand.optsWithGlobals()` for global flags (`--verbose`, `--quiet`, `--human`).
- All 20+ command files (`src/commands/**/*.ts`) accept `Command` as a parameter via the
  `registerXxxCommand(program: Command)` pattern.
- Async entrypoint uses `program.parseAsync(process.argv)`.

The `caamp` binary is a distinct binary from `cleo` with a separate purpose:
provider/adapter/package management for AI agent toolchains. The two binaries share zero CLI
surface code today and are consumed by different audiences (system administrators and CI
pipelines for `caamp`, task agents for `cleo`).

---

## Decision

**caamp MUST retain `commander@^14`. No migration to `citty` is required.**

The monorepo accepts that `cleo` uses `citty` and `caamp` uses `commander`. Both frameworks
will coexist as first-class dependencies of their respective packages. Neither package MUST
depend on the other's CLI framework.

---

## Rationale

### 1. Separate binary, separate concerns

`cleo` and `caamp` are separate Node.js binaries with separate entry points. They share the
`@cleocode/core` business logic layer but no CLI plumbing. Mandating a common CLI framework
would couple infrastructure that has no coupling benefit.

### 2. commander `preAction` + `optsWithGlobals()` pattern has no direct citty equivalent

The `caamp` CLI uses commander's `preAction` hook to propagate global flags (`--verbose`,
`--quiet`, `--human`) from the root command to every subcommand via `optsWithGlobals()`. This
hook fires before any subcommand executes and is Commander's primary mechanism for inheriting
parent options.

`citty` does not expose an equivalent pre-action hook. The closest pattern is re-declaring
global args on every `defineCommand` or building a wrapper. Either approach requires
restructuring all 20+ command registrations — a large, low-value rewrite.

### 3. commander `parseAsync` test isolation

`commander`'s `parseAsync` consumes `process.argv` and returns a `Promise<Command>`. In tests,
`process.argv` can be overridden before calling `parseAsync`. Citty's `runMain` writes
directly to `process.exit` and does not expose a test-friendly async return value without
additional wrapping. The existing CAAMP test suite is built around commander's test interface;
migrating would require rewriting all CLI-level tests.

### 4. commander@14 is actively maintained

`commander@^14` (released 2025) is under active maintenance. The package has no known
deprecation schedule and is the most widely deployed CLI framework in the Node ecosystem with
80M+ weekly downloads. The risk of framework abandonment is negligible.

### 5. Zero user-visible benefit

Both `cleo` and `caamp` are consumed primarily by LLM agents via spawned subprocesses. Neither
has a rich interactive help renderer that would benefit from citty's formatting improvements.
The migration effort would produce no observable improvement for any consumer.

### 6. Migration cost exceeds benefit

Migrating caamp would require:

- Replacing the `registerXxxCommand(program: Command)` pattern across 20+ files
- Removing `preAction`/`optsWithGlobals` and redesigning global flag propagation
- Rewriting the async entrypoint
- Updating all CLI-level tests

Estimated effort: medium (3–5 days). Expected benefit: zero functional gain.

---

## Consequences

**Positive**:
- Zero engineering cost. caamp continues working without disruption.
- Each package owns its own CLI framework choice — clearer ownership.
- No cross-package framework coupling introduced.

**Negative**:
- Developers familiar with only one framework must context-switch when working across packages.
  Mitigation: the frameworks are well-documented and the pattern is consistent within each
  package.
- Two framework versions to track for security advisories. Mitigation: both are actively
  maintained with regular releases; automated dependency tooling (Renovate/Dependabot) handles
  version updates.

**Neutral**:
- Bundle size: both `citty` and `commander` are small. No material impact.
- The `packages/cleo` citty migration (ADR-043) is unaffected and remains authoritative for the
  `cleo` binary.

---

## Alternatives Considered

**Alternative A**: Migrate caamp to citty.
Rejected: high rewrite cost, no functional benefit, breaks test isolation model.

**Alternative B**: Extract a shared CLI abstraction layer (adapters over both frameworks).
Rejected: over-engineering. The packages serve different purposes and have no need to share
CLI plumbing.

**Alternative C**: Replace both with a third framework (e.g., oclif, yargs).
Rejected: introduces a third framework with zero benefit over the status quo.

---

## Implementation Notes

No code changes are required. This ADR documents the accepted divergence and serves as the
decision record to prevent future discussions from re-litigating the migration.

Future maintainers wishing to revisit this decision SHOULD first audit whether:
1. `citty` has added a pre-action hook mechanism equivalent to commander's.
2. The caamp test suite has been restructured to allow framework-agnostic testing.
3. A concrete user-visible or performance benefit exists.

If none of the above conditions are satisfied, this ADR SHOULD remain accepted.
