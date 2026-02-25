# Git Sync Reference

Bidirectional synchronization between a Git repository (GitHub or GitLab) and a GitBook space.

## Overview

Git Sync connects a GitBook space to a branch in your repository. Edits in either location are synced to the other. The GitHub App integration handles webhooks and authentication.

## Setup

### GitHub Integration

1. Open your space in GitBook
2. Navigate to **Integrations > Git Sync**
3. Click **Connect with GitHub** — installs the GitBook GitHub App
4. Select the repository and branch
5. Choose sync direction: **GitHub to GitBook**, **GitBook to GitHub**, or **Bidirectional**

### GitLab Integration

1. Navigate to **Integrations > Git Sync**
2. Click **Connect with GitLab**
3. Provide a GitLab personal access token with `api` scope
4. Select the project and branch

## .gitbook.yaml

Optional configuration file at the repository root (or at the root specified by the `root` field).

```yaml
# Root directory for documentation (relative to repo root)
root: ./docs/

# Structure files
structure:
  readme: README.md    # Main page file name (default: README.md)
  summary: SUMMARY.md  # Table of contents file (default: SUMMARY.md)

# Redirects for moved/renamed pages
redirects:
  previous/page: current/page.md
  old-guide: guides/new-guide.md
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `root` | `./` | Root directory for docs content |
| `structure.readme` | `README.md` | Filename for the space's main page |
| `structure.summary` | `SUMMARY.md` | Filename for the table of contents |
| `redirects` | — | Map of old paths to new paths |

## SUMMARY.md

Defines the page hierarchy and navigation structure. GitBook reads this file to determine the sidebar tree.

### Format

```markdown
# Summary

## Section Title

* [Page Title](path/to/page.md)
* [Another Page](path/to/another.md)
  * [Nested Page](path/to/nested.md)
    * [Deep Nested](path/to/deep.md)

## Another Section

* [Page](section2/page.md)
```

### Rules

- Top-level `## Headings` create navigation groups
- `* [Title](path.md)` creates a page link
- Indentation (2 spaces) creates nesting
- Maximum 3 levels of nesting recommended
- Links must be relative paths from the `root` directory
- Each linked file must exist or GitBook shows a warning
- `README.md` in a directory serves as the group's landing page

### Example — Multi-Section Docs

```markdown
# Summary

## Getting Started
* [Introduction](README.md)
* [Installation](getting-started/installation.md)
* [Quick Start](getting-started/quickstart.md)
* [Configuration](getting-started/config.md)

## User Guide
* [Overview](guide/README.md)
* [Basic Usage](guide/basics.md)
* [Advanced Topics](guide/advanced/README.md)
  * [Plugins](guide/advanced/plugins.md)
  * [Theming](guide/advanced/theming.md)
  * [Hooks](guide/advanced/hooks.md)

## API Reference
* [REST API](api/rest.md)
* [TypeScript SDK](api/sdk.md)
* [Webhooks](api/webhooks.md)

## Resources
* [FAQ](resources/faq.md)
* [Troubleshooting](resources/troubleshooting.md)
* [Changelog](CHANGELOG.md)
```

## Mono-Repo Support

For repositories containing more than just documentation:

```yaml
# .gitbook.yaml at repo root
root: ./packages/docs/

structure:
  readme: README.md
  summary: SUMMARY.md
```

Only files under `root` are synced. The rest of the repository is ignored.

## Sync Directions

| Direction | Behavior |
|-----------|----------|
| GitHub → GitBook | Repo is source of truth. Push triggers import. GitBook editor is read-only. |
| GitBook → GitHub | GitBook is source of truth. Edits create commits on the branch. |
| Bidirectional | Both are editable. Most recent change wins. Conflicts shown in UI. |

### Conflict Resolution

When bidirectional sync encounters conflicts:
1. GitBook displays a conflict notification
2. Choose to keep the GitBook version or the Git version
3. The chosen version is synced to both locations

## Branch Strategy

- **Production branch** (`main`): Sync to the primary space for live docs
- **Feature branches**: Create a separate space or use Change Requests
- **Version branches** (`v1`, `v2`): Sync each to a content variant

## Supported File Types

| Extension | Treatment |
|-----------|-----------|
| `.md` | Parsed as content pages |
| `.yaml` / `.json` | OpenAPI specs rendered as API references |
| Images (`.png`, `.jpg`, `.svg`, `.gif`) | Stored as assets |
| Other files | Ignored by GitBook |

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Sync not triggering | GitHub App webhook failed | Re-install the GitHub App |
| Pages missing | Not listed in SUMMARY.md | Add entries to SUMMARY.md |
| Wrong page order | SUMMARY.md ordering | Reorder entries in SUMMARY.md |
| Images broken | Path is absolute | Use relative paths from the page file |
| .gitbook.yaml ignored | File not at repo root | Move to repository root |
| Conflicts on every sync | Bidirectional with frequent edits | Choose a single direction |

## Resources

- **Git Sync Docs**: https://docs.gitbook.com/integrations/git-sync
- **GitHub App**: https://github.com/apps/gitbook-com
- **.gitbook.yaml Reference**: https://docs.gitbook.com/integrations/git-sync/content-configuration
