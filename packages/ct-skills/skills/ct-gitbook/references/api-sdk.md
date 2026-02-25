# @gitbook/api TypeScript SDK Reference

The official TypeScript SDK for the GitBook API. Works in Node.js and browsers.

## Installation

```bash
npm install @gitbook/api
```

## Client Initialization

```typescript
import { GitBookAPI } from '@gitbook/api';

// With explicit token
const client = new GitBookAPI({
  authToken: 'gb_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
});

// From environment
const client = new GitBookAPI({
  authToken: process.env.GITBOOK_API_TOKEN,
});
```

## Authentication

Generate an API token at `https://app.gitbook.com/account/developer`.

```typescript
// Verify authentication
const user = await client.user.getCurrentUser();
console.log(user.data.displayName);
// Returns: { data: { id, displayName, email, photoURL } }
```

Token scopes control access. Create tokens with the minimum required permissions.

## Organizations

```typescript
// List all organizations for the authenticated user
const orgs = await client.orgs.listOrganizationsForAuthenticatedUser();
for (const org of orgs.data.items) {
  console.log(`${org.title} (${org.id})`);
}

// Get organization by ID
const org = await client.orgs.getOrganizationById(orgId);

// List members
const members = await client.orgs.listMembersInOrganization(orgId);

// Invite members
await client.orgs.inviteMembersToOrganization(orgId, {
  emails: ['user@example.com'],
  role: 'editor', // admin | creator | editor | reviewer | reader
});

// Update member role
await client.orgs.updateMemberInOrganization(orgId, memberId, {
  role: 'admin',
});

// Remove member
await client.orgs.removeMemberFromOrganization(orgId, memberId);
```

## Spaces

```typescript
// List spaces in an organization
const spaces = await client.orgs.listSpacesInOrganization(orgId);

// Get space by ID
const space = await client.spaces.getSpaceById(spaceId);

// Create space
const newSpace = await client.orgs.createSpace(orgId, {
  title: 'API Documentation',
  visibility: 'public', // public | private | unlisted
});

// Update space
await client.spaces.updateSpace(spaceId, {
  title: 'Updated Title',
  visibility: 'private',
});

// Delete space
await client.spaces.deleteSpace(spaceId);
```

## Content & Pages

```typescript
// List pages in a space (returns tree structure)
const pages = await client.spaces.listPagesInSpace(spaceId);
for (const page of pages.data.pages) {
  console.log(`${page.title} — ${page.path}`);
}

// Get a specific page
const page = await client.spaces.getPageInSpace(spaceId, pageId);

// Search content
const results = await client.spaces.searchSpaceContent(spaceId, {
  query: 'authentication',
});

// Import content from external source
await client.spaces.importContentInSpace(spaceId, {
  source: {
    type: 'github',
    url: 'https://github.com/org/docs-repo',
    ref: 'main',
  },
});
```

## Content Variants

```typescript
// List variants for a space
const variants = await client.spaces.listVariantsInSpace(spaceId);

// Create a variant
const variant = await client.spaces.createVariant(spaceId, {
  title: 'v2.0',
  slug: 'v2',
});

// Set default variant
await client.spaces.setDefaultVariant(spaceId, variantId);

// Get variant content
const content = await client.spaces.listPagesInVariant(spaceId, variantId);

// Delete variant
await client.spaces.deleteVariant(spaceId, variantId);
```

## Collections

```typescript
// List collections
const collections = await client.orgs.listCollectionsInOrganization(orgId);

// Create collection
const collection = await client.orgs.createCollection(orgId, {
  title: 'Product Docs',
  description: 'All product documentation',
});

// Add space to collection
await client.collections.addSpaceToCollection(collectionId, spaceId);

// List spaces in collection
const spaces = await client.collections.listSpacesInCollection(collectionId);

// Remove space from collection
await client.collections.removeSpaceFromCollection(collectionId, spaceId);
```

## Docs Sites

```typescript
// Create a docs site
const site = await client.orgs.createSite(orgId, {
  title: 'Developer Documentation',
});

// List sites
const sites = await client.orgs.listSitesInOrganization(orgId);

// Get site
const site = await client.sites.getSiteById(siteId);

// Update site customization
await client.sites.updateSiteCustomization(siteId, {
  hostname: 'docs.example.com',
  styling: {
    primaryColor: '#0066FF',
    font: 'Inter',
  },
  themes: {
    default: 'light',
    toggleable: true,
  },
  favicon: 'https://example.com/favicon.ico',
  logo: {
    light: 'https://example.com/logo-light.png',
    dark: 'https://example.com/logo-dark.png',
  },
});

// Delete site
await client.sites.deleteSite(siteId);
```

## Site Sections

```typescript
// Add a section to a site
await client.sites.addSiteSection(siteId, {
  spaceId: spaceId,
  title: 'API Reference',
});

// List sections
const sections = await client.sites.listSiteSections(siteId);

// Update section
await client.sites.updateSiteSection(siteId, sectionId, {
  title: 'Updated Section Title',
});

// Remove section
await client.sites.removeSiteSection(siteId, sectionId);

// Create section group (nested navigation)
await client.sites.addSiteSectionGroup(siteId, {
  title: 'Products',
  sections: [sectionId1, sectionId2],
});
```

## Change Requests

```typescript
// Create a change request
const cr = await client.spaces.createChangeRequest(spaceId, {
  subject: 'Update authentication guide',
});

// List change requests
const changeRequests = await client.spaces.listChangeRequests(spaceId);

// Get change request details
const detail = await client.spaces.getChangeRequest(spaceId, crId);

// Merge change request
await client.spaces.mergeChangeRequest(spaceId, crId);
```

## Error Handling

The SDK throws typed errors for API failures:

```typescript
import { GitBookAPI, GitBookAPIError } from '@gitbook/api';

try {
  await client.spaces.getSpaceById('invalid-id');
} catch (error) {
  if (error instanceof GitBookAPIError) {
    console.error(`API Error ${error.statusCode}: ${error.message}`);
    // error.statusCode — HTTP status (401, 403, 404, etc.)
    // error.message — Human-readable error description
  }
}
```

### Common Error Codes

| Status | Meaning | Action |
|--------|---------|--------|
| 401 | Unauthorized | Check/regenerate API token |
| 403 | Forbidden | Token lacks required scope |
| 404 | Not Found | Verify resource ID |
| 429 | Rate Limited | Back off and retry |
| 500 | Server Error | Retry with exponential backoff |

## Rate Limiting

The API enforces rate limits. Handle 429 responses with exponential backoff:

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof GitBookAPIError && error.statusCode === 429 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}
```

## Pagination

List endpoints return paginated results:

```typescript
// Manual pagination
let page = await client.orgs.listSpacesInOrganization(orgId);
const allSpaces = [...page.data.items];

while (page.data.next) {
  page = await client.orgs.listSpacesInOrganization(orgId, {
    page: page.data.next,
  });
  allSpaces.push(...page.data.items);
}
```

## Resources

- **npm**: https://www.npmjs.com/package/@gitbook/api
- **API Docs**: https://developer.gitbook.com/
- **API Reference**: https://gitbook.com/docs/developers/gitbook-api/api-reference
