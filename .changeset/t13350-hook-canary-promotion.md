---
id: t13350-hook-canary-promotion
tasks: [T13350]
kind: feat
summary: Add independent numbered canary releases and require validated hook pilot evidence for explicitly scoped hooks-v1 stable promotion.
---

Canary publication never promotes latest automatically. The stable hooks-v1 promotion plan uses --hooks-v1-promotion; ordinary stable releases and hotfixes are exempt. Missing, stale or unverifiable evidence holds that promotion before GitHub Release creation and npm publication.

Redacted retained proofs bind the packed and published cohort, VidaPeps commit, normalized source digest, live harness versions and read-only checks; hosted CI is verified independently. Canary runs print the digest recomputed from their checkout. Release-owned canary and hotfix manifest labels normalize out of the digest; runtime configuration changes invalidate proof.
