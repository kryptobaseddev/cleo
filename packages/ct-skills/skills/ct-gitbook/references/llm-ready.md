# LLM-Ready Documentation Reference

llms.txt, MCP server, Markdown endpoints, and SEO for GitBook published sites.

## Overview

GitBook automatically generates LLM-optimized outputs for every published Docs Site. No configuration required — these features are enabled by default on all published sites.

## llms.txt

Every published site serves a plain-text index at `/llms.txt`:

```
https://docs.example.com/llms.txt
```

This file follows the emerging `llms.txt` standard, providing a structured index of all documentation pages with titles and URLs.

### llms-full.txt

A complete version containing the full text of all pages in a single file:

```
https://docs.example.com/llms-full.txt
```

Use this for bulk ingestion into LLM context windows or RAG pipelines.

### Format

```text
# docs.example.com

> Site description from settings

## Getting Started
- [Introduction](https://docs.example.com/getting-started)
- [Installation](https://docs.example.com/getting-started/installation)

## API Reference
- [Authentication](https://docs.example.com/api/authentication)
- [Endpoints](https://docs.example.com/api/endpoints)
```

### Use Cases

- **RAG pipelines**: Index documentation for retrieval-augmented generation
- **AI assistants**: Provide documentation context to chatbots
- **Search engines**: Alternative to sitemaps for AI crawlers
- **Documentation audits**: Quick machine-readable content inventory

## Markdown Endpoints

Every page on a GitBook site is available as raw Markdown by appending `.md` to the URL:

```
https://docs.example.com/getting-started.md
https://docs.example.com/api/authentication.md
```

### Benefits

- Clean Markdown without HTML rendering artifacts
- Ideal for LLM ingestion — no HTML parsing required
- Preserves content structure (headings, lists, code blocks)
- Lower token count compared to HTML

### Programmatic Access

```typescript
// Fetch a page as Markdown
const response = await fetch('https://docs.example.com/getting-started.md');
const markdown = await response.text();

// Use in an LLM prompt
const prompt = `Based on this documentation:\n\n${markdown}\n\nAnswer: ${question}`;
```

## MCP Server

Every published space exposes a Model Context Protocol (MCP) server for structured AI tool access.

### Endpoint

```
https://docs.example.com/~gitbook/mcp
```

### Configuration

Add to your agent's MCP server configuration:

```json
{
  "mcpServers": {
    "company-docs": {
      "url": "https://docs.example.com/~gitbook/mcp"
    }
  }
}
```

### What MCP Provides

- **Resource discovery**: AI tools can list available documentation pages
- **Content retrieval**: Fetch specific pages or sections by path
- **Search**: Query documentation content programmatically
- **Structured access**: No scraping — clean, structured data

### Supported Agents

Any MCP-compatible agent can use the server, including:
- Claude Code (via MCP server config)
- Cursor (via MCP settings)
- VS Code with Copilot (via MCP extension)
- Custom agents using the MCP SDK

### Example — Claude Code Configuration

```json
{
  "mcpServers": {
    "project-docs": {
      "url": "https://docs.example.com/~gitbook/mcp"
    }
  }
}
```

The agent can then query your documentation directly during coding sessions.

## SEO

GitBook generates SEO-optimized output automatically.

### Auto-Generated

| Feature | Description |
|---------|-------------|
| Sitemaps | `sitemap.xml` at site root |
| Open Graph | Meta tags for social sharing |
| Twitter Cards | Rich preview cards |
| JSON-LD | Structured data for search engines |
| Canonical URLs | Proper canonical tags for custom domains |
| Clean URLs | Slug-based paths, no file extensions |

### Custom Meta

Set per-page meta descriptions in the GitBook editor:
1. Open a page
2. Click the page settings (gear icon)
3. Add a custom description

This description appears in search engine results and social shares.

### Robots.txt

GitBook generates a `robots.txt` allowing all crawlers by default. For authenticated sites, the robots.txt blocks crawlers to prevent indexing of protected content.

## AI Readership Metrics

AI documentation readership increased over 500% in 2025. Optimizing for LLM consumption is no longer optional — it directly impacts how well AI tools can assist developers using your product.

## Feature Timeline

| Date | Feature |
|------|---------|
| January 2025 | `/llms.txt` support launched |
| June 2025 | `llms-full.txt` and `.md` page endpoints |
| September 2025 | MCP server for published spaces |

## Resources

- **LLM-Ready Docs**: https://gitbook.com/docs/publishing-documentation/llm-ready-docs
- **llms.txt Standard**: https://llmstxt.org/
- **Model Context Protocol**: https://modelcontextprotocol.io/
- **GitBook llms.txt**: https://docs.gitbook.com/llms.txt
- **GitBook llms-full.txt**: https://gitbook.com/docs/llms-full.txt
