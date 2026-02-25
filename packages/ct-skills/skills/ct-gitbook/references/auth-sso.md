# Authentication & SSO Reference

Visitor authentication, SSO/SAML, and identity provider setup for GitBook.

## Overview

GitBook provides two layers of authentication:

1. **Organization SSO** — Controls who can edit documentation (team members)
2. **Visitor Authentication** — Controls who can view published documentation (end users)

## Visitor Authentication

Protect published docs behind a login screen. When enabled, visitors must authenticate through your identity provider before viewing content.

### Supported Providers

| Provider | Type | GitBook Integration |
|----------|------|-------------------|
| Auth0 | Native | Install from integrations |
| Okta | Native | Install from integrations |
| Azure AD | Native | Install from integrations |
| AWS Cognito | Native | Install from integrations |
| Custom OIDC | Manual | Build your own backend |

### Enabling Authenticated Access

1. Open your site's settings
2. Navigate to **Audience**
3. Select **Authenticated access**
4. Choose your identity provider
5. Configure the provider settings

## Auth0 Setup

### 1. Create Auth0 Application

In Auth0 dashboard:
- Create a new **Regular Web Application**
- Note the Domain, Client ID, and Client Secret

### 2. Configure Callback URLs

Add your GitBook docs URL as an allowed callback:
```
https://docs.example.com/~gitbook/auth/callback
```

### 3. Install GitBook Integration

In GitBook:
1. Go to site settings > Integrations
2. Install the **Auth0** integration
3. Enter your Auth0 Domain, Client ID, and Client Secret

### 4. Configure Claims for Adaptive Content

To use Auth0 with adaptive content, add an Auth0 Action or Rule that includes custom claims in the ID token:

```javascript
// Auth0 Action — Add custom claims
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://docs.example.com/';
  api.idToken.setCustomClaim(`${namespace}plan`, event.user.app_metadata?.plan || 'free');
  api.idToken.setCustomClaim(`${namespace}role`, event.user.app_metadata?.role || 'user');
};
```

These claims become available for adaptive content conditions in GitBook.

## Okta Setup

### 1. Create Okta Application

In Okta admin console:
- Create a new **Web Application**
- Set the sign-in redirect URI to your GitBook callback URL
- Note the Client ID and Client Secret

### 2. Configure in GitBook

Install the Okta integration and provide:
- Okta domain (e.g., `dev-12345.okta.com`)
- Client ID
- Client Secret

### 3. Claims for Adaptive Content

Configure Okta to include custom claims in the authentication token:

1. Go to **Security > API > Authorization Servers**
2. Select your authorization server
3. Add custom claims (e.g., `plan`, `role`) with values from user profile attributes

## Azure AD Setup

### 1. Register Application

In Azure portal:
- Navigate to **Azure Active Directory > App registrations**
- Register a new application
- Add redirect URI: `https://docs.example.com/~gitbook/auth/callback`
- Create a client secret

### 2. Configure in GitBook

Install the Azure AD integration and provide:
- Tenant ID
- Client ID
- Client Secret

### Known Limitation

The Azure integration removes heading URL fragments upon authentication. Deep links to specific headings may not work as expected after the auth redirect.

## Custom OIDC Backend

For providers not natively supported, implement a custom authentication backend:

### Requirements

Your backend must:
1. Handle the OIDC authorization flow
2. Redirect to GitBook with a signed JWT
3. Include required claims in the JWT payload

### JWT Payload

```json
{
  "sub": "user-id",
  "email": "user@example.com",
  "name": "User Name",
  "iat": 1706000000,
  "exp": 1706003600,
  "custom_claims": {
    "plan": "enterprise",
    "role": "admin"
  }
}
```

### Flow

1. Visitor accesses protected docs
2. GitBook redirects to your auth endpoint
3. Your backend authenticates the user
4. Your backend redirects back to GitBook with a signed JWT
5. GitBook validates the JWT and grants access

## Organization SSO

Separate from visitor auth — this controls team member access to the GitBook organization.

### Email Domain SSO

Allow anyone with an email from your domain to join your organization:

1. Go to **Organization settings > SSO**
2. Add your verified email domain
3. Team members can sign in with their work email

### SAML 2.0

For enterprise identity providers:

1. Go to **Organization settings > SSO > SAML**
2. Provide your IdP's metadata URL or upload metadata XML
3. Configure attribute mapping:
   - `email` → User email
   - `firstName` → First name
   - `lastName` → Last name
4. Enable SAML SSO

### Supported SAML IdPs

Any SAML 2.0 compliant provider works, including:
- Okta
- Azure AD
- OneLogin
- Google Workspace
- PingFederate
- JumpCloud

## Security Certifications

GitBook holds:
- **SOC 2 Type II** — Security, availability, and confidentiality
- **ISO 27001** — Information security management

## Access Control Roles

| Role | Permissions |
|------|------------|
| Admin | Full organization management |
| Creator | Create spaces and content |
| Editor | Edit existing content |
| Reviewer | Review change requests, add comments |
| Reader | View private content only |

## Resources

- **Visitor Authentication**: https://docs.gitbook.com/publishing-documentation/visitor-authentication
- **SSO & SAML**: https://gitbook.com/docs/account-management/sso-and-saml
- **Auth0 Setup**: https://gitbook.com/docs/publishing-documentation/authenticated-access/setting-up-auth0
- **Okta Setup**: https://gitbook.com/docs/publishing-documentation/authenticated-access/setting-up-okta
- **Azure AD Setup**: https://gitbook.com/docs/publishing-documentation/authenticated-access/setting-up-azure-ad
- **Authenticated Access**: https://gitbook.com/docs/publishing-documentation/authenticated-access/enabling-authenticated-access
