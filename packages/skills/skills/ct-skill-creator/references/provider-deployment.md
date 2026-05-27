# Provider Deployment

This reference covers multi-provider skill deployment: where each provider reads skills from, how symlinks enable a single source of truth, and how to add new skills to the @cleocode/skills package.

## Architecture

Skills follow a single-source-of-truth model:

```
packages/skills/skills/         <-- canonical location
  ct-cleo/SKILL.md
  ct-orchestrator/SKILL.md
  ct-skill-creator/SKILL.md
  ...
  manifest.json                    <-- CLEO-only metadata
```

Providers read skills from their own vendor-specific directories. Symlinks point from each provider's skill directory back to the canonical location, so a single SKILL.md serves all providers.

**SKILL.md** is the open standard -- every provider reads it. It contains only the 11 standard v2 fields (name, description, etc.) that all providers understand.

**manifest.json** is CLEO-only metadata -- tier, tags, capabilities, dispatch routing. Non-CLEO providers ignore it entirely. This is why CLEO-specific fields must never appear in SKILL.md: providers that do not understand them may reject the skill or behave unpredictably.

## Provider Path Table

| Provider | Global Skills Path | Project Skills Path | Symlinks |
|---|---|---|---|
| claude-code | `$HOME/.claude/skills` | `.claude/skills` | Yes |
| codex-cli | `$HOME/.agents/skills` | `.agents/skills` | Yes |
| gemini-cli | `$HOME/.gemini/skills` | `.gemini/skills` | Yes |
| cursor | `$HOME/.cursor/skills` | `.cursor/skills` | Yes |
| github-copilot | `$HOME/.copilot/skills` | `.github/skills` | Yes |
| windsurf | `$HOME/.codeium/windsurf/skills` | `.windsurf/skills` | No |
| opencode | `$HOME/.config/opencode/skills` | `.opencode/skills` | Yes |
| kimi-coding | `$HOME/.kimi/skills` | `.kimi/skills` | No |
| antigravity | `$HOME/.antigravity/skills` | `.agent/skills` | Yes |

**Global skills** are available across all projects for that provider. **Project skills** are scoped to the repository they live in.

**Symlink support** indicates whether the provider follows symbolic links when reading skill directories. Providers without symlink support (windsurf, kimi-coding) require the skill directory to be copied rather than symlinked.

## What Providers Read

### Standard Providers (non-CLEO)

Standard providers read SKILL.md only. They parse the YAML frontmatter for standard v2 fields and load the markdown body when the skill triggers. They have no awareness of manifest.json, dispatch-config.json, or any CLEO infrastructure.

Fields they understand: `name`, `description`, `argument-hint`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `model`, `context`, `agent`, `hooks`, `license`.

Fields they do not understand: `version`, `tier`, `core`, `category`, `protocol`, `dependencies`, `sharedResources`, `compatibility`, `tags`, `triggers`, `token_budget`, `capabilities`, `constraints`, `metadata`.

### CLEO-Aware Providers

CLEO-aware providers read both SKILL.md and manifest.json. The manifest provides dispatch routing, tier-based loading priorities, token budgets, and capability declarations that enable advanced features like skill chaining and orchestration.

## Deployment Strategies

### CLEO Package Skills

Skills in `packages/skills/skills/` are managed by CLEO infrastructure. They are deployed via the CLEO skill system and do not need manual symlink setup. The manifest.json, dispatch-config.json, and provider-skills-map.json coordinate deployment automatically.

### User Global Skills

For standalone skills installed directly into a provider's global skill directory:

```bash
# Claude Code
cp -r my-skill/ ~/.claude/skills/my-skill/

# Gemini CLI
cp -r my-skill/ ~/.gemini/skills/my-skill/

# Codex CLI
cp -r my-skill/ ~/.agents/skills/my-skill/
```

### Multi-Provider via Symlinks

For skills that should be available across multiple providers, create the skill in one location and symlink to each provider's directory:

```bash
# Canonical location
mkdir -p ~/shared-skills/my-skill
# ... create SKILL.md and resources in ~/shared-skills/my-skill/

# Symlink to each provider
ln -s ~/shared-skills/my-skill ~/.claude/skills/my-skill
ln -s ~/shared-skills/my-skill ~/.gemini/skills/my-skill
ln -s ~/shared-skills/my-skill ~/.agents/skills/my-skill
```

For providers that do not support symlinks (windsurf, kimi-coding), copy the directory instead:

```bash
cp -r ~/shared-skills/my-skill ~/.codeium/windsurf/skills/my-skill
cp -r ~/shared-skills/my-skill ~/.kimi/skills/my-skill
```

### Project-Level Skills

Place the skill directory inside the project's provider-specific skill path:

```bash
# Claude Code project skill
cp -r my-skill/ .claude/skills/my-skill/

# Cursor project skill
cp -r my-skill/ .cursor/skills/my-skill/
```

Project skills are committed to the repository and shared with all contributors.

## Adding a New Skill to @cleocode/skills

To add a new skill to the CLEO package (`packages/skills/`):

1. **Create the skill directory**:
   ```bash
   mkdir -p packages/skills/skills/my-new-skill
   ```

2. **Write SKILL.md with standard fields only**:
   ```yaml
   ---
   name: my-new-skill
   description: "Clear description of what the skill does and when to use it."
   license: MIT
   ---
   # My New Skill

   Instructions for using the skill...
   ```
   Include only v2 standard fields. No `version`, `tier`, `category`, or other CLEO-only fields.

3. **Add entry to manifest.json** (`packages/skills/skills/manifest.json`):
   ```json
   {
     "name": "my-new-skill",
     "version": "1.0.0",
     "description": "Same description as SKILL.md",
     "path": "skills/my-new-skill",
     "tags": ["relevant", "tags"],
     "status": "active",
     "tier": 2,
     "token_budget": 6000,
     "references": [],
     "capabilities": {
       "inputs": [],
       "outputs": [],
       "dependencies": [],
       "dispatch_triggers": ["trigger phrase"],
       "compatible_subagent_types": ["general-purpose"],
       "chains_to": [],
       "dispatch_keywords": {
         "primary": ["keyword1", "keyword2"],
         "secondary": ["keyword3", "keyword4"]
       }
     },
     "constraints": {
       "max_context_tokens": 60000,
       "requires_session": false,
       "requires_epic": false
     }
   }
   ```

4. **Add entry to dispatch-config.json** (`packages/skills/dispatch-config.json`):
   Add the skill to relevant `by_task_type`, `by_keyword`, and/or `by_protocol` mappings if it should participate in dispatch routing.

5. **Update totalSkills** in manifest.json `_meta.totalSkills` to reflect the new count.

6. **Validate**: Run the skill validator to confirm the new skill passes all checks:
   ```bash
   python3 packages/skills/skills/ct-skill-creator/scripts/quick_validate.py packages/skills/skills/my-new-skill
   ```
