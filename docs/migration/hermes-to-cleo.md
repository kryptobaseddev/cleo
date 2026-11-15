# Migrating from Hermes Agent to CLEO

If you've been using [Hermes Agent](https://github.com/hermes-agent) to manage
skills, `cleo skills import-hermes` copies your Hermes skill registry into
CLEO: each skill's provenance, lifecycle state, pinned flag and usage counters.
This guide walks through it end to end.

> **TL;DR**: Install CLEO, run `cleo skills import-hermes --dry-run`, check the
> rows, then run `cleo skills import-hermes` once. Keep `~/.hermes/skills/` in
> place: CLEO records where each skill lives, it does not copy the files.

## What gets migrated

The importer (`packages/core/src/skills/hermes-importer.ts`) reads two files
under `<hermesHome>/skills/`:

- `.usage.json`: one JSON object keyed by skill name.
- `.bundled_manifest`: `<name>:<hash>` lines listing hub-bundled skills
  (optional).

| Hermes data (`.usage.json` entry)          | CLEO destination (global `cleo.db`)              |
|--------------------------------------------|--------------------------------------------------|
| skill name                                 | `skills_skills` row, upserted by `name`          |
| `<hermesHome>/skills/<name>/` directory    | `install_path` (the files stay where they are)   |
| `state` (`active` / `stale` / `archived`)  | `lifecycle_state` (same three values)            |
| `pinned`                                   | `pinned`                                         |
| `archived_at`                              | `archived_at`                                    |
| `use_count` / `view_count` / `patch_count` | one `skills_skill_usage` row per count (`load` / `view` / `patch` events) |

Provenance maps to CLEO's `source_type` like this:

| Hermes signal                          | CLEO `source_type` |
|----------------------------------------|--------------------|
| `created_by: "agent"` (auto-improver)  | `agent-created`    |
| listed in `.bundled_manifest`          | `canonical`        |
| anything else                          | `user`             |

The importer never assigns `community`, never quarantines a skill, and does
not read any federation or source URL (`source_url` is left empty). It does
not copy `SKILL.md` files, run the skills-guard scan, or touch
`~/.cleo/federation.json`.

## Prerequisites

- CLEO installed. The import writes to the global `cleo.db` under your CLEO
  home (`~/.local/share/cleo/` on Linux, `~/Library/Application Support/cleo/`
  on macOS); it needs no project.
- A Hermes home with `skills/.usage.json`. By default that is
  `$HERMES_HOME`, else `~/.hermes`; pass `--hermes-home <dir>` to use another
  one.

## Step 1: Dry-run the import

Always preview first:

```bash
cleo skills import-hermes --dry-run
# or, for a non-default Hermes home:
cleo skills import-hermes --hermes-home /path/to/.hermes --dry-run
```

A dry run walks the same code path but writes nothing. The envelope's `data`
looks like this:

```jsonc
{
  "success": true,
  "data": {
    "hermesHome": "/home/you/.hermes",
    "dryRun": true,
    "seen": 3,
    "imported": 3,
    "skipped": 0,
    "failed": 0,
    "rows": [
      { "name": "memory", "disposition": "imported", "sourceType": "agent-created", "synthesizedUsageRows": 42, "error": null },
      { "name": "code-review", "disposition": "imported", "sourceType": "canonical", "synthesizedUsageRows": 7, "error": null },
      { "name": "scrape-prices", "disposition": "imported", "sourceType": "user", "synthesizedUsageRows": 0, "error": null }
    ],
    "totalSynthesizedUsage": 49
  }
}
```

In a dry run, `imported` means "would be imported". A `failed` row carries
the reason in `error`. If `.usage.json` is missing, every count is 0 and
`rows` is empty.

## Step 2: Run the import

When the dry run looks right, drop `--dry-run`:

```bash
cleo skills import-hermes
```

Each skill row is upserted by name, so re-running does not duplicate skills.
**Run it once, though:** the usage rows are inserted again on every run, so a
second run doubles the imported usage counts.

## Step 3: Verify the migration

```bash
cleo skills stats --by-source --by-lifecycle --agent-created
```

This shows the usage rollup plus the source-type and lifecycle breakdowns and
the agent-created skills. Check that the source types, lifecycle states and
counts match what Hermes had.

## Trust and federation after the import

Imported skills keep the provenance above; the import does not apply the
skills-guard trust ladder of
[ADR-075](../adr/adr-075-skills-federation-trust-ladder.md). That ladder is
checked when a skill is installed (`shouldAllowInstall` in the CAAMP install
pipeline), not on import.

To make a source a federation peer, add it yourself:

```bash
cleo federation add https://<host>/ --trust verified
cleo federation list
```

Peers live in `~/.cleo/federation.json`; `cleo federation remove <url>`
removes one. See the [federation guide](../reference/federation.md) for the
federation model.

## Troubleshooting

### Nothing was imported (`seen: 0`)

CLEO found no `skills/.usage.json` under the resolved Hermes home. Check
`hermesHome` in the output, then pass the right directory with
`--hermes-home` or set `HERMES_HOME`.

### The command failed with a JSON error

`.usage.json` exists but is not a JSON object. Fix or restore the file and
re-run.

### A row shows `disposition: "failed"`

The row could not be written; its `error` says why. The other rows are
unaffected. Fix the cause and re-run (mind the usage-row note in Step 2).

## Where to next

- [Federation guide](../reference/federation.md): federation peers, the trust
  ladder, first-install prompts.
- [ADR-075](../adr/adr-075-skills-federation-trust-ladder.md): the skills
  federation trust ladder and the skills-guard rule set.
