---
id: caamp-pi-not-primary
tasks: [T13995]
kind: fix
summary: "CAAMP no longer prefers Pi: Pi is not the primary provider and the default exclusivity mode is legacy"
---
The Pi/CleoOS harness is retiring (ADR-098). CAAMP's registry marked Pi as the
`primary` provider and defaulted to the `auto` exclusivity mode, so any user
with Pi installed had skills and instructions routed to Pi only, and users
without Pi saw a "Pi is not installed" warning.

- Pi's registry priority is now `medium`, like the other installable harnesses.
- The default exclusivity mode is now `legacy`: CAAMP targets the installed
  high-tier providers and prints no Pi warnings.
- `auto` and `force-pi` still work as explicit opt-ins
  (`CAAMP_EXCLUSIVITY_MODE`); they find the Pi harness by id.

**Routing change:** with Pi and another high-tier provider installed (for
example Claude Code), the default target is now that provider, not Pi.
