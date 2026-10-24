---
id: t13996-cleoos-postinstall-freeze
tasks: [T13996]
kind: chore
summary: 'cleo-os postinstall stops seeding .cant files and skills; cleo tui and caamp pi verbs warn they are deprecated (ADR-098)'
---

The Pi/CleoOS harness is retiring (ADR-098).

- **cleo-os postinstall.** A global install of `@cleocode/cleo-os` no longer
  creates the `cant/` directory and no longer seeds the `model-routing.cant`
  stub or the starter team bundle. It also no longer runs `cleo skills
  install`, and it prints a deprecation notice. It still deploys the
  extensions the `cleoos` launcher loads, so an installed `cleoos` keeps
  starting. Files already seeded are left in place.
- **`cleo tui`** prints a deprecation notice on stderr naming ADR-098, then
  starts the cockpit as before.
- **`caamp pi <verb>`** prints a deprecation notice on stderr naming ADR-098
  before each verb runs. The verbs behave as before.
