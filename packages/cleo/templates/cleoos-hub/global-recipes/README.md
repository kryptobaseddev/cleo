# CleoOS Global Recipes Hub

This directory is the Single Source of Truth for cross-project automation
**recipes** — shell commands that any agent can invoke regardless of which
project it's working in.

## The three-way SSoT split (Phase 4 alignment)

CleoOS separates protocol, workflow, and deterministic automation into
three distinct representations, each with a dedicated SSoT:

| Purpose | SSoT | Location | Authors |
|---|---|---|---|
| **Agent protocols & constraints** | SKILL.md files | `packages/skills/skills/ct-*` | Humans (edit), Chef Agent (propose) |
| **Agent workflows & hooks** | .cant files | `.cleo/agents/*.cant` + `$CLEO_HOME/cant-workflows` | Humans + agents |
| **Deterministic automation** | justfile recipes | `$CLEO_HOME/global-recipes/justfile` + project-local | Humans + Chef Agent |

**Do not duplicate protocol text into justfile recipes.** Recipes should
wrap `cleo` CLI commands that resolve the protocol from skills at runtime.

## Writers

- **Humans** — edit `justfile` and sibling files directly with your editor.
- **Cleo Chef Agent** — the meta-agent cooks up new recipes via the
  `pm_upsert_global_recipe` tool binding (available from Phase 3 onward).

## Runners

Agents invoke recipes via the `pm_run_action` tool binding, which resolves to:

    just -f $CLEO_HOME/global-recipes/justfile <recipe> [args...]

Local project `justfile`s still take precedence for project-specific work.

## Naming

- Keep recipe names lowercase-kebab
- Prefix domain-specific recipes (`rcasd-init`, `schema-validate`)
- Document every recipe with a comment above the rule
- Reference skills by name (e.g. `ct-research-agent`) — don't embed prose

## Governance

Context anchoring strictness is enforced per project/global config
(`cleo config get contextAnchoring.mode`). Default: `block` — recipes that
reference files or paths not in the BRAIN-anchored inventory will be blocked.
