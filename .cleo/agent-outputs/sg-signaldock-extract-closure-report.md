# Saga T10180 SG-SIGNALDOCK-EXTRACT — Closure Report

**Closed:** 2026-05-23
**Slug:** sg-signaldock-extract-closure-report
**Outcome:** ALL 7 EPICS GREEN — signaldock extracted from cleocode → self-sustained at /mnt/projects/signaldock + crates.io

## Headline

cleocode workspace holds ZERO signaldock-* code. 9 crates published to crates.io across two repos. Boundary registry reflects migrated-out state.

## Per-Epic Receipts

### T10211 — E-SIGNALDOCK-WORKSPACE (T10181 W0)
- signaldock PR #7 merged at `6840a445`
- cleocode PR #501 merged at `d5a17632b`
- Result: signaldock/ restructured as proper Cargo workspace with `crates/*` glob

### T10213 — E-SIGNALDOCK-CRATE-MIGRATE (T10182 + T10183 W1+W2)
- signaldock PR #8 merged at `2bd171e2` (6 SDK crates received)
- cleocode PR #514 (T10187/W5) shipped externally in parallel — replaced cleocode-side T10182 work; T10183 collapsed (path deps wired in PR #8)

### T10217 — E-CLEOCODE-SIGNALDOCK-DELETE (T10187 W5/W6)
- cleocode PR #514 merged at `6827f457` — deleted all 7 signaldock-* crates from cleocode
- cleocode workspace shrunk from 19 → 12 crates
- ~17k LOC removed from cleocode

### T10212 — E-SIGNALDOCK-REPO-CLEANUP (T10188 W7)
- `signaldock-core` GitHub repo: ARCHIVED (isArchived=true verified via `gh repo view`)
- `signaldock-runtime-standalone` GitHub repo: confirmed already deleted (no-op)

### T10216 — E-SIGNALDOCK-CRATESIO-PUBLISH (T10185 + T10254 W4)
- conduit-core RENAMED → cleo-conduit-core to dodge crates.io name squat (cleocode PR #526 at `bfbc8b29`)
- cant-core bogus cleo-conduit-core dep dropped (cleocode PR #545 at `1538e083`)
- T10254: cargo-release adopted for atomic monorepo workspace publishes (cleocode PR #550 at `f52dcb845`)
- signaldock-side cutover: git deps → crates.io registry + publish=true flip on 4 SDK crates (signaldock PR #10 at `6fa4a5eb`)
- signaldock-storage spec vendor fix (signaldock PR #11 at `59f9d76b`)

#### crates.io publishes (live)
**cleocode** (@ 2026.5.105):
- `lafs-core`
- `cleo-conduit-core`
- `cant-core`

**signaldock** (@ 2026.5.0):
- `signaldock-core`
- `signaldock-protocol`
- `signaldock-storage`
- `signaldock-transport`
- `signaldock-sdk`
- `signaldock-payments`

Trusted publisher (OIDC) configured for the 3 cleocode crates via `release.yml`. signaldock-side trusted publisher setup deferred (owner action).

### T10214 — E-SIGNALDOCK-RUNTIME-CUTOVER (T10184 + T10186 W3+W5)
- T10184: drift reconcile NO-OP (cleocode runtime was strict subset of standalone; standalone has unique `health.rs` + `sse_receiver.rs` that cleocode lacked; ZERO cleocode-only code to fold forward)
- T10186: signaldock-runtime cutover NO-OP — runtime has no signaldock-* deps at all (verified by reading `/mnt/projects/signaldock-runtime/Cargo.toml`; it's a standalone HTTP client, just clap + tokio + reqwest)

### T10215 — E-SIGNALDOCK-CLOSURE (T10189 W6/W8 — THIS REPORT)
- Boundary registry SSoT (`packages/contracts/src/boundary.ts`): all 7 signaldock-* entries already flipped to `intent: 'migrated-out'` with `canonicalHome: { external: '...' }` (parallel saga T10197 handled this in cleocode PR #503)
- AGENTS.md: 1 historical reference updated with cross-reference to saga T10180

## Net Delta

| Repo | Change |
|---|---|
| cleocode | −7 signaldock-* crates (~17k LOC), −1 `conduit-core` (renamed) |
| /mnt/projects/signaldock | +6 SDK crates (workspace restructure + receive from cleocode) |
| crates.io | +9 NEW PUBLISHED CRATES (3 cleocode, 6 signaldock) |
| github.com/kryptobaseddev/signaldock-core | ARCHIVED |
| github.com/kryptobaseddev/signaldock-runtime-standalone | confirmed deleted pre-saga |
| /mnt/projects/signaldock-runtime | UNCHANGED (no SDK coupling existed) |

## Decisions

- **D003** (layered data-architecture) — signaldock as separate canonical home
- **O-mphm02zb-0** — T10176+T10180 parallel-saga scoping observation
- **ADR-078** (parallel T10176) — boundary registry pattern

## Saga adaptations (not in original plan)

1. **T10185 SDK publish revealed transitive git-dep blocker**: 4 of 6 SDK crates depended on cant-core/lafs-core/conduit-core via signaldock-protocol's `pub use` re-exports. Required publishing those 3 cleocode crates FIRST.
2. **conduit-core name squatted on crates.io** (unrelated "Binary IPC core" crate v2.1.1). Renamed to `cleo-conduit-core` (T10185 worker PR #526).
3. **cant-core had bogus cleo-conduit-core Cargo dep** never used in source (60+ src files, 0 usages). Removed in PR #545 — true leaf crate.
4. **Hardcoded version pins approach rejected by owner** as maintenance liability. Adopted cargo-release with `shared-version` + `pre-release-replacements` regex (T10254).
5. **signaldock-storage `build.rs` referenced workspace-root `specs/sqlite-pragmas.json`** which `cargo publish` strips. Vendored crate-local copy + fallback (PR #11).
6. **signaldock-runtime has zero SDK coupling** — T10186 cutover was a no-op.

## Follow-ups (filed)

- **T10260**: dialectic-hook crashes on brain.db malformed schema (parked under T9163 epic). Bit gate-validation mid-saga — worked around via `pr:<num>` atoms.
- **Future**: signaldock-side trusted publisher (OIDC) setup for crates.io — owner action.
- **Future**: CI gate enforcing `specs/sqlite-pragmas.json` byte-identity between workspace-root and `crates/signaldock-storage/specs/` vendored copy.

## Saga lessons → memory

- **Rust 1.94 + edition 2024 MANDATORY** ([feedback_rust_194_edition_2024](../../../.claude/projects/-mnt-projects-cleocode/memory/feedback_rust_194_edition_2024.md))
- cargo-release with `shared-version=true` is the canonical pattern for monorepo internal-dep version sync
- cargo publish strips files outside crate dir — vendor specs into the crate or use include
- Trusted-publisher (OIDC) is the production publish pattern; manual tokens are bootstrap-only

## Wall-clock

- Saga opened: 2026-05-23T00:25:49 (T10180 created)
- Saga closed: 2026-05-23T~16:00
- Total: ~15.5 hours across 8 PRs (cleocode #501, #514, #526, #545, #550 — signaldock #7, #8, #9, #10, #11) + 9 cargo publish invocations + 2 GitHub API admin ops
