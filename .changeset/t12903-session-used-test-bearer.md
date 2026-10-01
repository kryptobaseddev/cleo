---
id: t12903-session-used-test-bearer
tasks: [T12902, T12903]
kind: feat
summary: the 9.24 auto-upgrade maps E1 401 session-used to E_NEXUS_SESSION_EXPIRED and re-reads nexus-device.json first, reporting already-enrolled when a concurrent upgrade stored the credential; a staging-only CLEO_NEXUS_TEST_BEARER lets cleo login nexus enrol without a browser
---

**401 `session-used` on the auto-upgrade (T12903).** The deployed Cleo Nexus
server answers E1 `POST /v1/devices/enroll` with 401 `session-used` when a
concurrent E1 already consumed the one-shot 9.24 session (contract v2.12,
§3.4, §4.0.4). Before this change the CLI mapped it to
`E_NEXUS_NOT_SIGNED_IN`, and the upgrade deleted the session and failed even
though the process that won had usually already stored a device credential.
Now `session-used` maps to `E_NEXUS_SESSION_EXPIRED`. On that answer,
`upgradeNexusSession` removes the dead session locally and re-reads
`nexus-device.json`. If another process stored a credential, the outcome is
`already-enrolled`. Otherwise it fails with `E_NEXUS_SESSION_EXPIRED` and
asks for a browser login.

**Staging-only test bearer (T12902).** `CLEO_NEXUS_TEST_BEARER` holds a
better-auth session bearer minted by the staging test-signup endpoint
(`POST /v1/test/users` on `https://api.staging.cleocode.dev`). When the
resolved API origin is exactly `https://api.staging.cleocode.dev`, the
device-credential `cleo login nexus` skips the device-code step and runs the
same E2 (whoami), E1 (enrol) and sign-out path as a browser login, writing
`nexus-device.json`. For any other origin the variable is ignored with a
`W_NEXUS_TEST_BEARER_IGNORED` warning. Its value never appears in a result,
warning, error or log. A value that is not a valid header token is refused
before any request is sent.
