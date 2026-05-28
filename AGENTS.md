<!-- CAAMP:START -->
@~/.agents/AGENTS.md
@.cleo/project-context.json
# Run: cleo memory digest --brief
<!-- CAAMP:END -->

# CLEO Agent Code Quality Rules (MANDATORY)

These rules are NON-NEGOTIABLE. Every agent, subagent, and orchestrator MUST follow them. Violations are grounds for rejecting all work.

## Before You Write ANY Code

1. **Read first** — understand existing code, patterns, and contracts before writing
2. **Check for existing** — search for utilities, helpers, and shared code. NEVER duplicate
3. **Use contracts** — import types from `packages/contracts/src/`. NEVER inline or mock types

## Type Safety (ZERO TOLERANCE)

- **NEVER** use `any` type — find the root cause, inspect interfaces, wire correctly
- **NEVER** use `unknown` type as a shortcut — define proper types or use existing contracts
- **NEVER** use `as unknown as X` type casting chains — fix the actual type mismatch
- **NEVER** mock types or create inline type definitions — use `packages/contracts/src/`
- **ALWAYS** wire types from existing contracts or BUILD new contracts if they are genuinely missing

## Code Architecture (DRY + SOLID)

- **NEVER remove code** — ALWAYS improve existing code
- **ALWAYS** check for existing functions before creating new ones
- **ALWAYS** centralize shared logic into lib modules — no one-off helpers scattered around
- **ALWAYS** follow existing patterns in the codebase — match the style, naming, and structure
- **ALWAYS** keep imports organized and sorted (biome enforces this)

## Documentation

- **ALWAYS** add TSDoc comments (`/** ... */`) on ALL exported functions, classes, types, and constants
- **ALWAYS** update existing documentation — NEVER create new docs unless absolutely necessary
- **ALWAYS** validate with `forge-ts` when available

## Canonical Docs Routing (ADR-076 · T9796)

Every canonical document type (ADR, spec, research, handoff, note,
release-note, plan) MUST be created via `cleo docs add` — NOT a raw
`Write` to `.cleo/adrs/`, `.cleo/agent-outputs/`, or `.cleo/research/`.

The routing registry lives at `.cleo/canon.yml` (schema:
`.cleo/canon.schema.json`). It declares for each DocKind:

- `canonicalHome` — `ssot` (blob-store only) or `ssot-first` (dual-write
  via a dedicated `cleo` verb such as `cleo changeset add`).
- `publishMirror` — the human-reviewable copy written by `cleo docs publish`.
- `rawMdAllowed` — when `false`, raw `.md` additions under any
  `rawMdPaths` directory are blocked at PR-time by the CI gate.

The CI gate is `cleo check canon docs` (job: `Canon Drift Check (T9796)`).
It walks `git diff --diff-filter=A` between the PR base and `HEAD`,
flagging any NEW `*.md` that bypasses the SSoT. Existing legacy files
imported by T9791 are NEVER flagged — the gate is forward-only.

Envelope-first doctrine is documented in `docs/specs/LAFS-ENVELOPE-CONTRACT.md`
(`lafs-envelope-contract`, owner T11113). Use it as the human-readable contract
for LAFS envelope shape, metadata, invariants, errors, pagination, MVI, and
transport conventions.

If you genuinely need a doc-kind not yet listed:
1. Add it to `packages/contracts/src/docs-taxonomy.ts` (`BUILTIN_DOC_KINDS`).
2. Add a routing entry to `.cleo/canon.yml`.
3. Re-run `pnpm --filter @cleocode/cleo run build` and the gate stays green.

## Docs Storage Surfaces (Implementation Details) — T11052

CLEO stores documents in three storage surfaces. These are **implementation
details** — agents MUST NOT navigate, read, or write them directly:

| Surface | Location | What it stores |
|---------|----------|----------------|
| Attachment rows | `.cleo/attachments/index.db` + content-addressed blobs at `.cleo/attachments/sha256/<prefix>/<hash>.<ext>` | Per-task document attachments (5 variants: local-file, url, blob, llms-txt, llmtxt-doc). Each row maps an owner (task/session/observation) to a content-addressed blob with metadata (kind, slug, SHA-256). |
| Blob manifest | `.cleo/blobs/manifest.db` + `.cleo/blobs/blobs/<sha>` | Content-addressed doc SSoT — every canonical doc (ADR, spec, research, handoff, note, plan, changeset) lives here. The manifest tracks slug→SHA mapping, provenance, and publication state. |
| Publication ledger | `.cleo/docs-publications.json` | Maps published doc slugs to their on-disk mirror paths. The pre-commit hook (`scripts/hooks/pre-commit-docs-drift.mjs`) reads this ledger to detect drift between the SSoT blob and the published copy. |

### Agent-Facing Query Surface

Use these CLI commands for ALL document operations. Never grep the filesystem
for docs — the SSoT is the source of truth:

| Operation | Command |
|-----------|---------|
| Discover docs | `cleo docs list --type <kind>` or `cleo docs list --task <id>` |
| Read a doc | `cleo docs fetch <slug>` |
| Check drift | `cleo docs status` (or `--exit-on-drift` for CI) |
| Publish to disk | `cleo docs publish --for <ownerId> --to <path>` |
| Create a doc | `cleo docs add <ownerId> <path> --type <kind> --slug <handle>` |
| List doc kinds | `cleo docs list-types` |
| Generate summary | `cleo docs generate --for <taskId>` |

The blob manifest, attachment index, and publication ledger are write-once,
content-addressed stores. Agents that bypass the CLI surface and write to
`.cleo/blobs/`, `.cleo/attachments/`, or `.cleo/docs-publications.json`
directly will create unreachable blobs and trigger drift alerts.

## Skill Maintenance Discipline (Saga T9799 · Epic T9960)

Canonical `ct-*` skills under `packages/skills/skills/` describe how CLEO
works to every spawned agent. When core systems change but the skill text
does not, agents act on stale instructions. The T9540 release-system
rewrite is the canonical example — `ct-release-orchestrator` still
described the deleted `cleo release ship` monolith for weeks.

**Rule**: when you edit a path declared in the coverage map, you MUST
update the corresponding skill in the same PR — or acknowledge the
deferral explicitly.

### Coverage map (internal-only — never ships)

`packages/skills/internal/skill-coverage.yml` maps each canonical skill
to the code paths it documents. The file is listed in
`packages/skills/.npmignore` so it never lands in the published
`@cleocode/skills` bundle. Sibling tooling under `packages/skills/internal/`
(drift-check.mjs, the git-hook runners) is excluded the same way.

### Shipped per-skill metadata (in SKILL.md frontmatter)

Every canonical SKILL.md MUST carry a `metadata:` block. These fields
DO ship — they are documentation, not enforcement, and they let
consumers and the curator daemon reason about freshness:

```yaml
metadata:
  version: 2.0.0           # bump on every material change
  lastReviewed: 2026-05-21 # ISO date — set by the human/agent who reviewed
  stability: stable        # experimental | stable | deprecated
```

### Enforcement (T9960 — in progress)

- **Pre-commit hook**: regenerates `packages/skills/skills.json` from
  SKILL.md frontmatter. Drift between frontmatter and `skills.json` fails
  the hook.
- **CI gate `Skill Drift Check`**: scans the PR diff against the coverage
  map. If a covered path is touched but the matching SKILL.md is not, the
  PR fails with `E_SKILL_DRIFT_UNACKNOWLEDGED`.
- **Trailer override**: a commit trailer
  `Skill-Drift-Acknowledged: <reason>` bypasses the gate AND auto-files a
  sentient follow-up task for retroactive skill update.
- **Tier-0 skills get NO override** — `ct-cleo`, `ct-orchestrator`,
  `ct-task-executor`, `ct-dev-workflow`, `ct-documentor`, and
  `CLEO-INJECTION.md` must be kept current in the same PR. The trailer
  is rejected for these.

### Tier-0 core skills (strict — no drift tolerated)

These define the agent protocol surface. Edit the matching code path,
edit the skill in the same PR. Period.

- `ct-cleo` — CLI protocol + session lifecycle
- `ct-orchestrator` — spawn/delegation contract
- `ct-task-executor` — worker contract
- `ct-dev-workflow` — commit / branch / release flow
- `ct-documentor` — docs SSoT routing
- `CLEO-INJECTION.md` (template, not a skill folder) — protocol injected
  into every spawn prompt

### Tier-1 LOOM-stage skills (trailer override permitted)

One per LOOM stage in `packages/core/src/validation/protocols/`. Same
rule applies; trailer override is allowed for non-blocking deferrals.

### Internal-only validator

`ct-skill-validator` ships with `disable-model-invocation: true` and is
listed in `packages/skills/.npmignore` so it never reaches consumers.
It is the developer-side toolchain that drives the drift check, depth
audit, and quality evals.

## Worktree Location (ADR-055 · Saga T9800 · Decision D009)

ALL git worktrees provisioned for agent tasks MUST live under the canonical
XDG path: `<cleoHome>/worktrees/<projectHash>/<taskId>/`.

- **Linux**: `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`
- **macOS**: `~/Library/Application Support/cleo/worktrees/<projectHash>/<taskId>/`

### Banned locations

The following worktree locations are UNCONDITIONALLY FORBIDDEN:

- The project root (`/mnt/projects/cleocode/`)
- Any sibling path (`/mnt/projects/*`)
- Inside another worktree (nested worktrees)
- Inside `.claude/worktrees/` or any `.claude/` subdirectory

There is NO escape hatch — not even `CLEO_FORCE_LOCATION`.

### Enforcement

- **Runtime**: `packages/worktree/src/worktree-create.ts` throws
  `E_WT_LOCATION_FORBIDDEN` before any `git worktree add` call when the
  computed path is outside the canonical root.
- **CI gate**: `scripts/lint-worktree-location.mjs` (job: `Worktree Location Lint`)
  runs `git worktree list --porcelain` on every PR and fails on any non-primary
  worktree that is not under `<cleoHome>/worktrees/`. It also rejects a
  `worktrees/` *directory* under `<repo>/.cleo/` — only the sentinel file
  `.cleo/worktrees.json` is allowed there (D009 in-project sentinel pattern).
- **Migration tool**: `scripts/migrate-rogue-worktrees.mjs` detects and moves
  rogue worktrees. Use `--dry-run` to preview before executing.

See Epic **T9809** (`E-WT-PROVISIONING-LOCATION-GUARDS`) for full context.

## Worktree Include File (T9983 · Saga T9977 SG-WORKTRUNK-OWN)

CLEO reads a per-project file that lists which working-tree files should be
copied into agent worktrees on provisioning (gitignored-but-required env
files, IDE settings, lockfiles, dependency caches, etc.).

**Canonical location**: `<projectRoot>/.worktreeinclude` — matches Claude
Code Desktop, `worktrunk-core`, and the broader git-worktree-tooling
convention. The reader is implemented in
`packages/worktree/src/worktree-include.ts` and delegates pattern parsing
to `@cleocode/worktree-napi` (real `ignore::gitignore` matching).

**Legacy location**: `<projectRoot>/.cleo/worktree-include` — read for ONE
deprecation cycle (post-T9983 / Saga T9977) with a one-time
`process.emitWarning('DeprecationWarning', 'CLEO_WORKTREE_INCLUDE_LEGACY')`.
Removed no earlier than the next major release.

**Migration**:

```bash
# Preview what would change.
cleo doctor --migrate-worktree-include --dry-run

# Apply the migration. Backs the legacy file up to
# .cleo/backups/worktree-include-<iso8601>.bak before removing it.
cleo doctor --migrate-worktree-include
```

`cleo init` (and `cleo upgrade`'s scaffold sweep) writes
`<projectRoot>/.worktreeinclude` from the shipped template at
`packages/core/templates/worktreeinclude`. When only the legacy file is
present, the scaffolder skips it rather than auto-rewriting — the
migration is always explicit.

## Quality Gates (MUST PASS BEFORE COMPLETING)

Run these IN ORDER before marking any task complete:

```bash
# 1. Format and lint
pnpm biome check --write .

# 2. Build
pnpm run build

# 3. Test — verify ZERO new failures
pnpm run test

# 4. Verify your changes
git diff --stat HEAD
```

If ANY gate fails, FIX IT before completing. Do NOT mark a task done with failing gates.

## Anti-Patterns (INSTANT REJECTION)

- Claiming "tests pass" without actually running `pnpm run test`
- Using workarounds instead of fixing root causes
- Skipping biome/lint checks
- Creating new files when existing files should be extended
- Using `catch (err: unknown)` — use proper error types
- Leaving `console.log` in production code
- Adding imports without checking if they break circular dependencies
- Modifying test expectations to match broken code instead of fixing the code

## SSoT Enforcement — `defineCommand` Factory (T10072 · Epic T9837 · Saga T9831)

`packages/cleo/src/cli/lib/define-cli-command.ts` is the **ONLY** allowed
import source for `defineCommand` within `packages/cleo/src/`. Raw imports
directly from `'citty'` are forbidden outside that SSoT file.

| Anti-pattern | Replacement |
|---|---|
| `import { defineCommand } from 'citty'` in any `packages/cleo/src/` file | `import { defineCommand } from '../lib/define-cli-command.js'` (adjust relative path) |

**CI gate**: `scripts/lint-no-raw-define-command.mjs` (job: `Architectural Boundary Check (SG-ARCH-SOLID)`) runs in `--check` (baseline) mode on every PR. It fails when the number of raw citty imports **increases** above the committed baseline.

**Baseline file**: `.cleo/define-command-ssot-baseline.json` — committed and tracks the 139 legacy violations that pre-date this gate. Update it after each migration wave:
```bash
node scripts/lint-no-raw-define-command.mjs --baseline
git add .cleo/define-command-ssot-baseline.json
```

**Opt-out**: append `// define-command-ssot-allowed` with a justification comment on the import line for genuinely exceptional cases.

## Paths SSoT (T9802 / SG-WORKTREE-CANON)

`packages/paths/` is the **ONLY** source of worktree and `.cleo` XDG path
resolution per Council verdict D009. Three patterns are CI-gated by
`scripts/lint-paths-ssot.mjs` (job `paths-ssot-lint`):

| Anti-pattern | Replacement |
|---|---|
| `import envPaths from 'env-paths'` outside `packages/paths/` | `getCleoHome()` / `getCleoPlatformPaths()` from `@cleocode/paths` |
| `process.env['XDG_DATA_HOME'] ?? join(...)` | `getCleoHome()` from `@cleocode/paths` |
| Hand-rolled `'/cleo/worktrees'` string | `resolveWorktreeRootForHash()` / `getCleoWorktreesRoot()` from `@cleocode/paths` |

Sentinel index path (D009 hybrid verdict): `resolveWorktreeIndexPath(projectRoot)`
returns `<projectRoot>/.cleo/worktrees.json` — the canonical per-project worktree
registry consumed by T9805 lifecycle hooks.

**Phase 1 (T9802 PR, current):** lint baseline established at 17 existing violations
(all `hand-rolled-xdg-read`, zero new). CI fails on net-add. Allowlisted legacy:
`packages/paths/src/platform-paths.ts` (SSoT itself) and
`packages/cleo-os/src/postinstall.ts` (bootstrap, runs before `@cleocode/paths` installs).

**Phase 2 (follow-up):** sweep all 17 baseline violations to zero across
`packages/cleo-os`, `packages/core`, `packages/adapters`, `packages/cant`, and
`packages/cleo`. Track as a follow-up child of T9802.

## DB Open Guard (T10073 / Saga T9831 SG-ARCH-SOLID)

All SQLite database opens MUST flow through `openCleoDb(role, cwd)` (or
`openCleoDbSnapshot()` for read-only snapshot opens) from
`packages/core/src/store/open-cleo-db.ts`. Raw `new DatabaseSync(` and
`new Database(` calls outside the canonical allowlist are rejected by the
`DB Open Guard` CI job (`scripts/lint-no-direct-db-open.mjs`).

**Why**: bypassing the chokepoint causes pragma drift (missing SSoT from
`specs/sqlite-pragmas.json`), WAL/lock contention between processes, and
topology opacity (`cleo health` cannot enumerate the handle).

**Modes:**
- Default (baseline): `node scripts/lint-no-direct-db-open.mjs` — fails on net-add vs baseline
- Strict: `node scripts/lint-no-direct-db-open.mjs --strict` — fails on ANY violation
- Update baseline: `node scripts/lint-no-direct-db-open.mjs --update-baseline`

**Per-line opt-out:** append `// db-open-allowed: <reason>` for genuinely
exceptional cases (e.g. non-CLEO-metadata graph DBs like nexus per-project files).

**Canonical allowlist** (all other locations are violations):

| Location | Reason |
|---|---|
| `packages/core/src/store/**` | The chokepoint itself |
| `packages/core/src/migration/**` | Schema bootstrapping |
| `packages/core/src/memory/claude-mem-migration.ts` | One-shot memory migration |
| `packages/core/src/memory/graph-memory-bridge.ts` | Hot-path conduit open |
| `packages/core/src/conduit/**` | Core-owned conduit infrastructure |
| `packages/core/src/upgrade.ts` | One-shot historical migration (legacy reference — signaldock SDK extracted to /mnt/projects/signaldock + crates.io per saga T10180) |
| `packages/core/src/init.ts` | Bootstrap before chokepoint is available |
| `packages/core/src/agents/seed-install.ts` | One-shot global install |
| `packages/core/src/orchestration/classify.ts` | JSDoc @example blocks only |
| `packages/core/src/nexus/**` | Per-project graph DBs (non-CLEO metadata) |
| `packages/brain/src/db-connections.ts` | Package-boundary constraint (no core dep) |
| `packages/studio/src/lib/server/db/connections.ts` | Per-project ProjectContext-driven opens |
| Test files (`__tests__/`, `.test.ts`, `.spec.ts`) | May open raw for seeding |

## Contracts Fan-Out Lint (T10074 / E-SSOT-ENFORCEMENT)

`scripts/lint-contracts-fan-out.mjs` (CI job: `Contracts Fan-Out Lint (T10074)`) detects
`export interface` and `export type` declarations in `packages/cleo/src/` or
`packages/core/src/` that are imported by **more than 2 other packages** (fan-out > 2).
High-fan-out types belong in `packages/contracts/` so consumers pull a leaf package
instead of the full cleo/core dependency graph.

**Baseline mode (default):** CI reads `scripts/.lint-contracts-fan-out-baseline.json` and
fails only when the finding count **increases** (regression prevention). Improvements
(count drops) are always accepted. Run `node scripts/lint-contracts-fan-out.mjs --baseline`
after reducing violations to lock in progress.

**Strict mode:** `--strict` exits 1 on any finding (zero-tolerance gate).

**Opt-out:** append `// fan-out-ok: <reason>` on the export declaration line to exempt
a specific type (e.g. intentional CLI-only or core-only shape).

**Threshold:** defaults to fan-out > 2. Override with `--threshold N`.

## SSoT-EXEMPT Escape-Hatch Policy (T10075 / Epic T9837 / Saga T9831)

`SSoT-EXEMPT` is a controlled escape-hatch comment for code that legitimately
deviates from the Architectural SSoT contracts established by Saga T9831
SG-ARCH-SOLID. Every NEW `SSoT-EXEMPT` comment added in a PR is gated by
`scripts/lint-no-ssot-exempt.mjs` (CI job `ssot-exempt-lint`).

### Rules

| Mode | Behaviour |
|------|-----------|
| `--strict` (CI default) | Zero new `SSoT-EXEMPT` comments allowed — gate fails regardless of task linkage |
| `--baseline` (local default) | New `SSoT-EXEMPT` comments without a linked open `T####` task fail |

### Valid comment formats

```ts
// SSoT-EXEMPT:<reason> (T####)
// SSoT-EXEMPT: reason T####
// SSoT-EXEMPT:reason — tracked in T####
```

The `T####` MUST reference a task that is **not** in a terminal state
(`completed`, `cancelled`, or `deleted`).

### Per-line opt-out (use sparingly)

```ts
// SSoT-EXEMPT:reason (T####) // ssot-exempt-ok: genuinely irreducible
```

Adding `// ssot-exempt-ok: <reason>` as a trailing comment suppresses the linter
for that specific line. Reserve for cases where the exemption is provably permanent.

### How to add a legitimate exemption

1. File a follow-up task: `cleo add --type task --title "Remove SSoT-EXEMPT in <file>" --acceptance "..."`
2. Use the task ID in the comment: `// SSoT-EXEMPT: <reason> (T####)`
3. In CI the gate runs `--strict` — getting a legitimate exemption merged requires
   team discussion and a temporary relaxation of the CI gate (tracked separately).

## Architectural Boundary Check (SG-ARCH-SOLID · T9837)

Five CI gates enforce the SG-ARCH-SOLID architectural invariants. Run all five at once with:

```bash
cleo check arch          # baseline mode — fails only on regressions
cleo check arch --strict # zero-tolerance — fails on any violation
```

All five scripts are also wired into the `Architectural Boundary Check (SG-ARCH-SOLID T9837)`
CI job in `.github/workflows/ci.yml` (baseline mode by default).

### Gate 1 — No `defineCommand()` outside `cli/lib` factory (T9837a)

Script: `scripts/lint-no-raw-define-command.mjs`

Any `defineCommand()` call outside `packages/cleo/src/cli/lib/define-cli-command.ts` is a
violation. The factory wrapper is the canonical extension point.

**Example violation:**
```ts
// packages/cleo/src/cli/commands/foo.ts
import { defineCommand } from 'citty'; // VIOLATION — must use lib factory
```

**Remediation:** Replace with the factory import from `../lib/define-cli-command.js`.

### Gate 2 — No `DatabaseSync` outside `core/store` (T9837b)

Script: `scripts/lint-no-direct-db-open.mjs`

`new DatabaseSync(` or `new Database(` outside `packages/core/src/store/` are blocked.
All DB opens must flow through `openCleoDb(role, cwd)` (ADR-068).

**Remediation:** Use `openCleoDb(role, cwd)` from `@cleocode/core/store/open-cleo-db`.

### Gate 3 — No inline types imported by >2 files (T9837c)

Script: `scripts/lint-contracts-fan-out.mjs`

An `export interface` or `export type` declared inline in `packages/cleo/` or
`packages/core/` that is imported by more than 2 other files must move to
`packages/contracts/src/`.

**Remediation:** Promote the type to `packages/contracts/src/<domain>/` and
re-export it from the contracts barrel.

### Gate 4 — No `SSoT-EXEMPT` without a linked task ID (T9837d)

Script: `scripts/lint-no-ssot-exempt.mjs`

Every `// SSoT-EXEMPT` comment must be followed by a task ID (e.g. `T1234`) on the
same line or the next line. Bare exemptions with no follow-up are rejected.

**Example violation:**
```ts
const db = new Database(path); // SSoT-EXEMPT  ← missing task ID
```

**Remediation:** Add the tracking task ID: `// SSoT-EXEMPT: T1234`.

### Gate 5 — No business-logic helper > 30 LOC in CLI commands (T9837e)

Script: `scripts/lint-cli-package-boundary.mjs`
Baseline: `scripts/.lint-cli-boundary-baseline.json`

Any standalone named function (`function foo(...)`) inside
`packages/cleo/src/cli/commands/**/*.ts` that spans > 30 lines is a violation.
Such helpers must live in `packages/core/` where they can be unit-tested and
reused without CLI framework coupling.

**Exempt by convention:**
- Functions named `*Command` or `make*Command` (citty factory helpers)
- Functions annotated with `// cli-boundary-ok: <reason>` on the declaration line
- Files annotated with `// cli-boundary-file-ok: <reason>` in the first 20 lines

**Example violation:**
```ts
// packages/cleo/src/cli/commands/release.ts
async function buildChangelogSection(tasks: Task[]): Promise<string> {
  // 87 lines of business logic — VIOLATION
}
```

**Remediation:**
1. Move `buildChangelogSection` to `packages/core/src/release/changelog.ts`
2. Export it from the core barrel
3. Import via `@cleocode/core`
4. Update the baseline: `node scripts/lint-cli-package-boundary.mjs --baseline`

**Current mode:** baseline (fails on increase; count decreases always pass).
Flip to `--strict` after E-CLI-BOUNDARY (T9833) fully closes.

## Dogfood: Deployed Template Parity (T9860 · Saga T9855)

`packages/cleo/templates/workflows/*.yml.tmpl` (being relocated to
`packages/core/templates/workflows/*.yml.tmpl` by T9858) are the canonical
sources for the GitHub Actions workflows shipped to consuming projects via
`cleo init --workflows`. The deployed copies in `.github/workflows/` of *this*
repo are supposed to BE the rendered output. Today the deployed
`release-prepare.yml` has drifted: it lacks the SPEC-T9345 R-200/R-260
preflight job, hardcodes its node version + install command + branch prefix,
and skips the canonical placeholder substitution pass entirely.

This gate doesn't fix the drift — it pins the current state as a baseline and
prevents NEW divergence from creeping in. Closing the drift itself is a
separate follow-up.

| Command | What it does |
|---|---|
| `node scripts/lint-deployed-template-parity.mjs` | Default (baseline) — fails when finding count exceeds `.lint-deployed-template-parity-baseline.json` |
| `node scripts/lint-deployed-template-parity.mjs --strict` | Zero-tolerance — any divergence fails |
| `node scripts/lint-deployed-template-parity.mjs --update-baseline` | Regenerate the baseline JSON to accept the current state |

The script renders each template's `{{KEY}}` placeholders using project-context
defaults (NODE_VERSION=24, INSTALL_CMD=`pnpm install --frozen-lockfile`,
LINT_CMD=`pnpm biome check .`, TYPECHECK_CMD=`pnpm run typecheck`,
TEST_CMD=`pnpm run test`, BUILD_CMD=`pnpm run build`, BRANCH_PREFIX=`release`,
PR_LABEL=`release`), parses both the rendered template and the deployed YAML,
and compares structurally — `on:` triggers + inputs, `permissions`, and per-job
`runs-on`/`run`-step set/`uses`-step set. Whitespace, comment order, and
re-ordering of independent steps with the same `run:` body do not register as
divergence.

### Adding a new template → deployed pair

Edit `PARITY_MAP` in `scripts/lint-deployed-template-parity.mjs`:

```js
const PARITY_MAP = [
  {
    template: 'packages/core/templates/workflows/<name>.yml.tmpl',
    deployed: '.github/workflows/<name>.yml',
    fallbackTemplate: 'packages/cleo/templates/workflows/<name>.yml.tmpl', // optional
  },
];
```

Then run `--update-baseline` to capture the new entry's accepted drift.

CI gate: `Deployed Template Parity (T9860)` job in `.github/workflows/ci.yml`.

## Package-Boundary Check (MANDATORY)

Before creating or relocating ANY source file, verify the correct package by the
canonical layering contract:

| Package                    | Purpose                                           |
|----------------------------|---------------------------------------------------|
| `packages/core/`           | SDK — runtime primitives, domain logic, store, memory, sentient, gc |
| `packages/cleo/`           | CLI ONLY — thin dispatch + CLI command handlers   |
| `packages/contracts/`      | Shared types — envelope, operations, errors       |
| `packages/cleo-os/`        | Harness — Pi/Claude-Code adapters, CleoOS runtime |
| `packages/caamp/`          | Agent agent-manifest packaging (CAAMP)            |
| `packages/studio/`         | Frontend Studio (SvelteKit)                       |
| `packages/lafs/`           | LAFS envelope spec + validator                    |
| `packages/cant/`           | .cant DSL + parser                                |
| `packages/llmtxt-core/`    | llmtxt BlobOps/AgentSession primitives            |

Anti-patterns:
- ❌ Adding runtime/SDK code to `packages/cleo/` because files already exist there
- ❌ Placing cross-package shared types inline instead of in `packages/contracts/`
- ❌ Harness-specific code in `packages/core/` (belongs in `packages/cleo-os/`)
- ❌ CLI command handlers reaching into OS-level concerns (belongs in cleo-os)

When a task introduces new modules, the orchestrator MUST include an acceptance criterion of the form:
"Code placed in <packages/xxx/> per Package-Boundary Check — verified against AGENTS.md"

If existing files violate the boundary, flag as a separate cleanup task (e.g., T1015-style relocation epic). Do NOT continue appending to the wrong package.

## Task Hierarchy (PM-Core V2 — ADR-088)

**Canonical source:** `docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md`.
Legacy charter ADR-073 remains authoritative for pre-PM-Core V2 semantics; ADR-088 governs the PM-Core V2 target.

| Tier    | Prefix | type value | Scope-of-change                                    | Owner (ADR-070)       |
|---------|--------|------------|----------------------------------------------------|------------------------|
| Saga    | `SG-`  | `saga`     | Theme grouping ≥2 Epics across ≥2 releases         | Orchestrator (read)    |
| Epic    | `E-`   | `epic`     | One releasable slice; ≥1 PR to `main`              | Orchestrator (HITL)    |
| Task    | `T-`   | `task`     | One atomic PR-sized change; single wave            | Phase Lead             |
| Subtask | (none) | `subtask`  | One commit; ≤2 files; contributes to Task's PR     | Worker (leaf)          |

**Containment (I1):** `tasks.parent_id` is the **only** containment edge. Direct children,
ancestor/descendant traversal, closure rollups, and default parent completion are all derived
from `parent_id`. The parent matrix is:

| Child type | Parent type |
|------------|-------------|
| `subtask`  | `task`      |
| `task`     | `epic`      |
| `epic`     | `saga` or `null` |
| `saga`     | `null`      |

**Storage (I2):** All IDs stored as `T####`; `type` column discriminates tier (not `label`).
Prefixes (`SG-`, `E-`) are DISPLAY + import-mapping only.

**Non-containment (I3):** `task_relations` is for secondary graph semantics ONLY — dependency,
ordering, cross-reference, evidence, supersession, provenance. `task_relations` MUST NOT satisfy
containment, child listing, ancestor/descendant traversal, parent rollup, parent completion,
nesting-budget, or closure semantics. A relation can explain why work is associated, but it
cannot make that work a parent or child.

**Migration note:** T10638 (E10.W5) removed legacy `task_relations.groups` hierarchy reads and
dual-shape `label='saga'` fallbacks. Saga detection now uses `type='saga'`. Some CLI help text
in the released v2026.5.122 still references `label='saga'` — these help strings are cosmetic
and will be updated in a follow-up.

## Completion Criteria (PM-Core V2 — Typed ACs)

PM-Core V2 introduces typed acceptance criteria so parent completion can be derived
deterministically from child state (ADR-088 §4, T10639 backfill).

`task_acceptance_criteria.kind` is one of:

| Kind | Requires `target_task_id` | Purpose |
|------|--------------------------|---------|
| `text` | No | Human-authored acceptance criterion |
| `child_task` | **Yes** | Deterministic projection from a direct `parent_id` child |
| `evidence_bound` | No | Gate-backed criterion (`implemented`, `testsPassed`, `qaPassed`) |

**Key rules:**
- A parent with children uses `child_task` criteria by default; these are **deterministic
  projections** from `parent_id` containment. T10639 backfill ensures all existing
  parent→child relationships have corresponding `child_task` rows.
- `text` and `evidence_bound` criteria must NOT use `target_task_id`.
- Mixed criteria mode (`child_task` + `text` on the same parent) is **migration-only**
  or explicit advanced scope.
- Cancelled children do NOT automatically satisfy parent completion; they require waiver
  or replacement evidence.
- Adding or reopening required child work under a done parent reopens affected ancestors
  or creates explicit regression/rework tasks.

## Saga Operations (PM-Core V2)

Saga-level orchestration is first-class in PM-Core V2. Saga membership uses `parent_id`
containment (not `task_relations.groups`). Use `cleo orchestrate` commands directly on
saga IDs:

```bash
# Saga-level ready frontier — parallel-safe tasks across all member epics
cleo orchestrate ready <sagaId>

# Saga-level dependency waves — unified wave plan across all member epics
cleo orchestrate waves <sagaId>

# Saga status rollup — completion %, member counts
cleo saga rollup <sagaId>

# Saga membership listing via parent_id containment
cleo saga members <sagaId>
```

**Epic-level fallback:** If saga-level orchestrate fails, enumerate member epics from
`cleo saga members <sagaId>` and call `cleo orchestrate ready <epicId>` for each member
individually. Do not use `task_relations.groups` as a fallback for hierarchy —
it is non-containment only per I3.

## WorkGraph (PM-Core V2 — T10632/T10633/T10634)

The WorkGraph subsystem provides scaffold validation, atomic application, and planning
document generation.

| Feature | Task | What it does |
|---------|------|--------------|
| Scaffold Dry-Run Validator | T10632 | Validates WorkGraph JSON payloads against schema invariants before mutation. Returns `wouldCreate`/`wouldUpdate`/`wouldDelete`/`wouldAffect` without side effects. |
| Scaffold Apply Engine | T10633 | Atomically applies validated WorkGraph scaffolds to the task database. Creates, updates, and deletes tasks/relations/ACs in a single transaction. Sibling-relation-based (SQLite trigger blocks parent-child relation edges). |
| Planning Doc Generator | T10634 | `generatePlanningDoc()` produces structured markdown plans from the WorkGraph. Supports "agent" (compact) and "maintainer" (prose) output modes. |

## Task Context (PM-Core V2 — T10629/T10630/T10631)

Bounded task context with token budgeting for agent ergonomics.

| Feature | Task | What it does |
|---------|------|--------------|
| Task Context Pack | T10629 | `coreTaskContext` returns targeted task information (identity, acceptance criteria, blockers, edges, activity) respecting a configurable token budget. Uses `TasksContextOmission` to track overages and provides expansion hints. |
| Saga Context & Readiness | T10630/T10631 | Saga-level aggregate rollups: completion percentages, ready-frontiers, and blocker enumeration across all member epics via `parent_id` containment. |

## Sentient / Tier-2 Proposals

The `cleo sentient` subsystem manages autonomous task proposals.

- `cleo sentient status` — Show daemon status, kill-switch state, and tick stats.
- `cleo sentient propose enable` — Enable Tier-2 proposal generation.
- `cleo sentient propose disable` — Disable Tier-2 proposal generation.
- `cleo sentient propose list` — List all Tier-2 proposals (status=proposed).
- `cleo sentient propose accept <id>` — Accept a proposal.
- `cleo sentient propose reject <id>` — Reject a proposal.

Tier-2 proposals are **disabled by default**. Enable them with `cleo sentient propose enable`.
The kill-switch (`cleo sentient kill`) is always respected regardless of Tier-2 state.

## Release & Branching (ADR-065, SPEC-T9345)

All releases flow through a PR-gated pipeline. Direct pushes to `main` are
prohibited. The current pipeline uses the 4-verb model — `plan` → `open` →
`reconcile` (or `rollback`) — introduced by SPEC-T9345 and finalized when
T9540 removed the legacy `start` / `verify` / `publish` verbs.

All PRs target `main` through the **GitHub Merge Queue**; see
docs/release/merge-queue-runbook.md for the full runbook.

### Merge Queue & Zero-Admin-Merge Policy

This repository uses **GitHub Merge Queue** for all PRs targeting `main`.
Merge queue guarantees that every commit on `main` has passed CI on the
*exact* merge commit (not just the PR branch tip), eliminating the
"green PR + stale main" race condition.

**Zero-admin-merge policy**: No human clicks "Merge". Once a PR is
approved and CI-green, the author (or any collaborator) adds it to the
merge queue. The queue:
1. Builds the temporary merge commit (`gh-readonly-queue/<branch>`).
2. Runs the full CI matrix (all workflows that declare `merge_group:`).
3. On success, fast-forwards `main` and closes the PR automatically.

All 12 PR-gated workflows declare `merge_group:` in their `on:` block.
The five non-PR workflows (`release-prepare.yml`, `release.yml`,
`freshness-sentinel.yml`, `skills-council.yml`, `skills-grade.yml`) do
not need `merge_group:` because they are triggered by `workflow_dispatch`,
tag push, or cron — never by a PR merge event.

See `docs/release/merge-queue-runbook.md` for setup, operator commands,
troubleshooting, and FAQ.

### Branch Conventions

- **Feature work**: `feat/T####-<slug>` or `task/T####-<slug>` branches
- **Release branches**: cut by the `release-prepare` GitHub Actions workflow
  (dispatched by `cleo release open`) as `release/v<version>`
- **Main branch**: receives merges only from reviewed, CI-green PRs via
  the merge queue

### Shipping a Release

```bash
# 1. Plan — build the canonical Release Plan envelope.
#    Writes `.cleo/release/v<version>.plan.json` and persists one row in
#    `releases` with status='planned'. Read-mostly: no git mutations,
#    no `gh` calls, no network.
cleo release plan v2026.MM.N --epic TXXXX
# For cross-Epic release windows, pass the exact release task set explicitly.
cleo release plan v2026.MM.N --tasks TXXXX,TYYYY

# 2. Open — dispatch the release-prepare GHA workflow. The workflow cuts
#    `release/v<version>`, commits changelog + version bump, pushes the
#    branch, and opens the PR. `releases.status` advances to 'pr-opened'.
#    Use `--commit-plan` to commit the plan file in the same step.
cleo release open v2026.MM.N

# 3. (Optional) Poll PR + CI status while the workflow runs.
cleo release pr-status v2026.MM.N

# 4. Tag explicitly after the release PR merges. The retired
#    auto-tag-on-release-merge workflow is a no-op; do not rely on
#    GITHUB_TOKEN tag pushes to trigger downstream release publishing.
git tag -a v2026.MM.N -m "Release v2026.MM.N"
git push origin v2026.MM.N

# 5. Reconcile — after release.yml publishes from the tag, reconcile
#    backfills the 11 provenance tables. Typically invoked by the publish
#    workflow itself; can be run manually with --from-workflow=false.
cleo release reconcile v2026.MM.N
```

### Per-task evidence gating

Per-task quality gates are no longer batched at release time. The legacy
`cleo release verify` verb was removed in T9540; each task's gates must be
recorded individually via the ADR-051 evidence-based ritual BEFORE
completion:

```bash
# Per-task — runs once per gate, with programmatic evidence.
cleo verify T#### --gate implemented --evidence "commit:<sha>;files:..."
cleo verify T#### --gate testsPassed --evidence "tool:test"
cleo verify T#### --gate qaPassed --evidence "tool:lint;tool:typecheck"
cleo verify T#### --gate documented --evidence "files:..."

# Then mark the task done. CLEO re-validates every hard atom on complete.
cleo complete T####
```

See "Pre-Complete Gate Ritual (ADR-051)" in the protocol injection for the
full atom grammar and tool-resolution rules.

### Rules

- **NO direct pushes to `main`** — the pipeline enforces this
- `gh` CLI must be authenticated (`gh auth status`)
- Branch model is configurable: `cleo config set release.branchModel feat-to-main`
- To check in-flight PR CI status: `cleo release pr-status <version>`
- The deprecated `cleo release ship` shim was **deleted in T10103** (Saga
  T10099). Use the explicit two-verb invocation: `cleo release plan` then
  `cleo release open`. The full verb-to-state map is in
  `docs/release/verb-matrix.md`.
- One-shot end-to-end smoke: `cleo release ship-e2e-smoke <version> --epic
  <id>` walks plan → open → wait-for-PR → wait-for-tag →
  verify-npm-published. Dry-run by default; add `--execute` to perform
  real mutations. Idempotent and resumable from any failure point.

### Auto-Tag on Release Merge (Retired)

`.github/workflows/auto-tag-on-release-merge.yml` is retained only as a
manual-dispatch no-op with audit annotation `# @task T10434`. The previous
workflow pushed a `v*` tag from a `GITHUB_TOKEN` context and expected that tag
push to trigger downstream `release.yml`; ADR-087 retires that two-hop chain.
After a release prepare PR merges, create and push the release tag explicitly
(or manually dispatch `release.yml` against an existing tag).

### Branch Protection

Owner runs once to enforce protection at the GitHub level:

```bash
gh api -X PUT repos/:owner/:repo/branches/main/protection \
  -f required_status_checks[strict]=true \
  -f required_status_checks[contexts][]=CI \
  -f required_status_checks[contexts][]="Lockfile Check" \
  -f required_status_checks[contexts][]="Contracts Dep Lint" \
  -f enforce_admins=false \
  -f required_pull_request_reviews[required_approving_review_count]=0 \
  -f restrictions=null
```

See `docs/release/branch-protection-setup.md` for full setup guide.

## Runtime Data Safety (ADR-013 §9)

`.cleo/tasks.db`, `.cleo/brain.db`, `.cleo/config.json`, and
`.cleo/project-info.json` are **not tracked in git** — committing them
risks data loss on branch switch because git overwrites the live file
while SQLite's WAL sidecars remain out of sync.

- **Manual snapshot**: `cleo backup add` captures all four files using
  `VACUUM INTO` (SQLite) + atomic tmp-then-rename (JSON).
- **Auto snapshot**: every `cleo session end` triggers
  `vacuumIntoBackupAll` which writes `tasks-YYYYMMDD-HHmmss.db` and
  `brain-YYYYMMDD-HHmmss.db` under `.cleo/backups/sqlite/` (10 snapshots
  per DB, oldest rotated out).
- **List snapshots**: `cleo backup list`
- **Restore**: `cleo restore backup --file tasks.db` (or brain.db /
  config.json / project-info.json)
- **Fresh clones**: `cleo init` recreates config.json and
  project-info.json from code defaults. `tasks.db` and `brain.db` are
  created empty on first database access.

NEVER run `git add .cleo/tasks.db`, `.cleo/brain.db`, `.cleo/config.json`,
or `.cleo/project-info.json` — the root and nested `.gitignore` files
are configured to block this, but manual overrides will re-open the
T5158 data-loss vector.

## Worktree Subsystem (T9800 Saga — ADR-055 / D009)

CLEO manages agent worktrees through two complementary mechanisms:

### Canonical CLEO-spawned worktrees

Created by `cleo orchestrate spawn` via `packages/worktree/` SSoT. These
live under `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/` (XDG
canonical layout, D029). They are automatically listed, classified, and
cleaned up via `cleo worktree list|prune`.

### External worktrees (Claude Code Agent `isolation:worktree`)

Claude Code Agent tool spawns with `isolation:worktree` create directories
under `.claude/worktrees/<sessionId>/` **outside** the CLEO SSoT. These
bypass `cleo orchestrate spawn` entirely.

**Solution: Option B (Adopt)**  
CLEO cannot modify the Claude Code harness directly. Instead, external
worktrees are registered post-hoc using `cleo worktree adopt`.

#### Adopt command

```bash
# Register a Claude Code Agent worktree in the CLEO SSoT
cleo worktree adopt .claude/worktrees/<sessionId>

# With explicit source classification
cleo worktree adopt .claude/worktrees/<sessionId> --source claude-agent

# With explicit task ID association
cleo worktree adopt /path/to/worktree --source manual --task-id T9804
```

After adoption:
- The worktree appears in `cleo worktree list` tagged with `source: claude-agent`.
- An audit entry is appended to `.cleo/audit/worktree-lifecycle.jsonl`.
- The worktree is subject to the same auto-cleanup rules as CLEO-spawned worktrees.

#### Sentinel index

Adopted worktrees are tracked in `.cleo/worktrees.json` (council D009 hybrid
pattern). This file is gitignored and advisory — integrity does not depend on it.

**IMPORTANT**: Agents that use `isolation:worktree` MUST call `cleo worktree adopt`
immediately after the worktree is created if they want the worktree to surface in
`cleo worktree list` and receive lifecycle cleanup hooks. AC4 and AC5 validation
(real-world 5-agent test + `.claude/worktrees/` depopulation) are handled by T9808.