---
id: login-consent-redirected
tasks: [T13321]
kind: fix
summary: cleo login with stderr redirected no longer links or uploads unasked; the device read pins no keychain addon
---

- **Consent when stderr is redirected (#1973 review).** With stdin on a
  terminal but stderr redirected (`cleo login 2>log`), a person may be at the
  keyboard who cannot see the question. The guided first run now uses consent
  `never` there. It links nothing, uploads nothing, and prints the exact next
  commands. `--yes` stays the explicit opt-in. The other cases are unchanged:
  - stdin and stderr on a terminal: the run asks;
  - no terminal at all (an agent): T13288's unattended link and first backup;
  - CI: never acts.

  `cleo login --help` says so.
- **Keychain addons (#1973 review).** The device-credential read used by the
  hourly presence refresh is now also pinned against a native keychain addon.
  A test fails if `NexusDeviceStore.list()` calls `process.dlopen`, or if the
  store's static import graph names a keytar, keyring, keychain or libsecret
  module. This adds to the existing check that it starts no process.
