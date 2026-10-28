# Writing docs in this repo

CLEO Docs keeps one canonical home per doc. The store is the source of truth;
files under `docs/` are published mirrors of store docs. Agents that create a
new doc instead of updating the one that exists, or that put task ids and
dates in names, are the documentation rot this guide exists to prevent
(decision D11210).

## Before you write: find the existing doc

```bash
cleo docs query "<topic>"            # free-text search across the store
cleo docs query --similar <slug>     # near-duplicates of a doc you found
cleo docs fetch <slug>               # read it
```

If a doc on the topic exists, update it. Do not add a second one.

```bash
cleo docs update <slug> --file <path> --message "<what changed>"
```

`cleo docs list --limit 0` currently stops at 200 rows (T14115), so do not
use it to prove a doc is absent.

## Adding a new doc

```bash
cleo docs add <T####> <file> --type <kind> --slug <name>
cleo docs publish <name> --for <T####> --to docs/<folder>/<name>.md
```

The owner id links the doc to its task. Task and decision links, dates and
supersession live in the doc's metadata, never in its name.

When a new doc replaces an old one, record it:

```bash
cleo docs supersede <old-slug> <new-slug>
```

## Kinds and folders

`.cleo/canon.yml` is the routing registry and
`packages/contracts/src/docs-taxonomy.ts` lists the kinds. One kind per
folder:

| Kind | Folder | Holds |
|---|---|---|
| adr | `docs/adr` | architecture decisions, `adr-NNN-<topic>` |
| spec | `docs/spec` | normative specs and contracts |
| plan | `docs/plan` | plans that are still live |
| research | `docs/research` | investigations, audits, analyses |
| guide | `docs/guide` | how-to and runbooks |
| concept | `docs/concept` | explanations, architecture, design |
| reference | `docs/reference` | inventories, matrices, API and CLI reference |
| migration | `docs/migration` | migration guides |
| release-note | `docs/release` | release notes only, `v<version>` |
| note | `docs/note` | notes worth publishing |
| handoff | store only | never published |

`docs/generated` is generated output. Images live in `docs/assets`.

## Naming rule

Every tracked `docs/**.md` name, and every slug, is lowercase kebab-case
(`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 64 characters) with no task id, no
session id and no date. An ADR number and a release-note version are allowed,
because they are the doc's identity. The rule is implemented in
`packages/core/src/docs/doc-name-rule.ts` and described in the `ct-documentor`
skill.

`cleo check canon docs` enforces it in CI. Names on `main` that broke the rule
before it existed are listed in `scripts/.docs-name-baseline.json`. That list
only shrinks: a PR that renames or deletes one of those files removes its
entry, and the gate refuses new violators and stale entries.

## Writes the gates refuse

- A new `*.md` written straight into a mirror folder whose kind has
  `rawMdAllowed: false`. Use `cleo docs add` and `cleo docs publish`.
- A name that breaks the naming rule.

## Checking drift

```bash
cleo docs status    # each published mirror against the store
cleo docs doctor    # store health; dry run by default, --apply to repair
```
