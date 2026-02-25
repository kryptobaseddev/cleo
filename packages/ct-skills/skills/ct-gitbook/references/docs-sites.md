# Docs Sites Reference

Publishing, Site Sections, custom domains, content variants, and SEO for GitBook Docs Sites.

## Overview

A **Docs Site** is the published, visitor-facing representation of your documentation. Sites can combine multiple spaces via Site Sections, apply custom branding, use custom domains, and serve versioned content through variants.

## Creating a Docs Site

### Via UI

1. Navigate to your organization dashboard
2. Click **New site**
3. Choose a name and link your first space
4. Configure audience (public, authenticated, or private)

### Via API

```typescript
const site = await client.orgs.createSite(orgId, {
  title: 'Developer Documentation',
});
```

## Site Sections

Site Sections combine multiple spaces into a single site with tab-based or dropdown navigation.

### Adding Sections

```typescript
// Add individual sections
await client.sites.addSiteSection(siteId, {
  spaceId: apiDocsSpaceId,
  title: 'API Reference',
});

await client.sites.addSiteSection(siteId, {
  spaceId: guidesSpaceId,
  title: 'Guides',
});
```

### Section Groups

Group sections under a dropdown heading:

```typescript
await client.sites.addSiteSectionGroup(siteId, {
  title: 'Products',
  sections: [productASection, productBSection],
});
```

### Nested Groups

Since September 2025, GitBook supports **nested section groups** — groups within groups. This enables hierarchical navigation like:

```
Products (dropdown)
├── Platform
│   ├── API Reference
│   └── SDK Guide
└── Tools
    ├── CLI Reference
    └── Plugin Guide
```

### Section Settings

Each section can have:
- **Title**: Display name in the navigation tab
- **Icon**: Optional icon next to the title
- **Description**: Shown in dropdown menus for grouped sections

## Custom Domains

### Setup

1. Add a CNAME DNS record: `docs.example.com → hosting.gitbook.io`
2. Configure in site settings or via API:

```typescript
await client.sites.updateSiteCustomization(siteId, {
  hostname: 'docs.example.com',
});
```

3. GitBook provisions an SSL certificate automatically

### Multiple Domains

Each site supports one custom domain. For multiple domains, create separate sites or use DNS-level redirects.

## Branding & Customization

```typescript
await client.sites.updateSiteCustomization(siteId, {
  // Colors and fonts
  styling: {
    primaryColor: '#0066FF',
    font: 'Inter', // Inter, Roboto, Poppins, etc.
  },

  // Theme
  themes: {
    default: 'light', // light | dark
    toggleable: true,  // Allow visitors to toggle
  },

  // Logos
  favicon: 'https://example.com/favicon.ico',
  logo: {
    light: 'https://example.com/logo-light.png',
    dark: 'https://example.com/logo-dark.png',
  },
});
```

### Customizable Elements

| Element | Options |
|---------|---------|
| Primary color | Any hex color |
| Font family | Inter, Roboto, Poppins, Source Sans Pro, and others |
| Theme | Light, dark, or toggleable |
| Logo | Separate light/dark variants |
| Favicon | Custom favicon URL |
| Header links | Custom navigation links |
| Footer | Custom footer content |

## Content Variants

Variants maintain multiple versions of content within a single space.

### Use Cases

- API version documentation (v1, v2, v3)
- Product editions (Community, Enterprise)
- Language variants (en, fr, de)

### Creating Variants

```typescript
// Create version variants
await client.spaces.createVariant(spaceId, { title: 'v1.0', slug: 'v1' });
await client.spaces.createVariant(spaceId, { title: 'v2.0', slug: 'v2' });

// Set the default variant visitors see
await client.spaces.setDefaultVariant(spaceId, v2VariantId);
```

### Variant URLs

Variants are accessible via slug in the URL:

```
https://docs.example.com/v1/getting-started
https://docs.example.com/v2/getting-started
```

The default variant is served at the root URL without a slug prefix.

### Variant vs. Site Sections

| Feature | Variants | Site Sections |
|---------|----------|---------------|
| Content | Same space, different versions | Different spaces |
| Navigation | Version dropdown | Top-level tabs |
| Use case | Versioned docs | Multi-product docs |
| URL pattern | `/v2/page` | `/section/page` |

## SEO

GitBook generates SEO-friendly output automatically:

- **Sitemaps**: Auto-generated at `/sitemap.xml`
- **Open Graph**: Meta tags for social sharing
- **Structured data**: JSON-LD for search engines
- **Clean URLs**: Slug-based paths without file extensions
- **Meta descriptions**: Set per page in the editor
- **Canonical URLs**: Automatically set for custom domains

### Custom Meta

Set per-page descriptions in the GitBook editor via the page settings panel. These appear in search engine results.

## Audience Settings

| Setting | Description |
|---------|-------------|
| Public | Anyone can view |
| Authenticated | Requires login via visitor auth provider |
| Private | Only organization members |

## Resources

- **Docs Sites**: https://gitbook.com/docs/publishing-documentation
- **Site Sections**: https://gitbook.com/docs/publishing-documentation/site-structure/site-sections
- **Custom Domains**: https://docs.gitbook.com/publishing-documentation/custom-domain
- **Customization**: https://docs.gitbook.com/publishing-documentation/customization
