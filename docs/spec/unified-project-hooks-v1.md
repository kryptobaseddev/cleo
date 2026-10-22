# Unified project hooks v1 implementation

## Goal

CLEO delivers and executes opt-in project checks across harnesses, Git and worktrees. Projects own their checker implementation and policy. The owner-approved plan is `unified-hooks-canary-v1` (T13342). Git repair T13349 and independent canary channel T13350 ship in separate PRs.

## Interfaces

Track `.cleo/hooks.json` with `schemaVersion: 1` and an ordered `hooks` array. Each hook specifies `id`, `owner: "project"`, `bindings` of source/event pairs, `executable`, project-relative `handler`, literal `args`, declared `dependencies`, `timeoutMs`, and `checkerErrorPolicy` (`warn` or `block`). IDs starting `cleo.` are reserved. No implicit shell is used by the executor.

Run `cleo hook sync --dry-run` to validate and preview changes. `cleo hook sync --activate` records local approval and delivers supported project-local integrations. `cleo hook sync --disable` disables execution and undoes only what activation wrote: it removes provably owned, unchanged provider additions, skips providers with no delivery receipt and creates no files or directories. Containers that activation created and the removal empties are dropped, and the delivery receipt is deleted; a provider config file, and the directory holding it, that activation created are deleted once empty, while a pre-existing file keeps its other content byte-identical. For a receipt written before T13743, CLEO's entries are removed; the container and file are kept. Existing built-in Git checks remain installed. `cleo doctor hooks` inspects; `--fix` repairs delivery only while approved inputs remain active. `cleo hook check <id> --ci --candidate <sha>` checks an exact CI candidate.

`hooks.project.enabled` is machine-local state under Git's private `cleo-project-hooks` path, defaults false, and cannot be granted by tracked configuration. Activation binds project identity, normalized definition, handler/dependency/lockfile content, and resolved executable content. Changed inputs require explicit reactivation. A drifted or missing approval runs no handler: Git pushes, worktree lifecycle, direct and CI checks refuse with code `HOOK_REACTIVATION_REQUIRED` and a message naming `cleo hook sync --activate`, attributed to every approved or current hook (including hooks a linked checkout declares) that matches the event. An event none of them binds runs no hooks, except that an activation recorded before bindings were stored refuses it too. Activation records each hook's approved bindings, so a change that deletes, rebinds or corrupts a hook definition cannot escape: while such an activation exists, a `.cleo/hooks.json` that no longer parses, or a handler, dependency, lockfile or project-relative executable that is deleted or replaced by a directory, refuses the approved bindings. An activation without stored bindings refuses every non-agent event in those cases. The bindings carry a digest; bindings that fail it are treated as absent. A missing PATH runtime and other infrastructure faults still allow locally. Agent checks only warn (T13742). Linked worktrees inherit approval only for the same project and identical executable inputs.

Native harness project trust and exact hook-definition trust remain independent. CLEO never grants them automatically. Unknown harness versions and unobserved live delivery remain unverified. Kimi project-local delivery is unsupported; no global workaround is written.

## Release gate (T13557)

hooks-v1 was promoted to stable in v2026.10.17 and is released in source since T13776: `UNRELEASED_HOOK_FEATURES` (`packages/core/src/hooks/release-gate.ts`) is empty, so every build activates and runs project hooks with no release stamp. While a hook feature is unreleased, the gate behaves as follows. `cleo hook sync --activate` refuses with `E_HOOKS_V1_UNRELEASED` and writes no receipt. An existing activation receipt reports `activation: "unreleased"` and never runs: agent, Git and direct invocations return a non-blocking `skip` with code `HOOKS_V1_UNRELEASED`, a required `cleo hook check --ci` fails, and no handler is spawned. `cleo hook sync --disable` keeps working. Only code that passes the gate's `allowUnreleased` option (tests) opts in.

During the promotion the gate opened from release metadata only, so the pilot's implementation-source digest stayed valid: a `-canary.N` build ran hooks, and the stable release planned with `--hooks-v1-promotion` stamped `cleo.releasedFeatures: ["hooks-v1"]` into `@cleocode/core`'s manifest (`scripts/mark-hotfix-release.mjs`; the digest normalizes the stamp out). Releases after the promotion no longer stamp it.

## Execution and policy

The checker receives one JSON HookInvocation on stdin, including the active Git checkout, source/event and relevant ref updates, normalized tool input or lifecycle context. Emit exactly one JSON object on stdout with status `pass`, `block`, `warn`, `skip` or `checker-error` and an optional bounded message; exit zero. Nonzero, malformed output, signal and configured timeout are checker failures.

Agent checks are advisory and never rewrite commands. Git supplies exact pushed refs and OIDs; project blocks prevent pushes. Checker failures follow the declared local policy. CLEO infrastructure faults always warn/allow locally; required CI checks fail on infrastructure faults, missing approval or unverifiable results. All definitions execute in order; approval is checked again between handlers.

Input and combined child output are bounded to 64 KiB. Each hook timeout is at most 120 seconds; the entire invocation has a 120-second budget. Budget exhaustion is an infrastructure fault. Hashing streams bounded files under that deadline. Cancellation kills the checker process group on POSIX; independently detached descendants and Windows process-tree cleanup remain limited. No complete environment or payload is persisted. Last-result receipts retain bounded outcome metadata and the authorizing manifest hash, omitting checker messages.

## Worktree integration

The worktree package consumes the HookExecutor contracts port; it does not import core. Core injects an executor bound to the parent approval. Shared post-create/start checks precede the corresponding legacy hooks. Reattached worktrees preserve existing lifecycle behavior. Explicit duplicate registration via `projectHookId` is rejected before execution.

## VidaPeps pilot

VidaPeps branch `feat/T13347-unified-hooks-pilot`, initial implementation commit `a37e82cf7021c2e73736ccfc39daf878bbf6ae15`, consolidates migration checks around committed Git objects. Journal and SQL come from the same exact candidate. Multiple, new, deleted, non-HEAD and force-pushed refs are supported; ordinary agent commands do not query databases. Each environment ledger is read once per invocation. Confirmed pending migrations and structural defects block locally; unavailable verification warns locally and fails CI. Production boot enforcement remains unchanged.

The later VidaPeps owner decision D096, accepted and linked to T2145, supersedes the original advisory-only legacy-hook criterion after deployment auto-apply (#902). The legacy Claude hook keeps dev-first and safety checks for `gh pr merge`, always runs `check:migration-generated`, and omits only its duplicate exact-ref push check when CLEO is proven active and Git hooks are not bypassed. An inactive CLEO gate or bypass retains the full legacy push check. D096 records the owner's 2026-10-16 ask-tool answer in vidapeps-lead session 59904a3d and the merged #867 implementation. This is project policy; CLEO's shared agent adapter remains advisory. T2145's revised criteria were present on 2026-10-17, but its verification gates were still pending at this audit.

## Validation and recovery

Targeted tests, formatting, governed build, architecture, cycles, command delivery and actual installed tarballs are required. The installed probe verifies disabled/activated/drifted state, native adapter execution receipts, actual allow/block pushes and shared/legacy worktree lifecycle. This does not certify a live harness.

Before stable release, retain fresh proof bound to exact canary version, implementation-source digest, VidaPeps SHA and harness versions: local tarballs, exact published installation, live Claude/Codex sessions, hosted VidaPeps exact-candidate CI and read-only dev/production checks. Missing runner or proof holds promotion. A separate normal stable release publishes; no manual npm tag movement.

At publication of this implementation note, Git repair has 57 focused passing tests, VidaPeps has 22 and a targeted typecheck, and delivery's initial 17 focused tests pass. Subsequent hardening, executor, integrated build, packed preflight and external pilot gates remain pending; consult task evidence for current results. No acceptance or live certification is inferred from source inspection.

Recovery uses explicit disable and hash-guarded removal/rollback receipts, preserving foreign/customized hooks, existing resource-budget behavior and VidaPeps boot protection.

## Prepare version 2 evidence for the next native pilot

This section is a draft handoff for maintainers and the VidaPeps pilot owner. It describes the implementation at CLEO commit `52788c40e1f5d900ce8bd77fc1e91ad86d5abe37`, consisting of #2315 at `ca416dadd6d54aff5fbcd172c613cc3cdfbd8360` and the separate T13831 follow-up. These changes are not a claim that a 10.19 canary has been published or its pilot has passed. Recheck the schemas and verifier at the frozen canary source before collecting final proof.

Use `schemaVersion: 2` for the evidence index and all seven proof files: `packedArtifact`, `publishedCanary`, `readOnlyDev`, `readOnlyProd`, `liveClaude`, `liveCodex`, and `hostedCi`. Every proof identifies the same exact canary version, normalized implementation-source digest, VidaPeps commit, and Claude/Codex versions. Hash every retained proof and native artifact with SHA-256. Paths are relative to the evidence directory and cannot escape it. Version 1 remains auditable for stable targets through 2026.10.17; it cannot certify a later promotion.

Both live proofs retain a `native` object with `sessionId`, `checkout`, `startedAt`, `endedAt`, `receipt`, `trust`, `contextInjection`, and `infrastructureFaults`. The receipt reference contains its relative `path`, `sha256`, `source: "agent"`, `event`, `recordedAt`, `sessionId`, and `harness`. Capture the actual agent receipt before cleanup: the runner preserves one last result for each source/event binding as well as the overall last result. A later Git invocation must not replace the retained agent proof.

The raw receipt must parse as the strict runner receipt, contain the actual native payload's `session_id`, and identify `claude-code` or `codex` as appropriate. Its event, timestamp, session, and provider must match the proof reference. Its timestamp must fall within the recorded session window. Cross-session reuse, a Claude receipt backing Codex, and unredacted extra fields are rejected. The Codex live proof must come from a linked worktree.

For promotion, record `trust.mode: "persisted"`, `trust.home: "isolated"`, and `trust.grantedBy: "native-interactive"` or `"native-command"`. The grant must occur through the harness's own supported flow in an isolated home. CLEO activation does not grant native trust. Bypass-mode and user-global trust may describe diagnostic runs, but do not satisfy this promotion gate; hand-seeded trust is not an accepted grant method.

For the observed Codex CLI 0.163.0, top-level and debug help expose no hook-trust subcommand. The [official hook trust guidance](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks) uses interactive `/hooks` to review and trust the current definition hash. Run that flow in the pilot's isolated home. A headless persisted-grant route remains unverified; don't replace it with direct trust-file edits.

Set `contextInjection` to `observed`, `unverified`, or `not-observed`. An observed claim requires a hash-bound `contextEvidence` artifact. Retain Claude's actual context attachment when available; do not infer context delivery from checker execution. Record bounded infrastructure faults separately as source/code pairs, using source `agent`, `git`, or `sandbox`. A Git receipt-write failure or sandbox ref-lock denial is not evidence that native agent delivery failed, and must not be relabeled as a successful Git receipt.

The hosted proof must use a successful `workflow_dispatch` of VidaPeps's `.github/workflows/migration-hook-pilot.yml` on a branch whose tip is the exact declared commit. The verifier re-fetches the run and jobs through GitHub's API and requires the matching repository, run ID, URL, workflow path, head SHA, and a successful real `exact-candidate` runner job. A pull-request run reports the branch head while its workflow can check a synthetic merge commit, so PR-triggered runs cannot certify version 2 evidence even when their reported head matches. No retained or self-attested event field substitutes for the fresh API response.

Before the pilot, coordinate the Codex linked-worktree discovery, native trust route, and sandbox receipt behavior with their task owners. Use scratch clones, disposable remotes, read-only environment ledgers, sibling-worktree no-op checks, and root-inert checks. Preserve the existing VidaPeps boot gate and record D096's project policy and T2145's pending criterion-linked verification separately. Preserve the original advisory-only migration-hook criterion as superseded history.

The owner decision recorded on T13342 at 2026-10-17 02:01:52 UTC, from the ask-tool answer in the cleo-dev-mac session, selects an ordinary 10.19 release without `--hooks-v1-promotion`. The verifier changes can land in that release; the version 2 re-pilot runs separately against a 10.19 canary. Its passing evidence gates a later release explicitly prepared with `--hooks-v1-promotion`. Ordinary 10.19 publication does not complete this goal's native validation or hooks promotion. Freeze and publish the canary, collect fresh evidence against it, then validate the bundle before that separate promotion. Historical 10.17 receipts and local adapter tests do not replace the fresh pilot.

## Owners

CLEO owns schemas, execution, provider delivery, provenance and packaging. VidaPeps owns database identity, migration policy and checker code. cleo-dev-mac reviews release changes; review-hotfix reviews feature/Git repair PRs. The owner approves native trust when needed.
