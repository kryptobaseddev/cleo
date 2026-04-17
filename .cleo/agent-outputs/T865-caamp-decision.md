# T865 — CAAMP CLI Migration Decision: commander → citty

**Date**: 2026-04-16
**Author**: caamp-analyst subagent
**Decision**: Option B — Keep commander, file ADR to close the question permanently.

---

## Part 1: Audit

### Package Facts
| Field | Value |
|-------|-------|
| Binary | `caamp` (separate binary, not `cleo`) |
| commander version | `^14.0.0` |
| citty in cleo | `^0.2.1` |
| Source files importing commander | **34** |
| Total `.action()` calls | **53** |
| Total `.command()` / `.addCommand()` calls | **67** |
| `optsWithGlobals()` usages | **1** (cli.ts `preAction` hook) |
| `Commander.Option` / `new Option` usages | **0** |
| `program.parseAsync(argv)` usages | **1** (cli.ts `main()`) |

### Commander Surface Area

All 34 files use the `register*Command(program: Command)` pattern — each file receives a `Command` instance and attaches subcommands imperatively:

```
program.command('skills').description(...)
  .command('install')
    .option(...)
    .action(async (opts) => { ... })
```

- **Imperative `program.command().action()` pattern**: all 34 files.
- **Global option propagation**: `optsWithGlobals()` used in one `preAction` hook in `cli.ts` to push `--verbose`, `--quiet`, `--human` globals into every subcommand.
- **No `Commander.Option` class** (zero usages): only shorthand `.option()` strings.
- **No shared helpers with cleo's commander-shim**: shim is deleted; caamp has zero imports from `@cleocode/cleo`.

### Dispatch Architecture
caamp has its **own independent dispatch layer** (`src/core/harness/index.ts`) — no dependency on cleo's dispatch domains or engines. The CLEO dependency graph is: caamp → `@cleocode/lafs`, `@cleocode/cant` only.

### Test Surface
- **61 total test files** (12 integration, 49 unit).
- **16 test files** directly instantiate `new Command()` and call `program.parseAsync(...)` to drive integration assertions.
- Tests assert on LAFS envelope output (JSON stdout), not on citty/commander internals.
- The 12 integration tests would require complete rewrite for a citty migration — they construct a `Command`, register commands into it, then call `parseAsync`. citty does not expose a programmatic invocation surface compatible with this pattern.

---

## Part 2: Options Analysis

### Option A: Migrate caamp to citty (full monorepo consistency)

**Pros**
- One CLI framework across the monorepo (cleo + caamp both on citty).
- No per-maintainer context-switch between two frameworks.
- citty's `defineCommand` is more declarative — potentially cleaner type signatures.

**Cons**
- **34 files** must be rewritten; ~53 `.action()` callbacks + ~67 `.command()` calls migrated.
- **16 integration tests** require a complete rewrite — citty has no `parseAsync(argv)` equivalent for programmatic test invocation. Tests would have to shift to `execa`-based subprocess spawning or vitest environment mocking.
- citty does not support a `preAction` hook natively — the global `--verbose/--quiet/--human` propagation via `optsWithGlobals()` requires a custom workaround (e.g., environment variable bridge or per-command wrapper).
- Risk surface: caamp is a published npm binary (`@cleocode/caamp`). Regressions affect external users.
- caamp's business logic is entirely in the action bodies — the framework is a thin shell. Framework consistency gain is aesthetic, not functional.
- No user-facing improvement: caamp CLI output (LAFS envelopes) and UX are unchanged by framework swap.
- Zero shared code between cleo's citty setup and caamp's commander setup — there is nothing to reuse.
- **Estimated effort**: large (3-5 sprints, 34 files + 16 test rewrites + regression validation).

### Option B: Keep caamp on commander (stable, separate binary)

**Pros**
- Zero risk to a published binary. caamp v2026.4.77 is live on npm — stability is paramount.
- No test rewrite cost (16 integration tests remain valid and comprehensive).
- commander ^14 is actively maintained (2024 release) with LTS behavior.
- caamp is a **different product** with a different user base (AI tool vendors, developers configuring agent IDEs) — framework divergence has zero user-facing impact.
- The `register*(program: Command)` pattern is consistent, well-typed, and fully documented across all 34 files.
- Global option propagation via `preAction + optsWithGlobals` is a one-liner in commander with no equivalent simplicity in citty.
- Maintenance burden of "two frameworks" is low: caamp has its own package boundary, build, and test suite. Developers do not switch frameworks within a session.

**Cons**
- Technical heterogeneity: monorepo has two CLI frameworks. Future contributors must know both.
- commander is a heavier dependency than citty (though commander 14 tree-shakes well).

### Option C: Hybrid — keep commander but share citty patterns via adapter layer

**Pros**
- Preserves existing code while preparing for eventual consistency.

**Cons**
- Adds a third abstraction layer with no functional benefit.
- Increases complexity without solving the two-framework problem.
- No patterns are actually shareable: cleo's citty setup uses `defineCommand` + dispatch domain routing; caamp uses `register*(program)` functions + internal harness routing. The architectures are fundamentally different.
- **Verdict**: Option C is engineering theater. Rejected.

---

## Part 3: Recommendation

**Recommendation: Option B — Keep caamp on commander.**

### Rationale

1. **Separate product, separate binary.** caamp and cleo are distinct CLIs with distinct users. "Monorepo consistency" is a maintenance preference, not a requirement. The package boundary already enforces separation.

2. **Migration cost is disproportionate to benefit.** 34 files + 16 integration test rewrites + global option propagation reimplementation = large scope, zero user-facing improvement, non-trivial regression risk for a published package.

3. **citty has no programmatic test invocation surface.** The existing integration tests (`new Command(); program.parseAsync(...)`) are caamp's strongest test layer. A migration forces them to become subprocess-based or mock-based, reducing test fidelity.

4. **commander ^14 is actively maintained.** There is no EOL pressure. This is not a "migrate before it breaks" situation.

5. **The `preAction + optsWithGlobals` pattern** for global options is idiomatic commander and has no clean equivalent in citty. Replicating it requires environment variable bridging or per-command boilerplate — strictly worse.

**The divergence is acceptable.** cleo chose citty for its own dispatch architecture (domain routing, 300+ commands, custom help renderer). caamp chose commander for its own architecture (register pattern, 34 focused command files, integration-test-driven). Both were correct choices in context.

**Follow-up**: File ADR-052 as a CLEO task to formally document this decision.

---

## Part 4: N/A (Option B selected — no migration epic)

---

## Part 5: ADR Task

File a task to write ADR-052 documenting the decision so future contributors do not re-raise the question.

**ADR-052 scope:**
- Title: "caamp retains commander; monorepo CLI framework divergence is acceptable"
- Documents: separate product/binary rationale, test incompatibility, commander ^14 maintenance status, preAction/optsWithGlobals pattern, no shared code between cleo/caamp CLI layers
- Location: `.cleo/adrs/ADR-052-caamp-keeps-commander.md`
- Status: Accepted

---

## Appendix: File Inventory

All 34 commander-importing files:

```
src/cli.ts
src/commands/advanced/batch.ts
src/commands/advanced/index.ts
src/commands/advanced/instructions.ts
src/commands/advanced/providers.ts
src/commands/config.ts
src/commands/doctor.ts
src/commands/instructions/check.ts
src/commands/instructions/index.ts
src/commands/instructions/inject.ts
src/commands/instructions/update.ts
src/commands/mcp/detect.ts
src/commands/mcp/index.ts
src/commands/mcp/install.ts
src/commands/mcp/list.ts
src/commands/mcp/remove.ts
src/commands/pi/cant.ts
src/commands/pi/extensions.ts
src/commands/pi/index.ts
src/commands/pi/models.ts
src/commands/pi/prompts.ts
src/commands/pi/sessions.ts
src/commands/pi/themes.ts
src/commands/providers.ts
src/commands/skills/audit.ts
src/commands/skills/check.ts
src/commands/skills/find.ts
src/commands/skills/index.ts
src/commands/skills/init.ts
src/commands/skills/install.ts
src/commands/skills/list.ts
src/commands/skills/remove.ts
src/commands/skills/update.ts
src/commands/skills/validate.ts
```
