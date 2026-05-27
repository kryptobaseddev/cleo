# Templates

Bundled templates shipped with `@cleocode/core`. Used by `cleo init`, `cleo upgrade`, and the global bootstrap flow.

## Directory Structure

| Path | Purpose | Used By |
|------|---------|---------|
| `CLEO-INJECTION.md` | Global injection protocol (thin bootstrap) | `~/.cleo/templates/` → `~/.agents/AGENTS.md` |
| `config.template.json` | Project config defaults | `cleo init` → `.cleo/config.json` |
| `global-config.template.json` | Global config defaults | Bootstrap → `~/.cleo/config.json` |
| `cleo-gitignore` | Default `.cleo/.gitignore` content | `cleo init` |
| `agent-registry.json` | Agent registry template | `cleo init` |
| `github/ISSUE_TEMPLATE/` | GitHub issue templates (user-facing) | `cleo issue` command |
| `git-hooks/` | Git hook templates | `cleo init` (optional) |

## Template Resolution

All templates are resolved at runtime via `getPackageRoot() + '/templates/'`. They are bundled in the published npm package — never copied to `~/.cleo/` except for `CLEO-INJECTION.md` which is symlinked for provider `@`-reference resolution.

## Injection Chain

```
~/.agents/AGENTS.md
  └── @~/.cleo/templates/CLEO-INJECTION.md (symlink → npm package)

{project}/AGENTS.md
  └── @~/.agents/AGENTS.md + @.cleo/project-context.json + @.cleo/memory-bridge.md
```
