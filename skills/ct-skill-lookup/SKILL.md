---
name: ct-skill-lookup
description: This skill should be used when the user asks to "find me a skill", "search for skills", "what skills are available", "get skill XYZ", "install a skill", "extend Claude's capabilities with skills", or mentions Agent Skills, prompts.chat, SkillsMP, marketplace, external skills, or reusable AI agent components.
version: 1.1.0
---

When the user needs Agent Skills, wants to extend Claude's capabilities, or is looking for reusable AI agent components, you have two sources available:

1. **prompts.chat MCP server** - Agent Skills marketplace (when available)
2. **SkillsMP** - CLEO's built-in skill marketplace integration

## When to Use This Skill

Activate this skill when the user:

- Asks for Agent Skills ("Find me a code review skill")
- Wants to search for skills ("What skills are available for testing?")
- Needs to retrieve a specific skill ("Get skill XYZ")
- Wants to install a skill ("Install the documentation skill")
- Mentions extending Claude's capabilities with skills
- Mentions marketplace, SkillsMP, or external skills

## Available Tools

### prompts.chat MCP Tools (when available)

- `search_skills` - Search for skills by keyword
- `get_skill` - Get a specific skill by ID with all its files

### CLEO SkillsMP (built-in)

Use `cleo skills` commands to search and retrieve skills:

```bash
cleo skills search <query> [--source skillsmp]  # Search SkillsMP marketplace
cleo skills get <id> --source skillsmp          # Get skill from marketplace
cleo skills install <id> --source skillsmp      # Install from marketplace
```

## How to Search for Skills

### Using prompts.chat MCP

Call `search_skills` with:

- `query`: The search keywords from the user's request
- `limit`: Number of results (default 10, max 50)
- `category`: Filter by category slug (e.g., "coding", "automation")
- `tag`: Filter by tag slug

Present results showing:
- Title and description
- Author name
- File list (SKILL.md, reference docs, scripts)
- Category and tags
- Link to the skill

### Using SkillsMP

Execute `cleo skills search` with:

```bash
cleo skills search "code review" --source skillsmp
cleo skills search "testing" --source skillsmp --limit 20
```

Results include:
- Skill ID, name, and description
- Version and compatibility
- Author and license
- Installation status (local/marketplace)

## How to Get a Skill

### Using prompts.chat MCP

Call `get_skill` with:

- `id`: The skill ID

Returns the skill metadata and all file contents:
- SKILL.md (main instructions)
- Reference documentation
- Helper scripts
- Configuration files

### Using SkillsMP

Execute `cleo skills get`:

```bash
cleo skills get ct-code-reviewer --source skillsmp
```

Returns full skill content including metadata and files.

## How to Install a Skill

### Using prompts.chat MCP

When the user asks to install a skill:

1. Call `get_skill` to retrieve all files
2. Create the directory `.claude/skills/{slug}/`
3. Save each file to the appropriate location:
   - `SKILL.md` → `.claude/skills/{slug}/SKILL.md`
   - Other files → `.claude/skills/{slug}/{filename}`

### Using SkillsMP

Execute `cleo skills install`:

```bash
cleo skills install ct-code-reviewer --source skillsmp
cleo skills install ct-testing-assistant --source skillsmp --force
```

The command automatically:
- Downloads skill files from marketplace
- Validates skill structure
- Installs to `skills/{slug}/`
- Updates skill registry

## Skill Structure

Skills contain:
- **SKILL.md** (required) - Main instructions with frontmatter
- **Reference docs** - Additional documentation files
- **Scripts** - Helper scripts (Python, shell, etc.)
- **Config files** - JSON, YAML configurations

## Guidelines

- Always search before suggesting the user create their own skill
- Try SkillsMP first (`cleo skills search`), then prompts.chat MCP if available
- Present search results in a readable format with file counts
- When installing, confirm the skill was saved successfully
- Explain what the skill does and when it activates

## Examples

### Searching SkillsMP

```bash
# Find code review skills
cleo skills search "code review" --source skillsmp

# Find testing-related skills
cleo skills search "test" --source skillsmp --limit 10
```

### Getting Skill Details

```bash
# Get full skill information
cleo skills get ct-code-reviewer --source skillsmp
```

### Installing from Marketplace

```bash
# Install a skill from SkillsMP
cleo skills install ct-code-reviewer --source skillsmp

# Force reinstall (overwrite existing)
cleo skills install ct-code-reviewer --source skillsmp --force
```