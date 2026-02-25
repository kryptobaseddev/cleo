# Change Requests Reference

Branch-and-merge editing workflow with review, plus adaptive content personalization.

## Overview

A Change Request (CR) is an isolated copy of your space's content — similar to a Git branch or pull request. You can edit freely in a CR without affecting live documentation, then merge when ready.

## Workflow

### 1. Create a Change Request

**In the UI**: Click **New change request** in the space sidebar.

**Via API**:
```typescript
const cr = await client.spaces.createChangeRequest(spaceId, {
  subject: 'Update authentication guide',
});
console.log(`Created CR: ${cr.data.id}`);
```

### 2. Make Edits

- Edit pages in the GitBook editor within the CR context
- Add, remove, or reorder pages
- Upload new assets
- Use the Docs Agent (AI) to generate or refine content within the CR

All changes are isolated from the live site.

### 3. Request Review

- Tag reviewers in the CR's **Overview** tab
- Reviewers are notified and can approve, request changes, or comment
- Docs Agent can also be assigned as a reviewer for AI-assisted feedback

### 4. Review

Reviewers can:
- View a diff of all changes
- Add inline comments on specific content
- Approve or request changes
- Previous reviews are marked as **outdated** when the CR is updated

### 5. Merge

```typescript
await client.spaces.mergeChangeRequest(spaceId, crId);
```

Merging applies all changes to the main content and publishes them to the live site immediately.

## API Operations

```typescript
// Create change request
const cr = await client.spaces.createChangeRequest(spaceId, {
  subject: 'Add new API endpoints documentation',
});

// List change requests for a space
const list = await client.spaces.listChangeRequests(spaceId);
for (const item of list.data.items) {
  console.log(`${item.subject} — ${item.status}`);
}

// Get change request details
const detail = await client.spaces.getChangeRequest(spaceId, crId);

// Get content diff
const diff = await client.spaces.getChangeRequestDiff(spaceId, crId);

// Merge
await client.spaces.mergeChangeRequest(spaceId, crId);

// Close without merging
await client.spaces.closeChangeRequest(spaceId, crId);
```

## Review Features (October 2025 Updates)

- **Improved sidebar**: Filter CRs by creator, participant, or review status
- **Shortcut filters**: Quick access to "awaiting my review" and "created by me"
- **Outdated reviews**: Automatically marked when new changes are pushed
- **Re-request review**: Single-action button to request a fresh review
- **Review badges**: Visual indicators for review status on each CR

## Docs Agent Integration

The Docs Agent is GitBook's AI assistant that can:
- Generate content within a change request
- Review changes and suggest improvements
- Be assigned as a reviewer alongside human reviewers
- Provide automated quality feedback

## Change Request Statuses

| Status | Description |
|--------|-------------|
| `open` | Active, editable |
| `merged` | Changes applied to main content |
| `closed` | Discarded without merging |

## Best Practices

1. **One topic per CR** — Keep changes focused for easier review
2. **Descriptive subjects** — Use clear subjects like "Add OAuth2 guide" not "Update docs"
3. **Tag reviewers early** — Don't wait until the CR is complete to request feedback
4. **Use Docs Agent** — Let AI catch formatting issues and suggest improvements
5. **Merge promptly** — Long-lived CRs increase conflict risk

---

## Adaptive Content

Adaptive content personalizes published documentation based on visitor attributes (claims).

### How It Works

1. Visitors arrive with **claims** — data about who they are (role, plan, region, etc.)
2. Claims are passed via cookies, URL parameters, feature flags, or authentication providers
3. GitBook dynamically shows/hides content based on claim values

### Methods for Passing Claims

| Method | Use Case |
|--------|----------|
| Cookies | Public or signed cookies set by your app |
| URL parameters | `?plan=enterprise&role=admin` |
| Feature flag provider | LaunchDarkly, Split, etc. |
| Authentication provider | Auth0, Okta, Azure AD claims |

### What You Can Adapt

- **Pages**: Show/hide entire pages based on claims
- **Sections**: Show/hide page sections
- **Header links**: Dynamic navigation based on user type
- **Content blocks**: Conditional content within a page

### Example Use Cases

- Show "Getting Started" to new users, "Advanced API" to experienced users
- Display pre-filled API keys for authenticated developers
- Show enterprise features only to enterprise plan users
- Present region-specific compliance information
- Hide internal-only documentation from external visitors

### Configuration

Enable adaptive content in site settings. Requires an Ultimate plan and a custom domain.

```typescript
// Site must have authenticated access enabled
// Claims are then available for content conditions
await client.sites.updateSiteCustomization(siteId, {
  audience: 'authenticated',
});
```

### AI Assistant Integration

GitBook Assistant uses adaptive content context to provide personalized answers. When connected to MCP servers, the assistant can pull information from third-party sources and trigger actions based on visitor claims.

## Resources

- **Change Requests**: https://gitbook.com/docs/collaboration/change-requests
- **Adaptive Content**: https://gitbook.com/docs/publishing-documentation/adaptive-content
- **Personalization Guide**: https://gitbook.com/docs/guides/docs-personalization-and-authentication/setting-up-adaptive-content
