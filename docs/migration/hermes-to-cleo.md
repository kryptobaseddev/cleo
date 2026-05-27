# Migrating from Hermes Agent to CLEO

If you've been using [Hermes Agent](https://github.com/hermes-agent) to manage
skills, you can migrate your entire skill library to CLEO without losing usage
history, lifecycle state, or auto-improvement provenance. This guide walks you
through the migration end-to-end.

> **TL;DR**: Install CLEO, run `cleo skill import-hermes --from ~/.hermes/skills`,
> review quarantined skills with `cleo skills find --quarantined`, approve or
> remove each one, and you're done.

## What gets migrated

| Hermes artefact                            | CLEO destination                          |
|--------------------------------------------|-------------------------------------------|
| `~/.hermes/skills/<name>/SKILL.md`         | `~/.cleo/skills/<name>/SKILL.md` (copy)   |
| `~/.hermes/skills/<name>/.usage.json`      | `skills.db` `skill_usage` rows            |
| Hermes `lifecycle_state`                   | CLEO `lifecycle_state` (preserved)        |
| Hermes `is_agent_created` flag             | CLEO `source_type='agent-created'`        |
| Hermes `pinned` flag                       | CLEO `pinned` boolean (preserved)         |
| Hermes federation source URL               | CLEO `source_url` + classifier (T9733)    |

Auto-improver skills (created via Hermes `skill_manage`) keep their
`agent-created` provenance — they don't get quarantined just because their
URL is unknown.

## Prerequisites

- CLEO installed and initialised: `cleo init` (run once in any project root).
- A Hermes skills root at the default `~/.hermes/skills/` location, OR a custom
  path you'll pass via `--from`.
- A clean working tree if you plan to use `--dry-run` to preview the import
  before mutating disk state.

## Step 1 — Dry-run the import

Always preview first:

```bash
cleo skill import-hermes --from ~/.hermes/skills --dry-run
```

You'll see a JSON envelope listing what would happen for each skill:

```jsonc
{
  "success": true,
  "result": {
    "summary": { "imported": 0, "quarantined": 0, "skipped": 0 },
    "preview": [
      {
        "name": "memory",
        "sourceType": "agent-created",
        "needsReview": false,
        "reason": "Hermes is_agent_created=true — agent-created provenance preserved"
      },
      {
        "name": "code-review",
        "sourceType": "canonical",
        "needsReview": false,
        "reason": "Trusted origin openai/skills — auto-promoted to canonical",
        "registeredFederationUrl": "https://github.com/"
      },
      {
        "name": "scrape-prices",
        "sourceType": "community",
        "needsReview": true,
        "reason": "Unknown origin random.example/skills — quarantined pending review"
      }
    ]
  }
}
```

A `community` + `needsReview=true` outcome means the skill will be imported into
`skills.db` but its `lifecycle_state` will require manual approval before it
becomes active. This is the **quarantine** state.

## Step 2 — Run the import

When the dry-run output looks right, drop `--dry-run`:

```bash
cleo skill import-hermes --from ~/.hermes/skills
```

Each Hermes skill is upserted into `~/.cleo/skills/` and registered in
`~/.cleo/cleo.db` (the `skills` table). Trust classification runs per-skill
using the `TRUSTED_REPOS` allow-list documented in
[ADR-075](../../.cleo/adrs/ADR-075-skills-federation-trust-ladder.md):

- `openai/skills`, `anthropics/skills`, `huggingface/skills` → `canonical`
- Hermes `is_agent_created=true` → `agent-created`
- Everything else → `community` (quarantined)

## Step 3 — Review quarantined skills

List the quarantined-but-imported skills:

```bash
cleo skills find --quarantined --human
```

For each one, decide:

- **Trust it** — approve it for activation:
  ```bash
  cleo skill approve <name>
  ```
- **Keep it quarantined** — leave it imported but inactive. Skills in
  quarantine are never auto-loaded by the CLEO runtime.
- **Remove it** — delete from disk and `skills.db`:
  ```bash
  cleo skills remove <name>
  ```

## Step 4 — Verify the migration

Compare counts:

```bash
# how many skills Hermes had
ls ~/.hermes/skills | wc -l
# how many CLEO knows about now
cleo skills list --human | grep -c '^['
```

Lifecycle preservation:

```bash
cleo skills list --json | jq '.result.skills[] | {name, lifecycleState, pinned}'
```

You should see your old `pinned` and lifecycle states intact.

## Federation index inheritance

When a Hermes skill from `openai/skills` (or any other trusted repo) gets
imported, CLEO automatically registers the GitHub host as a `verified`
federation peer in `~/.cleo/federation.json`. This means:

- Future installs from the same host don't trigger the first-install prompt.
- `cleo skills find --federated` will fan out to that host if you opt in.

You can inspect / edit the federation index manually:

```bash
cleo federation list --human
cat ~/.cleo/federation.json
```

See the [federation guide](../skills/federation.md) for the full federation
model.

## Troubleshooting

### "No Hermes skills found at <path>"

CLEO didn't see any `SKILL.md` files at the path you supplied. Check the path
and re-run with `--verbose` to see the search predicates.

### "Skill <name> failed validation"

Hermes and CLEO both require `SKILL.md` frontmatter — `name`, `description`,
and `version`. If a Hermes skill is missing these, the import skips it and
reports the failure in `summary.failed`. Add the missing frontmatter to the
SKILL.md and re-run.

### Quarantined skills won't activate

That's the design — community-tier skills MUST be operator-approved before
they leave quarantine. Run `cleo skill approve <name>` per skill, or
`cleo skill approve --all-community` to bulk-approve.

### Federation peer wasn't auto-registered

Auto-registration only happens for trusted-URL imports. If your Hermes skill's
`sourceUrl` is an `owner/repo` shorthand (no scheme), there's no URL to
register — CLEO can't synthesise one. If you want the peer to exist, add it
manually: `cleo federation add https://<host>/ --trust verified`.

### "Force-importing a skill that was blocked by skills-guard"

The T9730 trust gate runs DURING import. If a skill triggers a `dangerous`
finding, the import refuses to write it. To override:

```bash
cleo skill import-hermes --from ~/.hermes/skills --force
```

Every `--force` import appends a row to `.cleo/audit/skill-trust-bypass.jsonl`
for the security audit trail.

## Where to next

- [Federation guide](../skills/federation.md) — opt-in to federation peers,
  manage the trust ladder, configure first-install prompts.
- [ADR-075](../../.cleo/adrs/ADR-075-skills-federation-trust-ladder.md) —
  full rule-set documentation, the 120-pattern threat table, and the
  anti-patterns the scanner does NOT cover.
- [Skills-guard reference](../skills/federation.md#trust-matrix) — quick
  lookup for the `INSTALL_POLICY` matrix.
