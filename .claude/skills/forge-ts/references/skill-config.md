# forge-ts Skill Package Configuration

## Overview

forge-ts generates an agentskills.io-compliant skill package alongside
documentation artifacts. The generated `SKILL-{project}/` directory contains
everything an LLM agent needs to understand your library.

## Generated Directory Structure

```
SKILL-{project}/
  SKILL.md                        # Main skill file (YAML frontmatter + content)
  references/
    API-REFERENCE.md              # Full function signatures and examples
    CONFIGURATION.md              # Config options and defaults
  scripts/
    test.sh                       # Run doctests (if CLI detected)
    check.sh                      # Run TSDoc coverage check
    build.sh                      # Generate documentation
```

## Config Options

```typescript
// forge-ts.config.ts
skill: {
  // Generate SKILL.md package (defaults to gen.llmsTxt value)
  enabled: true,

  // Custom sections injected after the auto-generated API summary
  customSections: [
    {
      heading: "The Flow",
      content: "check -> build -> docs init -> docs dev"
    },
    {
      heading: "Domain Concepts",
      content: "Describe your domain model here."
    },
  ],

  // Extra gotcha bullets appended to auto-detected gotchas
  extraGotchas: [
    "Stub pages are NEVER overwritten — safe to edit after first build.",
    "@example blocks require fenced code blocks. Bare code is ignored.",
    "Config warnings appear in JSON envelope under result._warnings.",
  ],
}
```

## What Gets Auto-Detected

The generated SKILL.md derives content from your source code:

| Section | Source |
|---------|--------|
| Description | `@packageDocumentation` summary or `package.json` description |
| Quick Start | `bin` field generates CLI usage; first `@example` for library usage |
| API Summary | Top exported functions with signatures |
| Configuration | Exported config types with property descriptions |
| Key Types | Top 10 exported interfaces/types |
| Gotchas | `@deprecated` symbols, `@throws` tags, enum constraints |

## Custom Sections

Custom sections appear between the API summary and Gotchas sections.
Each entry becomes a `## heading` with the content rendered as markdown.

Use custom sections for:
- **Workflow knowledge** — the recommended order of operations
- **Domain concepts** — mental models that can't be derived from types
- **SSoT principles** — how your docs relate to source code
- **Integration patterns** — how to use your library with other tools

## Extra Gotchas

Extra gotchas are appended as bullet points to the auto-detected Gotchas
section. Use them for:
- Common pitfalls specific to your project
- Non-obvious behavior that types don't capture
- Environment requirements or compatibility notes

## Directory Naming Convention

The generated directory follows `SKILL-{project}` convention:
- npm scope is stripped: `@forge-ts/core` becomes `SKILL-core`
- Special characters become hyphens: `my_lib` becomes `SKILL-my-lib`
- Max 64 characters
