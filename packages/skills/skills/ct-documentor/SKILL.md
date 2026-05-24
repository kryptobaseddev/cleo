---
name: ct-documentor
description: Documentation coordinator with CLEO style guide compliance. Routes every canonical-doc write (spec, adr, research, handoff, note, llm-readme) through the docs SSoT via `cleo docs add` / `cleo docs publish` / `cleo docs fetch` — never raw filesystem writes. Coordinates ct-docs-lookup, ct-docs-write, ct-docs-review, ct-spec-writer, and ct-adr-recorder. Use when creating or updating documentation files, consolidating scattered documentation, or validating documentation against style standards. Triggers on documentation tasks, doc update requests, or style guide compliance checks.
version: 3.13.0
tier: 3
core: false
category: specialist
protocol: null
metadata:
  version: 3.13.0
  lastReviewed: 2026-05-24
  stability: stable
dependencies:
  - ct-docs-lookup
  - ct-docs-write
  - ct-docs-review
  - ct-spec-writer
  - ct-adr-recorder
sharedResources:
  - subagent-protocol-base
  - task-system-integration
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# Documentation Specialist Context Injection

**Protocol**: @src/protocols/implementation.md
**Type**: Context Injection (cleo-subagent)
**Version**: 3.0.0

---

## Purpose

Context injection for documentation tasks spawned via cleo-subagent. Orchestrates documentation workflows by coordinating specialized skills for lookup, writing, and review.

---

## Skill Coordination

| Skill | Purpose | Invoke When |
|-------|---------|-------------|
| `ct-docs-lookup` | Query existing docs, find references via `cleo docs fetch`/`list` | Discovery phase, checking what exists |
| `ct-docs-write` | Create/edit docs via `cleo docs add` with CLEO style | Writing or updating content |
| `ct-docs-review` | Check compliance with style guide, read through `cleo docs fetch` | Quality validation before completion |
| `ct-spec-writer` | Author specs (REQ-XXX requirements) via `cleo docs add --type spec` | Formal specification work |
| `ct-adr-recorder` | Author ADRs via `cleo docs add --type adr --slug adr-NNN-...` | Architecture decisions promoted from consensus |

The coordinator never writes content itself — it routes the work to the
specialist skill that owns the doc type, and every specialist routes its
filesystem write through the docs SSoT (see "Coordinator Pattern" below).

---

## Coordinator Pattern: SSoT-First Routing

ct-documentor is a router. It dispatches each doc-type to its owning skill,
and every owner writes through `cleo docs add` — not raw filesystem writes.

| Doc Type | Owner Skill | SSoT Command |
|----------|-------------|--------------|
| `spec` (REQ-XXX requirements) | `ct-spec-writer` | `cleo docs add <ownerId> <path> --type spec --slug spec-<feature>` |
| `adr` (architecture decisions) | `ct-adr-recorder` | `cleo docs add <ownerId> <path> --type adr --slug adr-<NNN>-<rest>` (TODO T10360 · E3.2 pending: `--title` + auto-`adr-NNN` allocation) |
| `research` (multi-source investigation) | `ct-research-agent` | `cleo docs add <ownerId> <path> --type research --slug research-<topic>` |
| `handoff` (session/agent transition) | `ct-documentor` (this skill) | `cleo docs add <ownerId> <path> --type handoff --slug handoff-<context>` |
| `note` (conversational prose) | `ct-docs-write` | `cleo docs add <ownerId> <path> --type note --slug <kebab-topic>` |
| `llm-readme` (agent-facing) | `ct-docs-write` | `cleo docs add <ownerId> <path> --type llm-readme --slug <kebab-topic>` |

Hard rule: EVERY canonical-type write goes through the SSoT. The coordinator
rejects any subagent return that wrote raw markdown into `.cleo/adrs/`,
`.cleo/research/`, `.cleo/agent-outputs/`, or `docs/` without first
materializing through `cleo docs add` + (optionally) `cleo docs publish`.

---

## Through SDK (preferred)

Documentation work flows through the docs SSoT in three steps —
add, publish, fetch. Use the slug-based contract so downstream consumers
can retrieve docs without grepping the filesystem.

### Add a doc attached to a task

```bash
cleo docs add T1234 docs/drafts/feature-x.md \
  --type note \
  --slug feature-x-overview \
  --desc "Conversational overview — pre-review"
```

- `--type` MUST be one of `spec | adr | research | handoff | note | llm-readme`.
  Pick the type by the document's purpose, not its filename.
- `--slug` is the human-friendly retrieval handle (kebab-case). If taken the
  CLI returns `E_SLUG_RESERVED` (legacy alias `E_SLUG_TAKEN`) with 3
  alternatives — pick one, do not overwrite.
- The owner ID (`T1234` above) auto-classifies the attachment by prefix:
  `T###` → task, `ses_*` → session, `O-*` → observation.

### Strict flag validation (T10359 · closes T10238)

`cleo docs add` rejects unknown flags with `E_UNKNOWN_FLAG` + Levenshtein
"did you mean" suggestions and exits with code `6` (`VALIDATION_ERROR`).
This closes the silent-absorption footgun where citty's underlying
`parseArgs({ strict: false })` accepted typo'd flags (e.g. `--titel`,
`--title`) as positional values.

```bash
# Typo → E_UNKNOWN_FLAG with suggestion
$ cleo docs add T123 file.md --titel "X"
{
  "success": false,
  "error": {
    "code": 6,
    "codeName": "E_UNKNOWN_FLAG",
    "message": "E_UNKNOWN_FLAG: unknown flag '--titel' for 'docs add'. Did you mean: --type, --slug?",
    "fix": "Try one of: --type, --slug. Run `cleo docs add --help` for the full flag list.",
    "alternatives": [{ "action": "--type", "command": "--type" }, { "action": "--slug", "command": "--slug" }],
    "details": { "flag": "--titel", "knownFlags": [...] }
  },
  "meta": { ... }
}
```

The accepted positional + named surface is enumerated in
`cleo docs add --help` — agents MUST consult `--help` rather than guessing
flag names. Use the `--flag=value` form (`--type=spec`) or
`--flag value` (`--type spec`) — both are recognised.

#### Slug allocation goes through ONE chokepoint (T10392 · Saga T10288)

Every code path that writes an attachment with a slug — `cleo docs add`,
`cleo changeset add`, and any future writer — MUST first call the central
allocator at `packages/core/src/docs/slug-allocator.ts:reserveSlug` BEFORE
invoking `attachmentStore.put({ slug })`. The allocator:

1. Normalises the slug to canonical kebab-case (lowercase, trim, single
   hyphens).
2. Acquires a per-slug in-process Mutex so concurrent reservations
   serialise.
3. Returns `{ ok: false, code: 'E_SLUG_RESERVED', suggestions }` when the
   slug is taken — uniform shape across both writers.

The `attachmentStore.put` chokepoint enforces this via a runtime assert
(`SlugNotReservedByAllocatorError`) when `CLEO_STRICT_SLUG_ALLOCATOR=1`
is set. Strict mode becomes default in the next release after both
writers are wired. **BOTH writers are LIVE on the allocator as of T10388**:
`cleo docs add` (T10386 — `packages/cleo/src/dispatch/domains/docs.ts:add`)
and `cleo changeset add` (T10388 — `packages/core/src/changesets/writer.ts:writeChangesetEntry`)
both call `reserveSlug(kind, slug)` BEFORE any filesystem or DB mutation.
Collisions surface the uniform envelope:

```json
{
  "success": false,
  "error": {
    "code": "E_SLUG_RESERVED",
    "message": "slug 'foo' is already in use in this project",
    "details": {
      "suggestions": ["foo-2", "foo-3", "foo-4"],
      "aliases": ["E_SLUG_TAKEN"]
    }
  }
}
```

`details.aliases` retains the legacy `E_SLUG_TAKEN` (docs-add path) /
`E_SSOT_WRITE_FAILED` (changeset-add path) codes for ONE release of
back-compat — downstream consumers grepping for the old codes can still match
via the alias array. Removed after E2 (T10290 — DocKind writer dedup) lands.

Slugs share a GLOBAL namespace across all DocKinds — `reserveSlug('changeset',
'foo')` followed by `reserveSlug('research', 'foo')` collides. The decision
is recorded in **ADR-076 §6 amendment AMD-001** (slug
`adr-076-canonical-docs-ssot`, T10390 / E1.5). Three-point evidence (human-memorable
global lookup, DocKind-distinct prefix conventions, backward-compat cost) and
the full counterfactual analysis live in that amendment. Matches the
`uniq_attachments_slug` partial UNIQUE INDEX in migration `20260519000001`.

When choosing a slug, follow the DocKind prefix conventions in the routing
matrix above (`adr-NNN-*`, `spec-*`, `research-*`, `t<id>-*` for changesets,
etc.) — this is what makes cross-kind collisions structurally near-impossible.

#### One writer per DocKind — WriterRegistry SSoT (T10366 · Saga T10288 / Epic T10290)

`packages/core/src/docs/writer-registry.ts:WriterRegistry` is the SSoT for
"which CLI verb writes which DocKind". Every `BuiltinDocKind` maps to EXACTLY
ONE writer descriptor — multi-writer regressions trip the registry at build
time (the slug-collision class root-cause from T10294).

**Decision tree — pick the verb without guessing:**

```text
if kind === 'changeset'          → cleo changeset add
elif kind === 'llm-readme'       → tooling-composed (system-managed)
elif kind === 'release-note'     → cleo release reconcile (system-managed)
else                              → cleo docs add --type <kind>
```

In code:

```ts
import { WriterRegistry } from '@cleocode/core/internal';

const desc = WriterRegistry.for('changeset');
// → { kind: 'changeset', verb: 'changeset add', dispatchOp: 'changeset.add',
//     coreFn: 'writeChangesetEntry', mode: 'ssot-first',
//     sourcePath: 'packages/core/src/changesets/writer.ts' }

// Resolve the verb programmatically — no string-matching in caller code.
const verb = WriterRegistry.for(kind).verb; // 'docs add' | 'changeset add' | 'system-managed'
```

Descriptor modes mirror `.cleo/canon.yml`'s `canonicalHome`:
- `'ssot'` — bytes live in the blob store; published copy is a mirror.
- `'ssot-first'` — dual-write via a dedicated verb (`changeset` today).
- `'system-managed'` — tooling-composed (e.g. `llm-readme`, `release-note`).

Test parity: every `ssot-first` descriptor MUST match a kind whose
`canonicalHome: 'ssot-first'` in `.cleo/canon.yml`, and vice versa.

**Legitimate bypass — `WriterRegistry.systemManaged` (T10368):** writers
for `system-managed` kinds (e.g. `generateDocsLlmsTxt`, `composeReleaseNotes`)
do not go through `cleo docs add` because the bytes are tooling-composed
rather than human-authored. The registry still names the producer via
`coreFn`, so drift tooling can follow the breadcrumb from kind →
core function without an exception list. Do NOT invent NEW `system-managed`
entries to dodge the docs-add path — every kind authored by a human MUST
flow through `cleo docs add` or `cleo changeset add`.

**Cross-link to the allocator contract:** the registry calls
{@link reserveSlug} BEFORE the writer delegates. A taken slug returns
`{ ok: false, code: 'E_SLUG_RESERVED', details: { suggestions } }`
with the SAME shape both `cleo docs add` and `cleo changeset add` surface
to callers (closing the T10294 envelope-drift bug). See the
"Slug allocation goes through ONE chokepoint" section above for the
allocator contract and the legacy `E_SLUG_TAKEN` alias.

T10366 establishes the registry contract; T10367 (docs add) and T10368
(changeset add) wire the actual writer delegation. Until those land,
`WriterRegistry.write()` returns `E_NOT_IMPLEMENTED` after consulting the
allocator — callers should continue invoking the existing writers
(`cleo docs add` dispatch handler, `writeChangesetEntry`) directly.

**T10367 LIVE — `cleo docs add --type changeset` delegates to
`writeChangesetEntry`.** The dispatch handler in
`packages/cleo/src/dispatch/domains/docs.ts` now branches on
`payload.type === 'changeset'` and routes the call through the
canonical dual-write transaction. This eliminates the second writer
for the `changeset` DocKind (the SG-DOCS-INTEGRITY invariant) — the
bytes that land on `.changeset/<slug>.md` AND the SSoT blob are
byte-identical regardless of which verb the operator invoked. The
`cleo changeset add` CLI remains the friendlier authoring surface
(it prompts for every required frontmatter field) while
`cleo docs add --type changeset --file <path>` works for agents that
already have a fully-formed changeset markdown blob in hand.

Contract for the docs-add path:
- The input file MUST carry valid changeset frontmatter
  (`id`, `tasks`, `kind`, `summary`). Missing → `E_REQUIRES_CHANGESET_VERB`
  with a fix hint pointing at `cleo changeset add` for guided authoring.
- When `--slug` is also passed it MUST match the frontmatter `id`
  (the frontmatter is canonical) — divergence → `E_SLUG_MISMATCH`.
- The LAFS envelope on success carries `data.type === 'changeset'`,
  `data.slug`, `data.attachmentId`, and `data.sha256` — round-trip
  identical to what `cleo changeset add` emits.

#### CI gate — DocKind Writer Uniqueness (T10369)

`scripts/lint-dockind-writer-uniqueness.mjs` (CI job:
`DocKind Writer Uniqueness (T10369)`) enforces the
WriterRegistry invariants at PR-time. It refuses to merge a PR that:

1. Adds a new entry to `BUILTIN_DOC_KINDS` (in
   `packages/contracts/src/docs-taxonomy.ts`) without a matching
   descriptor in `writer-registry.ts` (`dockind-coverage-missing`).
2. Declares more than one descriptor for the same DocKind
   (`dockind-coverage-collision` — the registry itself throws at module
   load too, this gate surfaces it earlier in CI).
3. Has a `mode: 'ssot-first'` descriptor that does NOT match
   `.cleo/canon.yml`'s `canonicalHome` for the same kind, or vice versa
   (`canon-yml-ssot-first-drift`).
4. Adds a NEW raw `writeFileSync(path.md, …)` / `writeFile(path.md, …)`
   call inside `packages/core/src/**` that is not in
   `.lint-dockind-writer-baseline.json` (`unregistered-md-write`).

Schema-parity rules (#1-#3) are ALWAYS strict — there is no baseline.
The unregistered-md-write rule runs in baseline mode by default; count
decreases always pass, count increases fail. The two legitimate
non-DocKind `.md` writers (`packages/core/src/sessions/handoff-markdown.ts`
for session snapshots and `packages/core/src/changesets/writer.ts` for
the canonical `changeset` DocKind) are allowlisted in the script.

Per-line opt-out (use sparingly): append
`// dockind-writer-allowed: <reason>` on the writeFile line.

#### Audit complement — manual-write sweep (T10372)

`scripts/sweep-manual-doc-writes.mjs` (CI job:
`Manual Write Sweep (T10372)`) is the read-only audit counterpart to
the writer-uniqueness lint. Where T10369 prevents *new* raw `.md`
writers from landing in `packages/core/src/**`, this sweep walks every
`*.md` file *already* added under `.cleo/canon.yml`'s `rawMdPaths`
directories since the T9791 docs-import cutoff (commit `251814e86`)
and classifies each one against the docs SSoT:

| Remediation | Meaning | Fix |
|---|---|---|
| `in-sync` | File SHA matches a blob already in the SSoT — bytes are tracked. | None. |
| `drift` | Slug exists in SSoT but the on-disk content has changed. | Re-publish via `cleo docs publish` or re-add as a new version. |
| `orphan` | Neither SHA nor slug resolves — the file is a raw fs write that bypassed `cleo docs add`. | Migrate via `cleo docs add <ownerId> <file> --type <kind> --slug <slug>`. |
| `deleted` | File was added since the cutoff but no longer exists on disk. | Informational only — does not count toward `unresolved`. |

Each run writes a timestamped report to
`audit/manual-write-sweep-<date>.json` and prints the summary block to
stdout. The CI job uploads the report as a workflow artefact on every
run and is wired with `continue-on-error: true` initially so the
existing orphan corpus does not break PRs. Saga T10288 / Epic T10293
E5.3 closes the orphan migration; the gate flips strict after that
lands.

```bash
# Local invocation — uses the globally-installed `cleo` on PATH.
node scripts/sweep-manual-doc-writes.mjs

# CI / monorepo build — point at the just-built local CLI bundle.
node scripts/sweep-manual-doc-writes.mjs \
  --cleo-bin "node packages/cleo/dist/cli/index.js" \
  --allow-unresolved
```

Exit codes: `0` (clean OR `--allow-unresolved`), `1` (at least one
`orphan` or `drift` entry), `2` (canon.yml parse failure, git not
available, SSoT query failed).

### T10179 + T10203 manual-write migration (T10371)

Saga T10176's two known raw-write workarounds are normalised:

| Original file | SSoT slug | Type | Notes |
|---|---|---|---|
| `docs/research/t10179-executor-probe-result.md` | `t10179-executor-probe` | research | in-sync via earlier T9791 import — verified by SHA. |
| `.changeset/t10179-executor-probe.md` (consumed v5.108) | `t10179-changeset-archive` | note | bytes preserved verbatim from git `cc48ca10e`; archived because the pnpm/changesets `"@cleocode/cleo": patch` frontmatter does not satisfy the `changeset` DocKind schema. |
| `.changeset/t10203-napi-step-exports.md` (consumed v5.108) | `t10203-napi-step-exports` | changeset | in-sync via the `cleo changeset add` dual-write at PR-time. |

Round-trip parity is regression-locked by
`packages/core/src/docs/__tests__/manual-write-migration.test.ts`. The
test embeds the canonical bytes inline and asserts that
`createAttachmentStore().put(...) → findBySlug(...)` returns the same
SHA-256 it started with. Any future migration that silently rewrites or
recompresses these blobs fails the test.

### Sweep-driven remediation loop (T10373)

T10371 only covers the *known* manual-write set declared in the original
Saga T10176 disposition. The T10372 sweep surfaces *every* orphan
remaining under `rawMdPaths` at the moment it runs. T10373 closes the
loop by consuming the sweep report and migrating each orphan into the
SSoT using the same `cleo docs add --slug` pattern T10371 established.

The recurring pattern (use this any time the sweep flags fresh
orphans):

1. Run the sweep: `node scripts/sweep-manual-doc-writes.mjs`. The
   report lands at `audit/manual-write-sweep-<date>.json`.
2. For each `orphan` entry, derive the migration tuple:
   - `--type` from the file's parent directory (`.cleo/adrs/` → `adr`,
     `.cleo/research/` → `research`, `.cleo/agent-outputs/` →
     `handoff` or `note` based on content, `.cleo/rcasd/` → `rcasd`).
   - `--slug` from the filename — lowercase, kebab-case, no
     extension (e.g. `ADR-085-cross-db-invariants.md` →
     `adr-085-cross-db-invariants`).
   - `<owner-id>` from the file's frontmatter `task:` field if
     present, otherwise from `cleo find "<filename-keyword>"`.
3. Run `cleo docs add <ownerId> <file> --type <kind> --slug <slug>
   --desc "<sweep-remediation context>"`. The `--desc` should
   reference the originating task ID so future operators can trace
   the migration.
4. Verify via `cleo docs fetch <slug>` and re-run the sweep — the
   `orphan` count MUST drop by the number of files migrated.
5. Add the new (slug, sha256, type, ownerId) row to a
   round-trip parity test alongside the T10371 set. The canonical
   example lives at
   `packages/core/src/docs/__tests__/sweep-remediation.test.ts`.

T10373 migrated five orphans this way: `ADR-083`, `ADR-085`,
`T10268-saga-closeout`, `t10292-e4-cli-verb-matrix`, and
`t10292-e4-sdk-import-edges`. The last two were direct fallout from
the pre-T10389 worktree-unreachable bug — T10353 and T10354 workers
fell back to raw filesystem writes because `cleo docs add` rejected
inside their spawned worktrees. Re-publishing the bytes via the SSoT
proves the round-trip and closes the loop the bug opened.

If a sweep run surfaces a file that should genuinely stay as raw
markdown (e.g. an audit log not meant for SSoT propagation), add an
entry to `audit/sweep-exemptions.yml` rather than migrating it. The
sweep script honours exemptions and does not flag them as orphans.

### Stuck-saga closure via `cleo saga reconcile` (T10374 · Saga T10288 / Epic T10293)

When a Saga's docs-related closeout was completed under the saga's
member Epics — every Epic flipped to `status='done'` — but the parent
Saga row itself is still `pending`, the recovery verb is
`cleo saga reconcile <sagaId>`. This is the cron-safe T10121 path
that the ADR-076 / T10113 auto-close path delivers; sagas that pre-date
the auto-close path (T9625 is the canonical example) need an explicit
nudge.

The recipe — use this any time a docs-canon Saga is observably stuck
even though its members have all shipped via `cleo docs add` /
`cleo docs publish`:

1. Verify member-Epic terminality:
   `for E in <memberIds>; do cleo show $E | jq '.data.task.status'; done`.
   Every member must be `done`, `cancelled`, or `archived` before
   reconcile will close the parent. If any member is genuinely stuck,
   close THAT one first (evidence-based per ADR-051) — do NOT cancel
   a member just to satisfy the gate.
2. Verify the SSoT fetch-gate the Saga's acceptance gates on (typically
   a research plan or closure note):
   `cleo docs fetch <slug>` — must return `success: true` with the
   expected bytes.
3. Reconcile: `cleo saga reconcile <sagaId>`. The verb is idempotent
   (re-runs return `action: 'no-op'`) and never modifies member rows.
4. Confirm: `cleo show <sagaId>` — `status` must be `done` and
   `completedAt` populated. The action is appended to
   `.cleo/audit/saga-reconcile.jsonl` for audit.
5. Write a closure-evidence handoff via
   `cleo docs add <taskId> <file> --type handoff --slug <saga>-closure-evidence`
   capturing: member statuses (table), reconcile envelope output,
   sibling-saga sanity check (no cross-saga side effects), and
   ADR-076 + T10113 path validation. The slug `t9625-closure-evidence`
   is the canonical reference.

Regression coverage for this path lives at
`packages/core/src/sagas/__tests__/t9625-closure.test.ts` and locks
three invariants: stuck-saga closure (AC1), sibling-saga isolation
(AC2), and idempotency (AC3). Add a new case there whenever you close
another stuck docs-canon Saga so the recovery pattern stays under
test.

### Docs->memory auto-emit (T9976 · regression-tested by T10375)

Every successful `cleo docs add` fires a fire-and-forget memory observation
into `brain_observations`. The CLI never blocks on this write — a BRAIN
failure cannot fail `docs add` — but the observation is the bridge that
makes `cleo memory find '<slug>'` surface attached docs.

**Title shape**: `"Doc attached: <slug>"` (or `"Doc attached: <attachmentId>"`
when no slug is provided). This is what the FTS index matches on, so the
slug is also a memory-discovery key — not just a docs-lookup key.

**Narrative payload** (the {@link DocAttachmentObservationPayload} contract):

```jsonc
{
  "kind": "doc-attachment",        // discriminator
  "attachmentId": "<id>",          // assigned by the docs store
  "ownerId": "<T#### | SG-#### | …>",
  "slug": "<kebab-slug>",          // omitted only when --slug not passed
  "type": "<docKind>",             // omitted only when --type not passed
  "addedAt": "<ISO 8601 timestamp>"
}
```

The payload is consumed by `cleo memory verify <observationId>` for
round-trip checks against the docs store — see AC3 of the original T9976
suite at `packages/cleo/src/dispatch/domains/__tests__/docs-memory-observation.test.ts`.

**Retroactive sweeps**: when migrating manual `Write`-based docs back into
the SSoT (the T10371 + T10373 pattern), the auto-emit fires uniformly for
the kebab-case slugs the sweep uses (`t<num>-<kebab>`, `adr-<num>-<kebab>`).
Regression coverage lives at
`packages/cleo/src/dispatch/domains/__tests__/docs-memory-observation-retroactive.test.ts`
(T10375). Add a new case to that table whenever you discover a slug shape
not yet under test.

**Anti-pattern**: do NOT write a `cleo memory observe` manually after a
`cleo docs add` — the auto-emit already happened, and the duplicate
observation pollutes the FTS index. Use `cleo memory backfill-docs` (AC4
of T9976) only to repair attachments that pre-date the auto-emit feature
or were written outside the SSoT.

#### System-managed exemptions (T10368)

Not every `.md` write inside `packages/core/src/**` is a DocKind authoring
path. Release composers, RCASD migration tooling, nexus wiki generators, and
the publish-mirror copier all emit Markdown bytes from inside `core/` but
SHOULD NOT route through `WriterRegistry.write` — they are deterministic
derived artifacts, not user-authored canonical documents.

These legitimate bypasses live in `SYSTEM_MANAGED_ENTRIES` inside
`writer-registry.ts`. Every entry cites an ADR pointer:

```ts
WriterRegistry.listSystemManaged();
// → [
//   { id: 'release.plan-json',          adrRef: 'ADR-028 ...' },
//   { id: 'release.changelog',          adrRef: 'ADR-028 §2.5 ...' },
//   { id: 'lifecycle.rcasd-migration',  adrRef: 'ADR-076 ...' },
//   { id: 'lifecycle.stage-artifact',   adrRef: 'ADR-076 ...' },
//   { id: 'sessions.handoff-markdown',  adrRef: 'ADR-076 ...' },
//   { id: 'nexus.wiki-overview',        adrRef: 'ADR-076 ...' },
//   { id: 'docs.publish-mirror',        adrRef: 'ADR-076 ...' },
// ]

// Path-based exemption lookup — used by the writer-audit test + T10369 lint:
const hit = WriterRegistry.isSystemManaged('.cleo/release/v2026.5.103.plan.json');
// → { id: 'release.plan-json', kind: null, adrRef: 'ADR-028 ...', ... }
```

When adding a NEW `.md` writer inside `packages/core/src/**`, you MUST
either:

1. Route through `WriterRegistry.write({kind, slug, payload})` (the
   canonical path for DocKind authoring), OR
2. Append a new entry to `SYSTEM_MANAGED_ENTRIES` with an ADR pointer
   ratifying the bypass.

The `writer-audit.test.ts` regression test fails when a new `.md` writer
appears without either path. T10369 (next in the epic) promotes this from a
unit test to a full CI lint gate.

### Slug similarity warn (T10361 · closes T10167)

`cleo docs add` runs a fuzzy-match check against existing slugs for the
SAME DocKind at write-time. If the proposed `--slug` is close to an
existing one (default threshold: normalised Levenshtein score ≥ `0.85`,
< `1.0`), the CLI surfaces "did you mean: `cleo docs update <slug>`?"
so an agent does not fork a near-duplicate when an update is the
intent. Exact (`1.0`) matches fall through to the slug-collision path
(`E_SLUG_TAKEN`) — they are NOT covered by this check.

```bash
# Near-duplicate slug — warn mode is the project default.
$ cleo docs add T123 file.md --slug cant-spec --type spec
INFO Similar to 'cantspec' (score 0.89) — did you mean: cleo docs update cantspec? Pass --allow-similar to bypass.
# (write proceeds because mode=warn)

# Same input under `mode: block` (configured in .cleo/canon.yml) — exits 6.
$ cleo docs add T123 file.md --slug cant-spec --type spec
{
  "success": false,
  "error": {
    "code": 6,
    "codeName": "E_SLUG_SIMILARITY",
    "message": "Similar to 'cantspec' (score 0.89) — did you mean: cleo docs update cantspec? Pass --allow-similar to bypass.",
    "fix": "Use `cleo docs update cantspec` if updating, or pass --allow-similar to add as a new doc.",
    "alternatives": [
      { "action": "update 'cantspec' instead", "command": "cleo docs update cantspec" },
      { "action": "bypass the similarity check", "command": "cleo docs add T123 file.md --slug cant-spec --type spec --allow-similar" }
    ]
  }
}

# Intentional add (true near-twin, not an update) — bypass + audit-log.
$ cleo docs add T123 file.md --slug cant-spec --type spec --allow-similar
# appends one JSONL line to .cleo/audit/similar-bypass.jsonl
```

Project-level overrides live in `.cleo/canon.yml`:

```yaml
similarity:
  warnThreshold: 0.85   # 0..1 — score above this triggers the hint
  mode: warn            # 'warn' (default) | 'block'
```

`mode: block` is recommended for CI agents — it surfaces the intent
mismatch as an exit code rather than a silently-printed warning that
non-TTY callers ignore. The `--allow-similar` flag is ALWAYS the
escape hatch and ALWAYS logged.

### Publish to a git-tracked path (when the doc must live on disk)

```bash
cleo docs publish --for T1234 --to docs/feature-x.md
```

Atomic tmp-then-rename. The published file ships in the next commit; the
SSoT blob remains canonical and continues to track future versions.

### Fetch the doc back by slug

```bash
cleo docs fetch feature-x-overview         # latest version
cleo docs versions --for T1234             # list every SHA version
```

Slug-based fetch is the contract used by reviewers, downstream skills, and
the docs graph — never grep the filesystem for the file you just wrote.

### List + sync

```bash
cleo docs list --type spec --project       # every spec in this project
cleo docs list --task T1234                # everything attached to a task
cleo docs sync --from docs/legacy.md --for T1234 --type note --slug legacy-doc
```

`cleo docs sync` back-fills an existing on-disk file into the SSoT.

---

## Deprecated: Direct filesystem

The legacy "write straight to `.cleo/adrs/`, `.cleo/research/`,
`.cleo/agent-outputs/`, or `docs/` and commit" pattern is deprecated.
The drift between the working file and the docs SSoT is real: published
files go stale, types are inferred ad-hoc from path, and slug-based
retrieval becomes impossible. Migrate every doc-type write to
`cleo docs add --type X --slug Y`.

---

## Worktree-Aware Routing (T10389 / ADR-068 amendment §3.1)

When running from an agent-spawned worktree (e.g. under
`~/.local/share/cleo/worktrees/<hash>/<task>/`), `cleo docs add` and
`cleo changeset add` automatically route the SSoT write back to the
canonical project root. The bytes land in the MAIN repo's SSoT — never
inside the worktree.

You can pass file paths relative to the worktree cwd as usual:

```bash
cd ~/.local/share/cleo/worktrees/<hash>/<task>/
cleo docs add T10389 docs/note.md --slug t10389-investigation --type note
# stderr: [T10389] routing SSoT write from worktree cwd <...> → canonical project root <...>
```

The verbs detect a stray `.cleo/tasks.db` inside the worktree
(pre-T9803 leak or rogue write) and emit `E_STRAY_WORKTREE_DB` BEFORE
invoking the DB chokepoint, so the user gets actionable remediation
(`rm -rf <worktree>/.cleo`) instead of the deeper
`E_WT_DB_ISOLATION_VIOLATION` exception.

Suppress the routing log line with `CLEO_QUIET=1` if you need clean
stderr in automation. The fix-pack closes T10353 + T10354 + T10294's
3-guard collision class (`E_PATH_TRAVERSAL` + `E_FILE_ERROR` +
`E_WT_DB_ISOLATION_VIOLATION`).

---

## Core Principle: MAINTAIN, DON'T DUPLICATE

```
BEFORE creating ANY new file, you MUST:
1. Search for existing documentation on the topic
2. Identify the canonical location for this information
3. UPDATE the existing file instead of creating a new one
4. Only create new files when NO suitable location exists
```

---

## Workflow Phases

### Phase 1: Discovery (MANDATORY)

Before writing anything, discover what exists. Prefer the SSoT over `Glob`/`Grep`
when scanning canonical docs — `cleo docs list` returns slug + owner + type
without forcing a filesystem walk.

```bash
# SSoT-first discovery (preferred)
cleo docs list --project                       # all docs for this project
cleo docs list --type {TYPE} --project         # docs filtered by canonical type
cleo docs fetch {SUSPECTED_SLUG}               # check if a slug exists

# Filesystem fallback (only for un-migrated content)
Glob: pattern="docs/**/*.md"
Grep: pattern="{TOPIC_KEYWORDS}" path="docs/"
Grep: pattern="{RELATED_TERMS}" path="docs/" output_mode="files_with_matches"
```

**Invoke `/ct-docs-lookup`** for deeper documentation research.

### Phase 2: Assess

| Question | Action |
|----------|--------|
| Does a doc file for this topic exist? | UPDATE that file |
| Is the info scattered across files? | CONSOLIDATE into canonical location |
| Is there a related doc that should include this? | ADD section to that file |
| Is this truly new with no home? | CREATE minimal new file |

### Phase 3: Write/Update

**Invoke `/ct-docs-write`** for content creation.

**For EXISTING files:**
1. Read the current content
2. Identify the correct section for new info
3. Add/update content IN PLACE
4. Preserve existing structure
5. Update any version numbers or dates

**For CONSOLIDATION:**
1. Identify all files with related content
2. Choose the canonical location
3. Move content to canonical file
4. Add deprecation notices to old locations
5. Update cross-references

**For NEW files (last resort):**
1. Confirm no existing location is suitable
2. Follow project's doc structure conventions
3. Add to appropriate docs/ subdirectory
4. Update any index or TOC files
5. Keep minimal - single topic focus

### Phase 4: Review

**Invoke `/ct-docs-review`** for quality validation.

Checklist:
- [ ] No formal language ("utilize", "offerings", "cannot")
- [ ] "People/companies" not "users"
- [ ] No excessive exclamation points
- [ ] Important information leads, not buried
- [ ] No verbose text without value
- [ ] Headings state the point
- [ ] Descriptive link text (never "here")
- [ ] No "easy" or "simple"
- [ ] Code examples actually work

---

## Anti-Duplication Checklist

Before completing, verify:

- [ ] Searched for existing docs on this topic via `cleo docs list` first
- [ ] Did NOT create a file that duplicates existing content
- [ ] Updated existing file if one existed
- [ ] Added deprecation notice if consolidating
- [ ] Cross-references are updated
- [ ] No orphaned documentation created
- [ ] Every canonical-type write went through `cleo docs add --type X --slug Y`
- [ ] Slug retrieval verified via `cleo docs fetch <slug>` before declaring done

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Task Workflow

```bash
# 1. Read task details
cleo show {TASK_ID}

# 2. Start task
cleo start {TASK_ID}

# 3. Execute documentation workflow (phases 1-4)

# 4. Complete task when done
cleo complete {TASK_ID}

# 5. Link research if applicable
cleo research link {TASK_ID} {RESEARCH_ID}
```

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST write documentation output to: `{{OUTPUT_DIR}}/`
2. MUST append ONE line to: `{{MANIFEST_PATH}}`
3. MUST return ONLY: "Documentation complete. Manifest appended to pipeline_manifest."
4. MUST NOT return documentation content in response

### Output File Format

Write to `{{OUTPUT_DIR}}/`:

```markdown
# Documentation Update: {TITLE}

**Date**: {DATE} | **Agent**: ct-documentor | **Status**: complete

---

## Summary

{What was updated and why}

## Changes Made

### File: {path/to/file.md}
- {Change 1}
- {Change 2}

## Files NOT Created (Avoided Duplication)

- {Considered creating X but updated Y instead}
- {Found existing coverage in Z}

## Verification

- [ ] Changes don't duplicate existing content
- [ ] Cross-references updated
- [ ] Examples tested
- [ ] Style guide compliance verified via ct-docs-review
```

### Manifest Entry

Append ONE line to `{{MANIFEST_PATH}}`:

```json
{"id":"docs-{TOPIC}-{DATE}","file":"{DATE}_docs-{TOPIC}.md","title":"Documentation Update: {TITLE}","date":"{DATE}","status":"complete","agent_type":"documentation","topics":["documentation","{topic}"],"key_findings":["Updated {file} with {change}","Consolidated {topic} docs into {canonical-location}","Avoided duplication by updating existing {file}"],"actionable":false,"needs_followup":[],"linked_tasks":["{TASK_ID}"]}
```

---

## Completion Requirements

- [ ] Discovery phase completed (searched existing docs via `cleo docs list`)
- [ ] Core principle followed (maintain, don't duplicate)
- [ ] Coordinator pattern followed: every doc-type routed to its owning skill
- [ ] Every canonical-type write went through `cleo docs add --type X --slug Y`
- [ ] `/ct-docs-write` invoked for `note`/`llm-readme` content
- [ ] `/ct-spec-writer` invoked when writing specs (REQ-XXX requirements)
- [ ] `/ct-adr-recorder` invoked when promoting consensus → ADR
- [ ] `/ct-docs-review` invoked for quality validation
- [ ] Anti-duplication checklist verified
- [ ] Output file written with "Files NOT Created" section
- [ ] Manifest entry appended
- [ ] Task completed via `cleo complete`

---

## See references/

Progressive disclosure — load on demand only:

- `references/chain-orchestration.md` — when to invoke lookup/write/review, input shapes, review loop budget
- `references/doc-types-and-templates.md` — Diátaxis grid plus CLEO-native (ADR, agent-output, skill) templates
- `references/style-coordination.md` — tone pillars, forbidden phrases, link/code/table discipline
- `references/anti-patterns.md` — twelve documentation coordination failure modes
