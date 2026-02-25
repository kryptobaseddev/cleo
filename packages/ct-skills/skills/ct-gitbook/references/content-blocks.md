# Content Blocks Reference

Content types, OpenAPI integration, embeds, and Markdown extensions in GitBook.

## Overview

GitBook's block-based editor supports rich content beyond standard Markdown. When using Git Sync, special syntax and templates map to these blocks.

## Block Types

### Code Blocks

Standard fenced code blocks with syntax highlighting:

````markdown
```typescript
const x = 42;
```
````

**Code tabs** — multiple language examples in a single block:

```markdown
{% tabs %}
{% tab title="TypeScript" %}
```typescript
const client = new GitBookAPI({ authToken: token });
```
{% endtab %}
{% tab title="cURL" %}
```bash
curl -H "Authorization: Bearer $TOKEN" https://api.gitbook.com/v1/user
```
{% endtab %}
{% endtabs %}
```

### Hints (Callouts)

```markdown
{% hint style="info" %}
This is an informational callout.
{% endhint %}

{% hint style="warning" %}
Proceed with caution.
{% endhint %}

{% hint style="success" %}
Operation completed successfully.
{% endhint %}

{% hint style="danger" %}
This action is irreversible.
{% endhint %}
```

Available styles: `info`, `warning`, `success`, `danger`.

### Tabs

```markdown
{% tabs %}
{% tab title="macOS" %}
Installation instructions for macOS.
{% endtab %}
{% tab title="Linux" %}
Installation instructions for Linux.
{% endtab %}
{% tab title="Windows" %}
Installation instructions for Windows.
{% endtab %}
{% endtabs %}
```

### Expandable Sections

```markdown
<details>
<summary>Click to expand</summary>

Hidden content goes here. Supports full Markdown.

</details>
```

### Cards

Link cards with optional images, rendered as visual previews:

```markdown
{% content-ref url="getting-started.md" %}
[getting-started.md](getting-started.md)
{% endcontent-ref %}
```

### Embedded URLs

Auto-expanding embeds for supported services:

```markdown
{% embed url="https://www.youtube.com/watch?v=VIDEO_ID" %}
YouTube video title
{% endembed %}

{% embed url="https://www.figma.com/file/FILE_ID" %}
Figma design
{% endembed %}
```

Supported embed providers include YouTube, Vimeo, Figma, CodePen, Loom, Google Drive, and others.

### Math (LaTeX)

Inline math: `$$E = mc^2$$`

Block math:

```markdown
$$
\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}
$$
```

### Files

Attach downloadable files:

```markdown
{% file src=".gitbook/assets/report.pdf" %}
Download the full report
{% endfile %}
```

### Drawings

Created in the GitBook editor's built-in drawing tool. These are stored as SVG assets and referenced in the page content. Not editable via Git Sync — use the editor.

### Tables

Standard Markdown tables:

```markdown
| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |
```

### Images

```markdown
![Alt text](path/to/image.png)

<!-- With caption -->
<figure><img src="path/to/image.png" alt="Description"><figcaption>Caption text</figcaption></figure>
```

Image paths in Git Sync should be relative to the page file or use `.gitbook/assets/` for shared assets.

## OpenAPI Integration

GitBook renders OpenAPI (Swagger) specifications as interactive API reference pages.

### Methods

**1. URL reference in the editor:**
Paste an OpenAPI spec URL in the editor. GitBook fetches and renders it.

**2. File in Git Sync:**
Place `.yaml` or `.json` OpenAPI files in your repository. Reference them in pages:

```markdown
{% swagger src="./openapi.yaml" path="/users" method="get" %}
[openapi.yaml](openapi.yaml)
{% endswagger %}
```

**3. Inline specification:**
Paste the full spec inline (not recommended for large specs).

### Rendered Output

GitBook generates:
- Endpoint listings with method badges (GET, POST, etc.)
- Request/response schemas with type information
- Try-it-out functionality for testing endpoints
- Authentication configuration display
- Parameter descriptions and examples

### Supported Versions

- OpenAPI 3.0.x
- OpenAPI 3.1.x
- Swagger 2.0 (converted internally)

## Markdown Extensions Summary

| Syntax | Renders As |
|--------|------------|
| `{% hint style="..." %}` | Callout box |
| `{% tabs %}` / `{% tab %}` | Tabbed content |
| `{% embed url="..." %}` | Rich embed |
| `{% swagger src="..." %}` | API reference |
| `{% content-ref url="..." %}` | Link card |
| `{% file src="..." %}` | File download |
| `$$...$$` | Math equation |
| `<details>` / `<summary>` | Expandable section |

## Assets Directory

Git-synced repos store uploaded assets in `.gitbook/assets/`:

```
docs/
├── .gitbook/
│   └── assets/
│       ├── logo.png
│       └── diagram.svg
├── README.md
└── SUMMARY.md
```

Reference assets with relative paths from the page: `../.gitbook/assets/logo.png` or absolute from root: `.gitbook/assets/logo.png`.

## Resources

- **Content Editor**: https://docs.gitbook.com/content-editor
- **OpenAPI**: https://docs.gitbook.com/integrations/openapi
- **Markdown**: https://docs.gitbook.com/content-editor/editing-content/markdown
