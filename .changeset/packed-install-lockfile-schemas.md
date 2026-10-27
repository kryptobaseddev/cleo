---
id: packed-install-lockfile-schemas
tasks: [T14062]
kind: chore
summary: "The packed-install smoke compares resolved contracts/core dependencies with the lockfile and parses schema fixtures through the installed contracts"
---

Published installs resolved zod 4.6.7 while CI tested the lockfile's 4.3.6,
and `testCountSummarySchema` rejected every count summary only in the
published install (T14061). The packed-install smoke now compares the runtime
dependencies npm resolves for the installed `@cleocode/contracts` and
`@cleocode/core` with the lockfile: drift in any contracts dependency or in zod
fails the smoke, and other drift is recorded in the manifest as an untested
resolution. It then parses an acceptance gate and count summaries (without
and with `testResults`) through the installed contracts package.
