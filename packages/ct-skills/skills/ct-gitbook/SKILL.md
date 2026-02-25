---
name: ct-gitbook
description: >-
  Comprehensive guide for the modern GitBook platform including Docs Sites
  publishing, @gitbook/api TypeScript SDK, Git Sync with GitHub App, Change
  Requests, Site Sections, adaptive content, visitor authentication
  (Auth0/Okta/Azure AD), LLM-ready docs (llms.txt, MCP server), OpenAPI
  integration, content blocks, custom domains, SSO/SAML, SEO optimization,
  and migration from MkDocs/Docusaurus. Use when creating, managing, or
  automating GitBook documentation sites, configuring Git Sync, working
  with the GitBook API, setting up authentication, or migrating
  documentation to GitBook.
version: 1.0.0
tier: 3
core: false
category: meta
protocol: null
dependencies: []
sharedResources: []
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
---

# GitBook Platform Guide

GitBook is an AI-native documentation platform for publishing, managing, and automating documentation through Docs Sites, a TypeScript SDK, Git Sync, Change Requests, and LLM-ready output.

## Platform Overview

GitBook organizes documentation into **Spaces** (content containers), published through **Docs Sites** (public-facing sites). Spaces contain pages authored in a block-based editor or synced from Git. Docs Sites support **Site Sections** for multi-product navigation, **content variants** for versioning, **adaptive content** for personalization, and **visitor authentication** for access control.

Key platform capabilities:
- **Docs Sites** — Publish spaces with custom domains, sections, and SEO
- **Git Sync** — Bidirectional sync with GitHub/GitLab via the GitHub App
- **@gitbook/api SDK** — TypeScript client for all API operations
- **Change Requests** — Branch-and-merge editing workflow with review
- **Adaptive Content** — Personalize docs based on visitor claims
- **LLM-Ready** — Auto-generated `llms.txt`, `.md` endpoints, MCP server
- **Visitor Auth** — Protect docs via Auth0, Okta, Azure AD, or OIDC

> For deep-dive content on each topic, see the [Reference Index](#reference-index) at the bottom.

## Quick Start

### 1. Install the SDK

```bash
npm install @gitbook/api
```

### 2. Initialize the Client

```typescript
import { GitBookAPI } from '@gitbook/api';

const client = new GitBookAPI({ authToken: process.env.GITBOOK_API_TOKEN });

// Verify authentication
const user = await client.user.getCurrentUser();
console.log(`Authenticated as: ${user.data.displayName}`);
```

### 3. Create a Space

```typescript
const org = await client.orgs.listOrganizationsForAuthenticatedUser();
const orgId = org.data.items[0].id;

const space = await client.orgs.createSpace(orgId, {
  title: 'API Documentation',
  visibility: 'public',
});
console.log(`Space created: ${space.data.id}`);
```

### 4. Publish a Docs Site

```typescript
const site = await client.orgs.createSite(orgId, {
  title: 'Developer Docs',
});
// Link the space as the site's primary content
await client.sites.addSiteSection(site.data.id, {
  spaceId: space.data.id,
  title: 'API Reference',
});
```

> Full SDK reference: `references/api-sdk.md`

## Git Sync Configuration

Git Sync provides bidirectional synchronization between a GitHub/GitLab repository and a GitBook space. Content authored in either location stays in sync.

### Setup

1. Install the **GitBook GitHub App** from your space's integrations
2. Select the repository and branch to sync
3. Optionally add `.gitbook.yaml` for structure configuration

### .gitbook.yaml

```yaml
root: ./docs/

structure:
  readme: README.md
  summary: SUMMARY.md

redirects:
  old-page: new-page.md
```

### SUMMARY.md

Controls the page hierarchy in GitBook:

```markdown
# Summary

## Getting Started
* [Introduction](README.md)
* [Installation](getting-started/installation.md)

## Guides
* [Basic Usage](guides/basic.md)
* [Advanced](guides/advanced/README.md)
  * [Plugins](guides/advanced/plugins.md)
```

### Sync Behavior

- **GitHub to GitBook**: Push to the synced branch triggers content import
- **GitBook to GitHub**: Edits in the GitBook editor create commits on the branch
- **Conflicts**: GitBook shows a conflict resolution UI; prefer one direction
- Mono-repo support: use `root` in `.gitbook.yaml` to scope to a subdirectory

> Full details: `references/git-sync.md`

## Docs Sites and Publishing

A **Docs Site** is the published, public-facing version of your documentation. Each site has its own URL, custom domain, and navigation structure.

### Site Sections

Site Sections let you combine multiple spaces into a single site with tab-based navigation. Each section maps to one space.

```typescript
// Add sections to a site
await client.sites.addSiteSection(siteId, {
  spaceId: apiDocsSpaceId,
  title: 'API Reference',
});
await client.sites.addSiteSection(siteId, {
  spaceId: guidesSpaceId,
  title: 'Guides',
});
```

Sections support **nested groups** — group related sections under a dropdown heading.

### Custom Domains

```typescript
await client.sites.updateSiteCustomization(siteId, {
  hostname: 'docs.example.com',
});
```

Configure DNS: add a CNAME record pointing `docs.example.com` to `hosting.gitbook.io`.

### Content Variants

Variants let you maintain multiple versions of documentation within a single space (e.g., v1, v2, latest).

```typescript
await client.spaces.createVariant(spaceId, { title: 'v2.0', slug: 'v2' });
await client.spaces.setDefaultVariant(spaceId, variantId);
```

> Full details: `references/docs-sites.md`

## Content Authoring

GitBook's editor supports rich content blocks beyond plain Markdown.

### Supported Block Types

| Block | Description |
|-------|-------------|
| Code blocks | Syntax-highlighted with language tabs |
| Hints | Info, warning, success, danger callouts |
| Tabs | Tabbed content sections |
| Expandables | Collapsible sections |
| Cards | Link cards with images |
| Embedded URLs | Auto-expanding embeds (YouTube, Figma, etc.) |
| OpenAPI | Render API reference from spec files |
| Drawings | Diagrams authored in the editor |
| Math | LaTeX math blocks and inline equations |
| Files | Attached file downloads |

### OpenAPI Integration

Upload or link an OpenAPI spec to auto-generate interactive API reference pages:

```yaml
# In your Git-synced repo, reference a spec file:
# GitBook detects .yaml/.json OpenAPI files and renders them
```

Or paste an OpenAPI spec URL in the editor — GitBook renders endpoints with try-it-out functionality.

### Markdown in Git Sync

When syncing from Git, GitBook supports standard Markdown plus extensions:
- `{% hint style="info" %}` blocks for callouts
- `{% tabs %}` / `{% tab %}` for tabbed content
- `{% embed url="..." %}` for embeds
- `{% swagger src="./openapi.yaml" %}` for API specs

> Full details: `references/content-blocks.md`

## Change Requests

Change Requests provide a branch-and-merge workflow for documentation, analogous to pull requests in Git.

### Workflow

1. **Create** a change request from the space sidebar
2. **Edit** content in the isolated branch — no impact on live docs
3. **Request review** from team members or the Docs Agent (AI reviewer)
4. **Merge** to publish changes to the live site

### API Usage

```typescript
// Create a change request
const cr = await client.spaces.createChangeRequest(spaceId, {
  subject: 'Update API authentication guide',
});

// Merge when ready
await client.spaces.mergeChangeRequest(spaceId, cr.data.id);
```

### Review Features

- Tag specific reviewers for notification
- Reviews marked as outdated when new changes are pushed
- Re-request review with a single action
- Filter change requests by creator, participant, or status

> Full details: `references/change-requests.md`

## Authentication and Access Control

### Visitor Authentication

Protect published docs behind a login screen. Supported providers:

| Provider | Integration |
|----------|-------------|
| Auth0 | Native GitBook integration |
| Okta | Native GitBook integration |
| Azure AD | Native GitBook integration |
| AWS Cognito | Native GitBook integration |
| Custom OIDC | Build your own backend |

Enable in site settings under **Audience > Authenticated access**.

### SSO & SAML

For organization member authentication (not visitor auth):
- SSO via authorized email domain
- SAML 2.0 with any compliant IdP
- SOC 2 and ISO 27001 certified

### Adaptive Content with Auth

When visitor authentication is enabled, you can pass **claims** (role, plan, region) from your IdP to personalize content per visitor. See the Adaptive Content section in `references/auth-sso.md`.

> Full details: `references/auth-sso.md`

## LLM-Ready Documentation

GitBook automatically generates LLM-optimized outputs for every published site.

### llms.txt

Append `/llms.txt` to any docs site URL to get a plain-text index:

```
https://docs.example.com/llms.txt       # Index with page links
https://docs.example.com/llms-full.txt  # Full content in one file
```

### Markdown Endpoints

Append `.md` to any page URL to get raw Markdown — ideal for LLM ingestion:

```
https://docs.example.com/getting-started.md
```

### MCP Server

Every published space exposes a Model Context Protocol server:

```
https://docs.example.com/~gitbook/mcp
```

Configure in your agent's MCP settings to give it structured access to your docs.

### SEO

GitBook generates sitemaps, Open Graph meta tags, and structured data automatically. Custom meta descriptions can be set per page.

> Full details: `references/llm-ready.md`

## API Operations Quick Reference

### Organizations

```typescript
// List orgs
const orgs = await client.orgs.listOrganizationsForAuthenticatedUser();

// Get org details
const org = await client.orgs.getOrganizationById(orgId);

// List members
const members = await client.orgs.listMembersInOrganization(orgId);

// Invite member
await client.orgs.inviteMembersToOrganization(orgId, {
  emails: ['user@example.com'],
  role: 'editor',
});
```

### Spaces

```typescript
// List spaces
const spaces = await client.orgs.listSpacesInOrganization(orgId);

// Get space
const space = await client.spaces.getSpaceById(spaceId);

// Update space
await client.spaces.updateSpace(spaceId, { title: 'New Title' });

// Delete space
await client.spaces.deleteSpace(spaceId);
```

### Content

```typescript
// Get page tree
const content = await client.spaces.listPagesInSpace(spaceId);

// Search
const results = await client.spaces.searchSpaceContent(spaceId, {
  query: 'authentication',
});

// Import from Git
await client.spaces.importContentInSpace(spaceId, {
  source: { type: 'github', url: 'https://github.com/org/repo' },
});
```

### Docs Sites

```typescript
// Create site
const site = await client.orgs.createSite(orgId, { title: 'Docs' });

// List sites
const sites = await client.orgs.listSitesInOrganization(orgId);

// Update customization
await client.sites.updateSiteCustomization(siteId, {
  styling: { primaryColor: '#0066FF' },
  themes: { default: 'light', toggleable: true },
});
```

> Full SDK reference: `references/api-sdk.md`

## CI/CD Integration Patterns

### GitHub Actions — Validate Docs Structure

```yaml
name: Validate Docs
on:
  pull_request:
    paths: ['docs/**']

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check SUMMARY.md links
        run: |
          while IFS= read -r link; do
            if [ ! -f "docs/$link" ]; then
              echo "Broken link: $link"
              exit 1
            fi
          done < <(grep -oP '\[.*?\]\(\K[^)]+' docs/SUMMARY.md)
          echo "All links valid"
```

### GitHub Actions — Trigger Sync

```yaml
name: Sync to GitBook
on:
  push:
    branches: [main]
    paths: ['docs/**']

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "GitBook auto-syncs via GitHub App — no manual trigger needed"
      # The GitBook GitHub App handles sync automatically.
      # This workflow is for additional validation only.
```

### Pre-commit Hook

```bash
#!/usr/bin/env bash
# .git/hooks/pre-commit — validate docs before commit
if git diff --cached --name-only | grep -q '^docs/'; then
  if [ -f docs/SUMMARY.md ]; then
    grep -oP '\[.*?\]\(\K[^)]+' docs/SUMMARY.md | while read -r link; do
      [ -f "docs/$link" ] || { echo "Broken: $link"; exit 1; }
    done
  fi
fi
```

## Migration

### From MkDocs

1. Copy `docs/` directory contents to your GitBook repo
2. Convert `mkdocs.yml` nav to `SUMMARY.md` format
3. Add `.gitbook.yaml` with `root: ./`
4. Replace `!!! note` admonitions with `{% hint style="info" %}` blocks
5. Connect via Git Sync

### From Docusaurus

1. Copy `docs/` directory to your GitBook repo
2. Convert `sidebars.js` structure to `SUMMARY.md`
3. Strip MDX components — replace with GitBook equivalents
4. Replace `import` statements with standard Markdown
5. Convert frontmatter `sidebar_position` to SUMMARY.md ordering

### From Legacy GitBook (v1/v2)

1. Export content from the legacy instance
2. Structure matches — `SUMMARY.md` format is unchanged
3. Update `.gitbook.yaml` for any root path changes
4. Plugins are not supported — replace with native GitBook features

> Full details: `references/migration.md`

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| 401 Unauthorized | Invalid or expired token | Regenerate at `app.gitbook.com/account/developer` |
| Git Sync not updating | Branch mismatch or conflict | Check space integrations; verify branch name |
| Broken links after migration | Missing `.md` extensions | Ensure all internal links include `.md` suffix |
| Images not displaying | Wrong path format | Use paths relative to the page file |
| Custom domain not working | DNS not configured | Add CNAME to `hosting.gitbook.io` |
| Change request conflicts | Concurrent edits | Resolve in GitBook UI or re-create the CR |
| Site sections not showing | Section not linked | Add section in site Settings > Structure |
| MCP server returns error | Accessed via browser | MCP endpoint is for agent tools, not browsers |

## Reference Index

| Reference | File | Topics |
|-----------|------|--------|
| TypeScript SDK | `references/api-sdk.md` | @gitbook/api client, all endpoints, error handling |
| Git Sync | `references/git-sync.md` | GitHub App, .gitbook.yaml, SUMMARY.md, mono-repos |
| Docs Sites | `references/docs-sites.md` | Publishing, Site Sections, domains, variants, SEO |
| Content Blocks | `references/content-blocks.md` | Block types, OpenAPI, embeds, Markdown extensions |
| Change Requests | `references/change-requests.md` | CR workflow, review, Docs Agent, adaptive content |
| Auth & SSO | `references/auth-sso.md` | Visitor auth, Auth0/Okta/Azure AD, SAML, adaptive |
| LLM-Ready | `references/llm-ready.md` | llms.txt, MCP server, Markdown endpoints, SEO |
| Migration | `references/migration.md` | MkDocs, Docusaurus, legacy GitBook v1/v2 |

## Starter Templates

Copy these assets into a new project to bootstrap a GitBook-ready repository:

| Asset | File | Description |
|-------|------|-------------|
| GitBook config | `assets/gitbook.yaml` | Starter `.gitbook.yaml` with root, structure, and redirects |
| Table of contents | `assets/SUMMARY.md` | Starter `SUMMARY.md` with multi-section navigation |
