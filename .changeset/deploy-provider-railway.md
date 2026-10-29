---
id: deploy-provider-railway
tasks: [T14091]
kind: feat
summary: "deploy: evidence asks Railway's API that the deployment is live and was built from the named commit"
---

A `deploy:railway/<deploymentId>@<sha>|<probe-url>` atom is now also checked
with Railway's API, using the user's own token from the environment:
`RAILWAY_API_TOKEN` (an account token) or `RAILWAY_TOKEN` (a project token).
The token is read at verify time and never stored; CLEO reads no other
tool's login file. The deployment must exist, must be the live one (the
newest successful deployment of its service and environment), and must have
been built from exactly the atom's commit. A refusal names the deployment id
and both commits. The atom records `providerCheck`. Other providers, or a
missing credential, keep the probe-only behaviour, recorded as
`providerCheck: { verified: false, reason }`. A `DeployProviderAdapter`
interface lets further providers follow.
