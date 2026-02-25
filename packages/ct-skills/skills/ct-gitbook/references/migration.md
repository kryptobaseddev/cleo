# Migration Reference

Migrate documentation from MkDocs, Docusaurus, or legacy GitBook (v1/v2) to the modern GitBook platform.

## Overview

GitBook accepts standard Markdown with a `SUMMARY.md` for structure. Migration from most documentation tools involves converting the navigation configuration and adjusting Markdown syntax for GitBook's extensions.

## From MkDocs

### Steps

1. **Copy content**: Move your `docs/` directory contents to the GitBook repo
2. **Convert navigation**: Transform `mkdocs.yml` `nav` to `SUMMARY.md`
3. **Convert admonitions**: Replace MkDocs admonition syntax with GitBook hints
4. **Add config**: Create `.gitbook.yaml`
5. **Fix links**: Ensure all internal links have `.md` extensions
6. **Connect Git Sync**: Link the repo to a GitBook space

### Navigation Conversion

**MkDocs (`mkdocs.yml`):**
```yaml
nav:
  - Home: index.md
  - Getting Started:
    - Installation: getting-started/installation.md
    - Quick Start: getting-started/quickstart.md
  - API Reference:
    - REST API: api/rest.md
    - SDKs: api/sdks.md
```

**GitBook (`SUMMARY.md`):**
```markdown
# Summary

* [Home](README.md)

## Getting Started
* [Installation](getting-started/installation.md)
* [Quick Start](getting-started/quickstart.md)

## API Reference
* [REST API](api/rest.md)
* [SDKs](api/sdks.md)
```

### Admonition Conversion

| MkDocs | GitBook |
|--------|---------|
| `!!! note "Title"` | `{% hint style="info" %}` |
| `!!! warning "Title"` | `{% hint style="warning" %}` |
| `!!! tip "Title"` | `{% hint style="success" %}` |
| `!!! danger "Title"` | `{% hint style="danger" %}` |

**MkDocs:**
```markdown
!!! note "Important"
    This is an important note.
```

**GitBook:**
```markdown
{% hint style="info" %}
**Important**: This is an important note.
{% endhint %}
```

### MkDocs Extensions Not Supported

| Extension | Alternative |
|-----------|-------------|
| `pymdownx.tabbed` | `{% tabs %}` blocks |
| `pymdownx.details` | `<details>` / `<summary>` |
| `pymdownx.superfences` | Standard fenced code blocks |
| `mkdocstrings` | Manual API docs or OpenAPI spec |
| Custom themes | GitBook branding customization |
| Plugins | GitBook integrations |

### .gitbook.yaml for MkDocs Migration

```yaml
root: ./

structure:
  readme: README.md
  summary: SUMMARY.md
```

Note: MkDocs uses `index.md` as the landing page. Rename to `README.md` or configure in `.gitbook.yaml`.

## From Docusaurus

### Steps

1. **Copy content**: Move `docs/` directory to the GitBook repo
2. **Convert sidebar**: Transform `sidebars.js` to `SUMMARY.md`
3. **Strip MDX**: Replace JSX/MDX components with Markdown equivalents
4. **Remove imports**: Delete `import` statements from Markdown files
5. **Convert frontmatter**: Remove Docusaurus-specific frontmatter fields
6. **Fix links**: Update relative links to include `.md` extensions
7. **Connect Git Sync**

### Sidebar Conversion

**Docusaurus (`sidebars.js`):**
```javascript
module.exports = {
  docs: [
    'intro',
    {
      type: 'category',
      label: 'Getting Started',
      items: ['installation', 'quickstart'],
    },
    {
      type: 'category',
      label: 'API',
      items: ['api/rest', 'api/sdks'],
    },
  ],
};
```

**GitBook (`SUMMARY.md`):**
```markdown
# Summary

* [Introduction](intro.md)

## Getting Started
* [Installation](installation.md)
* [Quick Start](quickstart.md)

## API
* [REST API](api/rest.md)
* [SDKs](api/sdks.md)
```

### MDX to Markdown

| Docusaurus MDX | GitBook Equivalent |
|----------------|-------------------|
| `<Tabs>` / `<TabItem>` | `{% tabs %}` / `{% tab %}` |
| `<Admonition type="note">` | `{% hint style="info" %}` |
| `<CodeBlock>` | Fenced code blocks |
| `import Component` | Remove entirely |
| `<Component />` | Replace with Markdown content |
| `:::note` | `{% hint style="info" %}` |

### Frontmatter Cleanup

Remove Docusaurus-specific fields:

```yaml
# Remove these:
# sidebar_position: 1
# sidebar_label: "Custom Label"
# slug: /custom-url
# custom_edit_url: ...

# Keep these (if used):
# title: Page Title
# description: Page description
```

GitBook uses `SUMMARY.md` for ordering, not frontmatter.

## From Legacy GitBook (v1/v2)

### Overview

Legacy GitBook (the open-source Node.js tool) used the same `SUMMARY.md` format. Migration is straightforward.

### Steps

1. **Export content**: Download or clone from the legacy instance
2. **Review SUMMARY.md**: Format is compatible — no conversion needed
3. **Remove plugins**: Legacy plugins are not supported; replace with native features
4. **Update .gitbook.yaml**: Add if not present
5. **Connect Git Sync**

### Plugin Replacements

| Legacy Plugin | Modern Equivalent |
|---------------|-------------------|
| `gitbook-plugin-search` | Built-in search |
| `gitbook-plugin-highlight` | Native syntax highlighting |
| `gitbook-plugin-sharing` | Built-in social sharing |
| `gitbook-plugin-fontsettings` | Theme customization |
| `gitbook-plugin-livereload` | N/A (cloud-hosted) |
| `gitbook-plugin-lunr` | Built-in search with AI |
| `gitbook-plugin-theme-*` | Branding customization |

### book.json to .gitbook.yaml

**Legacy (`book.json`):**
```json
{
  "root": "./docs",
  "structure": {
    "readme": "README.md",
    "summary": "SUMMARY.md"
  },
  "plugins": ["search", "highlight"]
}
```

**Modern (`.gitbook.yaml`):**
```yaml
root: ./docs/

structure:
  readme: README.md
  summary: SUMMARY.md
```

Plugins are removed — features are built into the platform.

## Common Post-Migration Tasks

### Fix Relative Links

Ensure all internal links use `.md` extensions:

```markdown
<!-- Correct -->
[Installation](getting-started/installation.md)

<!-- Incorrect — will break -->
[Installation](getting-started/installation)
[Installation](/getting-started/installation)
```

### Fix Image Paths

Use relative paths from the page file:

```markdown
<!-- From docs/guides/setup.md -->
![Diagram](../assets/diagram.png)

<!-- Or use .gitbook/assets for shared images -->
![Logo](../.gitbook/assets/logo.png)
```

### Validate Structure

After migration, verify:
- All files referenced in `SUMMARY.md` exist
- All images load correctly
- No broken internal links
- Code blocks have language tags
- GitBook renders pages as expected

## Resources

- **MkDocs**: https://www.mkdocs.org/
- **Docusaurus**: https://docusaurus.io/
- **Git Sync Configuration**: https://docs.gitbook.com/integrations/git-sync/content-configuration
- **Publishing Guide**: https://gitbook.com/docs/guides/editing-and-publishing-documentation/complete-guide-to-publishing-docs-gitbook
