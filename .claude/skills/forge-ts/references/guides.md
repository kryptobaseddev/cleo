# forge-ts Generated Pages Guide

## Page Categories

forge-ts build produces two categories of documentation pages. Understanding
which are auto-generated and which are stubs determines your editing strategy.

## Auto-Generated Pages (Hands-Off)

These pages are **regenerated from source code on every build**. Do not edit
them — your changes will be overwritten. Fix the source code instead.

| Page | What it contains | Fix by |
|------|-----------------|--------|
| `index.mdx` | Project overview from `@packageDocumentation` and `package.json` | Edit `package.json` description or entry point TSDoc |
| `getting-started.mdx` | First `@example` block found in exports | Edit the `@example` tag on your primary export |
| `configuration.mdx` | Detected config types with property descriptions | Add/edit TSDoc on your config interface members |
| `packages/<name>/api/functions.mdx` | Function signatures, params, returns, examples | Edit `@param`, `@returns`, `@example` on functions |
| `packages/<name>/api/types.mdx` | Interface/type property documentation | Edit TSDoc on interface members |
| `packages/<name>/api/examples.mdx` | Aggregated `@example` blocks | Add/edit `@example` blocks on exports |
| `llms.txt` / `llms-full.txt` | Compact AI context | Improve TSDoc summaries |
| `SKILL-{project}/SKILL.md` | agentskills.io skill package | Use `config.skill.customSections` |

## Stub Pages (Human/Agent Edited)

These pages are **created once on first build** and never overwritten.
They contain `<!-- FORGE:AUTO-START id -->` / `<!-- FORGE:AUTO-END id -->`
marker sections that are refreshed on each build, while content outside
markers is preserved.

| Page | Purpose | What to write |
|------|---------|--------------|
| `concepts.mdx` | Architecture and mental models | Domain knowledge, how components relate, design decisions |
| `guides/index.mdx` | How-to guides | Step-by-step workflows for common tasks |
| `faq.mdx` | Common questions | Answers to questions from issues, support, or new users |
| `contributing.mdx` | Contribution guidelines | Dev setup, PR process, coding standards |
| `changelog.mdx` | Release history | Notable changes per version |

## Working with FORGE:AUTO Markers

```markdown
## API Overview

<!-- FORGE:AUTO-START api-summary -->
| Function | Description |
|----------|-------------|
| `add` | Adds two numbers |
<!-- FORGE:AUTO-END api-summary -->

## My Custom Content

This section is **safe** — forge-ts never touches it.
```

- Content **inside** markers is refreshed from source on every build
- Content **outside** markers is preserved across builds
- New exports automatically appear in marker sections
- `--force-stubs` resets the ENTIRE stub to scaffolding (use with caution)

## SSG Navigation Config

When `gen.ssgTarget` is set, `forge-ts build` also generates SSG-specific
navigation config (e.g. `docs.json` for Mintlify). This file is auto-generated
and regenerated on each build.

`forge-ts docs init` writes additional adapter scaffolding that may include
package.json scripts, dependencies, and starter config files specific to the
target platform.

## Editing Strategy

1. **Auto pages**: Never edit directly. Improve source code TSDoc instead.
2. **Stub marker sections**: Don't edit — they refresh on build.
3. **Stub content outside markers**: Safe to edit freely.
4. **Custom sections in SKILL.md**: Use `config.skill.customSections`.
5. **To reset a stub**: Run `forge-ts build --force-stubs` (destructive).
