# Docs AC3 Slug Renames

**Task:** T14108 AC3 · **Census:** `docs-census-cleanup` I.3 and I.4 · **Status:** reviewed plan, not yet applied

Fifteen store docs carry a task id or a `-spec` suffix in their slug. This plan
renames each to its stable slug with `cleo docs modernize --plan <file> --apply`
(store mode, T14578). The old slug stays resolvable as an alias, no content or
published mirror path changes, and kinds stay `spec`. Task ids dropped from a
slug are linked to the doc as task refs (`ownerTasks`).

## Goal

Give every store doc a stable slug with no task id, session id or date (T14108 AC3, D11210 naming rule), without changing any doc's content, kind or published path.

## Rows

| Current slug | New slug | Kind | Task refs linked | Census row |
|---|---|---|---|---|
| `caamp-integration-spec` | `caamp-integration` | spec | — | TRACKED (publishes a mirror) |
| `cleo-brain-package-spec` | `cleo-brain-package` | spec | — | TRACKED (publishes a mirror) |
| `cleo-conduit-protocol-spec` | `cleo-conduit-protocol` | spec | — | TRACKED (publishes a mirror) |
| `cleo-grade-spec` | `cleo-grade` | spec | — | TRACKED (publishes a mirror) |
| `cleo-studio-http-spec` | `cleo-studio-http` | spec | — | TRACKED (publishes a mirror) |
| `cleo-task-dashboard-spec` | `cleo-task-dashboard` | spec | — | TRACKED (publishes a mirror) |
| `core-api-agent-guide` | `core-sdk` | spec | — | TRACKED (publishes a mirror) |
| `t11627-dbwriterlease-spec` | `db-writer-lease` | spec | T11627 | KEEP |
| `t11762-output-schema-spec` | `output-schema` | spec | T11762 | KEEP |
| `t12341-uid-scheme` | `uid-scheme` | spec | T12341 | KEEP |
| `t12342-t12343-journal-design` | `sync-change-journal` | spec | T12342, T12343 | TRACKED (publishes a mirror) |
| `t12859-sync-write-validator-inventory` | `sync-write-validator-inventory` | spec | T12859 | KEEP |
| `t13420-ask-enforce-stop-hook-design` | `ask-enforce-stop-hook-design` | spec | T13420 | KEEP |
| `t13661-ponytail-parity-matrix` | `ponytail-parity-matrix` | spec | T13661 | KEEP |
| `t832-gate-integrity-spec` | `gate-integrity` | spec | T832 | TRACKED (publishes a mirror) |

## Checks before apply

- Dry run: `cleo docs modernize --plan docs-ac3-renames.plan.json` (no `--apply`) returned `success: true`, summary "15 stored docs to re-kind or re-slug; dry run, nothing written". The dry run parses the plan against the schema and runs the path guard and the store-row guard (`assertStorePlanRows`: no file rows, every new slug obeys the doc naming rule).
- Every current slug resolves to the attachment id and sha256 below, every doc is `draft`, and none of the 15 new slugs exists (`cleo docs fetch <new>` returns E_NOT_FOUND), checked on 2026-11-14 with 2026.11.10.
- At apply, `assertStoreRenamesFree` re-checks each row against the live store before the journal starts (old slug is the current slug, id matches, target free, no duplicate source or target), so a drifted row refuses the whole run.

## The plan

The `storeRows` below are the plan applied verbatim; their sha256 (of the
JSON as printed, two-space indent) is `5821becdf6d8810c50fd363595b8857367481272e7cb1bac7d36b286230f6cbe`. `root` is redacted here: the
apply sets it to the project root, which the plan guard requires.

```json
{
  "root": "<project root at apply time>",
  "generatedAt": "2026-11-14T20:05:25.099Z",
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
      "attachmentId": "aca7b02b-9097-442c-b681-2b41fa66dfc7",
      "sha256": "f8e61090546abd75aa438dea294426caeb4d08364f2bd72e5c7b31412edbb108",
      "slug": "caamp-integration-spec",
      "newSlug": "caamp-integration",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug caamp-integration; caamp-integration-spec stays as an alias",
        "TRACKED: this slug publishes a tracked mirror; only the slug changes, never the mirror path"
      ],
      "judgments": []
    },
    {
      "attachmentId": "1324a0ca-8ba0-4c7f-935a-65d931f0a280",
      "sha256": "ba1decb3a89dadb84c72287dc1a3b2031a42e37375f44efb0d1cd0bdfc97f4d6",
      "slug": "cleo-brain-package-spec",
      "newSlug": "cleo-brain-package",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug cleo-brain-package; cleo-brain-package-spec stays as an alias",
        "TRACKED: this slug publishes a tracked mirror; only the slug changes, never the mirror path"
      ],
      "judgments": []
    },
    {
      "attachmentId": "d192dfcd-4030-4555-9e3c-c3a50c06b102",
      "sha256": "3d8f273e82fb361981d16065961f79d0b6af500f35d5a9a350fcbcfda81fb1ca",
      "slug": "cleo-conduit-protocol-spec",
      "newSlug": "cleo-conduit-protocol",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug cleo-conduit-protocol; cleo-conduit-protocol-spec stays as an alias",
        "TRACKED: this slug publishes a tracked mirror; only the slug changes, never the mirror path"
      ],
      "judgments": []
    },
    {
      "attachmentId": "4bbfa1e9-188c-4292-bda8-89dd276e8ae6",
      "sha256": "5c81da42fce708ce2fc635d7e58753ddb6ff691fdf2a557bae5f680eee6da1cf",
      "slug": "cleo-grade-spec",
      "newSlug": "cleo-grade",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug cleo-grade; cleo-grade-spec stays as an alias",
        "TRACKED: this slug publishes a tracked mirror; only the slug changes, never the mirror path"
      ],
      "judgments": []
    },
    {
      "attachmentId": "4ffe3fca-0a58-488d-9595-88995c5a6421",
      "sha256": "3cdb579c614fae1b7897f5dc9afbfa6ef1db2b45a0ed449cf833c67747903006",
      "slug": "cleo-studio-http-spec",
      "newSlug": "cleo-studio-http",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug cleo-studio-http; cleo-studio-http-spec stays as an alias",
        "TRACKED: this slug publishes a tracked mirror; only the slug changes, never the mirror path"
      ],
      "judgments": []
    },
    {
      "attachmentId": "5a7c907a-e422-4348-a3c5-56e78e1efd06",
      "sha256": "96d3e06844b147189ffc8440d39aeb1960c769cfa4a424ea45e3fbc2866a6e14",
      "slug": "cleo-task-dashboard-spec",
      "newSlug": "cleo-task-dashboard",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug cleo-task-dashboard; cleo-task-dashboard-spec stays as an alias",
        "TRACKED: this slug publishes a tracked mirror; only the slug changes, never the mirror path"
      ],
      "judgments": []
    },
    {
      "attachmentId": "1f6684ca-a8f2-4938-8034-a71b0299ba1c",
      "sha256": "a6f9b127abc796bbc307a5b5ae9b207d02871ba970a26c341e6bedc23bff3290",
      "slug": "core-api-agent-guide",
      "newSlug": "core-sdk",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug core-sdk; core-api-agent-guide stays as an alias",
        "TRACKED: this slug publishes a tracked mirror; only the slug changes, never the mirror path"
      ],
      "judgments": []
    },
    {
      "attachmentId": "aa86a04d-5265-47d0-a9a4-03146fad73a0",
      "sha256": "19d86984f39ce0384154b3c42af0ea7cad331206508c1625442d62cd476b52ea",
      "slug": "t11627-dbwriterlease-spec",
      "newSlug": "db-writer-lease",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [
        "T11627"
      ],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug db-writer-lease; t11627-dbwriterlease-spec stays as an alias",
        "KEEP: restored to draft in #2919; task token dropped per the doc naming rule (D11210)"
      ],
      "judgments": []
    },
    {
      "attachmentId": "a62f9740-3150-4ef9-91b7-b29783067084",
      "sha256": "e41c74ac8f66be88a8135994b05d566a80b8b58e02a2c1a075128e57acd60e9d",
      "slug": "t11762-output-schema-spec",
      "newSlug": "output-schema",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [
        "T11762"
      ],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug output-schema; t11762-output-schema-spec stays as an alias",
        "KEEP: restored to draft in #2919; task token dropped per the doc naming rule (D11210)"
      ],
      "judgments": []
    },
    {
      "attachmentId": "9bae030e-294f-419d-8c7f-43b40c161c30",
      "sha256": "48ea1388bbfa2434d161e9177aa1913a4270aff7174e3ad5b872931c437dd18a",
      "slug": "t12341-uid-scheme",
      "newSlug": "uid-scheme",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [
        "T12341"
      ],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug uid-scheme; t12341-uid-scheme stays as an alias",
        "KEEP: restored to draft in #2919; task token dropped per the doc naming rule (D11210)"
      ],
      "judgments": []
    },
    {
      "attachmentId": "1d9f330b-5aea-4221-83a1-fd9c507e1714",
      "sha256": "cbd15efc95fb69b2c4ac1c758637b0ea158ad49ef21a91ff836a75c957946a9b",
      "slug": "t12342-t12343-journal-design",
      "newSlug": "sync-change-journal",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [
        "T12342",
        "T12343"
      ],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug sync-change-journal; t12342-t12343-journal-design stays as an alias",
        "TRACKED: this slug publishes a tracked mirror; only the slug changes, never the mirror path"
      ],
      "judgments": []
    },
    {
      "attachmentId": "2d9fd701-c997-4e2d-a205-3401ac3726d8",
      "sha256": "b93f1c7519e3b1d0c108fd116e012c7d1bf0b2090d693757c2be2637695fdf2d",
      "slug": "t12859-sync-write-validator-inventory",
      "newSlug": "sync-write-validator-inventory",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [
        "T12859"
      ],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug sync-write-validator-inventory; t12859-sync-write-validator-inventory stays as an alias",
        "KEEP: restored to draft in #2919; task token dropped per the doc naming rule (D11210)"
      ],
      "judgments": []
    },
    {
      "attachmentId": "bbc08b95-ca9b-4818-b7c0-ef53ef1d7949",
      "sha256": "0a18cf2f5385961e01f58c5ed212b78fd1a8251681e0b12e64eed6a31c9840af",
      "slug": "t13420-ask-enforce-stop-hook-design",
      "newSlug": "ask-enforce-stop-hook-design",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [
        "T13420"
      ],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug ask-enforce-stop-hook-design; t13420-ask-enforce-stop-hook-design stays as an alias",
        "KEEP: restored to draft in #2919; task token dropped per the doc naming rule (D11210)"
      ],
      "judgments": []
    },
    {
      "attachmentId": "8b46f573-26c3-4050-bcf9-c3ec312a5cf2",
      "sha256": "a0fdf696e6d7ea731828a04b00f0254655c886b314e0953d64d95297946b8e0e",
      "slug": "t13661-ponytail-parity-matrix",
      "newSlug": "ponytail-parity-matrix",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [
        "T13661"
      ],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug ponytail-parity-matrix; t13661-ponytail-parity-matrix stays as an alias",
        "KEEP: restored to draft in #2919; task token dropped per the doc naming rule (D11210)"
      ],
      "judgments": []
    },
    {
      "attachmentId": "c9e7c9d8-a5b1-404b-a3bb-b31ffd1670dd",
      "sha256": "639955d363a51ffbc8c216d334f3025b1825e7449b933601ffa4f3183a80c47d",
      "slug": "t832-gate-integrity-spec",
      "newSlug": "gate-integrity",
      "kind": "spec",
      "newKind": "spec",
      "ownerTasks": [
        "T832"
      ],
      "reasons": [
        "T14108 census I.3/I.4 AC3: slug gate-integrity; t832-gate-integrity-spec stays as an alias",
        "TRACKED: this slug publishes a tracked mirror; only the slug changes, never the mirror path"
      ],
      "judgments": []
    }
  ]
}
```

## After apply

Record the receipt run id in the census Phase 2 log; `cleo docs modernize --rollback <runId>` reverses the run.
