---
id: t13686-sdk-client-regen
tasks: [T13686]
kind: fix
summary: "generated gateway SDK client regenerated to cover every OPERATIONS entry (473); CI now fails when it drifts"
---

The committed gateway client (`@cleocode/core/gateway-client`) had fallen behind the OPERATIONS registry: operations added since its last regeneration had no typed client method. It is regenerated with `pnpm --filter @cleocode/core run gen:sdk` (purely additive: no existing export removed), and CI's Build job now runs `gen:sdk:check` against the freshly built core, so an operation added without regenerating the client fails the build.
