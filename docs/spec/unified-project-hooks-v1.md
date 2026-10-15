# Unified project hooks v1 implementation

## Goal

CLEO delivers and executes opt-in project checks across harnesses, Git and worktrees. Projects own their checker implementation and policy. The owner-approved plan is `unified-hooks-canary-v1` (T13342). Git repair T13349 and independent canary channel T13350 ship in separate PRs.

## Interfaces

Track `.cleo/hooks.json` with `schemaVersion: 1` and an ordered `hooks` array. Each hook specifies `id`, `owner: "project"`, `bindings` of source/event pairs, `executable`, project-relative `handler`, literal `args`, declared `dependencies`, `timeoutMs`, and `checkerErrorPolicy` (`warn` or `block`). IDs starting `cleo.` are reserved. No implicit shell is used by the executor.

Run `cleo hook sync --dry-run` to validate and preview changes. `cleo hook sync --activate` records local approval and delivers supported project-local integrations. `cleo hook sync --disable` disables execution and undoes only what activation wrote: it removes provably owned, unchanged provider additions, skips providers with no delivery receipt and creates no files or directories. Containers emptied by the removal are dropped; a provider config file, and the directory holding it, that activation created are deleted once empty, while a pre-existing file keeps its other content byte-identical. A receipt written before T13743 records no creation, so its config is pruned but kept. Existing built-in Git checks remain installed. `cleo doctor hooks` inspects; `--fix` repairs delivery only while approved inputs remain active. `cleo hook check <id> --ci --candidate <sha>` checks an exact CI candidate.

`hooks.project.enabled` is machine-local state under Git's private `cleo-project-hooks` path, defaults false, and cannot be granted by tracked configuration. Activation binds project identity, normalized definition, handler/dependency/lockfile content, and resolved executable content. Changed inputs require explicit reactivation. A drifted or missing approval runs no handler: every matching check refuses wherever its `block` verdict would be enforced (Git pushes, worktree lifecycle, direct and CI checks) with code `HOOK_REACTIVATION_REQUIRED` and a message naming `cleo hook sync --activate`; agent checks only warn (T13742). Linked worktrees inherit approval only for the same project and identical executable inputs.

Native harness project trust and exact hook-definition trust remain independent. CLEO never grants them automatically. Unknown harness versions and unobserved live delivery remain unverified. Kimi project-local delivery is unsupported; no global workaround is written.

## Release gate (T13557)

Project hooks are gated behind the unreleased feature `hooks-v1` (`packages/core/src/hooks/release-gate.ts`) until the stable promotion. On a build where it is unreleased, `cleo hook sync --activate` refuses with `E_HOOKS_V1_UNRELEASED` and writes no receipt. An existing activation receipt reports `activation: "unreleased"` and never runs: agent, Git and direct invocations return a non-blocking `skip` with code `HOOKS_V1_UNRELEASED`, a required `cleo hook check --ci` fails, and no handler is spawned. `cleo hook sync --disable` keeps working. A source checkout carries a stable version, so it is gated too; only code that passes the gate's `allowUnreleased` option (tests) opts in.

The gate opens from release metadata only, so the pilot's implementation-source digest stays valid: a `-canary.N` build runs hooks, and the stable release planned with `--hooks-v1-promotion` stamps `cleo.releasedFeatures: ["hooks-v1"]` into `@cleocode/core`'s manifest (`scripts/mark-hotfix-release.mjs`; the digest normalizes the stamp out). A stable candidate without the stamp proves the runtime inert instead of exercising it. After the promotion, remove `hooks-v1` from `UNRELEASED_HOOK_FEATURES` in an ordinary change before the next stable release, which no longer stamps it.

## Execution and policy

The checker receives one JSON HookInvocation on stdin, including the active Git checkout, source/event and relevant ref updates, normalized tool input or lifecycle context. Emit exactly one JSON object on stdout with status `pass`, `block`, `warn`, `skip` or `checker-error` and an optional bounded message; exit zero. Nonzero, malformed output, signal and configured timeout are checker failures.

Agent checks are advisory and never rewrite commands. Git supplies exact pushed refs and OIDs; project blocks prevent pushes. Checker failures follow the declared local policy. CLEO infrastructure faults always warn/allow locally; required CI checks fail on infrastructure faults, missing approval or unverifiable results. All definitions execute in order; approval is checked again between handlers.

Input and combined child output are bounded to 64 KiB. Each hook timeout is at most 120 seconds; the entire invocation has a 120-second budget. Budget exhaustion is an infrastructure fault. Hashing streams bounded files under that deadline. Cancellation kills the checker process group on POSIX; independently detached descendants and Windows process-tree cleanup remain limited. No complete environment or payload is persisted. Last-result receipts retain bounded outcome metadata and the authorizing manifest hash, omitting checker messages.

## Worktree integration

The worktree package consumes the HookExecutor contracts port; it does not import core. Core injects an executor bound to the parent approval. Shared post-create/start checks precede the corresponding legacy hooks. Reattached worktrees preserve existing lifecycle behavior. Explicit duplicate registration via `projectHookId` is rejected before execution.

## VidaPeps pilot

VidaPeps branch `feat/T13347-unified-hooks-pilot`, initial implementation commit `a37e82cf7021c2e73736ccfc39daf878bbf6ae15`, consolidates migration checks around committed Git objects. Journal and SQL come from the same exact candidate. Multiple, new, deleted, non-HEAD and force-pushed refs are supported; ordinary agent commands do not query databases. Each environment ledger is read once per invocation. Confirmed pending migrations and structural defects block locally; unavailable verification warns locally and fails CI. Production boot enforcement remains unchanged.

## Validation and recovery

Targeted tests, formatting, governed build, architecture, cycles, command delivery and actual installed tarballs are required. The installed probe verifies disabled/activated/drifted state, native adapter execution receipts, actual allow/block pushes and shared/legacy worktree lifecycle. This does not certify a live harness.

Before stable release, retain fresh proof bound to exact canary version, implementation-source digest, VidaPeps SHA and harness versions: local tarballs, exact published installation, live Claude/Codex sessions, hosted VidaPeps exact-candidate CI and read-only dev/production checks. Missing runner or proof holds promotion. A separate normal stable release publishes; no manual npm tag movement.

At publication of this implementation note, Git repair has 57 focused passing tests, VidaPeps has 22 and a targeted typecheck, and delivery's initial 17 focused tests pass. Subsequent hardening, executor, integrated build, packed preflight and external pilot gates remain pending; consult task evidence for current results. No acceptance or live certification is inferred from source inspection.

Recovery uses explicit disable and hash-guarded removal/rollback receipts, preserving foreign/customized hooks, existing resource-budget behavior and VidaPeps boot protection.

## Owners

CLEO owns schemas, execution, provider delivery, provenance and packaging. VidaPeps owns database identity, migration policy and checker code. cleo-dev-mac reviews release changes; review-hotfix reviews feature/Git repair PRs. The owner approves native trust when needed.
