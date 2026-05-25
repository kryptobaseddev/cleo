# T10566: Drizzle ORM + Kit rc.3 Compatibility Experiment

Task: E3.W1 Test drizzle-orm + drizzle-kit rc.3 version-pair compatibility
Date: 2026-05-25
Workspace: `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T10566-rc3-experiment`

## Summary

The `drizzle-orm@1.0.0-rc.3` + `drizzle-kit@1.0.0-rc.3` pair was tested together against the monorepo Drizzle command surface.

Result: defer a product upgrade for now. The rc.3 pair does not regress `db:check`, but it also does not improve `db:generate` behavior for this SQLite-heavy codebase. `db:generate` still reaches the same interactive table-create/rename prompt path as the current beta pair and fails in non-interactive shells because Drizzle requires a TTY for that prompt.

## Version pair tested

Current project versions from T10565:

- root `drizzle-kit`: `1.0.0-beta.19-d95b7a4`
- root `drizzle-orm`: `1.0.0-beta.22-ec7b61d`
- package `drizzle-orm` consumers: root, `packages/core`, `packages/nexus`, `packages/playbooks`

Experiment versions tested:

- `drizzle-kit`: `1.0.0-rc.3`
- `drizzle-orm`: `1.0.0-rc.3`
- `drizzle-orm` was temporarily aligned across root, core, nexus, and playbooks so the rc.3 ORM and rc.3 kit were evaluated as a pair.

No product package.json upgrade was left staged in the final commit; this report records the experiment and decision only.

## Commands run

Baseline beta pair:

```bash
pnpm install --ignore-scripts
pnpm db:check
pnpm db:generate
script -q -c 'pnpm db:generate' /dev/null
```

rc.3 pair:

```bash
pnpm add -w drizzle-orm@1.0.0-rc.3
pnpm add -Dw drizzle-kit@1.0.0-rc.3
pnpm --filter @cleocode/core add drizzle-orm@1.0.0-rc.3
pnpm --filter @cleocode/nexus add drizzle-orm@1.0.0-rc.3
pnpm --filter @cleocode/playbooks add drizzle-orm@1.0.0-rc.3
pnpm db:check
pnpm db:generate
script -q -c 'pnpm db:generate' .cleo/agent-outputs/T10566/rc3-db-generate-tty.typescript
```

## AC1: rc.3 ORM + kit pair tested together

Pass. The experiment installed and tested the public npm versions:

- `drizzle-orm@1.0.0-rc.3`
- `drizzle-kit@1.0.0-rc.3`

`pnpm-lock.yaml` resolved both rc.3 packages and downstream `llmtxt` peer resolutions against `drizzle-orm@1.0.0-rc.3` during the experiment.

## AC2: db:check / db:generate before-after comparison

### `pnpm db:check`

Current beta pair result: pass for all configured Drizzle configs.

Observed configs:

- `drizzle/tasks.config.ts`
- `drizzle/brain.config.ts`
- `drizzle/nexus.config.ts`
- `drizzle/signaldock.config.ts`
- `drizzle/telemetry.config.ts`

Each printed `Everything's fine 🐶🔥`.

rc.3 pair result: pass for the same five configs. No behavior difference was observed for `db:check`.

Evidence logs:

- `.cleo/agent-outputs/T10566/baseline-db-check.log`
- `.cleo/agent-outputs/T10566/rc3-db-check.log`

### `pnpm db:generate`

Current beta pair result after building local workspace package outputs enough for schema imports:

- Reached Drizzle diffing for `drizzle/tasks.config.ts`.
- Non-interactive shell failed with: `Interactive prompts require a TTY terminal`.
- TTY run prompted: `Is evidence_ac_bindings table created or renamed from another table?`
- The first prompt offered:
  - `+ evidence_ac_bindings create table`
  - `~ release_manifests › evidence_ac_bindings rename table`

rc.3 pair result:

- Reached the same Drizzle diffing path for `drizzle/tasks.config.ts`.
- Non-interactive shell failed with the same TTY requirement.
- TTY run showed the same first table-create/rename prompt for `evidence_ac_bindings`.

Evidence logs:

- `.cleo/agent-outputs/T10566/baseline-db-generate-after-build-deps.log`
- `.cleo/agent-outputs/T10566/rc3-db-generate.log`
- `.cleo/agent-outputs/T10566/rc3-db-generate-tty.typescript`

Important baseline nuance: before building local workspace package outputs, baseline `db:generate` failed earlier with `ERR_PACKAGE_PATH_NOT_EXPORTED` while resolving `@cleocode/contracts`. After building enough workspace outputs, it reached the Drizzle schema-diff prompt path. That first failure is build-artifact related, not caused by the Drizzle version pair.

## AC3: upgrade decision covering ORM and kit

Decision: do not upgrade this repo to Drizzle rc.3 yet.

Rationale:

1. rc.3 is MySQL-focused per T10565; the SQLite rework needed by this repository is explicitly deferred to a future Drizzle release.
2. The rc.3 pair passes `db:check`, but the current beta pair already passes `db:check`.
3. The rc.3 pair does not resolve the `db:generate` interactive table-create/rename behavior for `drizzle/tasks.config.ts`.
4. `db:generate` remains unsuitable for unattended CI/agent execution when the schema diff requires prompt classification.
5. A safe future upgrade should wait for the SQLite-focused Drizzle release or be paired with a repo-side migration-generation policy that avoids unattended `drizzle-kit generate` on ambiguous diffs.

Recommended next upgrade shape:

- Upgrade `drizzle-orm` and `drizzle-kit` together, not separately.
- Align every package-level `drizzle-orm` declaration: root, `packages/core`, `packages/nexus`, and `packages/playbooks`.
- Re-run `pnpm db:check` against all five configs.
- Treat `pnpm db:generate` as interactive/manual unless Drizzle introduces non-interactive prompt policy flags or this repo wraps generation with explicit rename/create decisions.
- Continue using hand-written SQL migrations for SQLite edge cases that Drizzle cannot represent or diff deterministically.

## Additional environment finding

`cleo orchestrate spawn T10566` failed before worker dispatch because the task had no file scope (`E_ATOMICITY_NO_SCOPE`). Retrying with `--orchestrator-defer` found an existing locked T10566 worktree with unrelated dirty changes. To avoid overwriting those changes, this experiment used a separate CLEO-XDG worktree path: `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T10566-rc3-experiment`.

The experiment worktree gitdir had an incorrect `core.worktree=/mnt/projects/cleocode`; it was repaired with:

```bash
git --git-dir=/mnt/projects/cleocode/.git/worktrees/T10566-rc3-experiment config core.worktree /home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T10566-rc3-experiment
```

The canonical root `/mnt/projects/cleocode` remained clean for the Drizzle package files.
