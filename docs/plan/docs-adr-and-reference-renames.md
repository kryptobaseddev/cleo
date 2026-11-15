# Docs ADR and reference renames plan

Store and tree plans for the census D follow-ups (T14108 AC3, AC4): the
`taxonomy` re-kind, the ADR index rename, and the 11 case-only ADR file
renames. Built from `origin/main` 9458c2efb with `cleo docs modernize`
(2026.11.11). Nothing is applied until this plan is reviewed.

## Goal

Every tracked docs file name and every doc kind follows the naming rule
(D11210) and the one-kind-per-folder routing in `.cleo/canon.yml`, with each
renamed entry removed from `scripts/.docs-name-baseline.json`.

## Plans

| Plan | Rows | Dry run | Status |
|---|---|---|---|
| Store plan | `taxonomy`: kind `note` → `reference`, slug unchanged | `1 stored docs to re-kind or re-slug; dry run, nothing written` | apply after review |
| Tree plan | `adr/README.md` → `adr/adr-index.md`, named after the doc's store slug `adr-index` | `1 files: 0 keep, 1 rename, 0 merge, 0 delete, 0 link-fix; dry run, nothing written` | apply after review |
| ADR case plan | the 11 case-only renames below, plus 16 link fixes | `11 files: 0 keep, 11 rename, 0 merge, 0 delete, 16 link-fix; dry run, nothing written` | **blocked by T14610** |

Each hash is the sha256 of the rows array as printed with two-space indent:

- store plan `storeRows`: `6c0af667fdcfd0619b6961a746b09c5615615353caf13944375d126be4a17ae6`
- tree plan `rows`: `86cab151d3ec77d8ce389c1435e3ad7f543045ec8153bcb5685d588e1c90ba44`
- ADR case plan `rows`: `9443272ae16a96db8fc2cc0e416b5865c50c2dfa96cc85b8069f7e99e8795fed`
- ADR case plan `linkFixes`: `72ab929a1c6ca2f51cada0bda728ee14aea5d6dbd6e54db109ed57889f8a9dee`

## Why the ADR case plan is blocked

A tree apply first writes each renamed file at its target. It then deletes
every plan path that is not also a target
(`packages/core/src/docs/modernize/apply.ts`). That comparison is
case-sensitive. This checkout is on macOS APFS (`core.ignorecase=true`), where
`adr/ADR-068-….md` and `adr/adr-068-….md` name the same file, so the second
step would delete the file the first step just wrote. A tree apply also leaves
each publication ledger row on the old path. T14610 tracks both. The case plan
is applied once T14610 ships, or from a case-sensitive checkout.

| Current file | New file |
|---|---|
| `ADR-068-per-worktree-handoff.md` | `adr-068-per-worktree-handoff.md` |
| `ADR-072-nexus-db-split.md` | `adr-072-nexus-db-split.md` |
| `ADR-076-canonical-docs-ssot.md` | `adr-076-canonical-docs-ssot.md` |
| `ADR-077-worktreeinclude-canonical-location.md` | `adr-077-worktreeinclude-canonical-location.md` |
| `ADR-078-boundary-registry.md` | `adr-078-boundary-registry.md` |
| `ADR-086-nested-nexus-disposition.md` | `adr-086-nested-nexus-disposition.md` |
| `ADR-087-worktree-ffi-topology.md` | `adr-087-worktree-ffi-topology.md` |
| `ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md` | `adr-088-pm-core-v2-workgraph-relations-completion-criteria.md` |
| `ADR-088-release-pipeline-coherence.md` | `adr-088-release-pipeline-coherence.md` |
| `ADR-089-cleo-daemon-native-dispatch.md` | `adr-089-cleo-daemon-native-dispatch.md` |
| `ADR-097-goal-protocol-ocg-runtime.md` | `adr-097-goal-protocol-ocg-runtime.md` |

The case plan's 16 link fixes repoint `ADR-0xx` links to the lowercase names:

- 5 found by the plan: `adr/adr-073-above-epic-naming.md`,
  `concept/cleo-architecture-guide.md` (two links), `spec/cleo-nexus-architecture.md`
  and `spec/cleo-tasks-api.md`.
- 11 added by hand for the ADR index, covering all 13 uppercase ADR links in it
  (two targets appear twice). They are keyed to `adr/adr-index.md`, the index's
  path once the tree plan above lands. The plan's scan missed them because the
  index was a `README.md`. Re-run the case plan's dry run after the tree plan
  merges, before applying it under T14610.

All 11 files have entries in `scripts/.docs-name-baseline.json`, and those
entries leave the baseline with the case plan.

Two ADR files share the number 088 (`pm-core-v2-workgraph-relations-completion-criteria`
and `release-pipeline-coherence`). Lowercasing does not change that, and this
plan does not renumber.

## Steps

Apply steps for the store and tree plans, after review:

1. Check both hashes above against the plan files. Check that `root` is the
   project root (store plan) or `<project>/docs` (tree plan).
2. `cleo docs modernize --plan <store plan> --apply`, then confirm that
   `cleo docs fetch taxonomy --field /data/metadata/type` reports `reference`.
3. `cleo docs modernize --plan <tree plan> --apply`. The file's bytes already
   belong to the `adr-index` doc, so the store row stays and only the file
   moves (T14231).
4. Because the tree apply does not move the ledger row (T14610), publish the
   doc at its new path: `cleo docs publish adr-index --for T14108 --to docs/adr/adr-index.md`.
5. Link `docs/adr/adr-index.md` from the canon index. The orphan check exempts
   the name `README.md` but not `adr-index.md`.
6. Gate on `cleo check canon`, the `cleo docs rot` summary and
   `cleo check canon docs`, commit and push, and post the apply receipt as a
   PR comment.
7. After the PR merges, fetch so `main` has the rename, then run
   `cleo docs doctor --only publication-ledger-drift` (dry run, then `--apply`)
   to prune the old `docs/adr/README.md` row. It cannot run earlier: the doctor
   refuses to prune while HEAD and `main` still track `docs/adr/README.md`
   (`packages/core/src/docs/doctor.ts:751`). Post that receipt as a follow-up
   PR comment.

`adr/README.md` has no baseline entry, so these two plans need no baseline
edit. The only other reference the plan found is a test fixture
(`packages/core/src/adrs/__tests__/adr-home.test.ts`) that writes its own
`docs/adr/README.md`, so the rename does not affect it.

## Owners

- Plan and apply: agent-t14108 (T14108 worker).
- Review and merge: the T14106 coordinator.
- ADR case plan unblock: the owner of T14610.

## Left out

`docs/migration/hermes-to-cleo.md`: the full plan proposed `hermes-to-cleo-2.md`,
but the file name already follows the rule. The real problems are different:

- The mirror has no ledger row.
- The store's `hermes-to-cleo` holds an older copy plus a store-only merged
  section; the plan's similarity check called them different docs.
- The guide names commands that do not exist: `cleo skill import-hermes` is
  `cleo skills import-hermes`; `skill approve`, `skills find --quarantined` and
  `skills remove` do not exist.

That is content work, proposed for the README PR.

## ADR case plan: link fixes added for the index

```json
[
  {
    "kind": "link-fix",
    "path": "adr/adr-index.md",
    "href": "ADR-068-per-worktree-handoff.md",
    "newHref": "adr-068-per-worktree-handoff.md"
  },
  {
    "kind": "link-fix",
    "path": "adr/adr-index.md",
    "href": "ADR-072-nexus-db-split.md",
    "newHref": "adr-072-nexus-db-split.md"
  },
  {
    "kind": "link-fix",
    "path": "adr/adr-index.md",
    "href": "ADR-076-canonical-docs-ssot.md",
    "newHref": "adr-076-canonical-docs-ssot.md"
  },
  {
    "kind": "link-fix",
    "path": "adr/adr-index.md",
    "href": "ADR-077-worktreeinclude-canonical-location.md",
    "newHref": "adr-077-worktreeinclude-canonical-location.md"
  },
  {
    "kind": "link-fix",
    "path": "adr/adr-index.md",
    "href": "ADR-078-boundary-registry.md",
    "newHref": "adr-078-boundary-registry.md"
  },
  {
    "kind": "link-fix",
    "path": "adr/adr-index.md",
    "href": "ADR-086-nested-nexus-disposition.md",
    "newHref": "adr-086-nested-nexus-disposition.md"
  },
  {
    "kind": "link-fix",
    "path": "adr/adr-index.md",
    "href": "ADR-087-worktree-ffi-topology.md",
    "newHref": "adr-087-worktree-ffi-topology.md"
  },
  {
    "kind": "link-fix",
    "path": "adr/adr-index.md",
    "href": "ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md",
    "newHref": "adr-088-pm-core-v2-workgraph-relations-completion-criteria.md"
  },
  {
    "kind": "link-fix",
    "path": "adr/adr-index.md",
    "href": "ADR-088-release-pipeline-coherence.md",
    "newHref": "adr-088-release-pipeline-coherence.md"
  },
  {
    "kind": "link-fix",
    "path": "adr/adr-index.md",
    "href": "ADR-089-cleo-daemon-native-dispatch.md",
    "newHref": "adr-089-cleo-daemon-native-dispatch.md"
  },
  {
    "kind": "link-fix",
    "path": "adr/adr-index.md",
    "href": "ADR-097-goal-protocol-ocg-runtime.md",
    "newHref": "adr-097-goal-protocol-ocg-runtime.md"
  }
]
```

## Store plan JSON (root redacted)

```json
{
  "root": "<project root at apply time>",
  "generatedAt": "2026-11-15T18:58:13.701Z",
  "rows": [],
  "counts": {
    "keep": 0,
    "rename": 0,
    "merge-into": 0,
    "delete": 0
  },
  "mode": "store",
  "storeRows": [
    {
      "attachmentId": "bc151b0b-908b-4fd1-9d11-bcb42a5c594f",
      "sha256": "42b9038b2be023af37c06b5132d3a6dc6d536d364039bd2dbfdbd75a21893fc5",
      "slug": "taxonomy",
      "newSlug": "taxonomy",
      "kind": "note",
      "newKind": "reference",
      "ownerTasks": [],
      "reasons": [
        "T14108 census D: taxonomy is published to docs/reference/ (one kind per folder, .cleo/canon.yml); re-kind note -> reference, slug unchanged"
      ],
      "judgments": []
    }
  ]
}
```

## Tree plan JSON (root redacted)

```json
{
  "root": "<project root at apply time>/docs",
  "generatedAt": "2026-11-15T18:58:46.618Z",
  "rows": [
    {
      "path": "adr/README.md",
      "sha256": "c15a6a4b71c1dfc00fc7c498ce29d72193a0d3851fa4b6e7ebf8b5ae0f4cc0f1",
      "kind": "reference",
      "slug": "adr-index",
      "title": "Architecture Decision Records",
      "disposition": "rename",
      "target": "adr/adr-index.md",
      "reasons": [
        "kind reference: kind given by the caller",
        "slug architecture-decision-records: task, session and date tokens dropped from the name",
        "moves to reference/architecture-decision-records.md",
        "already stored in CleoDocs as adr-index; the file moves, the stored doc is left as is",
        "override: T14108 census D: name the ADR index after its store slug adr-index (README.md is a generic name)"
      ],
      "judgments": [],
      "ownerTasks": [],
      "category": "reference",
      "refs": [
        "packages/core/src/adrs/__tests__/adr-home.test.ts"
      ],
      "overridden": true,
      "covers": [],
      "baselineRemove": true
    }
  ],
  "counts": {
    "keep": 0,
    "rename": 1,
    "merge-into": 0,
    "delete": 0
  },
  "mode": "tree",
  "linkFixes": []
}
```

The two plan rows above that say `slug architecture-decision-records` and
`moves to reference/architecture-decision-records.md` are the tool's rule
reasons from before the override. The override sets the slug to `adr-index`
and the target to `adr/adr-index.md`, which is what the dry run reports.
