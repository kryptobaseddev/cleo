---
id: t11669-codex-openai-pkce-login
tasks: [T11669]
kind: feat
summary: cleo llm login openai and codex now work via OAuth PKCE (fixed loopback port 1455); supported-provider help is derived from the registry so it cannot drift
---

Adds the openai/codex provider profile (SG-PROVIDER-AUTH-UNIFICATION E4). cleo llm login openai (alias codex) runs the RFC 7636 PKCE flow against auth.openai.com on the pre-registered loopback port 1455, stores the OAuth credential for the runtime CodexResponsesTransport, and the E_NOT_IMPLEMENTED hint is now generated from the provider registry (DHQ-006 anti-drift). Adds ProviderOAuthConfig.extraAuthParams + a fixed-loopback-port option to the PKCE flow. Also removes the external GitNexus integration (CLAUDE.md section + .claude/skills/gitnexus + 182M index) per owner directive — it is a competing code-intelligence system, not part of CLEO.
