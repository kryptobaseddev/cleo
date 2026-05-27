# T10292 E4.1 — CLI Verb Matrix Audit (cleo docs / cleo changeset)

**Saga**: T10288 SG-DOCS-INTEGRITY (Wave 1) · **Epic**: T10292 E4-DOCS-SDK-BOUNDARY
**Task**: T10353 · **Author**: cleo-prime · **Date**: 2026-05-23

> **SSoT publish failure — evidence for E1/E4.** `cleo docs add` (the prescribed publish path)
> rejected this doc from inside the canonical worktree path with
> `E_WT_DB_ISOLATION_VIOLATION` (DB-isolation guard refuses to open `tasks.db` from inside a
> worktree gitlink, forcing resolution to the canonical project root) chained with
> `E_VALIDATION_FAILED: Path traversal detected` (file-path guard then sees the worktree path
> as outside the resolved project root). Three permutations tried: (a) `/tmp/...md` → traversal,
> (b) `T10353-cli-verb-matrix.md` (worktree-relative) → resolved to `/mnt/projects/cleocode/` and
> failed `E_FILE_ERROR: Cannot read file`, (c) `CLEO_PROJECT_ROOT=.` → `E_WT_DB_ISOLATION_VIOLATION`.
> Net: from inside any worktree provisioned by `cleo orchestrate spawn`, `cleo docs add` is
> currently unreachable. Doc written as a raw `.md` under
> `.cleo/research/t10292-e4-cli-verb-matrix.md` as the fallback. This itself confirms the
> E1/E4 boundary problem under investigation: worktree-protocol-compliant agents cannot use
> the canonical SSoT writer.

This document audits every subcommand exposed under `cleo docs` and `cleo changeset` and traces the
full call path: CLI handler (`packages/cleo/src/cli/commands/{docs,changeset}.ts`) → dispatch op
(`packages/cleo/src/dispatch/domains/docs.ts`) or direct core import → core wrapper
(`packages/core/src/docs/docs-ops.ts`, `packages/core/src/docs/publish-pr.ts`,
`packages/core/src/changesets/{writer,parser}.ts`) → underlying SDK primitive.

The goal: surface coupling, redundant code paths, and slug-namespace hazards that block the
broader SG-DOCS-INTEGRITY remediation (E1 slug allocator, E2 one-writer-per-DocKind,
E3 CLI hardening, E4 SDK boundary, E5 retroactive normalisation).

## Surface inventory (verb count)

Source: `packages/cleo/src/cli/commands/docs.ts` `subCommands` block + `packages/cleo/src/cli/commands/changeset.ts` `subCommands` block.

`docsCommand.subCommands` declares **19 verbs in-file** (the doc comment lists only 17 — out of
date) **plus 4 verbs spread via `...docsViewerSubcommands`**: `serve`, `open`, `stop`,
`viewer-status`. `changesetCommand.subCommands` declares **2 verbs**. The task scope (per the
parent prompt) is "17 docs + 2 changeset = 19 rows"; the actual count is **19 docs + 4 viewer
+ 2 changeset = 25 verbs**. Matrix below lists the 19 docs verbs in `docs.ts` plus the 2
changeset verbs (21 rows total) and footnotes the 4 viewer verbs.

## Matrix

| # | Verb | Dispatch Op | SDK Subpath | SDK Function | DocKind | Side (R/W) | Known Gap | Severity |
|---|---|---|---|---|---|---|---|---|
| 1 | `cleo docs add` | `mutate docs add` | `core/store/attachment-store` + `core/store/attachment-store-v2` + `llmtxt` (graph node mint) | `createAttachmentStore().put()` + `createAttachmentStoreV2().put()` mirror + `ensureLlmtxtNode` (fire-and-forget) | Any registered (default `adr|spec|research|handoff|note|llm-readme|changeset|release-note|plan|rcasd`) — accepted via runtime `DocKindRegistry` | **W (primary slug writer)** | T10238 unknown flags parsed as positional (P2); T10153 no auto-number for `adr` kind (P2); T10167 no similarity warn pre-add (none); T10294 slug-race vs `changeset add` (P2) | High |
| 2 | `cleo docs list` | `query docs list` | `core/store/attachment-store` | `createAttachmentStore().listByOwner()` / `listAllInProject()` + `resolveAttachmentBackend()` | All (filter via `--type`) | R | Default-scope auto-promote masks "no docs at all" vs "wrong owner" — surfaces a single hint string only (T9792 designed-but-conflated UX) | Low |
| 3 | `cleo docs fetch` | `query docs fetch` | `core/store/attachment-store` | `store.get()` + `store.getMetadata()` + `store.findBySlug()` + `store.getExtras()` + `resolveAttachmentBackend()` | All | R | Slug resolution path goes through 4 lookup branches (full sha256, att-id, slug, hex prefix) — `findBySlug` returns first hit only; collision case (T10294) is silently first-write-wins on the read side | Med |
| 4 | `cleo docs remove` | `mutate docs remove` | `core/store/attachment-store` + `core/store/attachment-store-v2` mirror | `store.deref()` + `v2.remove()` (best-effort) | All | W (ref-decrement; blob purged when refCount hits 0) | v2 mirror remove keys on att-id but llmtxt v2 indexes by blob-name → mirror is no-op for any blob that was not put inside the same process | Med |
| 5 | `cleo docs generate` | `query docs generate` | `core/docs/generate-docs-llmstxt` + `core/store/attachment-store` (when `--attach`) | `generateDocsLlmsTxt()` + optional `store.put()` writing a synthetic `llms-txt` attachment | `llm-readme` (when `--attach`) | R (default) / **W (when `--attach`)** | `--attach` writes back through `store.put` with kind `llms-txt` but does NOT pass `extras` (no slug, no type) — generated docs are unsearchable by slug. Bypasses the same slug-allocator surface E1 will tighten. | Med |
| 6 | `cleo docs export` | **none — direct core call** | `core/docs/export-document` | `exportDocument()` from `@cleocode/core/internal` (uses `llmtxt/export.formatMarkdown` under the hood) | n/a (reads task metadata, not a kind) | R | Bypasses dispatch entirely — no `meta.operation` in standard envelope shape, `cliOutput` invoked directly. T10238-class flag-parsing hazards latent here too. | Low |
| 7 | `cleo docs search` | **none — direct core call** | `core/docs/docs-ops` → `llmtxt/similarity` | `searchDocs()` (owner-scoped, by blob name) OR `searchAllProjectDocs()` (project-wide, by content) → `rankBySimilarity` | All | R | Two code paths in one verb: `--owner` switches between name-only and content-based ranking. `searchDocs` (name-only) is effectively legacy — `searchAllProjectDocs` superseded it for project-wide search (T9647) but the CLI keeps both reachable. Candidate for E4 deprecation. | Low |
| 8 | `cleo docs merge` | **none — direct core call** | `core/docs/docs-ops` → `llmtxt/sdk` | `mergeDocs()` → `squashPatches` / `diffVersions` / `reconstructVersion` | n/a (takes raw text/attA/attB, not a kind) | R (does not persist) | Output is `cliOutput`-only — `--out <file>` writes to arbitrary filesystem path (no `publishDir` integration). Stays outside the SSoT entirely. | Low |
| 9 | `cleo docs graph` | **none — direct core call** | `core/docs/docs-ops` → `llmtxt/graph` | `buildDocsGraph()` → `buildGraph()` over synthetic `MessageInput` from `blobList()` | All (via owner) | R | Synthesises `MessageInput` from blob metadata only (name + sha256 + mime) — graph never sees doc content. `--out <file>` again writes outside SSoT. | Low |
| 10 | `cleo docs rank` | **none — direct core call** | `core/docs/docs-ops` → `llmtxt/similarity` | `rankDocs()` → `rankBySimilarity` over blob NAMES | All (via owner) | R | Ranks by `blob.name`, not content. Duplicate semantics with `docs search --owner` (#7); both should consolidate to one ranking surface per E4. | Med |
| 11 | `cleo docs versions` | **none — direct core call** | `core/store/blob-ops` | `listDocVersions()` → `blobList()` | All (via owner) | R | No coupling to dispatch / registry — pure blob enumeration. | Low |
| 12 | `cleo docs publish` | **none — direct core call** | `core/docs/docs-ops` (publish + ledger) | `publishDocs()` (tmp-then-rename) + `recordPublication()` (best-effort ledger) | All | W (writes outside `.cleo/`; mirrors SSoT blob to git-tracked path) | Ledger write is best-effort and swallows errors silently — `docs status` (#15) reports drift it cannot detect when the ledger row was lost. | Med |
| 13 | `cleo docs publish-pr` | **none — direct core call** | `core/docs/publish-pr` + `git` + `gh` CLI | `publishDocsAsPr()` → provisions worktree, `git push`, `gh pr create`/edit | All built-in kinds via `BUILTIN_DOC_KIND_VALUES`; slug pattern enforced per kind | W (external — opens/updates GitHub PR) | Operates on slug independently of the SSoT slug-namespace — can branch+PR a slug that the SSoT has not yet allocated (no `E_SLUG_RESERVED`-equivalent gate). | High |
| 14 | `cleo docs sync` | **none — direct core call (two modes)** | `core/docs/docs-ops` → `syncFromGit` (mode A) OR local `detectDrift` (mode B legacy) | `syncFromGit()` reads git path, hashes bytes, writes new blob version; `detectDrift()` walks `scripts/` vs `docs/commands/COMMANDS-INDEX.json` | All (mode A) / n/a (mode B) | W (mode A) / R (mode B) | Two modes behind one verb. Mode B is legacy (T4551) and unrelated to docs SSoT — should split into separate verb per E3 CLI hardening. | Med |
| 15 | `cleo docs status` | **none — direct core call** | `core/docs/docs-ops` → ledger | `statusDocs()` → reads `docs-publications.json` ledger | All | R | Depends on ledger that is written best-effort (see #12). False "in-sync" possible when ledger row missing. | Med |
| 16 | `cleo docs gap-check` | **none — direct CLI logic** | local `runGapCheck()` over `.cleo/agent-outputs/` | n/a — pure regex scan | n/a (legacy) | R | T4551 legacy — unrelated to docs SSoT; lives in this command file only because of namespacing. Candidate for retirement in E3. | Low |
| 17 | `cleo docs import` | **none — direct core call** | `core/docs/import` (`runDocsImport` + `createAttachmentStoreDocsAccessor` + `makeClassifierForScanRoot`) | `runDocsImport()` walks dir, classifies by source-dir, hashes bytes, writes via `DocsAccessor`; integrates `slug.ts` collision chain (`-2, -3, …`) | All (auto-classified by source-dir) | **W (bulk slug writer)** | Has its OWN collision chain (`-2`, `-3`) in `core/docs/import/slug.ts` — separate from the runtime `E_SLUG_TAKEN` path in `store.put()`. Two independent allocators is exactly what E1 wants to collapse. | High |
| 18 | `cleo docs schema` | **none — direct CLI logic** | `@cleocode/contracts/DocKindRegistry` | `DocKindRegistry.load()` / `builtinOnly()` | All (enumerates) | R | Pure read. Best practice surface for agents to discover what `--type` accepts. | Low |
| 19 | `cleo docs list-types` | **none — direct CLI logic** | `@cleocode/contracts/DocKindRegistry` + `core/store/attachment-store` (when `--counts`) | Same registry as #18 + `store.listAllInProject()` | All (enumerates) | R | Functionally a subset of #18 — human-readable variant. Could be `--human` flag on `schema`. | Low |
| 20 | `cleo changeset add` | **none — bypasses dispatch entirely** | `core/changesets/writer` + `core/store/attachment-store` | `writeChangesetEntry()` → renders YAML markdown + tmp-then-rename file write + `store.put()` with `{slug, type: 'changeset'}` extras | `changeset` only | **W (dual-write: file AND SSoT)** | **T10294 root cause:** writes through `writeChangesetEntry` directly into `store.put()`, but `cleo docs add --type changeset --slug X` ALSO calls `store.put()` for the same kind. Two callers, one slug namespace, no central allocator. Slug pattern `/^t\d+-[a-z0-9-]+$/` validated independently in both paths. | Critical |
| 21 | `cleo changeset list` | **none — bypasses dispatch entirely** | `core/changesets/parser` | `parseChangesetDir()` reads `.changeset/*.md` | `changeset` (file mirror only) | R | Reads ONLY the filesystem mirror, NOT the SSoT — diverges from `cleo docs list --type changeset` which reads SSoT. The SSoT row and the file may disagree on edits made through one surface only. | High |

**Footnote — docs-viewer subcommands (4 additional verbs).** Spread into `docsCommand.subCommands` via `...docsViewerSubcommands`:
`serve`, `open`, `stop`, `viewer-status`. All four operate on a child `cleocode-viewer` Node process (HTTP UI on port 5174). None touch the docs SSoT or slug namespace; they exist for the local browser-based reader. Out of scope for E4 SDK boundary work.

**Footnote — DocKind "Any registered" semantics.** Several rows above show DocKind = "All" or
"Any registered". `cleo docs add --type` accepts every kind whose runtime metadata is loaded into
the `DocKindRegistry` (built-ins + `.cleo/docs-config.json` extensions). The 10 built-in kinds are
`adr`, `spec`, `research`, `handoff`, `note`, `llm-readme`, `changeset`, `release-note`, `plan`,
`rcasd` (source: `packages/contracts/src/docs-taxonomy.ts` `BUILTIN_DOC_KINDS`).

## Cross-references

### T10238 — `cleo docs add` silently parses unknown flags as positional args
- **Affects row(s):** #1 (`docs add`).
- **Path:** `packages/cleo/src/cli/commands/docs.ts:172-249` — `defineCommand` argument schema. citty
  accepts any extra `--flag value` as a positional candidate when not declared. The
  `'owner-id'` positional eats whatever appears before the first declared flag.
- **Also at risk:** every verb that uses `defineCommand` with a positional arg AND optional flags
  (i.e. rows #3, #4, #6, #7, #8, #9, #17, #20). Same parser, same hazard.

### T10153 — `cleo docs add --type adr` does NOT auto-number slugs
- **Affects row(s):** #1 (`docs add` with `--type adr`).
- **Path:** `packages/cleo/src/dispatch/domains/docs.ts:822-998` — `add` handler validates against
  `entityIdPattern: /^adr-\d{3,4}-[a-z0-9-]+$/` (`packages/contracts/src/docs-taxonomy.ts:127`) but
  the user must hand-pick the NNN portion. No `SELECT MAX(entity_id)` query before insert.
- **Absorbed into:** T10157 E12 → T10159 (atomic next-number resolution).

### T10167 — No similarity warn pre-add
- **Affects row(s):** #1 (`docs add`).
- **Path:** `docs.ts:172-249` runs straight to `dispatchFromCli` without scanning existing
  same-kind docs. `core/docs/docs-ops.ts` HAS `rankBySimilarity` available (used in #7 search,
  #10 rank). Reusing it pre-`store.put()` would close the gap.
- **Blocked-on:** T10163.

### T10294 — `cleo changeset add` slug collides with `cleo docs add --type changeset`
- **Affects row(s):** #1 (`docs add` for `changeset` kind), #20 (`changeset add`).
- **Root cause path:** TWO independent slug-allocator code paths converge on the same
  `attachment_refs` table:
  - `packages/cleo/src/dispatch/domains/docs.ts:822-998` (via `dispatchFromCli`) →
    `store.put(bytes, attachment, 'task', ownerId, attachedBy, projectRoot, {slug, type})`.
  - `packages/core/src/changesets/writer.ts:170-293` (direct, NOT via dispatch) → same
    `store.put(..., {slug: validated.id, type: 'changeset'})`.
- Both pass `extras.slug` and rely on the store's `SlugCollisionError` for uniqueness. Inside one
  process they serialise correctly. Cross-process or cross-worktree spawns are subject to the
  classic check-then-act race because there is no DB-level UNIQUE constraint on
  `(projectId, slug)` enforced at the SDK boundary — slug uniqueness is application-level only.
- E1 (T10289) E_SLUG_RESERVED design must place the allocator BEHIND one entry point so #1 and
  #20 share a single chokepoint.

## Findings summary

1. **8 of 19 docs verbs bypass the dispatch layer entirely.** Rows #6, #7, #8, #9, #10, #11, #12,
   #14, #15, #16, #17 call core functions directly via `@cleocode/core/internal`. Only `add`, `list`,
   `fetch`, `remove`, `generate` route through `dispatchFromCli` (i.e. only 5/19 are typed via
   `DocsTypedOps`). Dispatch is NOT the universal entry point the architecture suggests.

2. **Two independent slug-allocator surfaces converge on `store.put`.** `cleo changeset add` and
   `cleo docs add --type changeset` write through DIFFERENT call stacks but the SAME table. There
   is no central namespace allocator; uniqueness is enforced application-side via
   `SlugCollisionError` (`attachment-store.ts`). This is the T10294 root cause.

3. **Two independent slug-allocator surfaces in `cleo docs import`.** Row #17 has its OWN
   per-run collision chain in `core/docs/import/slug.ts` (`-2`, `-3`) that operates BEFORE
   `store.put()` is called. So we actually have THREE slug surfaces converging on one namespace:
   single-doc-add path, changeset path, and bulk-import path.

4. **`searchDocs` (owner-scoped) and `rankDocs` are functionally duplicates.** Both rank by blob
   name only; both call `rankBySimilarity`. T9647 introduced `searchAllProjectDocs` (content-based)
   but never retired the name-only path. Candidate for E4 consolidation: one ranking primitive,
   one CLI verb (`search`) with `--by-name | --by-content` flags.

5. **`docs sync` is two verbs in a trenchcoat.** Mode A (`--from <path>`) is reverse-ingest into
   the SSoT — current docs work. Mode B (no `--from`) is T4551 legacy drift detection over
   `scripts/` vs `docs/commands/COMMANDS-INDEX.json` — unrelated. Splitting via E3 yields cleaner
   help and prevents accidental mode invocation.

6. **`docs publish` ledger writes are best-effort.** Failure swallowed in `docs.ts:939-949` →
   `docs status` (#15) will report incorrectly "in-sync" for entries whose ledger row was lost.
   The two verbs form a feedback loop that can silently desync.

7. **`changeset list` reads file mirror only.** Row #21 calls `parseChangesetDir(dir)` — never
   queries the SSoT. If `cleo docs add --type changeset --slug X path.md` writes to the SSoT
   without writing the `.changeset/X.md` file, `changeset list` won't see it. The "SSoT-first"
   claim in the file header (line 5) is aspirational, not enforced.

8. **`generate --attach` produces unsearchable docs.** Row #5 puts an `llms-txt` attachment via
   `store.put()` but does NOT pass `extras` (no slug, no type). The generated doc can never be
   retrieved by `docs fetch <slug>` — only by sha256 or att-id.

9. **`publish-pr` operates on slugs the SSoT may not own.** Row #13 will happily branch + PR a
   doc using a slug that no SSoT row references. Combined with the multi-allocator finding
   above, this is the loose end E1 must close.

10. **Two registry-introspection verbs (`schema` + `list-types`) duplicate.** Both read the same
    `DocKindRegistry`. They differ only in human-vs-JSON rendering. Could be one verb with
    `--human` flag, matching the `changeset list` convention.

## Consolidation candidates (input to E4 SDK boundary work)

- **Single dispatch entry point** for all docs verbs that currently bypass it (~14 of 21 verbs).
  Goal: every slug-touching write goes through `dispatchFromCli` so a centralised slug allocator
  can be installed at one point.
- **Single ranking primitive**: consolidate `searchDocs` (owner-scoped name) + `rankDocs` +
  `searchAllProjectDocs` (project content) into one core function with `scope: 'owner' | 'project'`
  and `mode: 'name' | 'content'`.
- **Split `docs sync`** into `docs sync-from-git` (mode A) and retire mode B legacy drift.
- **One writer per DocKind** (E2): `cleo docs add --type changeset` either rejects with
  "use `cleo changeset add`" OR delegates internally — never two paths.
- **One reader per DocKind**: `changeset list` should read the SSoT (or read both and reconcile)
  to deliver on the "SSoT-first" doc comment.
